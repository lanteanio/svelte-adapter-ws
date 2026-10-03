// How each HTTP lane frames what it writes, on the BUILT runtime over raw
// sockets. uWS derives a Content-Length from whatever `end()` is handed, while
// node frames a `writeHead()` that names no length as chunked; a fetch client
// reads either shape the same way, so only the wire shows which one went out.
//
// The oracle is pipelining, as in head-and-204-framing-real.test.js: a second
// request is written right behind the probe on the same connection, and its
// status line has to begin exactly where the probe's framing says the probe
// ends. A length that is off by a byte, or a chunked answer where a length was
// due, moves that boundary.

import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const BASE_WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: ['http://allowed.example'],
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 60,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false
};

// Every route answers with a shape whose framing is the writer's decision,
// never the Response's own Content-Length. `vary` keeps the request-dedup
// leader from buffering the streamed body into one chunk.
const SERVER = `
export class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init() {}
	async respond(request) {
		const p = new URL(request.url).pathname;
		const text = { 'content-type': 'text/plain' };
		if (p === '/empty-stream') {
			return new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: text });
		}
		if (p === '/misdeclared') {
			return new Response('twelve bytes', { headers: { ...text, 'content-length': '999' } });
		}
		if (p === '/streamed') {
			const enc = new TextEncoder();
			const body = new ReadableStream({
				async start(c) {
					c.enqueue(enc.encode('first|'));
					await new Promise((r) => setTimeout(r, 30));
					c.enqueue(enc.encode('second'));
					c.close();
				}
			});
			return new Response(body, { headers: { ...text, 'content-length': '12', vary: 'accept-language' } });
		}
		if (p === '/declared-bodyless') return new Response(null, { headers: { 'content-length': '12' } });
		if (p === '/declared-304') return new Response(null, { status: 304, headers: { 'content-length': '12' } });
		if (p === '/declared-204') return new Response(null, { status: 204, headers: { 'content-length': '0' } });
		if (p === '/refused-header') {
			return new Response('x', { headers: { 'x-bad': 'a' + String.fromCharCode(127) + 'b' } });
		}
		if (p === '/locked') {
			const consumed = new Response('consumed');
			await consumed.text();
			return consumed;
		}
		if (p === '/relayed-te') {
			// A Response relayed from fetch() keeps the upstream's framing header.
			return new Response('upstream body', { headers: { ...text, 'transfer-encoding': 'chunked' } });
		}
		if (p === '/string-chunk') {
			return new Response(new ReadableStream({ start(c) { c.enqueue('hello'); c.close(); } }), { headers: text });
		}
		if (p === '/buffer-chunk') {
			return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('bytes').buffer); c.close(); } }), { headers: text });
		}
		if (p === '/vary-merge') {
			return new Response('<html>' + 'v'.repeat(4096) + '</html>', { headers: { 'content-type': 'text/html', vary: 'Accept-Language' } });
		}
		if (p === '/head-cancel') {
			globalThis.__headCancelled = false;
			return new Response(new ReadableStream({
				pull(c) { c.enqueue(new TextEncoder().encode('never read')); },
				cancel() { globalThis.__headCancelled = true; }
			}), { headers: text });
		}
		if (p === '/head-cancel-state') return new Response(String(globalThis.__headCancelled), { headers: text });
		if (p === '/status-error') return Response.error();
		if (p === '/wide-header') {
			return new Response('x', { headers: { ...text, 'x-note': String.fromCharCode(99, 97, 102, 233) } });
		}
		if (p === '/bad-cookie') {
			return new Response('x', { headers: { ...text, 'set-cookie': 'a=' + String.fromCharCode(127) } });
		}
		if (p === '/string-big') {
			const page = '<html>' + 's'.repeat(4096) + '</html>';
			return new Response(new ReadableStream({ start(c) { c.enqueue(page); c.close(); } }), { headers: { 'content-type': 'text/html' } });
		}
		if (p === '/multibyte-chunk') {
			return new Response(new ReadableStream({ start(c) { c.enqueue('héllo €😀'); c.close(); } }), { headers: text });
		}
		if (p === '/view-chunk') {
			// A DataView and a wider typed array, each over an offset into a
			// larger buffer: only the bytes the view spans may go out.
			const bytes = new TextEncoder().encode('ABCDEFGHIJKL');
			return new Response(new ReadableStream({
				start(c) {
					c.enqueue(new DataView(bytes.buffer, 2, 4));
					c.enqueue(new Uint16Array(bytes.buffer, 6, 2));
					c.close();
				}
			}), { headers: text });
		}
		if (p === '/streamed-mixed') {
			// The chunks after the first reach the streaming path, each a
			// different shape of the same kind of content.
			const bytes = new TextEncoder().encode('xxd|yy');
			return new Response(new ReadableStream({
				async start(c) {
					c.enqueue(new TextEncoder().encode('a|'));
					await new Promise((r) => setTimeout(r, 30));
					c.enqueue('b€|');
					c.enqueue(new TextEncoder().encode('c|').buffer);
					c.enqueue(new DataView(bytes.buffer, 2, 2));
					c.close();
				}
			}), { headers: text });
		}
		if (p === '/string-stream-big') {
			// Past the dedup sharing cap in string chunks: the leader has to
			// count them to stop holding the body.
			const piece = 'x'.repeat(16 * 1024);
			let sent = 0;
			return new Response(new ReadableStream({
				pull(c) {
					if (sent === 40) { c.close(); return; }
					sent += 1;
					c.enqueue(piece);
				}
			}), { headers: text });
		}
		if (p === '/declared-past-cap') {
			// A first chunk and then nothing, ever: only the lane that trusts
			// the declared length can answer a HEAD for it.
			return new Response(new ReadableStream({
				start(c) { c.enqueue(new TextEncoder().encode('tiny body')); },
				pull() { return new Promise(() => {}); }
			}), { headers: { ...text, 'content-length': '700000' } });
		}
		if (p === '/trailer') return new Response('hello', { headers: { ...text, trailer: 'x-foo' } });
		if (p === '/trailer-204') return new Response(null, { status: 204, headers: { trailer: 'x-foo' } });
		if (p === '/trailer-stream') {
			const enc = new TextEncoder();
			return new Response(new ReadableStream({
				async start(c) {
					c.enqueue(enc.encode('one|'));
					await new Promise((r) => setTimeout(r, 30));
					c.enqueue(enc.encode('two'));
					c.close();
				}
			}), { headers: { ...text, trailer: 'x-foo' } });
		}
		if (p === '/refuse-mid') {
			// A chunk the writer refuses, after one it sent: the source is still
			// open, so the writer has to cancel it.
			const enc = new TextEncoder();
			return new Response(new ReadableStream({
				async start(c) {
					c.enqueue(enc.encode('part1|'));
					await new Promise((r) => setTimeout(r, 30));
					c.enqueue(42);
				},
				cancel() { globalThis.__fafRefuseCancelled = true; }
			}), { headers: text });
		}
		if (p === '/fail-mid') {
			const enc = new TextEncoder();
			return new Response(new ReadableStream({
				async start(c) {
					c.enqueue(enc.encode('part1|'));
					await new Promise((r) => setTimeout(r, 30));
					c.enqueue(enc.encode('part2|'));
					await new Promise((r) => setTimeout(r, 30));
					c.error(new Error('source failed'));
				}
			}), { headers: { ...text, 'content-length': '18' } });
		}
		if (p === '/one-string-past-cap') {
			const page = '<html>' + 'b'.repeat(600 * 1024) + '</html>';
			return new Response(new ReadableStream({ start(c) { c.enqueue(page); c.close(); } }), { headers: { 'content-type': 'text/html' } });
		}
		if (p === '/slow-string') {
			await new Promise((r) => setTimeout(r, 200));
			const page = '<html>' + 's'.repeat(4096) + '</html>';
			return new Response(new ReadableStream({ start(c) { c.enqueue(page); c.close(); } }), { headers: { 'content-type': 'text/html' } });
		}
		if (p === '/long-body') {
			// 2 MiB, well past the dedup sharing cap. Finite, so a writer that
			// reads it all instead of cancelling ends rather than hangs.
			globalThis.__longBodyCancelled = false;
			const piece = new Uint8Array(64 * 1024);
			let sent = 0;
			return new Response(new ReadableStream({
				pull(c) {
					if (sent === 32) { c.close(); return; }
					sent += 1;
					c.enqueue(piece);
				},
				cancel() { globalThis.__longBodyCancelled = true; }
			}), { headers: text });
		}
		if (p === '/long-body-state') return new Response(String(globalThis.__longBodyCancelled), { headers: text });
		if (p === '/slow-shared') {
			await new Promise((r) => setTimeout(r, 200));
			return new Response('shared body', { headers: text });
		}
		return new Response('ok', { headers: text });
	}
}
`;

