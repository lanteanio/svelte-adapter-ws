// adapt() against a SvelteKit 3 shaped Builder: a flat config with no `kit`
// key, generateServerInstance instead of generateManifest (which Kit 3
// removed and throws from), and getAppPath. The emitted tree is then loaded
// by plain node in a child process, because Vitest's module runner
// serializes static dependency evaluation and would hide the ordering this
// file pins: the user's WebSocket handler, metrics and waiting-room renderer
// modules must evaluate only after SvelteKit's server.init() has resolved,
// even though init awaits.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import adapter from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Inside the repo tree so rollup and the runtime resolve @sveltejs/kit and ws
// by walking up; test/.tmp-adapt-* is gitignored.
const appDir = mkdtempSync(path.join(repoRoot, 'test', '.tmp-adapt-kit3-'));
const out = path.join(appDir, 'build');
const originalCwd = process.cwd();

// The stub server stands in for Kit's create_server(). Its init awaits a real
// timer before it marks itself initialized, so a module evaluated while
// _init.js is suspended at its top-level await sees the flag still unset.
const SERVER_SRC = `
class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init({ env }) {
		await new Promise((resolve) => setTimeout(resolve, 30));
		globalThis.__kit3InitEnv = env.KIT3_MODULE_TOKEN;
	}
	async respond(request) {
		return new Response('SSR:' + new URL(request.url).pathname + ':' + this.manifest.appPath, {
			headers: { 'content-type': 'text/html' }
		});
	}
}
export function create_server(manifest) { return new Server(manifest); }
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

/** @type {Array<{ dest: string, opts: any }>} */
const instanceCalls = [];

function makeKit3Builder() {
	const log = Object.assign(() => {}, { minor() {}, info() {}, success() {}, warn() {}, error() {} });
	return {
		log,
		rimraf: (/** @type {string} */ p) => rmSync(p, { recursive: true, force: true }),
		mkdirp: (/** @type {string} */ p) => mkdirSync(p, { recursive: true }),
		getBuildDirectory: (/** @type {string} */ name) => path.join(appDir, '.svelte-kit', name),
		config: {
			paths: { base: '' },
			env: { dir: appDir },
			files: { assets: path.join(appDir, 'static') },
			alias: {},
			version: { name: 'kit3' }
		},
		writeClient(/** @type {string} */ dest) {
			mkdirSync(path.join(dest, '_app', 'immutable'), { recursive: true });
			writeFileSync(path.join(dest, '_app', 'immutable', 'entry.js'), 'export const v = 1;');
			return [];
		},
		writePrerendered(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			return [];
		},
		writeServer(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'index.js'), SERVER_SRC);
			return [];
		},
		generateManifest() {
			throw new Error('builder.generateManifest() has been removed');
		},
		generateServerInstance(/** @type {string} */ dest, /** @type {any} */ opts) {
			instanceCalls.push({ dest, opts });
			writeFileSync(dest, [
				"import { create_server } from './index.js';",
				"const manifest = { appPath: '_app', mimeTypes: {}, assets: new Set([]) };",
				'export const server = create_server(manifest);'
			].join('\n'));
		},
		getAppPath: () => '_app',
		prerendered: { paths: [] },
		compress: async () => {},
		hasServerInstrumentationFile: () => false,
		copy(/** @type {string} */ from, /** @type {string} */ to, /** @type {{ replace: Record<string, string> }} */ opts) {
			copyTree(from, to, opts.replace);
		}
	};
}

/** @type {any} */
let report = null;

beforeAll(async () => {
	writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
		name: 'fake-kit3-app', private: true, type: 'module', dependencies: {}
	}));
	// Each user module records, at module scope, whether SvelteKit had already
	// initialized when it evaluated.
	writeFileSync(path.join(appDir, 'socket.js'), [
		'const seen = globalThis.__kit3InitEnv;',
		'globalThis.__kit3HandlerSaw = seen ?? null;',
		'export function open() {}',
		''
	].join('\n'));
	writeFileSync(path.join(appDir, 'metrics.js'), [
		'globalThis.__kit3MetricsSaw = globalThis.__kit3InitEnv ?? null;',
		'export default {',
		'	counter: () => ({ inc() {} }),',
		'	gauge: () => ({ set() {} }),',
		'	histogram: () => ({ observe() {} })',
		'};',
		''
	].join('\n'));
	writeFileSync(path.join(appDir, 'renderer.js'), [
		'globalThis.__kit3RendererSaw = globalThis.__kit3InitEnv ?? null;',
		"export default () => '<p>wait</p>';",
		''
	].join('\n'));
	process.chdir(appDir);
	try {
		const instance = adapter({
			out,
			websocket: {
				handler: './socket.js',
				metrics: './metrics.js',
				upgradeAdmission: { waitingRoom: { renderer: './renderer.js' } }
			}
		});
		await instance.adapt(makeKit3Builder());
	} finally {
		process.chdir(originalCwd);
	}

	const handlerUrl = pathToFileURL(path.join(out, 'handler.js')).href;
	const script = [
		`const handler = await import(${JSON.stringify(handlerUrl)});`,
		"await handler.start('127.0.0.1', 0);",
		'const port = handler.server.address().port;',
		"const res = await fetch('http://127.0.0.1:' + port + '/page');",
		'const body = await res.text();',
		'await handler.shutdown({ timeoutMs: 2000 });',
		"console.log('REPORT ' + JSON.stringify({ status: res.status, body, handlerSaw: globalThis.__kit3HandlerSaw, metricsSaw: globalThis.__kit3MetricsSaw, rendererSaw: globalThis.__kit3RendererSaw }));",
		'process.exit(0);'
	].join('\n');
	const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: appDir,
		encoding: 'utf8',
		windowsHide: true,
		timeout: 60000,
		env: { ...process.env, KIT3_MODULE_TOKEN: 'fixture-secret', ORIGIN: 'http://127.0.0.1', PORT: '0' }
	});
	const line = stdout.split('\n').find((l) => l.startsWith('REPORT '));
	report = line ? JSON.parse(line.slice('REPORT '.length)) : { stdout };
}, 120000);

afterAll(async () => {
	process.chdir(originalCwd);
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

describe('adapter build against a SvelteKit 3 builder', () => {
	it('builds the server from generateServerInstance and never calls generateManifest', () => {
		expect(instanceCalls).toHaveLength(1);
		const tmp = path.join(appDir, '.svelte-kit', 'adapter-ws');
		expect(path.resolve(instanceCalls[0].dest)).toBe(path.join(tmp, 'manifest.js'));
		expect(path.resolve(instanceCalls[0].opts.serverDirectory)).toBe(tmp);
		expect(existsSync(path.join(out, 'server', 'manifest.js'))).toBe(true);
	});

	it('serves SSR through the generated server instance', () => {
		expect(report.status, JSON.stringify(report)).toBe(200);
		expect(report.body).toBe('SSR:/page:_app');
	});

	it('evaluates the WebSocket handler module after SvelteKit initialization', () => {
		expect(report.handlerSaw, JSON.stringify(report)).toBe('fixture-secret');
	});

	it('evaluates the metrics module after SvelteKit initialization', () => {
		expect(report.metricsSaw, JSON.stringify(report)).toBe('fixture-secret');
	});

	it('evaluates the waiting-room renderer module after SvelteKit initialization', () => {
		expect(report.rendererSaw, JSON.stringify(report)).toBe('fixture-secret');
	});
});
