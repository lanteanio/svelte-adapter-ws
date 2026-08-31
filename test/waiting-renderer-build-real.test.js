// The production waiting-room localization pipeline, driven end to end from
// the REAL build: waitingRoom.renderer is a module PATH (production refuses a
// live function), so only a real build exercises the build-side validation,
// the isolated esbuild renderer entry, the default/renderWaitingRoom pick, and
// the bridge artifact the runtime imports. Every other renderer test injects a
// live function, which means this whole chain could be deleted with the suite
// green.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import adapter from '../src/index.js';
import { resolveWaitingRoom } from '../src/runtime/utils/upgrade-admission.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The fake app must live inside this repo's tree: esbuild and rollup resolve
// the build-time tools by walking up from the app's package.json, and a
// system-temp location has no node_modules above it.
const appDir = mkdtempSync(path.join(repoRoot, 'test', '.tmp-adapt-waiting-renderer-'));
const out = path.join(appDir, 'build');
const originalCwd = process.cwd();

const SERVER_SRC = `
export class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init() {}
	async respond() { return new Response('ssr', { headers: { 'content-type': 'text/html' } }); }
}
`;

// Localizing renderer, configured as a module PATH and therefore bundled by
// the adapter build into the isolated renderer entry the bridge imports.
const RENDERER_SRC = `
export function renderWaitingRoom({ queueDepth, request }) {
	const preferred = (request.headers.get('accept-language') || '').toLowerCase();
	const french = preferred.startsWith('fr');
	const lang = french ? 'fr' : 'en';
	const title = french ? "File d'attente" : 'Waiting room';
	const status = french
		? 'Vous êtes dans la file. Position mise à jour automatiquement.'
		: 'You are in the queue. Your position updates automatically.';
	const retry = french ? 'Réessayer maintenant' : 'Retry now';
	const depth = Number.isFinite(queueDepth) ? String(queueDepth) : '';
	const body = '<!doctype html>\\n' +
		\`<html lang="\${lang}" dir="ltr">\\n\` +
		'<head><meta charset="utf-8"><title>' + title + '</title></head>\\n' +
		'<body>\\n' +
		'<main>\\n' +
		'<h1>' + title + '</h1>\\n' +
		'<p role="status">' + status + (depth ? ' (' + depth + ')' : '') + '</p>\\n' +
		'<a href="/">' + retry + '</a>\\n' +
		'</main>\\n' +
		'</body>\\n' +
		'</html>\\n';
	return { body, lang, dir: 'ltr' };
}
`;

/** @param {string} source @param {Record<string, string>} replace */
function substitute(source, replace) {
	let result = source;
	for (const [key, value] of Object.entries(replace)) {
		result = result.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
	}
	return result;
}

/** @param {string} from @param {string} to @param {Record<string, string>} replace */
function copyTree(from, to, replace) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst, replace);
		else writeFileSync(dst, substitute(readFileSync(src, 'utf8'), replace));
	}
}

function makeBuilder() {
	const log = Object.assign(() => {}, {
		minor() {}, info() {}, success() {}, warn() {}, error() {}
	});
	return {
		log,
		rimraf: (/** @type {string} */ p) => rmSync(p, { recursive: true, force: true }),
		mkdirp: (/** @type {string} */ p) => mkdirSync(p, { recursive: true }),
		getBuildDirectory: (/** @type {string} */ name) => path.join(appDir, '.svelte-kit', name),
		config: {
			kit: {
				paths: { base: '' },
				env: { dir: appDir, publicPrefix: 'PUBLIC_', privatePrefix: '' },
				files: { assets: path.join(appDir, 'static') },
				alias: {},
				version: { name: 'test' }
			}
		},
		writeClient(/** @type {string} */ dest) {
			mkdirSync(path.join(dest, '_app'), { recursive: true });
			writeFileSync(path.join(dest, '_app', 'entry.js'), 'export const v = 1;');
			return [];
		},
		writePrerendered(/** @type {string} */ dest) { mkdirSync(dest, { recursive: true }); return []; },
		writeServer(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'index.js'), SERVER_SRC);
			return [];
		},
		generateManifest: () => "{ appPath: '_app', mimeTypes: {}, assets: new Set([]) }",
		prerendered: { paths: [] },
		compress: async () => {},
		hasServerInstrumentationFile: () => false,
		copy(/** @type {string} */ from, /** @type {string} */ to, /** @type {{ replace: Record<string, string> }} */ opts) {
			copyTree(from, to, opts.replace);
		}
	};
}

