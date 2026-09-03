// The reserved admin route on the BUILT runtime: the production module graph,
// booted over a real socket. Nothing here runs through the testing harness -
// the harness half of this lane is covered by test/admin-route.test.js, and
// this file is what proves the same behaviour survives the real request edge,
// the boot log lines included.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const BASE_WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false
};

// The app-authored admin handler. Everything it returns is written back
// verbatim; everything it throws becomes the adapter's generic 500.
const WS_HANDLER = `
export function message() {}
export async function admin(request) {
	const url = new URL(request.url);
	if (url.pathname.endsWith('/boom')) throw new Error('admin boom');
	if (url.pathname.endsWith('/empty')) return new Response(null, { status: 204 });
	if (request.method === 'POST') {
		const body = await request.text();
		return new Response(JSON.stringify({ echoed: body, method: request.method }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	return new Response(JSON.stringify({
		ok: true,
		url: request.url,
		xTest: request.headers.get('x-test') || null
	}), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}
`;

// A handler with no admin export: the prefix must stay unmounted, so those
// paths belong to the app like any other URL.
const WS_HANDLER_NO_ADMIN = `
export function message() {}
`;

/** @type {{ log: string[], warn: string[], error: string[] }} */
const captured = { log: [], warn: [], error: [] };
const original = { log: console.log, warn: console.warn, error: console.error };

function installConsoleCapture() {
	console.log = (...args) => { captured.log.push(args.join(' ')); };
	console.warn = (...args) => { captured.warn.push(args.join(' ')); };
	console.error = (...args) => { captured.error.push(args.join(' ')); };
}

function restoreConsole() {
	console.log = original.log;
	console.warn = original.warn;
	console.error = original.error;
}

function resetCapture() {
	captured.log.length = 0;
	captured.warn.length = 0;
	captured.error.length = 0;
}

/**
 * Boot one payload and hand back the console lines its module evaluation and
 * boot produced, so the mount log and the auth warning can be pinned.
 *
 * @param {Record<string, unknown>} wsOptions
 * @param {string} handlerSource
 */
async function bootWith(wsOptions, handlerSource) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: handlerSource
	});
	resetCapture();
	const rt = await bootRuntime(payload);
	return { payload, rt, boot: { log: [...captured.log], warn: [...captured.warn] } };
}

/**
 * One raw HTTP exchange, for the requests fetch() refuses to make (TRACE) and
 * the ones it would have to actually send a body for (an oversized declared
 * content-length).
 *
 * @param {number} port
 * @param {string} text
 * @returns {Promise<string>}
 */
function rawRequest(port, text) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		let out = '';
		socket.setTimeout(5000, () => {
			socket.destroy();
			reject(new Error('raw request timed out'));
		});
		socket.on('connect', () => socket.write(text));
		socket.on('data', (chunk) => { out += chunk.toString(); });
		socket.on('close', () => resolve(out));
		socket.on('error', (err) => reject(err));
	});
}

/** @type {any} */
let mounted;
/** @type {any} */
let relocated;
/** @type {any} */
let disabled;
/** @type {any} */
let unexported;

beforeAll(async () => {
	installConsoleCapture();
	try {
		mounted = await bootWith({ adminPath: '/__realtime', adminAuthAcknowledged: false }, WS_HANDLER);
		relocated = await bootWith({ adminPath: '/__ops', adminAuthAcknowledged: true }, WS_HANDLER);
		disabled = await bootWith({ adminPath: false, adminAuthAcknowledged: false }, WS_HANDLER);
		unexported = await bootWith({ adminPath: '/__realtime', adminAuthAcknowledged: false }, WS_HANDLER_NO_ADMIN);
	} catch (err) {
		restoreConsole();
		throw err;
	}
	restoreConsole();
}, 60000);

afterAll(async () => {
	restoreConsole();
	for (const built of [mounted, relocated, disabled, unexported]) {
		if (!built) continue;
		await built.rt.close();
		built.payload.cleanup();
	}
});

