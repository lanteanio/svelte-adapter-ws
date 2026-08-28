// Test-side mirror of the adapter's runtime emission: copy src/runtime into a
// temp payload dir applying the same placeholder replace map adapt() uses,
// and lay a fixture server/manifest/client tree beside it. Tests then import
// the REAL runtime files and drive them over real sockets - the same code
// path a production build executes, minus the SvelteKit build itself.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeDir = path.join(repoRoot, 'src', 'runtime');

/**
 * Replicates builder.copy's placeholder substitution: word-boundary global
 * replace of each key.
 *
 * @param {string} source
 * @param {Record<string, string>} replace
 * @returns {string}
 */
function substitute(source, replace) {
	let out = source;
	for (const [key, value] of Object.entries(replace)) {
		out = out.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
	}
	return out;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {Record<string, string>} replace
 */
function copyRuntime(from, to, replace) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) {
			copyRuntime(src, dst, replace);
		} else {
			writeFileSync(dst, substitute(readFileSync(src, 'utf8'), replace));
		}
	}
}

/**
 * The default fixture SvelteKit "server": routes crafted for the HTTP-half
 * integration suite. Lives inside the payload as server/index.js, exactly
 * where the build would put the bundled app.
 */
const FIXTURE_SERVER = `
export class Server {
	constructor(manifest) {
		this.manifest = manifest;
	}
	async init({ env, read }) {
		this.env = env;
		this.read = read;
	}
	async respond(request, { platform, getClientAddress }) {
		const url = new URL(request.url);
		const p = url.pathname;
		if (p === '/api/echo') {
			let body = null;
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				// Real SvelteKit maps a body-limit stream error to its status;
				// the fixture mirrors that mapping.
				try {
					body = await request.text();
				} catch (err) {
					return new Response(String(err && err.message || err), { status: (err && err.status) || 500 });
				}
			}
			return new Response(JSON.stringify({
				method: request.method,
				url: request.url,
				requestId: platform.requestId,
				isWarmup: platform.isWarmupRequest(request),
				clientAddress: getClientAddress(),
				xff: request.headers.get('x-forwarded-proto') || null,
				body
			}), { headers: { 'content-type': 'application/json' } });
		}
		if (p === '/api/big') {
			return new Response('<html>' + 'x'.repeat(8192) + '</html>', {
				headers: { 'content-type': 'text/html' }
			});
		}
		if (p === '/api/charset') {
			return new Response('<html>' + 'c'.repeat(4096) + '</html>', {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		if (p === '/api/chunked') {
			const enc = new TextEncoder();
			const stream = new ReadableStream({
				async start(controller) {
					for (let i = 0; i < 4; i++) {
						controller.enqueue(enc.encode('chunk-' + i + '-' + 'z'.repeat(2048)));
						await new Promise((r) => setTimeout(r, 5));
					}
					controller.close();
				}
			});
			return new Response(stream, { headers: { 'content-type': 'text/html' } });
		}
		if (p === '/api/vary-lang') {
			globalThis.__renders = (globalThis.__renders || 0) + 1;
			await new Promise((r) => setTimeout(r, 80));
			return new Response('<html>lang</html>', {
				headers: { 'content-type': 'text/html', vary: 'Accept-Language' }
			});
		}
		if (p === '/api/cookie-counted') {
			globalThis.__renders = (globalThis.__renders || 0) + 1;
			await new Promise((r) => setTimeout(r, 80));
			const headers = new Headers({ 'content-type': 'text/html' });
			headers.append('set-cookie', 'per=request; Path=/');
			return new Response('<html>cookie</html>', { headers });
		}
		if (p === '/api/tiny') {
			return new Response('ok', { headers: { 'content-type': 'text/html' } });
		}
		if (p === '/api/cookie') {
			const headers = new Headers({ 'content-type': 'text/html' });
			headers.append('set-cookie', 'a=1; Path=/');
			headers.append('set-cookie', 'b=2; Path=/');
			return new Response('<html>' + 'c'.repeat(4096) + '</html>', { headers });
		}
		if (p === '/api/slow') {
			await new Promise((r) => setTimeout(r, 300));
			return new Response('slow-done', { headers: { 'content-type': 'text/plain' } });
		}
		if (p === '/api/counted') {
			globalThis.__renders = (globalThis.__renders || 0) + 1;
			await new Promise((r) => setTimeout(r, 100));
			return new Response('<html>' + 'y'.repeat(2048) + '</html>', {
				headers: { 'content-type': 'text/html' }
			});
		}
		if (p === '/api/read') {
			const stream = this.read('hello.txt');
			return new Response(stream, { headers: { 'content-type': 'text/plain' } });
		}
		if (p === '/api/error') {
			throw new Error('boom');
		}
		if (p === '/api/sse') {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: 1\\n\\n'));
				}
			});
			return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
		}
		return new Response('SSR:' + p, {
			status: p === '/missing' ? 404 : 200,
			headers: { 'content-type': 'text/html' }
		});
	}
}
`;

