// The authenticate endpoint on the BUILT runtime, over raw sockets: what it
// answers when the request is refused before the hook runs, which URL the hook
// is handed, and when an oversized body is refused. The family's native tier
// answers all of these the same way; each case names the rule it pins.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';

const WS_OPTS = {
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

// `x-mode: url` answers with the URL the hook was handed, `event-url` with the
// event's own `url`; `x-mode: read` reads the whole body and answers with its
// length; `throw` fails the hook, `bad-header` returns a header node refuses;
// anything else never touches the body and succeeds.
const WS_HANDLER = `
export function message() {}
export async function authenticate({ request, headers, url, cookies, platform, getClientAddress }) {
	if (headers['x-mode'] === 'cookies') {
		cookies.set('set_by', 'cookies', { path: '/' });
		return new Response('ok', { headers: { 'set-cookie': 'set_by=response; Path=/' } });
	}
	if (headers['x-mode'] === 'rid') return new Response(platform.requestId, { headers: { 'content-type': 'text/plain' } });
	if (headers['x-mode'] === 'addr') return new Response(getClientAddress(), { headers: { 'content-type': 'text/plain' } });
	if (headers['x-mode'] === 'url') {
		return new Response(request.url, { headers: { 'content-type': 'text/plain' } });
	}
	if (headers['x-mode'] === 'event-url') {
		return new Response(url, { headers: { 'content-type': 'text/plain' } });
	}
	if (headers['x-mode'] === 'throw') throw new Error('authenticate boom');
	if (headers['x-mode'] === 'bad-header') {
		return new Response('x', { headers: { 'x-bad': 'a' + String.fromCharCode(1) + 'b' } });
	}
	if (headers['x-mode'] === 'read') {
		const body = await request.text();
		return new Response(String(body.length), { headers: { 'content-type': 'text/plain' } });
	}
	return {};
}
`;

/**
 * Send raw bytes and resolve with the FIRST complete response: its status
 * line, header lines and Content-Length-framed body. Resolving on a complete
 * response rather than on EOF is what lets a case observe an answer the server
 * writes while the request body it declared is still unsent.
 *
 * @param {number} port
 * @param {string | Buffer} wire
 * @returns {Promise<{ status: string, lines: string[], body: string }>}
 */
function exchange(port, wire) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(wire));
		let buffer = '';
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('no complete response within 5 s; got ' + JSON.stringify(buffer.slice(0, 200))));
		}, 5000);
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			const at = buffer.indexOf('\r\n\r\n');
			if (at < 0) return;
			const lines = buffer.slice(0, at).split('\r\n');
			const length = lines
				.filter((line) => line.toLowerCase().startsWith('content-length:'))
				.map((line) => Number(line.slice(15).trim()))[0] ?? 0;
			if (buffer.length < at + 4 + length) return;
			clearTimeout(timer);
			socket.destroy();
			resolve({ status: lines[0], lines: lines.slice(1), body: buffer.slice(at + 4, at + 4 + length) });
		});
		socket.on('error', (err) => { clearTimeout(timer); reject(err); });
	});
}

/**
 * @param {number} port
 * @param {string[]} extra header lines
 * @param {{ host?: string, body?: string, target?: string, xhr?: boolean }} [opts]
 *   `xhr: false` leaves out the header that passes the origin check
 */
const post = (port, extra, { host = `127.0.0.1:${port}`, body = '', target = '/__ws/auth', xhr = true } = {}) => [
	`POST ${target} HTTP/1.1`,
	`Host: ${host}`,
	...(xhr ? ['x-requested-with: XMLHttpRequest'] : []),
	...extra,
	'', ''
].join('\r\n') + body;

/**
 * @param {Record<string, unknown>} wsOptions
 * @param {Record<string, string>} [env] set only while the payload's modules
 *   evaluate, which is when config.js reads it
 * @param {Record<string, string>} [files] written into the payload after its
 *   stubs, so one can replace the tracing provider
 */