const WS_HANDLER = `
export function message() {}
export function authenticate({ headers, cookies }) {
	const mode = headers['x-mode'];
	if (mode === 'wide-cookie-error') {
		// A wide cookie set, then a Response node cannot write a status for:
		// the 500 that answers it carries none of the hook's headers.
		cookies.set('caf' + String.fromCharCode(233), 'v', { path: '/' });
		return Response.error();
	}
	if (mode === 'wide-cookie') {
		// A cookie name past U+00FF, which goes out as its UTF-8 bytes.
		cookies.set(String.fromCharCode(256), 'v', { path: '/' });
		return undefined;
	}
	if (mode === 'deny') return false;
	if (mode === 'throw') throw new Error('authenticate boom');
	if (mode === 'body') {
		return new Response('auth body', { headers: { 'content-type': 'text/plain', 'content-length': '999' } });
	}
	if (mode === 'declared') return new Response(null, { headers: { 'content-length': '12' } });
	if (mode === 'declared-304') return new Response(null, { status: 304, headers: { 'content-length': '12' } });
	if (mode === 'bad-204') return new Response(null, { status: 204, headers: { 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
	if (mode === 'trailer') return new Response('auth trailer', { headers: { 'content-type': 'text/plain', trailer: 'x-foo' } });
	if (mode === 'relayed-te') {
		return new Response('auth relayed', { headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } });
	}
	return {};
}
export function admin(request) {
	const adminPath = new URL(request.url).pathname;
	if (adminPath === '/__realtime/date-bad') return new Response('x', { headers: { date: 'Thu, 01 Jan 2026 00:00:00 GMT', 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
	if (adminPath === '/__realtime/bad-204') return new Response(null, { status: 204, headers: { 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
	if (adminPath === '/__realtime/close-bad') {
		return new Response('x', { headers: { connection: 'close', 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
	}
	if (adminPath === '/__realtime/trailer') {
		return new Response('admin trailer', { headers: { 'content-type': 'text/plain', trailer: 'x-foo' } });
	}
	if (new URL(request.url).pathname === '/__realtime/bad-header') {
		return new Response('x', { headers: { 'x-bad': 'a' + String.fromCharCode(127) + 'b' } });
	}
	if (new URL(request.url).pathname === '/__realtime/relayed-te') {
		return new Response('admin relayed', { headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } });
	}
	if (adminPath === '/__realtime/empty') return new Response('', { headers: { 'content-type': 'text/plain' } });
	if (adminPath === '/__realtime/wide-header') {
		return new Response('x', { headers: { 'content-type': 'text/plain', 'x-note': String.fromCharCode(99, 97, 102, 233) } });
	}
	if (adminPath === '/__realtime/empty-declared') {
		return new Response('', { headers: { 'content-type': 'text/plain', 'content-length': '5' } });
	}
	return new Response('admin', { headers: { 'content-type': 'text/plain' } });
}
`;

/**
 * Write every request on one connection, back to back, and return the whole
 * byte stream the server answers with, read through EOF.
 *
 * @param {number} port
 * @param {string[][]} requests each request as its lines, request line first;
 *   `Host` and, on the last one, `Connection: close` are added here
 * @param {string} [body] written after the FIRST request's header block
 * @returns {Promise<string>} latin1, so byte positions are string positions
 */
function pipeline(port, requests, body = '') {
	const wire = requests.map((lines, i) => {
		const out = [lines[0], `Host: 127.0.0.1:${port}`, ...lines.slice(1)];
		if (i === requests.length - 1) out.push('Connection: close');
		return out.join('\r\n') + '\r\n\r\n' + (i === 0 ? body : '');
	}).join('');
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => { socket.write(wire); });
		let buffer = '';
		socket.on('data', (chunk) => { buffer += chunk.toString('latin1'); });
		socket.on('end', () => { clearTimeout(timer); resolve(buffer); });
		socket.on('error', reject);
		const timer = setTimeout(() => { socket.destroy(); resolve(buffer); }, 5000);
		timer.unref?.();
	});
}

/** @param {string} raw */
function splitFirst(raw) {
	const at = raw.indexOf('\r\n\r\n');
	expect(at, 'a complete header block; got: ' + JSON.stringify(raw.slice(0, 200))).toBeGreaterThan(0);
	const lines = raw.slice(0, at).split('\r\n');
	return { status: lines[0], lines: lines.slice(1), rest: raw.slice(at + 4) };
}

/**
 * @param {string[]} lines
 * @param {string} name
 */
const header = (lines, name) => lines
	.filter((line) => line.toLowerCase().startsWith(name + ':'))
	.map((line) => line.slice(name.length + 1).trim());

/**
 * One request on its own socket: what arrived, and how the socket ended.
 * @param {(onConnect: () => void) => import('node:net').Socket} open
 * @param {string[]} lines the request head
 * @returns {Promise<{ buffer: string, how: string }>}
 */
function exchange(open, lines) {
	return new Promise((resolve) => {
		const socket = open(() => { socket.write(lines.join('\r\n') + '\r\n\r\n'); });
		let buffer = '';
		let how = 'timeout';
		socket.on('data', (chunk) => { buffer += chunk.toString('latin1'); });
		socket.on('end', () => { if (how === 'timeout') how = 'end'; });
		socket.on('error', (err) => { how = 'error ' + /** @type {any} */ (err).code; });
		socket.on('close', () => { clearTimeout(timer); resolve({ buffer, how }); });
		const timer = setTimeout(() => { socket.destroy(); resolve({ buffer, how }); }, 5000);
	});
}