/**
 * Build a runnable runtime payload in a temp dir.
 *
 * @param {{
 *   replace?: Partial<Record<string, string>>,
 *   serverSource?: string,
 *   manifestSource?: string,
 *   files?: Record<string, string | Buffer>,
 *   mtime?: Date
 * }} [options]
 * @returns {{ dir: string, importRuntime: () => Promise<any>, cleanup: () => void }}
 */
export function buildRuntime(options = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'saw-rt-'));

	// Defaults mirror adapt()'s production defaults so tests boot what a real
	// build boots; a test that needs a different value overrides per key.
	const replace = {
		MANIFEST: './server/manifest.js',
		SERVER: './server/index.js',
		KIT_NODE: './server/kit-node.js',
		ENV_PREFIX: JSON.stringify(''),
		PRECOMPRESS: JSON.stringify(true),
		HEALTH_CHECK_PATH: JSON.stringify('/healthz'),
		READINESS_CHECK_PATH: JSON.stringify('/readyz'),
		WARMUP_PATHS: JSON.stringify(['/']),
		STATIC_HEADERS: JSON.stringify(null),
		STATIC_CACHE_CONTROL: JSON.stringify(null),
		STATIC_DOTFILES: JSON.stringify(false),
		...options.replace
	};

	copyRuntime(runtimeDir, dir, /** @type {Record<string, string>} */ (replace));

	mkdirSync(path.join(dir, 'server'), { recursive: true });
	writeFileSync(path.join(dir, 'server', 'index.js'), options.serverSource ?? FIXTURE_SERVER);
	writeFileSync(
		path.join(dir, 'server', 'manifest.js'),
		options.manifestSource ??
			[
				"export const manifest = { appPath: '_app' };",
				"export const prerendered = new Set(['/about', '/docs']);",
				"export const base = '';"
			].join('\n')
	);
	// The public kit primitives resolve from this repo's own devDependency in
	// tests (resolved here, in repo context, because the temp payload has no
	// node_modules); the real build bundles them into the payload instead.
	const kitNodeUrl = import.meta.resolve('@sveltejs/kit/node');
	writeFileSync(
		path.join(dir, 'server', 'kit-node.js'),
		`export { getRequest, setResponse, createReadableStream } from ${JSON.stringify(kitNodeUrl)};\n`
	);

	for (const [rel, content] of Object.entries(options.files ?? {})) {
		const abs = path.join(dir, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, content);
		if (options.mtime) utimesSync(abs, options.mtime, options.mtime);
	}

	return {
		dir,
		importRuntime: () => import(pathToFileURL(path.join(dir, 'handler.js')).href),
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

/**
 * Boot a built payload's handler on an ephemeral loopback port.
 *
 * @param {{ dir: string, importRuntime: () => Promise<any> }} payload
 * @returns {Promise<{ handler: any, port: number, origin: string, close: () => Promise<void> }>}
 */
export async function bootRuntime(payload) {
	const handler = await payload.importRuntime();
	await handler.start('127.0.0.1', 0);
	const port = handler.server.address().port;
	return {
		handler,
		port,
		origin: `http://127.0.0.1:${port}`,
		close: () => handler.shutdown({ timeoutMs: 2000 })
	};
}