function requestWith(language) {
	return {
		method: 'GET',
		url: '/ws',
		headers: { get: (name) => (name.toLowerCase() === 'accept-language' ? language : null) }
	};
}

beforeAll(async () => {
	writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
		name: 'fake-app', private: true, type: 'module', dependencies: {}
	}));
	mkdirSync(path.join(appDir, 'src'), { recursive: true });
	writeFileSync(path.join(appDir, 'src', 'waiting-room.renderer.js'), RENDERER_SRC);
	// adapt() reads package.json, the out path and hook candidates from cwd.
	process.chdir(appDir);
	const instance = adapter({
		out,
		websocket: {
			allowedOrigins: '*',
			upgradeAdmission: {
				maxConcurrent: 4,
				waitingRoom: { renderer: './src/waiting-room.renderer.js' }
			}
		}
	});
	await instance.adapt(makeBuilder());
	process.chdir(originalCwd);
}, 400000);

afterAll(async () => {
	process.chdir(originalCwd);
	// esbuild keeps a service child whose cwd is inside appDir (adapt() chdirs
	// there), and Windows refuses to delete a directory that is any process's
	// cwd - stop the service before removing the tree.
	try {
		const esbuild = await import('esbuild');
		await esbuild.stop?.();
	} catch { /* esbuild not resolvable - nothing to stop */ }
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			rmSync(appDir, { recursive: true, force: true });
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}
});

describe('built waiting-room renderer pipeline', () => {
	it('bundles the configured module into a real renderer artifact, not the null stub', async () => {
		const url = pathToFileURL(path.join(out, 'server', 'waiting-room-renderer.js'));
		url.searchParams.set('test', String(Date.now()));
		const artifact = await import(url.href);
		expect(typeof artifact.default, 'renderer artifact still exports the unused-feature stub').toBe('function');
	});

	it('serves localized documents through resolveWaitingRoom exactly as the runtime wires it', async () => {
		const url = pathToFileURL(path.join(out, 'server', 'waiting-room-renderer.js'));
		url.searchParams.set('test', 'localized-' + Date.now());
		const artifact = await import(url.href);
		const room = resolveWaitingRoom(
			{ maxConcurrent: 4, waitingRoom: {} },
			artifact.default
		);
		expect(room).not.toBeNull();

		const english = room.renderResponse(3, requestWith('en-US,en;q=0.9'));
		expect(english.lang).toBe('en');
		expect(english.varyAcceptLanguage).toBe(true);
		expect(english.body).toContain('You are in the queue');

		const french = room.renderResponse(3, requestWith('fr-CH,fr;q=0.9'));
		expect(french.lang).toBe('fr');
		expect(french.body).toContain('Vous êtes dans la file');
	});

	it('keeps the runtime bridge bound to the built artifact', () => {
		// The bridge is the ONLY route the bundled renderer reaches the
		// runtime through; assert the BUILT bridge (not the repo source) still
		// imports the artifact, so deleting the wiring turns this red.
		const bridge = readFileSync(path.join(out, 'waiting-room-renderer-bridge.js'), 'utf8');
		expect(bridge).toContain('./server/waiting-room-renderer.js');
	});

	it('feeds the bridge value into resolveWaitingRoom in the built upgrade path', () => {
		// The last hop: the built upgrade path must pass the bridge import as
		// the second argument. Replacing it with null breaks production
		// localization while every renderer unit test stays green, so the BUILT
		// module is asserted to carry the feed - not the repo source, which a
		// build could be configured to ignore.
		const realtime = readFileSync(path.join(out, 'handler', 'realtime.js'), 'utf8');
		const feed = /resolveWaitingRoom\(\s*([A-Za-z_$][\w$]*)\??\.?[\w$]*\.?upgradeAdmission\s*,\s*([A-Za-z_$][\w$]*)\s*\)/
			.exec(realtime);
		expect(feed, 'built upgrade path does not call resolveWaitingRoom with two arguments').not.toBeNull();
		const rendererBinding = feed[2];
		expect(rendererBinding).not.toBe('null');
		expect(rendererBinding).not.toBe('undefined');
		// That binding must be the value imported from the bridge, not a local
		// placeholder that happens to be named something plausible.
		expect(realtime).toMatch(
			new RegExp('import\\s*\\{[^}]*\\b' + rendererBinding + '\\b[^}]*\\}\\s*from\\s*["\'][^"\']*waiting-room-renderer-bridge')
		);
	});
});