const FOLLOWER = 'the next response begins where the framing says this one ends; got: ';

/**
 * A length-framed answer: exactly one Content-Length, no Transfer-Encoding,
 * the body is that many bytes, and the pipelined follower starts right after.
 *
 * @param {string} raw
 * @param {{ status: string, body: string }} expected
 */
function expectLengthFramed(raw, { status, body }) {
	const first = splitFirst(raw);
	expect(first.status).toContain(status);
	expect(header(first.lines, 'transfer-encoding')).toEqual([]);
	// `raw` is latin1, one character per byte, so the body is cut by its byte
	// length and decoded back before it is compared.
	const bytes = Buffer.byteLength(body);
	expect(header(first.lines, 'content-length')).toEqual([String(bytes)]);
	expect(Buffer.from(first.rest.slice(0, bytes), 'latin1').toString('utf8')).toBe(body);
	const next = first.rest.slice(bytes);
	expect(next.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(next.slice(0, 40))).toBe(true);
	return first;
}

/**
 * The same framing check for a body the test cannot spell in advance: the
 * length the answer declares is read back, and the follower must begin exactly
 * that many bytes past the header terminator.
 *
 * @param {string} raw
 * @param {string} status
 * @returns {string} the body
 */
function readLengthFramed(raw, status) {
	const first = splitFirst(raw);
	expect(first.status).toContain(status);
	expect(header(first.lines, 'transfer-encoding')).toEqual([]);
	const lengths = header(first.lines, 'content-length');
	expect(lengths).toHaveLength(1);
	const length = Number(lengths[0]);
	const next = first.rest.slice(length);
	expect(next.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(next.slice(0, 40))).toBe(true);
	return first.rest.slice(0, length);
}

/**
 * A bodyless answer: the Content-Length named (or none), no Transfer-Encoding,
 * and the follower starts right at the header terminator.
 *
 * @param {string} raw
 * @param {{ status: string, length: number | null }} expected
 */
function expectBodyless(raw, { status, length }) {
	const first = splitFirst(raw);
	expect(first.status).toContain(status);
	expect(header(first.lines, 'transfer-encoding')).toEqual([]);
	expect(header(first.lines, 'content-length')).toEqual(length === null ? [] : [String(length)]);
	expect(first.rest.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(first.rest.slice(0, 40))).toBe(true);
	return first;
}

/**
 * A chunked answer: no Content-Length, the decoded body, and the follower
 * right after the terminating chunk. Decoded as bytes, so a multi-byte body
 * compares as the text it carries.
 *
 * @param {string} raw
 * @param {string} status
 * @returns {string} the decoded body
 */
function readChunked(raw, status) {
	const first = splitFirst(raw);
	expect(first.status).toContain(status);
	expect(header(first.lines, 'content-length')).toEqual([]);
	expect(header(first.lines, 'transfer-encoding')).toEqual(['chunked']);
	let at = 0;
	/** @type {Buffer[]} */
	const parts = [];
	for (;;) {
		const eol = first.rest.indexOf('\r\n', at);
		expect(eol, 'a chunk size line').toBeGreaterThan(-1);
		const size = parseInt(first.rest.slice(at, eol), 16);
		at = eol + 2;
		if (size === 0) { at += 2; break; }
		parts.push(Buffer.from(first.rest.slice(at, at + size), 'latin1'));
		at += size + 2;
	}
	const next = first.rest.slice(at);
	expect(next.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(next.slice(0, 40))).toBe(true);
	return Buffer.concat(parts).toString('utf8');
}

const OK = ['GET /ok HTTP/1.1'];
const AUTH = (...extra) => ['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest', 'Content-Length: 0', ...extra];

// A waiting-room renderer whose one header node refuses to write, and on a
// URL carrying `wide` one past U+00FF, which goes out as its UTF-8 bytes.
const BAD_RENDERER = `
export default function renderer(context) {
	if (String(context && context.request && context.request.url).includes('wide')) {
		return {
			body: '<!doctype html><html lang="en" dir="ltr"><head><title>Hold</title></head>' +
				'<body><main><h1>Hold</h1><p role="status" aria-live="polite">wait</p>' +
				'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
			lang: 'en',
			dir: 'ltr',
			headers: { 'x-note': [99, 97, 102, 233, 32, 9731].map((c) => String.fromCharCode(c)).join('') }
		};
	}
	if (String(context && context.request && context.request.url).includes('trailer')) {
		return {
			body: '<!doctype html><html lang="en" dir="ltr"><head><title>Hold</title></head>' +
				'<body><main><h1>Hold</h1><p role="status" aria-live="polite">wait</p>' +
				'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
			lang: 'en',
			dir: 'ltr',
			headers: { trailer: 'x-foo' }
		};
	}
	return {
		body: '<!doctype html><html lang="en" dir="ltr"><head><title>Hold</title></head>' +
			'<body><main><h1>Hold</h1><p role="status" aria-live="polite">wait</p>' +
			'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
		lang: 'en',
		dir: 'ltr',
		headers: { 'x-note': 'a' + String.fromCharCode(127) + 'b' }
	};
}
`;

/**
 * @param {Record<string, unknown>} wsOptions
 * @param {Record<string, unknown>} [extra] further build options
 */
async function boot(wsOptions, extra = {}) {
	const payload = buildRuntime({
		...extra,
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, ...wsOptions })
		},
		serverSource: SERVER,
		wsHandlerSource: WS_HANDLER
	});
	const rt = await bootRuntime(payload);
	return { payload, rt };
}

/** @type {any} */ let open;
/** @type {any} */ let limited;
/** @type {any} */ let siege;
/** @type {any} */ let waiting;

beforeAll(async () => {
	open = await boot({
		adminPath: '/__realtime',
		adminAuthAcknowledged: true,
		upgradeAdmission: { maxConcurrent: 10, waitingRoom: { admitCheckPath: '/__admit-check' } }
	});
	limited = await boot({ authPathRateLimit: 1 });
	waiting = await boot(
		{ upgradeAdmission: { maxConcurrent: 1, waitingRoom: { renderer: './renderer.js' } } },
		{ waitingRoomRendererSource: BAD_RENDERER }
	);
	siege = await boot({
		protection: 'siege',
		upgradeAdmission: { maxConcurrent: 10, waitingRoom: { admitCheckPath: '/__admit-check' } }
	});
}, 60000);

