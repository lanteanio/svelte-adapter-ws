// The build half, end to end in-process: adapt() runs against a stub Builder,
// rollup really bundles the server output (kit-node included), the runtime is
// really copied with the production replace map, and the resulting build/
// tree BOOTS and answers - SSR, prerendered, static, probes and a WebSocket
// welcome. This is the lane that keeps the "production needs no
// devDependencies" claim honest: the emitted bundle is scanned for bare
// imports, and only `ws` and node builtins may remain.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import WebSocket from 'ws';
import { parse } from 'acorn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import adapter from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The fake app must live inside this repo's tree: rollup and the runtime
// resolve @sveltejs/kit and ws by walking up from the build files, and a
// system-temp location has no node_modules above it. test/.tmp-adapt-* is
// gitignored.
const appDir = mkdtempSync(path.join(repoRoot, 'test', '.tmp-adapt-'));
const out = path.join(appDir, 'build');
const originalCwd = process.cwd();

const SERVER_SRC = `
export class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init({ env, read }) { this.read = read; }
	async respond(request, { platform, getClientAddress }) {
		const p = new URL(request.url).pathname;
		return new Response('SSR:' + p, {
			status: p === '/missing' ? 404 : 200,
			headers: { 'content-type': 'text/html' }
		});
	}
}
`;

/**
 * builder.copy's placeholder substitution: word-boundary global replace of
 * each key, the same semantics the runtime's test harness mirrors.
 * @param {string} source @param {Record<string, string>} replace
 */
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

/** @type {string[]} */
const warnings = [];

function makeBuilder() {
	const log = Object.assign((/** @type {string} */ msg) => {}, {
		minor() {},
		info() {},
		success() {},
		warn(/** @type {string} */ msg) { warnings.push(msg); },
		error(/** @type {string} */ msg) { warnings.push(msg); }
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
			mkdirSync(path.join(dest, '_app', 'immutable'), { recursive: true });
			writeFileSync(path.join(dest, 'app.css'), 'body { margin: 0 }');
			writeFileSync(path.join(dest, '_app', 'immutable', 'entry.js'), 'export const v = 1;');
			return [];
		},
		writePrerendered(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'about.html'), '<html>prerendered about</html>');
			return [];
		},
		writeServer(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'index.js'), SERVER_SRC);
			return [];
		},
		generateManifest: () => "{ appPath: '_app', mimeTypes: {}, assets: new Set([]) }",
		prerendered: { paths: ['/about'] },
		compress: async () => {},
		hasServerInstrumentationFile: () => false,
		copy(/** @type {string} */ from, /** @type {string} */ to, /** @type {{ replace: Record<string, string> }} */ opts) {
			copyTree(from, to, opts.replace);
		}
	};
}

/** @type {any} */
let handler = null;
/** @type {number} */
let port = 0;

beforeAll(async () => {
	writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
		name: 'fake-app', private: true, type: 'module', dependencies: {}
	}));
	// A recording tracing provider: spans land on a global the booted runtime
	// shares with this test process, proving the configured module is bundled,
	// loaded, and armed - not just copied.
	writeFileSync(path.join(appDir, 'tracing-fixture.js'), [
		'export default {',
		'	startSpan(name, options) {',
		'		(globalThis.__traceSpans ??= []).push({ name, kind: options?.kind });',
		"		return { spanContext: () => ({ traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8), traceFlags: 1 }), end() {} };",
		'	}',
		'};',
		''
	].join('\n'));
	// adapt() reads package.json, the out path and hook candidates from cwd.
	process.chdir(appDir);
	const instance = adapter({ out, websocket: {}, tracing: './tracing-fixture.js' });
	await instance.adapt(makeBuilder());
	process.chdir(originalCwd);

	process.env.PORT = '0';
	// The default same-origin WebSocket policy refuses to boot without a host
	// pin; a pinned ORIGIN is the production-shaped way to satisfy it.
	process.env.ORIGIN = 'http://127.0.0.1';
	handler = await import(pathToFileURL(path.join(out, 'handler.js')).href);
	await handler.start('127.0.0.1', 0);
	port = handler.server.address().port;
}, 120000);