describe('the reserved admin route on the built runtime', () => {
	it('mounts the app handler under the default prefix and writes its Response back', async () => {
		const res = await fetch(`${mounted.rt.origin}/__realtime/introspect?handlers=true`, {
			headers: { 'x-test': 'hi' }
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.xTest).toBe('hi');
		const url = new URL(body.url);
		expect(url.pathname).toBe('/__realtime/introspect');
		expect(url.searchParams.get('handlers')).toBe('true');
		// no-store survives; nosniff is default-filled by the route writer.
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('claims the prefix and nothing that merely starts with its name', async () => {
		// The mount is `<prefix>/`, so the bare prefix and a longer name that
		// shares its start belong to the app, exactly as the wildcard route
		// they mirror behaves.
		const bare = await fetch(`${mounted.rt.origin}/__realtime`);
		expect(await bare.text()).toBe('SSR:/__realtime');
		const neighbour = await fetch(`${mounted.rt.origin}/__realtimezzz`);
		expect(await neighbour.text()).toBe('SSR:/__realtimezzz');
		// The trailing slash alone IS under the prefix.
		const root = await fetch(`${mounted.rt.origin}/__realtime/`);
		expect(root.status).toBe(200);
		expect((await root.json()).ok).toBe(true);
	});

	it('delivers a request body to the app handler', async () => {
		const res = await fetch(`${mounted.rt.origin}/__realtime/replay`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'queue=dead-letters'
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ echoed: 'queue=dead-letters', method: 'POST' });
	});

	it('writes back an empty reply without inventing a body', async () => {
		const res = await fetch(`${mounted.rt.origin}/__realtime/empty`);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe('');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		// 204 is defined to carry no body, so it must not carry a length either.
		expect(res.headers.get('content-length')).toBeNull();
	});

	it('answers with the length of the body it wrote, HEAD included', async () => {
		// The handler's own content-length is dropped and rewritten from the
		// buffered body. Omitting it would answer chunked where the family
		// answers with a length, and would leave a HEAD reply - whose body node
		// strips - reporting no size at all.
		const res = await fetch(`${mounted.rt.origin}/__realtime/introspect`);
		const body = await res.arrayBuffer();
		expect(res.headers.get('content-length')).toBe(String(body.byteLength));
		expect(res.headers.get('transfer-encoding')).toBeNull();

		const head = await fetch(`${mounted.rt.origin}/__realtime/introspect`, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		expect(Number(head.headers.get('content-length'))).toBe(body.byteLength);
	});

	it('logs the mount and warns that the adapter gates nothing', () => {
		expect(mounted.boot.log).toContain('[svelte-adapter-ws] Admin route registered at /__realtime/*');
		const warning = mounted.boot.warn.find((line) => line.includes('Admin route'));
		expect(warning).toBe(
			'[svelte-adapter-ws] Warning: Admin route /__realtime/* is mounted with NO adapter-level ' +
			'authentication. It is publicly reachable unless the app\'s admin() ' +
			'handler gates it (e.g. by validating a session cookie or bearer token). ' +
			'Set websocket.adminAuthAcknowledged: true once it is gated to silence this.'
		);
	});

	it('mounts at a relocated prefix, and adminAuthAcknowledged silences the warning', async () => {
		const custom = await fetch(`${relocated.rt.origin}/__ops/introspect`);
		expect(custom.status).toBe(200);
		expect((await custom.json()).ok).toBe(true);
		// The default prefix is the app's again once the route moved.
		const def = await fetch(`${relocated.rt.origin}/__realtime/introspect`);
		expect(await def.text()).toBe('SSR:/__realtime/introspect');

		expect(relocated.boot.log).toContain('[svelte-adapter-ws] Admin route registered at /__ops/*');
		expect(relocated.boot.warn.filter((line) => line.includes('Admin route'))).toEqual([]);
	});

	it('mounts nothing with adminPath false', async () => {
		const res = await fetch(`${disabled.rt.origin}/__realtime/introspect`);
		expect(await res.text()).toBe('SSR:/__realtime/introspect');
		expect(disabled.boot.log.filter((line) => line.includes('Admin route'))).toEqual([]);
		expect(disabled.boot.warn.filter((line) => line.includes('Admin route'))).toEqual([]);
	});

	it('mounts nothing when the handler exports no admin', async () => {
		const res = await fetch(`${unexported.rt.origin}/__realtime/introspect`);
		expect(await res.text()).toBe('SSR:/__realtime/introspect');
		expect(unexported.boot.log.filter((line) => line.includes('Admin route'))).toEqual([]);
		expect(unexported.boot.warn.filter((line) => line.includes('Admin route'))).toEqual([]);
	});

	it('refuses a fetch-forbidden method with 405 and an Allow header', async () => {
		const raw = await rawRequest(
			mounted.rt.port,
			`TRACE /__realtime/introspect HTTP/1.1\r\nHost: 127.0.0.1:${mounted.rt.port}\r\nConnection: close\r\n\r\n`
		);
		expect(raw.startsWith('HTTP/1.1 405')).toBe(true);
		expect(raw.toLowerCase()).toContain('allow: get, head, post, put, patch, delete, options');
		// The admin lane must not frame its own answers two ways: the refusals
		// it writes itself carry a length, so this one does too. Without it
		// node falls back to chunked, and a HEAD would carry no size at all.
		const head = raw.slice(0, raw.indexOf('\r\n\r\n')).toLowerCase();
		expect(head, '405 answered chunked').not.toContain('transfer-encoding: chunked');
		// A WHOLE header line, not a substring: `content-length: 180` contains
		// `content-length: 18`, so a substring match would accept a declared
		// length ten times the body and read as though it checked the number.
		expect(head.split('\r\n'), '405 declared the wrong length').toContain(
			`content-length: ${'Method Not Allowed'.length}`
		);
	});

	it('refuses a declared content-length over the body cap with 413', async () => {
		const raw = await rawRequest(
			mounted.rt.port,
			`POST /__realtime/replay HTTP/1.1\r\nHost: 127.0.0.1:${mounted.rt.port}\r\n` +
			'Content-Type: text/plain\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n'
		);
		expect(raw.startsWith('HTTP/1.1 413')).toBe(true);
		expect(raw).toContain('{"error":"payload too large"}');
	});

	it('answers 500 on a throwing handler, emits the operational event, and serves the next request', async () => {
		installConsoleCapture();
		let res;
		try {
			res = await fetch(`${mounted.rt.origin}/__realtime/boom`);
			// Give the emission its turn before the console is handed back.
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			restoreConsole();
		}
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal error' });
		const emitted = captured.error.find((line) => line.includes('event=admin.handler-failed'));
		expect(emitted, captured.error.join('\n')).toBeTruthy();
		expect(emitted).toContain('component=runtime.admin');
		expect(emitted).toContain('severity=error');

		// The failure is scoped to that one request: the route still answers.
		const after = await fetch(`${mounted.rt.origin}/__realtime/introspect`);
		expect(after.status).toBe(200);
		expect((await after.json()).ok).toBe(true);
	});
});