afterAll(async () => {
	for (const built of [open, limited, siege, waiting]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

describe('the SSR writer frames what it was handed, never what the Response declared', () => {
	it('writes a single-chunk body with its real length', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /misdeclared HTTP/1.1'], OK]), {
			status: '200',
			body: 'twelve bytes'
		});
	});

	it('writes an empty stream as a zero length', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /empty-stream HTTP/1.1'], OK]), {
			status: '200',
			body: ''
		});
	});

	it('streams a body that keeps coming as chunked, dropping its declared length', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /streamed HTTP/1.1'], OK]));
		expect(first.status).toContain('200');
		expect(header(first.lines, 'content-length')).toEqual([]);
		expect(header(first.lines, 'transfer-encoding')).toEqual(['chunked']);
		const end = first.rest.indexOf('0\r\n\r\n');
		expect(end).toBeGreaterThan(0);
		const decoded = first.rest.slice(0, end).split('\r\n').filter((_, i) => i % 2 === 1).join('');
		expect(decoded).toBe('first|second');
		const next = first.rest.slice(end + 5);
		expect(next.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(next.slice(0, 40))).toBe(true);
	});

	it('names zero for a bodyless GET that declared a length, and the declared length for its HEAD', async () => {
		expectBodyless(await pipeline(open.rt.port, [['GET /declared-bodyless HTTP/1.1'], OK]), {
			status: '200',
			length: 0
		});
		expectBodyless(await pipeline(open.rt.port, [['HEAD /declared-bodyless HTTP/1.1'], OK]), {
			status: '200',
			length: 12
		});
	});

	it('keeps a declared length on a 304 and drops one from a 204', async () => {
		expectBodyless(await pipeline(open.rt.port, [['GET /declared-304 HTTP/1.1'], OK]), {
			status: '304',
			length: 12
		});
		expectBodyless(await pipeline(open.rt.port, [['GET /declared-204 HTTP/1.1'], OK]), {
			status: '204',
			length: null
		});
	});

	it('length-frames the 500 for a header node refuses to write', async () => {
		const body = readLengthFramed(await pipeline(open.rt.port, [['GET /refused-header HTTP/1.1'], OK]), '500');
		expect(body).toContain('Invalid character in header content');
	});

	it('drops a Transfer-Encoding the Response carries, and frames the body by its length', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /relayed-te HTTP/1.1'], OK]), {
			status: '200',
			body: 'upstream body'
		});
		expect(header(first.lines, 'transfer-encoding')).toEqual([]);
	});

	it('writes a body enqueued as a string or an ArrayBuffer', async () => {
		// Credentialed, so the dedup leader leaves the stream to this writer.
		expectLengthFramed(await pipeline(open.rt.port, [['GET /string-chunk HTTP/1.1', 'Cookie: s=1'], OK]), {
			status: '200',
			body: 'hello'
		});
		expectLengthFramed(await pipeline(open.rt.port, [['GET /buffer-chunk HTTP/1.1', 'Cookie: s=1'], OK]), {
			status: '200',
			body: 'bytes'
		});
	});

	it('writes the bytes a view spans and a multi-byte string as UTF-8', async () => {
		// Two chunks at once, so the writer streams them.
		expect(readChunked(await pipeline(open.rt.port, [['GET /view-chunk HTTP/1.1', 'Cookie: s=1'], OK]), '200')).toBe('CDEFGHIJ');
		expectLengthFramed(await pipeline(open.rt.port, [['GET /multibyte-chunk HTTP/1.1', 'Cookie: s=1'], OK]), {
			status: '200',
			body: 'h\u00e9llo \u20ac\u{1F600}'
		});
	});

	it('takes a string, an ArrayBuffer and a view after the first chunk of a stream', async () => {
		const body = readChunked(await pipeline(open.rt.port, [['GET /streamed-mixed HTTP/1.1', 'Cookie: s=1'], OK]), '200');
		expect(body).toBe('a|b\u20ac|c|d|');
	});

	it('sends a whole body of one string chunk uncompressed, as the native tier does', async () => {
		// Uncredentialed and not a GET, so neither the BREACH rule nor the
		// dedup leader decides: only the chunk's own shape does.
		const first = splitFirst(await pipeline(open.rt.port, [
			['POST /string-big HTTP/1.1', 'Accept-Encoding: gzip', 'Content-Length: 0'],
			OK
		]));
		expect(first.status).toContain('200');
		expect(header(first.lines, 'content-encoding')).toEqual([]);
		expect(header(first.lines, 'content-length')).toEqual([String(4096 + '<html></html>'.length)]);
	});

	it('length-frames the 500 for a Set-Cookie value node refuses to write', async () => {
		// Credentialed, so the dedup leader leaves the Response to this writer.
		const body = readLengthFramed(await pipeline(open.rt.port, [['GET /bad-cookie HTTP/1.1', 'Cookie: s=1'], OK]), '500');
		expect(body).toContain('Invalid character in header content');
	});

	it('keeps a Trailer on an answer it streams chunked', async () => {
		const raw = await pipeline(open.rt.port, [['GET /trailer-stream HTTP/1.1', 'Cookie: s=1'], OK]);
		expect(header(splitFirst(raw).lines, 'trailer')).toEqual(['x-foo']);
		expect(readChunked(raw, '200')).toBe('one|two');
	});

	it('drops that Trailer for an HTTP/1.0 request, which node answers close-delimited', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /trailer-stream HTTP/1.0', 'Cookie: s=1']]));
		expect(first.status).toContain('200');
		expect(header(first.lines, 'trailer')).toEqual([]);
		expect(header(first.lines, 'transfer-encoding')).toEqual([]);
		expect(header(first.lines, 'content-length')).toEqual([]);
		expect(first.rest).toBe('one|two');
	});

	it('keeps it for an HTTP/1.0 request that accepts chunked', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /trailer-stream HTTP/1.0', 'Cookie: s=1', 'TE: chunked']]));
		expect(first.status).toContain('200');
		expect(header(first.lines, 'trailer')).toEqual(['x-foo']);
		expect(header(first.lines, 'transfer-encoding')).toEqual(['chunked']);
		expect(first.rest).toBe('4\r\none|\r\n3\r\ntwo\r\n0\r\n\r\n');
	});

	it('cuts a chunked body that failed mid-stream before its terminal chunk', async () => {
		const ask = (/** @type {string} */ version, /** @type {string[]} */ extra = []) => exchange(
			(onConnect) => net.connect(open.rt.port, '127.0.0.1', onConnect),
			[`GET /fail-mid HTTP/${version}`, 'Host: 127.0.0.1', 'Cookie: s=1', ...extra]
		);
		// To HTTP/1.1, or to HTTP/1.0 that asked for chunked, the cut leaves out
		// the terminal chunk, and the close is a plain one, so the client keeps
		// every byte sent before it.
		for (const [version, extra] of /** @type {Array<[string, string[]]>} */ ([['1.1', []], ['1.0', ['TE: chunked']]])) {
			const chunked = await ask(version, extra);
			expect(header(splitFirst(chunked.buffer).lines, 'transfer-encoding'), version).toEqual(['chunked']);
			expect(chunked.buffer, version).toContain('part1|');
			expect(chunked.buffer.endsWith('0\r\n\r\n'), version + ': no terminal chunk').toBe(false);
			expect(chunked.how, version).toBe('end');
		}
	});

	it('drops a Trailer the Response carries, which node refuses on a length-framed answer', async () => {
		for (const cookie of [[], ['Cookie: s=1']]) {
			const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /trailer HTTP/1.1', ...cookie], OK]), {
				status: '200',
				body: 'hello'
			});
			expect(header(first.lines, 'trailer')).toEqual([]);
		}
		const empty = expectBodyless(await pipeline(open.rt.port, [['GET /trailer-204 HTTP/1.1'], OK]), { status: '204', length: null });
		expect(header(empty.lines, 'trailer')).toEqual([]);
	});

	it('keeps the app Vary beside the Accept-Encoding it adds for a compressed body', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /vary-merge HTTP/1.1', 'Accept-Encoding: gzip'], OK]));
		expect(header(first.lines, 'content-encoding')).toEqual(['gzip']);
		const vary = header(first.lines, 'vary').join(', ').toLowerCase();
		expect(vary).toContain('accept-language');
		expect(vary).toContain('accept-encoding');
	});

	it('cancels the body of a HEAD it never reads', async () => {
		// Credentialed, so the dedup leader does not read it first.
		const head = splitFirst(await pipeline(open.rt.port, [['HEAD /head-cancel HTTP/1.1', 'Cookie: s=1'], OK]));
		expect(head.status).toContain('200');
		const state = await pipeline(open.rt.port, [['GET /head-cancel-state HTTP/1.1']]);
		expect(splitFirst(state).rest).toBe('true');
	});

	it('length-frames the 500 for a Response whose body was already read', async () => {
		// Credentialed, so the request-dedup leader, which reads the body
		// before this writer sees it, stays out of the way.
		expectLengthFramed(await pipeline(open.rt.port, [['GET /locked HTTP/1.1', 'Cookie: s=1'], OK]), {
			status: '500',
			body: 'Fatal error: Response body is locked. ' +
				"This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
		});
	});
});

