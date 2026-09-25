// A request body the app stops reading, on the BUILT runtime. The body stream
// is fed from node's request as the bytes arrive; when the app cancels it -
// `request.body.cancel()`, breaking out of `for await`, or cancelling its
// reader after a read - the bytes still on their way must be discarded, not
// pushed into a stream that is closed now. Pushing them throws inside the
// request's event listener, where nothing can catch it, and takes the process
// down. Both lanes that stream a body into the Request are driven: an SSR
// route and the authenticate hook.

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

// The three ways a consumer lets go of a body it has started on.
const LET_GO = `
async function letGo(mode, body) {
	if (mode === 'cancel') await body.cancel();
	else if (mode === 'break') { for await (const chunk of body) break; }
	else if (mode === 'read-cancel') { const reader = body.getReader(); await reader.read(); await reader.cancel(); }
	else if (mode === 'late-cancel') { await new Promise((r) => setTimeout(r, 20)); await body.cancel(); }
}
`;

const SERVER = `
${LET_GO}
export class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init() {}
	async respond(request) {
		const mode = new URL(request.url).searchParams.get('mode');
		if (mode) {
			await letGo(mode, request.body);
			return new Response('let go', { headers: { 'content-type': 'text/plain' } });
		}
		return new Response('alive', { headers: { 'content-type': 'text/plain' } });
	}
}
`;

const WS_HANDLER = `
${LET_GO}
export function message() {}
export async function authenticate({ request, headers }) {
	await letGo(headers['x-mode'], request.body);
	return {};
}
`;

/**
 * One request; resolves with the status line once a complete response has
 * arrived, or with what arrived when the server hangs up.
 *
 * @param {number} port
 * @param {string} head request line and headers, no terminator
 * @param {string} body
 * @param {number} [splitAfter] write the body in two parts, this many ms apart
 */
function exchange(port, head, body, splitAfter) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			const wire = head + `\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
			if (splitAfter === undefined) {
				socket.write(wire + body);
			} else {
				socket.write(wire + body.slice(0, 1));
				setTimeout(() => socket.write(body.slice(1)), splitAfter);
			}
		});
		let raw = '';
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer within 5 s')); }, 5000);
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('close', () => { clearTimeout(timer); resolve(raw.split('\r\n')[0]); });
		socket.on('error', () => {});
	});
}

/** @type {any} */ let built;

// The throw this file is about lands in an event listener, which in a real
// process is an exit. vitest traps it instead, so each case also asserts that
// nothing escaped while it ran.
/** @type {unknown[]} */
const escaped = [];
/** @param {unknown} err */
const onEscaped = (err) => { escaped.push(err); };

beforeAll(async () => {
	process.on('uncaughtException', onEscaped);
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		serverSource: SERVER,
		wsHandlerSource: WS_HANDLER
	});
	built = { payload, rt: await bootRuntime(payload) };
}, 60000);

afterAll(async () => {
	process.off('uncaughtException', onEscaped);
	await built?.rt.close();
	built?.payload.cleanup();
});

describe('a body the app lets go of is discarded, and the server stays up', () => {
	for (const mode of ['cancel', 'break', 'read-cancel']) {
		for (const size of [10, 60000]) {
			for (const split of [undefined, 100]) {
				const shape = `${mode}, ${size} bytes${split === undefined ? '' : ', split'}`;

				it(`on an SSR route (${shape})`, async () => {
					const status = await exchange(built.rt.port, `POST /?mode=${mode} HTTP/1.1`, 'x'.repeat(size), split);
					expect(status).toContain('200');
					expect(await exchange(built.rt.port, 'POST /alive HTTP/1.1', '')).toContain('200');
					expect(escaped.splice(0), 'nothing escaped the request listener').toEqual([]);
				});

				it(`on the authenticate hook (${shape})`, async () => {
					const status = await exchange(
						built.rt.port,
						`POST /__ws/auth HTTP/1.1\r\nx-requested-with: XMLHttpRequest\r\nx-mode: ${mode}`,
						'x'.repeat(size),
						split
					);
					expect(status).toContain('204');
					expect(await exchange(built.rt.port, 'POST /alive HTTP/1.1', '')).toContain('200');
					expect(escaped.splice(0), 'nothing escaped the request listener').toEqual([]);
				});
			}
		}
	}
});

/**
 * A request with a body and a pipelined follower on ONE keep-alive connection;
 * resolves with both status lines, or rejects when the follower is never
 * answered. The follower is what shows that the rest of a let-go body was
 * drained off the socket rather than left in front of the next request.
 *
 * @param {number} port
 * @param {string} head request line and headers, no terminator
 * @param {string} body
 * @param {{ chunked?: boolean }} [opts] send the body undeclared, as one chunk
 */
function withFollower(port, head, body, { chunked = false } = {}) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			const framed = chunked
				? 'Transfer-Encoding: chunked\r\n\r\n' + body.length.toString(16) + '\r\n' + body + '\r\n0\r\n\r\n'
				: `Content-Length: ${body.length}\r\n\r\n` + body;
			socket.write(
				head + `\r\nHost: 127.0.0.1:${port}\r\n` + framed +
				`POST /alive HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
			);
		});
		let raw = '';
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('the follower was not answered within 5 s: ' + JSON.stringify(raw.slice(0, 120)))); }, 5000);
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('close', () => { clearTimeout(timer); resolve([...raw.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1])); });
		socket.on('error', () => {});
	});
}

describe('a body let go of after an await is drained, and the connection reaches its next request', () => {
	const big = 'y'.repeat(200000);

	it('on an SSR route', async () => {
		expect(await withFollower(built.rt.port, 'POST /?mode=late-cancel HTTP/1.1', big)).toEqual(['200', '200']);
		expect(escaped.splice(0), 'nothing escaped the request listener').toEqual([]);
	});

	it('on the authenticate hook', async () => {
		expect(await withFollower(
			built.rt.port,
			'POST /__ws/auth HTTP/1.1\r\nx-requested-with: XMLHttpRequest\r\nx-mode: late-cancel',
			big,
			// Undeclared: a declared length past the cap is refused before any read.
			{ chunked: true }
		)).toEqual(['204', '200']);
		expect(escaped.splice(0), 'nothing escaped the request listener').toEqual([]);
	});
});
