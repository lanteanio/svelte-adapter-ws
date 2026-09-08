// A request body with no Content-Type reaches the application on both lanes
// that build a Request: the SSR lane and the admin lane. The runtime reads
// every non-GET/HEAD body itself, so the bytes arrive whether or not the
// client named a media type; a reader that consulted Content-Type first
// handed the app a null body for exactly this request. Raw sockets, because
// fetch() and node's client add a Content-Type of their own for a body.

import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	adminPath: '/__realtime',
	adminAuthAcknowledged: true,
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

const WS_HANDLER = `
export function message() {}
export async function admin(request) {
	const body = await request.text();
	return new Response(JSON.stringify({ method: request.method, length: body.length, body }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}
`;

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

/**
 * One raw exchange: the request line, the headers given, a body, no
 * Content-Type unless the caller wrote one.
 * @param {string} target
 * @param {string} body
 * @param {string[]} [extraHeaders]
 */
function rawPost(target, body, extraHeaders = []) {
	return new Promise((resolve, reject) => {
		let buf = '';
		const sock = connect(rt.port, '127.0.0.1', () => {
			sock.write([
				`POST ${target} HTTP/1.1`,
				'Host: 127.0.0.1',
				`Content-Length: ${Buffer.byteLength(body)}`,
				...extraHeaders,
				'Connection: close',
				'',
				body
			].join('\r\n'));
		});
		sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout: ' + buf)); });
		sock.on('data', (d) => { buf += d.toString(); });
		sock.on('close', () => resolve(buf));
		sock.on('error', reject);
	});
}

const status = (raw) => raw.split('\r\n')[0];
/** The body of a raw exchange, de-chunked when the reply was chunk-framed. */
function bodyOf(raw) {
	const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
	let body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
	if (!/transfer-encoding:\s*chunked/i.test(head)) return body;
	let out = '';
	for (;;) {
		const lineEnd = body.indexOf('\r\n');
		const size = parseInt(body.slice(0, lineEnd), 16);
		if (!(size > 0)) break;
		out += body.slice(lineEnd + 2, lineEnd + 2 + size);
		body = body.slice(lineEnd + 2 + size + 2);
	}
	return out;
}

describe('a request body with no Content-Type', () => {
	it('reaches the SSR lane intact', async () => {
		const raw = await rawPost('/api/echo', 'hello');
		expect(status(raw)).toContain('200');
		const json = JSON.parse(bodyOf(raw));
		expect(json.method).toBe('POST');
		expect(json.body, 'the bytes the client sent must reach request.text()').toBe('hello');
	});

	it('reaches the admin lane intact', async () => {
		const raw = await rawPost('/__realtime/echo', 'admin-bytes');
		expect(status(raw)).toContain('200');
		const json = JSON.parse(bodyOf(raw));
		expect(json.method).toBe('POST');
		expect(json.length).toBe('admin-bytes'.length);
		expect(json.body).toBe('admin-bytes');
	});

	it('still reaches both lanes when a Content-Type is present, unchanged', async () => {
		const ssr = JSON.parse(bodyOf(await rawPost('/api/echo', 'typed', ['Content-Type: text/plain'])));
		expect(ssr.body).toBe('typed');
		const admin = JSON.parse(bodyOf(await rawPost('/__realtime/echo', 'typed-admin', ['Content-Type: text/plain'])));
		expect(admin.body).toBe('typed-admin');
	});
});