describe('the authenticate endpoint length-frames every answer it writes', () => {
	it('on a refused hook', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: deny'), OK]), {
			status: '401',
			body: 'Unauthorized'
		});
	});

	it('on a throwing hook', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: throw'), OK]), {
			status: '500',
			body: 'Internal Server Error'
		});
		expect(header(first.lines, 'x-request-id')).toHaveLength(1);
	});

	it('on a request header that arrives twice', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [
			AUTH('Authorization: Bearer one', 'Authorization: Bearer two'),
			OK
		]), { status: '400', body: 'Bad Request' });
	});

	it('on a foreign origin', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [
			['POST /__ws/auth HTTP/1.1', 'Origin: http://foreign.example', 'Content-Length: 0'],
			OK
		]), { status: '403', body: 'Origin not allowed' });
	});

	it('on a rate-limited client', async () => {
		const admitted = splitFirst(await pipeline(limited.rt.port, [AUTH(), AUTH(), OK]));
		expect(admitted.status).toContain('204');
		expect(admitted.rest.startsWith('HTTP/1.1 429'), FOLLOWER + JSON.stringify(admitted.rest.slice(0, 40))).toBe(true);
		readLengthFramed(admitted.rest, '429');
	});

	it('on a body past the cap', async () => {
		const big = 'x'.repeat(64 * 1024 + 1);
		const first = splitFirst(await pipeline(open.rt.port, [
			['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest', `Content-Length: ${big.length}`]
		], big));
		expect(first.status).toBe('HTTP/1.1 413 Content Too Large');
		expect(header(first.lines, 'transfer-encoding')).toEqual([]);
		expect(header(first.lines, 'content-length')).toEqual([String('Content Too Large'.length)]);
		expect(first.rest.slice(0, 'Content Too Large'.length)).toBe('Content Too Large');
	});

	it('on a Response the hook returns, by the body it carries rather than the length it declares', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: body'), OK]), {
			status: '200',
			body: 'auth body'
		});
	});

	it('on a Response the hook relays with its own Transfer-Encoding, dropping that header', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: relayed-te'), OK]), {
			status: '200',
			body: 'auth relayed'
		});
	});

	it('on a relayed 204 with a header node refuses, with a 500 that carries its body', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: bad-204'), OK]), {
			status: '500',
			body: 'Internal Server Error'
		});
		expect(first.status).toBe('HTTP/1.1 500 Internal Server Error');
	});

	it('on a page whose Response carries a status node cannot write, with a length-framed 500', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /status-error HTTP/1.1', 'Cookie: s=1'], OK]));
		expect(first.status).toBe('HTTP/1.1 500 Internal Server Error');
		const length = Number(header(first.lines, 'content-length')[0]);
		expect(Number.isInteger(length) && length > 0).toBe(true);
		expect(first.rest.slice(length).startsWith('HTTP/1.1 200'), 'the follower is served').toBe(true);
	});

	it('on the 500 for a status node refuses, which carries nothing of the hook\'s', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: wide-cookie-error'), OK]), {
			status: '500',
			body: 'Internal Server Error'
		});
		expect(header(first.lines, 'set-cookie')).toEqual([]);
	});

	it('on a cookie past U+00FF beside the implicit 204, which goes out as its UTF-8 bytes', async () => {
		// The cookie API refuses every control character itself; a name past
		// U+00FF goes out as its UTF-8 bytes, and the implicit 204 stays
		// bodyless.
		const first = expectBodyless(await pipeline(open.rt.port, [AUTH('x-mode: wide-cookie'), OK]), { status: '204', length: null });
		const wire = Buffer.from(String.fromCharCode(256) + '=v', 'utf8').toString('latin1');
		expect(header(first.lines, 'set-cookie').some((c) => c.startsWith(wire))).toBe(true);
	});

	it('on a relayed Trailer, which it drops', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [AUTH('x-mode: trailer'), OK]), {
			status: '200',
			body: 'auth trailer'
		});
		expect(header(first.lines, 'trailer')).toEqual([]);
	});

	it('on a bodyless Response the hook returns, by the bodyless rule', async () => {
		expectBodyless(await pipeline(open.rt.port, [AUTH('x-mode: declared'), OK]), { status: '200', length: 0 });
		expectBodyless(await pipeline(open.rt.port, [AUTH('x-mode: declared-304'), OK]), { status: '304', length: 12 });
	});
});

describe('the admin lane frames what it writes', () => {
	it('answers a relayed 204 with a header node refuses with a 500 that carries its body', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/bad-204 HTTP/1.1'], OK]), {
			status: '500',
			body: '{"error":"internal error"}'
		});
	});

	it('keeps the connection for its follower when a refused header came with connection: close', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/close-bad HTTP/1.1'], OK]), {
			status: '500',
			body: '{"error":"internal error"}'
		});
	});

	it('keeps its Date on the 500 after a refused header', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/date-bad HTTP/1.1'], OK]), {
			status: '500',
			body: '{"error":"internal error"}'
		});
		expect(header(first.lines, 'date')).toHaveLength(1);
	});

	it('drops a relayed Trailer', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/trailer HTTP/1.1'], OK]), {
			status: '200',
			body: 'admin trailer'
		});
		expect(header(first.lines, 'trailer')).toEqual([]);
	});

	it('answers a header node refuses with its length-framed 500', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/bad-header HTTP/1.1'], OK]), {
			status: '500',
			body: '{"error":"internal error"}'
		});
		expect(first.status).toBe('HTTP/1.1 500 Internal Server Error');
	});

	it('drops a Transfer-Encoding the Response carries, and frames the body by its length', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/relayed-te HTTP/1.1'], OK]), {
			status: '200',
			body: 'admin relayed'
		});
	});

	it('answers an empty body by the bodyless rule: zero to a GET, the declared length or none to a HEAD', async () => {
		// An empty body is no body to frame, so a HEAD names what the handler
		// declared, as it does for a null body, rather than a length of zero.
		expectBodyless(await pipeline(open.rt.port, [['HEAD /__realtime/empty HTTP/1.1'], OK]), { status: '200', length: null });
		expectBodyless(await pipeline(open.rt.port, [['HEAD /__realtime/empty-declared HTTP/1.1'], OK]), { status: '200', length: 5 });
		expectBodyless(await pipeline(open.rt.port, [['GET /__realtime/empty HTTP/1.1'], OK]), { status: '200', length: 0 });
		expectBodyless(await pipeline(open.rt.port, [['GET /__realtime/empty-declared HTTP/1.1'], OK]), { status: '200', length: 0 });
	});
});