afterAll(async () => {
	process.chdir(originalCwd);
	if (handler) await handler.shutdown({ timeoutMs: 2000 });
	delete process.env.PORT;
	delete process.env.ORIGIN;
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

/** @param {string} reqPath */
function get(reqPath) {
	return fetch(`http://127.0.0.1:${port}${reqPath}`);
}

describe('adapter build output', () => {
	it('emits the complete server tree', () => {
		for (const rel of [
			'index.js', 'handler.js',
			'server/index.js', 'server/manifest.js', 'server/kit-node.js', 'server/ws-handler.js',
			'meta/svelte-adapter-ws/package.json', 'meta/protocol.schema.json',
			'trace-context.js', 'tracing-provider.js'
		]) {
			expect(existsSync(path.join(out, rel)), `${rel} missing from build output`).toBe(true);
		}
	});

	it('bundles the configured tracing provider and arms it in the booted runtime', async () => {
		// The emitted provider is the BUNDLED user module behind its shape
		// validator, not the null stub.
		const provider = readFileSync(path.join(out, 'tracing-provider.js'), 'utf8');
		expect(provider).toContain('startSpan');
		expect(provider).not.toBe('export default null;\n');
		// A served request produces spans through the provider: the recording
		// fixture and this test share one process, so arming is observable.
		const before = (globalThis.__traceSpans ?? []).length;
		const res = await get('/api/echo');
		expect(res.status).toBe(200);
		const spans = globalThis.__traceSpans ?? [];
		expect(spans.length).toBeGreaterThan(before);
		expect(typeof spans[spans.length - 1].name).toBe('string');
	});

	it('leaves no placeholder unreplaced in the copied runtime', () => {
		const source = readFileSync(path.join(out, 'handler.js'), 'utf8');
		expect(source).not.toMatch(/from 'MANIFEST'|from 'SERVER'|from 'KIT_NODE'|from 'WS_HANDLER'/);
	});

	it('bundles every devDependency: only ws and node builtins stay bare', () => {
		const allowed = new Set(['ws', ...builtinModules]);
		/** @type {string[]} */
		const offenders = [];
		const record = (/** @type {string} */ file, /** @type {unknown} */ spec) => {
			if (typeof spec !== 'string') return;
			if (spec.startsWith('.') || spec.startsWith('node:') || allowed.has(spec)) return;
			offenders.push(`${path.relative(out, file)} -> ${spec}`);
		};
		const scan = (/** @type {string} */ dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const abs = path.join(dir, entry.name);
				if (entry.isDirectory()) { scan(abs); continue; }
				if (!entry.name.endsWith('.js')) continue;
				// A real parse, not a regex: the bundled kit primitives carry
				// JSDoc type imports that only look like module specifiers.
				const ast = parse(readFileSync(abs, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
				const walk = (/** @type {any} */ node) => {
					if (node === null || typeof node !== 'object') return;
					if (Array.isArray(node)) { for (const item of node) walk(item); return; }
					if (typeof node.type === 'string') {
						if (
							node.type === 'ImportDeclaration' ||
							node.type === 'ExportAllDeclaration' ||
							(node.type === 'ExportNamedDeclaration' && node.source)
						) record(abs, node.source?.value);
						if (node.type === 'ImportExpression' && node.source?.type === 'Literal') {
							record(abs, node.source.value);
						}
					}
					for (const key of Object.keys(node)) {
						if (key !== 'type' && key !== 'loc' && key !== 'range') walk(node[key]);
					}
				};
				walk(/** @type {any} */ (ast).body);
			}
		};
		scan(path.join(out, 'server'));
		// The runtime copy at the build root rides the same production rule.
		const runtimeSource = readFileSync(path.join(out, 'handler.js'), 'utf8');
		expect(runtimeSource).not.toContain("'@sveltejs/kit");
		expect(offenders, offenders.join('\n')).toEqual([]);
	});

	it('boots and serves SSR, prerendered, static, probes and a WebSocket welcome', async () => {
		const health = await get('/healthz');
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('OK');

		const ssr = await get('/some/route');
		expect(await ssr.text()).toBe('SSR:/some/route');

		const prerendered = await get('/about');
		expect(prerendered.status).toBe(200);
		expect(await prerendered.text()).toBe('<html>prerendered about</html>');

		const asset = await get('/app.css');
		expect(asset.status).toBe(200);
		expect(await asset.text()).toBe('body { margin: 0 }');

		const welcome = await new Promise((resolve, reject) => {
			// The same-origin policy compares against the pinned ORIGIN; a
			// non-browser client has to present it explicitly.
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://127.0.0.1' });
			ws.once('message', (raw) => { resolve(JSON.parse(raw.toString())); ws.close(); });
			ws.once('error', reject);
		});
		expect(/** @type {any} */ (welcome).type).toBe('welcome');
	});
});
