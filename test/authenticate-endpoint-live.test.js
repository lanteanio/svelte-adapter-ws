// The authenticate endpoint on the BUILT runtime, over raw sockets: what it
// answers when the request is refused before the hook runs, which URL the hook
// is handed, and when an oversized body is refused. The family's native tier
// answers all of these the same way; each case names the rule it pins.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

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

// `x-mode: url` answers with the URL the hook was handed; `x-mode: read` reads
// the whole body and answers with its length; anything else never touches
// the body and succeeds.
const WS_HANDLER = `
export function message() {}
export async function authenticate({ request, headers }) {
	if (headers['x-mode'] === 'url') {
		return new Response(request.url, { headers: { 'content-type': 'text/plain' } });
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
 * @param {{ host?: string, body?: string }} [opts]
 */
const post = (port, extra, { host = `127.0.0.1:${port}`, body = '' } = {}) => [
	'POST /__ws/auth HTTP/1.1',
	`Host: ${host}`,
	'x-requested-with: XMLHttpRequest',
	...extra,
	'', ''
].join('\r\n') + body;

/**
 * @param {Record<string, unknown>} wsOptions
 * @param {Record<string, string>} [env] set only while the payload's modules
 *   evaluate, which is when config.js reads it
 */
async function boot(wsOptions, env = {}) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: WS_HANDLER
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

/** @type {any} */ let plain;
/** @type {any} */ let limited;
/** @type {any} */ let proxied;
/** @type {any} */ let pinned;

beforeAll(async () => {
	plain = await boot({});
	limited = await boot({ authPathRateLimit: 1 });
	proxied = await boot({}, { PROTOCOL_HEADER: 'x-forwarded-proto' });
	pinned = await boot({}, { ORIGIN: 'https://app.example' });
}, 60000);

afterAll(async () => {
	for (const built of [plain, limited, proxied, pinned]) {
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
		expect(answer.status).toContain('413');
		expect(answer.body).toBe('Content Too Large');
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
});