describe('the request-dedup leader reads a body the way the writer does', () => {
	// Uncredentialed GET and HEAD go through the leader, which buffers a
	// render it may share before the writer sees it.
	it('keeps an ArrayBuffer, a view and a multi-byte string intact', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /buffer-chunk HTTP/1.1'], OK]), { status: '200', body: 'bytes' });
		expectLengthFramed(await pipeline(open.rt.port, [['GET /view-chunk HTTP/1.1'], OK]), { status: '200', body: 'CDEFGHIJ' });
		expectLengthFramed(await pipeline(open.rt.port, [['GET /string-chunk HTTP/1.1'], OK]), { status: '200', body: 'hello' });
		expectLengthFramed(await pipeline(open.rt.port, [['GET /multibyte-chunk HTTP/1.1'], OK]), {
			status: '200',
			body: 'h\u00e9llo \u20ac\u{1F600}'
		});
	});

	it('counts string chunks toward its sharing cap and streams the rest', async () => {
		const body = readChunked(await pipeline(open.rt.port, [['GET /string-stream-big HTTP/1.1'], OK]), '200');
		expect(body.length).toBe(40 * 16 * 1024);
		expect(body.replaceAll('x', '')).toBe('');
	});

	it('answers a HEAD past a declared cap with the declared length, not the body it carries', async () => {
		expectBodyless(await pipeline(open.rt.port, [['HEAD /declared-past-cap HTTP/1.1'], OK]), {
			status: '200',
			length: 700000
		});
	});

	it('answers a HEAD whose body runs past the cap without reading on, and cancels it', async () => {
		expectBodyless(await pipeline(open.rt.port, [['HEAD /long-body HTTP/1.1'], OK]), { status: '200', length: null });
		const state = await pipeline(open.rt.port, [['GET /long-body-state HTTP/1.1', 'Cookie: s=1']]);
		expect(splitFirst(state).rest).toBe('true');
	});

	it('sends a whole body of one string chunk uncompressed, from the leader and to a waiter', async () => {
		const [leader, waiter] = await Promise.all([
			pipeline(open.rt.port, [['GET /slow-string HTTP/1.1', 'Accept-Encoding: gzip'], OK]),
			new Promise((r) => setTimeout(r, 50)).then(() => pipeline(open.rt.port, [['GET /slow-string HTTP/1.1', 'Accept-Encoding: gzip'], OK]))
		]);
		for (const raw of [leader, /** @type {string} */ (waiter)]) {
			const first = splitFirst(raw);
			expect(first.status).toContain('200');
			expect(header(first.lines, 'content-encoding')).toEqual([]);
			expect(header(first.lines, 'content-length')).toEqual([String(4096 + '<html></html>'.length)]);
		}
	});

	it('sends a one-string body past the sharing cap uncompressed too', async () => {
		const first = splitFirst(await pipeline(open.rt.port, [['GET /one-string-past-cap HTTP/1.1', 'Accept-Encoding: gzip'], OK]));
		expect(first.status).toContain('200');
		expect(header(first.lines, 'content-encoding')).toEqual([]);
		expect(header(first.lines, 'content-length')).toEqual([String(600 * 1024 + '<html></html>'.length)]);
	});

	it('answers a waiting HEAD by the HEAD rule too, not by the shared body', async () => {
		// Two at once: the second arrives while the first renders, and is
		// answered from the first one's buffer.
		const [leader, waiter] = await Promise.all([
			pipeline(open.rt.port, [['HEAD /slow-shared HTTP/1.1'], OK]),
			new Promise((r) => setTimeout(r, 50)).then(() => pipeline(open.rt.port, [['HEAD /slow-shared HTTP/1.1'], OK]))
		]);
		expectBodyless(leader, { status: '200', length: null });
		expectBodyless(/** @type {string} */ (waiter), { status: '200', length: null });
	});
});

describe('bodylessLength', () => {
	it('reports no length for a declared value that is not a length', async () => {
		const { bodylessLength } = await import('../src/runtime/handler/http-helpers.js');
		for (const declared of ['-5', 'abc']) {
			expect(bodylessLength(200, declared, true), declared).toBe(null);
			expect(bodylessLength(304, declared, false), declared).toBe(null);
		}
		expect(bodylessLength(304, '12', false)).toBe(12);
	});
});

describe('a header value past ASCII goes out as its UTF-8 bytes', () => {
	// As the native tier writes it: node takes one byte per character and refuses
	// one past U+00FF, so every lane that relays an app header hands node the
	// value's UTF-8 bytes, one character each - which is how a latin1 read of
	// the wire spells them.
	// A Response header is a ByteString, so it carries at most U+00FF - `é`,
	// which uWS writes as `c3 a9`; a renderer's plain headers can carry more.
	const WIDE = Buffer.from(String.fromCharCode(99, 97, 102, 233), 'utf8').toString('latin1');
	const WIDER = Buffer.from(String.fromCharCode(99, 97, 102, 233, 32, 9731), 'utf8').toString('latin1');

	it('on a page', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /wide-header HTTP/1.1', 'Cookie: s=1'], OK]), { status: '200', body: 'x' });
		expect(header(first.lines, 'x-note')).toEqual([WIDE]);
	});

	it('on the admin route', async () => {
		const first = expectLengthFramed(await pipeline(open.rt.port, [['GET /__realtime/wide-header HTTP/1.1'], OK]), { status: '200', body: 'x' });
		expect(header(first.lines, 'x-note')).toEqual([WIDE]);
	});

	it('on the runtime holding page', async () => {
		const raw = await pipeline(waiting.rt.port, [['GET /__waiting-room?wide HTTP/1.1', 'Accept: text/html'], OK]);
		readLengthFramed(raw, '200');
		expect(header(splitFirst(raw).lines, 'x-note')).toEqual([WIDER]);
	});

	it('on the test server\'s holding page', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: { message() {} },
			upgradeAdmission: {
				maxConcurrent: 1,
				waitingRoom: {
					renderer: () => ({
						body: '<!doctype html><html lang="en" dir="ltr"><head><title>Hold</title></head>' +
							'<body><main><h1>Hold</h1><p role="status" aria-live="polite">wait</p>' +
							'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
						lang: 'en',
						dir: 'ltr',
						headers: { 'x-note': String.fromCharCode(99, 97, 102, 233, 32, 9731) }
					})
				}
			}
		});
		try {
			const raw = await pipeline(mirror.port, [['GET /__waiting-room HTTP/1.1', 'Accept: text/html'], ['GET /healthz HTTP/1.1']]);
			readLengthFramed(raw, '200');
			expect(header(splitFirst(raw).lines, 'x-note')).toEqual([WIDER]);
		} finally {
			await mirror.close();
		}
	});

	it('on the test server\'s admin mirror', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin() {
					return new Response('x', { headers: { 'x-note': String.fromCharCode(99, 97, 102, 233) } });
				}
			}
		});
		try {
			const first = expectLengthFramed(await pipeline(mirror.port, [['GET /__realtime/x HTTP/1.1'], ['GET /healthz HTTP/1.1']]), { status: '200', body: 'x' });
			expect(header(first.lines, 'x-note')).toEqual([WIDE]);
		} finally {
			await mirror.close();
		}
	});
});

