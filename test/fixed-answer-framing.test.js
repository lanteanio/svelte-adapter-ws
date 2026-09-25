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
		return new Response('ok', { headers: text });
	}
}
`;

const WS_HANDLER = `
export function message() {}
export function authenticate({ headers }) {
	const mode = headers['x-mode'];
	if (mode === 'deny') return false;
	if (mode === 'throw') throw new Error('authenticate boom');
	if (mode === 'body') {
		return new Response('auth body', { headers: { 'content-type': 'text/plain', 'content-length': '999' } });
	}
	if (mode === 'declared') return new Response(null, { headers: { 'content-length': '12' } });
	if (mode === 'declared-304') return new Response(null, { status: 304, headers: { 'content-length': '12' } });
	return {};
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
	expect(header(first.lines, 'content-length')).toEqual([String(Buffer.byteLength(body))]);
	expect(first.rest.slice(0, body.length)).toBe(body);
	const next = first.rest.slice(body.length);
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

const OK = ['GET /ok HTTP/1.1'];
const AUTH = (...extra) => ['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest', 'Content-Length: 0', ...extra];

/** @param {Record<string, unknown>} wsOptions */
async function boot(wsOptions) {
	const payload = buildRuntime({
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

beforeAll(async () => {
	open = await boot({ upgradeAdmission: { maxConcurrent: 10, waitingRoom: { admitCheckPath: '/__admit-check' } } });
	limited = await boot({ authPathRateLimit: 1 });
	siege = await boot({
		protection: 'siege',
		upgradeAdmission: { maxConcurrent: 10, waitingRoom: { admitCheckPath: '/__admit-check' } }
	});
}, 60000);

afterAll(async () => {
	for (const built of [open, limited, siege]) {
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
		expect(first.status).toContain('413');
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

	it('on a bodyless Response the hook returns, by the bodyless rule', async () => {
		expectBodyless(await pipeline(open.rt.port, [AUTH('x-mode: declared'), OK]), { status: '200', length: 0 });
		expectBodyless(await pipeline(open.rt.port, [AUTH('x-mode: declared-304'), OK]), { status: '304', length: 12 });
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