async function boot(wsOptions, env = {}, files = undefined) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: WS_HANDLER,
		files
	});
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	try {
		return { payload, rt: await bootRuntime(payload) };
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

// A tracing provider that only records what it was asked to open. The payload
// evaluates it in this process, so the list is shared with the test.
const RECORDING_PROVIDER = `
const spans = globalThis.__authSpans ??= [];
export default {
	startSpan(name, options) {
		spans.push({ name, parent: options.parent, attributes: options.attributes });
		return { end() {} };
	}
};
`;

/** @returns {Array<{ name: string, parent: any, attributes: Record<string, unknown> }>} */
const authSpans = () => (/** @type {any} */ (globalThis).__authSpans ?? [])
	.filter((/** @type {any} */ s) => s.name === 'adapter.http.websocket-authenticate');

/** @type {any} */ let plain;
/** @type {any} */ let limited;
/** @type {any} */ let ordered;
/** @type {any} */ let hostless;
/** @type {any} */ let proxied;
/** @type {any} */ let pinned;
/** @type {any} */ let traced;
/** @type {any} */ let addressed;

beforeAll(async () => {
	plain = await boot({});
	limited = await boot({ authPathRateLimit: 1 });
	ordered = await boot({ authPathRateLimit: 1 });
	hostless = await boot({ authPathRateLimit: 1 });
	proxied = await boot({}, { PROTOCOL_HEADER: 'x-forwarded-proto' });
	pinned = await boot({}, { ORIGIN: 'https://app.example' });
	traced = await boot({}, {}, { 'tracing-provider.js': RECORDING_PROVIDER });
	addressed = await boot({}, { ADDRESS_HEADER: 'x-client-ip' });
}, 60000);

afterAll(async () => {
	for (const built of [plain, limited, ordered, hostless, proxied, pinned, traced, addressed]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

describe('the authenticate endpoint', () => {
	it('names the authentication door in its rate-limit refusal', async () => {
		const first = await exchange(limited.rt.port, post(limited.rt.port, ['Content-Length: 0']));
		expect(first.status).toContain('204');
		const second = await exchange(limited.rt.port, post(limited.rt.port, ['Content-Length: 0']));
		expect(second.status).toContain('429');
		expect(second.body).toBe('Too many authentication requests');
	});

	it('hands the hook a URL built on the configured protocol header', async () => {
		const port = proxied.rt.port;
		const forwarded = await exchange(port, post(port, ['x-mode: url', 'x-forwarded-proto: https', 'Content-Length: 0']));
		expect(forwarded.status).toContain('200');
		expect(forwarded.body).toBe(`https://127.0.0.1:${port}/__ws/auth`);

		const direct = await exchange(port, post(port, ['x-mode: url', 'Content-Length: 0']));
		expect(direct.body).toBe(`http://127.0.0.1:${port}/__ws/auth`);
	});

	it('hands the hook a URL built on a pinned ORIGIN, whatever the Host says', async () => {
		const port = pinned.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: url', 'Content-Length: 0'], { host: 'elsewhere.example' }));
		expect(answer.status).toContain('200');
		expect(answer.body).toBe('https://app.example/__ws/auth');
	});

	it('refuses a protocol header value no origin can be made of with 400', async () => {
		const port = proxied.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: url', 'x-forwarded-proto: ftp', 'Content-Length: 0']));
		expect(answer.status).toContain('400');
		expect(answer.body).toBe('Bad Request');
	});

	it('refuses a Host the URL parser cannot read with 400, not 500', async () => {
		const port = plain.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: url', 'Content-Length: 0'], { host: 'a b' }));
		expect(answer.status).toContain('400');
		expect(answer.body).toBe('Bad Request');
	});

	it('refuses a declared body past the cap before reading any of it', async () => {
		// The body is never sent: the answer has to come from the declared
		// length alone, which is the only way it can arrive at all here.
		const port = plain.rt.port;
		const answer = await exchange(port, post(port, [`Content-Length: ${64 * 1024 + 1}`]));
		expect(answer.status).toBe('HTTP/1.1 413 Content Too Large');
		expect(answer.body).toBe('Content Too Large');
	});

	it('refuses an unusable base origin before a declared body past the cap', async () => {
		const port = proxied.rt.port;
		const answer = await exchange(port, post(port, ['x-forwarded-proto: ftp', `Content-Length: ${64 * 1024 + 1}`]));
		expect(answer.status).toContain('400');
		expect(answer.body).toBe('Bad Request');
	});

	it('refuses a declared body past the cap before building the Request', async () => {
		// A Host that is an authority but one the URL parser refuses - a port
		// past 65535 - would be the Request-build 400; the declared length is
		// judged first.
		const port = plain.rt.port;
		const answer = await exchange(port, post(port, [`Content-Length: ${64 * 1024 + 1}`], { host: '127.0.0.1:99999' }));
		expect(answer.status).toContain('413');
		expect(answer.body).toBe('Content Too Large');
	});

	it('names the 500 for a relayed header node refuses, not the status it replaced', async () => {
		const port = plain.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: bad-header', 'Content-Length: 0']));
		expect(answer.status).toBe('HTTP/1.1 500 Internal Server Error');
		expect(answer.body).toBe('Internal Server Error');
	});

	it('reports a failing hook as runtime.authenticate.failed with the request id it answered', async () => {
		/** @type {any[]} */
		const events = [];
		const dispose = setOperationalEventSink((record) => { events.push(record); });
		try {
			const port = plain.rt.port;
			const answer = await exchange(port, post(port, ['x-mode: throw', 'Content-Length: 0']));
			expect(answer.status).toContain('500');
			const requestId = answer.lines
				.filter((line) => line.toLowerCase().startsWith('x-request-id:'))
				.map((line) => line.slice('x-request-id:'.length).trim());
			expect(requestId).toHaveLength(1);
			const failed = events.filter((r) => r.event === 'runtime.authenticate.failed');
			expect(failed).toHaveLength(1);
			expect(failed[0].attributes.requestId).toBe(requestId[0]);
		} finally {
			dispose();
		}
	});

	it('refuses an undeclared oversized body only when the hook reads past the cap', async () => {
		const port = plain.rt.port;
		const big = 'x'.repeat(64 * 1024 + 1);
		const chunked = big.length.toString(16) + '\r\n' + big + '\r\n0\r\n\r\n';

		const unread = await exchange(port, post(port, ['Transfer-Encoding: chunked', 'Connection: close'], { body: chunked }));
		expect(unread.status).toContain('204');

		const read = await exchange(port, post(port, ['x-mode: read', 'Transfer-Encoding: chunked', 'Connection: close'], { body: chunked }));
		expect(read.status).toContain('413');
		expect(read.body).toBe('Content Too Large');

		const small = 'y'.repeat(1000);
		const within = await exchange(port, post(port, ['x-mode: read', `Content-Length: ${small.length}`], { body: small }));
		expect(within.status).toContain('200');
		expect(within.body).toBe('1000');
	});

	it('reads a body of exactly the cap, declared or chunked', async () => {
		const port = plain.rt.port;
		const cap = 'z'.repeat(64 * 1024);
		const declared = await exchange(port, post(port, ['x-mode: read', `Content-Length: ${cap.length}`], { body: cap }));
		expect(declared.status).toContain('200');
		expect(declared.body).toBe(String(cap.length));

		const chunked = cap.length.toString(16) + '\r\n' + cap + '\r\n0\r\n\r\n';
		const streamed = await exchange(port, post(port, ['x-mode: read', 'Transfer-Encoding: chunked', 'Connection: close'], { body: chunked }));
		expect(streamed.status).toContain('200');
		expect(streamed.body).toBe(String(cap.length));
	});

	it('refuses the origin before counting, and counts before any other refusal', async () => {
		// The budget is one request. Refused origins must not spend it - the
		// CSRF check comes first so hostile cross-site traffic behind a shared
		// address cannot use up the real clients' allowance - and the 403 comes
		// ahead of the declared-length 413. Once the budget is spent, every
		// later refusal is the 429: the limiter sits ahead of the Request-build
		// 400 and the declared-length 413.
		const port = ordered.rt.port;
		const foreign = ['Origin: http://foreign.example', `Content-Length: ${64 * 1024 + 1}`];
		for (let i = 0; i < 2; i++) {
			const refused = await exchange(port, post(port, foreign, { xhr: false }));
			expect(refused.status).toContain('403');
		}
		expect((await exchange(port, post(port, ['Content-Length: 0']))).status).toContain('204');
		expect((await exchange(port, post(port, ['Content-Length: 0'], { host: 'a b' }))).status).toContain('429');
		expect((await exchange(port, post(port, [`Content-Length: ${64 * 1024 + 1}`]))).status).toContain('429');
	});

	it('counts a request before asking for its origin', async () => {
		// An HTTP/1.0 request with no Host is one get_origin cannot make an
		// origin of. The budget is one: the first is counted and then refused
		// 400, and every later one - a usable request included - is the 429.
		const port = hostless.rt.port;
		const bare = 'POST /__ws/auth HTTP/1.0\r\nx-requested-with: XMLHttpRequest\r\nContent-Length: 0\r\n\r\n';
		expect((await exchange(port, bare)).status).toContain('400');
		expect((await exchange(port, bare)).status).toContain('429');
		expect((await exchange(port, post(port, ['Content-Length: 0']))).status).toContain('429');
	});

	it('answers the method before anything else, and a repeated header before the origin', async () => {
		// The native tier registers the route for POST only, so any other
		// method is 405 whatever its headers say; a POST that repeats a header
		// is refused before its origin is judged.
		const port = plain.rt.port;
		const getLine = (lines) => ['GET /__ws/auth HTTP/1.1', `Host: 127.0.0.1:${port}`, ...lines, '', ''].join('\r\n');
		expect((await exchange(port, getLine(['Origin: http://foreign.example']))).status).toContain('405');
		expect((await exchange(port, getLine(['Origin: http://allowed.example', 'Origin: http://allowed.example']))).status).toContain('405');
		const repeated = await exchange(port, post(port, ['Origin: http://foreign.example', 'Origin: http://allowed.example', 'Content-Length: 0'], { xhr: false }));
		expect(repeated.status).toContain('400');
	});

	it('relays the Response Set-Cookie first and the cookies.set ones after it', async () => {
		const port = plain.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: cookies', 'Content-Length: 0']));
		expect(answer.status).toContain('200');
		const cookies = answer.lines.filter((line) => line.toLowerCase().startsWith('set-cookie:')).map((line) => line.slice(11).trim());
		expect(cookies.map((c) => c.split(';')[0])).toEqual(['set_by=response', 'set_by=cookies']);
	});

	it('hands the hook the request id the client sent', async () => {
		const port = plain.rt.port;
		const id = '6f1c2a4e-9b3d-4c5e-8f7a-1b2c3d4e5f60';
		const answer = await exchange(port, post(port, ['x-mode: rid', `x-request-id: ${id}`, 'Content-Length: 0']));
		expect(answer.body).toBe(id);
	});

	it('hands the hook the client address the configured header names', async () => {
		const port = addressed.rt.port;
		const answer = await exchange(port, post(port, ['x-mode: addr', 'x-client-ip: 203.0.113.7', 'Content-Length: 0']));
		expect(answer.body).toBe('203.0.113.7');
	});

	it('reports no failure for a hook that read past the cap', async () => {
		/** @type {any[]} */
		const events = [];
		const dispose = setOperationalEventSink((record) => { events.push(record); });
		try {
			const port = plain.rt.port;
			const big = 'x'.repeat(64 * 1024 + 1);
			const chunked = big.length.toString(16) + '\r\n' + big + '\r\n0\r\n\r\n';
			const read = await exchange(port, post(port, ['x-mode: read', 'Transfer-Encoding: chunked', 'Connection: close'], { body: chunked }));
			expect(read.status).toContain('413');
			expect(events.filter((r) => r.event === 'runtime.authenticate.failed')).toEqual([]);
		} finally {
			dispose();
		}
	});

	it('hands the hook no bare trailing question mark, and keeps a query', async () => {
		const port = plain.rt.port;
		const bare = await exchange(port, post(port, ['x-mode: url', 'Content-Length: 0'], { target: '/__ws/auth?' }));
		expect(bare.body).toBe(`http://127.0.0.1:${port}/__ws/auth`);
		const query = await exchange(port, post(port, ['x-mode: url', 'Content-Length: 0'], { target: '/__ws/auth?a=1' }));
		expect(query.body).toBe(`http://127.0.0.1:${port}/__ws/auth?a=1`);

		// The event's own `url` is the same path and query.
		const eventBare = await exchange(port, post(port, ['x-mode: event-url', 'Content-Length: 0'], { target: '/__ws/auth?' }));
		expect(eventBare.body).toBe('/__ws/auth');
		const eventQuery = await exchange(port, post(port, ['x-mode: event-url', 'Content-Length: 0'], { target: '/__ws/auth?a=1' }));
		expect(eventQuery.body).toBe('/__ws/auth?a=1');
	});

	it('opens its span when the hook runs, under the context the request carried', async () => {
		const port = traced.rt.port;
		const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
		const before = authSpans().length;

		const refused = await exchange(port, post(port, [`traceparent: ${traceparent}`, 'Origin: http://foreign.example', 'Content-Length: 0'], { xhr: false }));
		expect(refused.status).toContain('403');
		const oversized = await exchange(port, post(port, [`traceparent: ${traceparent}`, `Content-Length: ${64 * 1024 + 1}`]));
		expect(oversized.status).toContain('413');
		const unbuildable = await exchange(port, post(port, [`traceparent: ${traceparent}`, 'Content-Length: 0'], { host: 'a b' }));
		expect(unbuildable.status).toContain('400');
		expect(authSpans().length, 'a request refused before the hook opens no span').toBe(before);

		const admitted = await exchange(port, post(port, [`traceparent: ${traceparent}`, 'Content-Length: 0']));
		expect(admitted.status).toContain('204');
		const spans = authSpans().slice(before);
		expect(spans).toHaveLength(1);
		expect(spans[0].parent?.traceparent).toBe(traceparent);
		expect(spans[0].attributes['http.request.method']).toBe('POST');
		expect(spans[0].attributes['network.protocol.name']).toBe('http');
	});
});