describe('a waiting-room renderer header node refuses', () => {
	it('is answered with the plain 500 on the runtime holding page', async () => {
		const first = expectLengthFramed(await pipeline(waiting.rt.port, [['GET /__waiting-room HTTP/1.1', 'Accept: text/html'], OK]), {
			status: '500',
			body: 'Internal Server Error'
		});
		expect(first.status).toBe('HTTP/1.1 500 Internal Server Error');
	});

	it('serves the runtime holding page without a Trailer its renderer set', async () => {
		const raw = await pipeline(waiting.rt.port, [['GET /__waiting-room?trailer HTTP/1.1', 'Accept: text/html'], OK]);
		const body = readLengthFramed(raw, '200');
		expect(header(splitFirst(raw).lines, 'trailer')).toEqual([]);
		expect(body).toContain('<h1>Hold</h1>');
	});

	it('is answered the same way by the test server, and nothing escapes it', async () => {
		/** @type {unknown[]} */
		const escaped = [];
		const onEscaped = (/** @type {unknown} */ err) => { escaped.push(err); };
		process.on('uncaughtException', onEscaped);
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: { message() {} },
			upgradeAdmission: {
				maxConcurrent: 1,
				waitingRoom: {
					renderer: (/** @type {any} */ context) => ({
						body: '<!doctype html><html lang="en" dir="ltr"><head><title>Hold</title></head>' +
							'<body><main><h1>Hold</h1><p role="status" aria-live="polite">wait</p>' +
							'<form method="get"><button type="submit">Retry</button></form></main></body></html>',
						lang: 'en',
						dir: 'ltr',
						headers: String(context && context.request && context.request.url).includes('trailer')
							? { trailer: 'x-foo' }
							: { 'x-note': 'a' + String.fromCharCode(127) + 'b' }
					})
				}
			}
		});
		try {
			expectLengthFramed(await pipeline(mirror.port, [['GET /__waiting-room HTTP/1.1', 'Accept: text/html'], ['GET /healthz HTTP/1.1']]), {
				status: '500',
				body: 'Internal Server Error'
			});
			const served = await pipeline(mirror.port, [['GET /__waiting-room?trailer HTTP/1.1', 'Accept: text/html'], ['GET /healthz HTTP/1.1']]);
			readLengthFramed(served, '200');
			expect(header(splitFirst(served).lines, 'trailer')).toEqual([]);
			expect(escaped, 'nothing escaped the request listener').toEqual([]);
		} finally {
			process.off('uncaughtException', onEscaped);
			await mirror.close();
		}
	});
});

describe("the 400 for a target node's parser refuses", () => {
	it('carries its body to a GET and its length alone to a HEAD', async () => {
		const ask = (/** @type {string} */ method) => exchange(
			(onConnect) => net.connect(open.rt.port, '127.0.0.1', onConnect),
			[`${method} /café HTTP/1.1`, 'Host: 127.0.0.1']
		);
		for (const [method, body] of [['GET', 'Bad Request'], ['HEAD', '']]) {
			const answer = await ask(method);
			const first = splitFirst(answer.buffer);
			expect(first.status, method).toBe('HTTP/1.1 400 Bad Request');
			expect(header(first.lines, 'content-length'), method).toEqual(['11']);
			expect(first.rest, method).toBe(body);
			expect(answer.how, method).toBe('end');
		}
	});
});

describe('the upgrade-capacity answers are length-framed', () => {
	it('on the admitting poll', async () => {
		expectLengthFramed(await pipeline(open.rt.port, [['GET /__admit-check HTTP/1.1'], OK]), {
			status: '200',
			body: '{"admit":true}'
		});
	});

	it('on the queueing poll and the bare refusal on the socket path', async () => {
		const body = readLengthFramed(await pipeline(siege.rt.port, [['GET /__admit-check HTTP/1.1'], OK]), '202');
		expect(JSON.parse(body).admit).toBe(false);

		expectLengthFramed(await pipeline(siege.rt.port, [['GET /ws HTTP/1.1', 'Accept: application/json'], OK]), {
			status: '503',
			body: 'Server is at upgrade capacity, please retry'
		});
	});
});

describe('createTestServer', () => {
	it('answers a refused header on a bodyless or HEAD admin answer with the 500', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin(request) {
					const p = new URL(request.url).pathname;
					if (p === '/__realtime/trailer') return new Response('t', { headers: { trailer: 'x-foo' } });
					if (p === '/__realtime/close-bad') return new Response('x', { headers: { connection: 'close', 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
					const status = p === '/__realtime/204' ? 204 : 200;
					return new Response(status === 204 ? null : 'x', { status, headers: { 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
				}
			}
		});
		try {
			for (const target of ['GET /__realtime/204 HTTP/1.1', 'HEAD /__realtime/x HTTP/1.1']) {
				const first = splitFirst(await pipeline(mirror.port, [[target], ['GET /healthz HTTP/1.1']]));
				expect(first.status, target).toBe('HTTP/1.1 500 Internal Server Error');
				const body = '{"error":"internal error"}';
				expect(header(first.lines, 'content-length'), target).toEqual([String(body.length)]);
				const bodyBytes = target.startsWith('HEAD') ? '' : body;
				expect(first.rest.slice(0, bodyBytes.length), target).toBe(bodyBytes);
				expect(first.rest.slice(bodyBytes.length).startsWith('HTTP/1.1 200'), target).toBe(true);
			}
			const trailer = expectLengthFramed(await pipeline(mirror.port, [['GET /__realtime/trailer HTTP/1.1'], ['GET /healthz HTTP/1.1']]), { status: '200', body: 't' });
			expect(header(trailer.lines, 'trailer')).toEqual([]);
			const closeBad = expectLengthFramed(await pipeline(mirror.port, [['GET /__realtime/close-bad HTTP/1.1'], ['GET /healthz HTTP/1.1']]), {
				status: '500',
				body: '{"error":"internal error"}'
			});
			expect(header(closeBad.lines, 'connection')).not.toContain('close');
		} finally {
			await mirror.close();
		}
	});

	it('drops a Trailer and keeps the connection on its bodyless admin answers too', async () => {
		const bad = 'a' + String.fromCharCode(1) + 'b';
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin(request) {
					const p = new URL(request.url).pathname;
					if (p === '/__realtime/trailer') return new Response('t', { headers: { trailer: 'x-foo' } });
					if (p === '/__realtime/trailer-204') return new Response(null, { status: 204, headers: { trailer: 'x-foo' } });
					if (p === '/__realtime/close-bad') return new Response('x', { headers: { connection: 'close', 'x-bad': bad } });
					return new Response(null, { status: 204, headers: { connection: 'close', 'x-bad': bad } });
				}
			}
		});
		try {
			// A HEAD declares the length of the body the handler returned.
			const head = expectBodyless(await pipeline(mirror.port, [['HEAD /__realtime/trailer HTTP/1.1'], ['GET /healthz HTTP/1.1']]), { status: '200', length: 1 });
			expect(header(head.lines, 'trailer')).toEqual([]);
			const empty = expectBodyless(await pipeline(mirror.port, [['GET /__realtime/trailer-204 HTTP/1.1'], ['GET /healthz HTTP/1.1']]), { status: '204', length: null });
			expect(header(empty.lines, 'trailer')).toEqual([]);
			const body = '{"error":"internal error"}';
			for (const target of ['HEAD /__realtime/close-bad HTTP/1.1', 'GET /__realtime/close-bad-204 HTTP/1.1']) {
				const first = splitFirst(await pipeline(mirror.port, [[target], ['GET /healthz HTTP/1.1']]));
				expect(first.status, target).toBe('HTTP/1.1 500 Internal Server Error');
				expect(header(first.lines, 'connection'), target).not.toContain('close');
				expect(header(first.lines, 'content-length'), target).toEqual([String(body.length)]);
				const bodyBytes = target.startsWith('HEAD') ? '' : body;
				expect(first.rest.slice(0, bodyBytes.length), target).toBe(bodyBytes);
				expect(first.rest.slice(bodyBytes.length).startsWith('HTTP/1.1 200'), target + ': the follower is served').toBe(true);
			}
		} finally {
			await mirror.close();
		}
	});

	it('answers an empty admin body by the bodyless rule, as the runtime does', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin(request) {
					const declared = new URL(request.url).pathname === '/__realtime/empty-declared';
					return new Response('', { headers: declared ? { 'content-length': '5' } : {} });
				}
			}
		});
		try {
			const follower = ['GET /healthz HTTP/1.1'];
			expectBodyless(await pipeline(mirror.port, [['HEAD /__realtime/empty HTTP/1.1'], follower]), { status: '200', length: null });
			expectBodyless(await pipeline(mirror.port, [['HEAD /__realtime/empty-declared HTTP/1.1'], follower]), { status: '200', length: 5 });
			expectBodyless(await pipeline(mirror.port, [['GET /__realtime/empty HTTP/1.1'], follower]), { status: '200', length: 0 });
			expectBodyless(await pipeline(mirror.port, [['GET /__realtime/empty-declared HTTP/1.1'], follower]), { status: '200', length: 0 });
		} finally {
			await mirror.close();
		}
	});

	it('answers a header node refuses in its admin mirror, as the runtime does', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin() {
					return new Response('x', { headers: { 'x-bad': 'a' + String.fromCharCode(127) + 'b' } });
				}
			}
		});
		try {
			const first = expectLengthFramed(await pipeline(mirror.port, [['GET /__realtime/x HTTP/1.1'], ['GET /healthz HTTP/1.1']]), {
				status: '500',
				body: '{"error":"internal error"}'
			});
			expect(first.status).toBe('HTTP/1.1 500 Internal Server Error');
		} finally {
			await mirror.close();
		}
	});

	it('drops a Transfer-Encoding its admin mirror is handed', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({
			handler: {
				message() {},
				admin() {
					return new Response('admin relayed', { headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } });
				}
			}
		});
		try {
			expectLengthFramed(await pipeline(mirror.port, [['GET /__realtime/x HTTP/1.1'], ['GET /healthz HTTP/1.1']]), {
				status: '200',
				body: 'admin relayed'
			});
		} finally {
			await mirror.close();
		}
	});

	it('length-frames its answer to a path it does not route', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const mirror = await createTestServer({ handler: { upgrade: () => ({}) } });
		try {
			expectLengthFramed(await pipeline(mirror.port, [['GET /nowhere HTTP/1.1'], ['GET /healthz HTTP/1.1']]), {
				status: '404',
				body: 'Not Found'
			});
		} finally {
			await mirror.close();
		}
	});
});

describe('a body that fails mid-stream over TLS', () => {
	// The same cut as over TCP: a chunked answer ends before its terminal chunk,
	// so the client can tell the body is short, and a close-delimited HTTP/1.0
	// answer is closed rather than left open with nothing more to send.
	const prefix = 'SAW_FAF_TLS_';
	const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
	/** @type {any} */ let secure;

	beforeAll(async () => {
		process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
		process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
		process.env[prefix + 'SSL_WATCH'] = '0';
		const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) }, serverSource: SERVER });
		secure = { payload, rt: await bootRuntime(payload) };
	}, 60000);

	afterAll(async () => {
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
		await secure?.rt.close();
		secure?.payload.cleanup();
	});

	it('cuts the chunked body before its terminal chunk, closes, cancels the source, and lets shutdown drain', async () => {
		for (const version of ['1.1', '1.0']) {
			for (const target of ['/fail-mid', '/refuse-mid']) {
				const label = `HTTP/${version} ${target}`;
				delete /** @type {any} */ (globalThis).__fafRefuseCancelled;
				const answer = await exchange(
					(onConnect) => tls.connect({ host: '127.0.0.1', port: secure.rt.port, rejectUnauthorized: false }, onConnect),
					[`GET ${target} HTTP/${version}`, 'Host: 127.0.0.1', 'Cookie: s=1']
				);
				const first = splitFirst(answer.buffer);
				expect(first.status, label).toBe('HTTP/1.1 200 OK');
				expect(header(first.lines, 'content-length'), label).toEqual([]);
				expect(first.rest, label).toContain('part1|');
				if (version === '1.1') {
					expect(header(first.lines, 'transfer-encoding'), label).toEqual(['chunked']);
					expect(answer.buffer.endsWith('0\r\n\r\n'), label + ': no terminal chunk').toBe(false);
				} else {
					expect(header(first.lines, 'transfer-encoding'), label).toEqual([]);
				}
				expect(answer.how, label + ' is closed, not left open').not.toBe('timeout');
				if (target === '/refuse-mid') {
					expect(/** @type {any} */ (globalThis).__fafRefuseCancelled, label + ': the refused source was cancelled').toBe(true);
				}
			}
		}
		expect(await secure.rt.handler.shutdown({ timeoutMs: 2000 }), 'nothing is left in flight').toBe(true);
	});
});
