import net from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({ files: { 'client/logo.txt': 'plain' } });
	rt = await bootRuntime(payload);
});


/**
 * Send a raw HTTP/1.1 exchange and return the full response text. Needed for
 * requests fetch() refuses to construct (duplicate singleton headers, TRACE).
 *
 * @param {number} port
 * @param {string} raw
 * @returns {Promise<string>}
 */
function rawRequest(port, raw) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
		let data = '';
		socket.on('data', (chunk) => { data += chunk.toString(); });
		socket.on('end', () => resolve(data));
		socket.on('error', reject);
		socket.setTimeout(5000, () => {
			socket.destroy();
			resolve(data);
		});
	});
}

describe('probe routes', () => {
	it('answers liveness with 200 OK', async () => {
		const res = await fetch(rt.origin + '/healthz');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	});

	it('reports readiness while ready', async () => {
		const res = await fetch(rt.origin + '/readyz');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ready');
	});

	// The probes are what a load balancer polls, and node answers chunked
	// whenever a writer leaves the length off. uWS derives one from the body
	// handed to end(), so leaving it off frames the same answer differently
	// from the rest of the family.
	//
	// GET only, deliberately: the probe routes are registered for GET alone,
	// here and in the family, so a HEAD falls through to the static and SSR
	// lanes and is not this writer's answer to frame.
	//
	// Raw sockets rather than fetch: undici does not surface the framing
	// headers reliably, and the framing is the whole subject.
	it('length-frames both probes rather than answering chunked', async () => {
		for (const [path, body] of [['/healthz', 'OK'], ['/readyz', 'ready']]) {
			const raw = await rawRequest(
				rt.port,
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
			);
			const head = raw.slice(0, raw.indexOf('\r\n\r\n')).toLowerCase();
			expect(head, `${path} answered chunked`).not.toContain('transfer-encoding: chunked');
			// A WHOLE header line: `content-length: 20` contains
			// `content-length: 2`, so a substring match would accept a declared
			// length that is a numeric extension of the true one.
			expect(head.split('\r\n'), `${path} declared no length, or the wrong one`)
				.toContain(`content-length: ${Buffer.byteLength(body)}`);
		}
	});
});

describe('edge policy', () => {
	it('refuses a duplicated Host header with 400', async () => {
		const response = await rawRequest(
			rt.port,
			'GET /api/echo HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\nConnection: close\r\n\r\n'
		);
		expect(response).toMatch(/^HTTP\/1\.1 400 /);
	});

	it('refuses TRACE with 405 and an Allow header', async () => {
		const response = await rawRequest(
			rt.port,
			'TRACE /api/echo HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n'
		);
		expect(response).toMatch(/^HTTP\/1\.1 405 /);
		expect(response.toLowerCase()).toContain('allow: get, head, post, put, patch, delete, options');
	});

	it.runIf(process.platform === 'win32')('refuses ADS and 8.3 spellings on win32', async () => {
		const ads = await rawRequest(
			rt.port,
			'GET /logo.txt::$DATA HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n'
		);
		expect(ads).toMatch(/^HTTP\/1\.1 400 /);
	});

	it('comma-joins repeated list headers in arrival order for the app', async () => {
		const response = await rawRequest(
			rt.port,
			'GET /api/echo HTTP/1.1\r\nHost: a.test\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Proto: http\r\nConnection: close\r\n\r\n'
		);
		// x-forwarded-proto sits in the last-line-wins proxy class: the app
		// must see exactly the last line, never a joined "https, http".
		expect(response).toContain('"xff":"http"');
	});
});

describe('graceful shutdown', () => {
	it('drains in-flight requests before completing', async () => {
		// Fresh runtime so shutting it down does not disturb sibling tests.
		const ownPayload = buildRuntime();
		const own = await bootRuntime(ownPayload);
		try {
			const slow = fetch(own.origin + '/api/slow');
			// Give the request a moment to be accepted before draining.
			await new Promise((r) => setTimeout(r, 50));
			const closed = own.handler.shutdown({ timeoutMs: 5000 });
			const res = await slow;
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('slow-done');
			await closed;
			expect(own.handler.lifecycleState()).toBe('closed');
			await expect(fetch(own.origin + '/healthz')).rejects.toThrow();
		} finally {
			ownPayload.cleanup();
		}
	});

	it('force-closes what outlives the shutdown budget and still resolves', async () => {
		const ownPayload = buildRuntime();
		const own = await bootRuntime(ownPayload);
		/** @type {string[]} */
		const errorLines = [];
		const originalError = console.error;
		console.error = (...args) => { errorLines.push(args.map(String).join(' ')); };
		try {
			// The fixture's slow route takes ~300ms; a 50ms budget must expire.
			const slow = fetch(own.origin + '/api/slow').catch((err) => err);
			await new Promise((r) => setTimeout(r, 30));
			await own.handler.shutdown({ timeoutMs: 50 });
			console.error = originalError;
			expect(own.handler.lifecycleState()).toBe('closed');
			// The dropped request is counted and reported through the catalog.
			const dropped = errorLines.filter((line) => line.includes('ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED'));
			expect(dropped.length).toBe(1);
			expect(dropped[0]).toContain('1 still open');
			// The truncated exchange surfaces as an error or an aborted body -
			// never a clean 200 with the full payload.
			const outcome = await slow;
			// By SHAPE, not by `instanceof Error`: each test file runs in its own
			// VM context, where an Error built in another realm is still an error
			// and still not an instance of this realm's constructor.
			if (typeof (/** @type {any} */ (outcome)?.text) === 'function') {
				await expect(/** @type {any} */ (outcome).text()).rejects.toThrow();
			} else {
				expect(String(/** @type {any} */ (outcome)?.cause ?? outcome)).toBeTruthy();
			}
		} finally {
			console.error = originalError;
			ownPayload.cleanup();
		}
	});

	it('bounds the whole teardown by ONE budget: a WS drain that eats it leaves the HTTP drain only the floor', async () => {
		// A socket that never acks the server's close frame pins the WS drain
		// at its full deadline, so under per-phase budgets the HTTP drain would
		// then spend the SAME budget again (~2x total). The sequence contract:
		// the HTTP drain gets only what the WS drain left.
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
		const SLOW_SERVER = `
export class Server {
	constructor(manifest) {}
	async init(opts) {}
	async respond(request) {
		const p = new URL(request.url).pathname;
		if (p === '/api/very-slow') {
			await new Promise((r) => setTimeout(r, 3000));
			return new Response('done', { headers: { 'content-type': 'text/plain' } });
		}
		return new Response('SSR:' + p, { headers: { 'content-type': 'text/html' } });
	}
}
`;
		const ownPayload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			serverSource: SLOW_SERVER,
			wsHandlerSource: 'export function message() {}\n'
		});
		const own = await bootRuntime(ownPayload);
		const holdout = new WebSocket(`ws://127.0.0.1:${own.port}/ws`);
		/** @type {string[]} */
		const errorLines = [];
		const originalError = console.error;
		try {
			await new Promise((resolve, reject) => {
				holdout.on('open', resolve);
				holdout.on('error', reject);
			});
			// Stop reading: the server's close frame is never acked, so the WS
			// drain holds until its deadline terminates the socket.
			holdout._socket.pause();
			const slow = fetch(own.origin + '/api/very-slow').catch((err) => err);
			await new Promise((r) => setTimeout(r, 50));

			console.error = (...args) => { errorLines.push(args.map(String).join(' ')); };
			const t0 = Date.now();
			await own.handler.shutdown({ timeoutMs: 900 });
			const elapsed = Date.now() - t0;
			console.error = originalError;

			expect(own.handler.lifecycleState()).toBe('closed');
			// The WS deadline was honored (the holdout was never going to ack)...
			expect(elapsed).toBeGreaterThanOrEqual(800);
			// ...and the HTTP drain got only the exhausted remainder, not a
			// fresh budget of its own: per-phase semantics would land at ~1800.
			expect(elapsed).toBeLessThan(1500);
			// The in-flight request was cut and counted, proving the HTTP drain
			// had live work it did NOT wait a second budget for.
			const dropped = errorLines.filter((line) => line.includes('ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED'));
			expect(dropped.length).toBe(1);
			const outcome = await slow;
			// A rejection is the ordinary outcome and a truncated Response the
			// other one. Tested by SHAPE, not by `instanceof Error`: each test
			// file runs in its own VM context, where an Error built in another
			// realm is still an error and still not an instance of this realm's
			// constructor.
			if (typeof (/** @type {any} */ (outcome)?.text) === 'function') {
				await expect(/** @type {any} */ (outcome).text()).rejects.toThrow();
			}
		} finally {
			console.error = originalError;
			try { holdout.terminate(); } catch { /* already gone */ }
			ownPayload.cleanup();
		}
	});

	it('treats repeated and premature shutdowns as safe', async () => {
		const ownPayload = buildRuntime();
		const own = await bootRuntime(ownPayload);
		try {
			await Promise.all([
				own.handler.shutdown({ timeoutMs: 1000 }),
				own.handler.shutdown({ timeoutMs: 1000 })
			]);
			expect(own.handler.lifecycleState()).toBe('closed');
			own.handler.beginDrain();
			expect(own.handler.lifecycleState()).toBe('closed');
		} finally {
			ownPayload.cleanup();
		}
	});

	it('reports draining on the readiness probe the moment drain begins', async () => {
		const ownPayload = buildRuntime();
		const own = await bootRuntime(ownPayload);
		try {
			own.handler.beginDrain();
			const res = await fetch(own.origin + '/readyz');
			expect(res.status).toBe(503);
			expect(await res.text()).toBe('draining');
			await own.handler.shutdown({ timeoutMs: 1000 });
		} finally {
			ownPayload.cleanup();
		}
	});
});

describe('proxy address resolution', () => {
	it('resolves the client from XFF when configured, gated on TRUSTED_PROXIES', async () => {
		// Untrusted peer first: loopback is NOT in the trusted set, so the
		// header claim must be ignored.
		process.env.SAW_P1_ADDRESS_HEADER = 'x-forwarded-for';
		process.env.SAW_P1_TRUSTED_PROXIES = '10.0.0.0/8';
		const untrustedPayload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('SAW_P1_') } });
		const untrusted = await bootRuntime(untrustedPayload);
		try {
			const res = await fetch(untrusted.origin + '/api/echo', {
				headers: { 'x-forwarded-for': '203.0.113.9' }
			});
			expect((await res.json()).clientAddress).toContain('127.0.0.1');
			await untrusted.handler.shutdown({ timeoutMs: 1000 });
		} finally {
			untrustedPayload.cleanup();
			delete process.env.SAW_P1_ADDRESS_HEADER;
			delete process.env.SAW_P1_TRUSTED_PROXIES;
		}

		// Trusted peer: loopback allowed, the claimed address resolves.
		process.env.SAW_P2_ADDRESS_HEADER = 'x-forwarded-for';
		process.env.SAW_P2_TRUSTED_PROXIES = '127.0.0.1';
		const trustedPayload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('SAW_P2_') } });
		const trusted = await bootRuntime(trustedPayload);
		try {
			const res = await fetch(trusted.origin + '/api/echo', {
				headers: { 'x-forwarded-for': '203.0.113.9' }
			});
			expect((await res.json()).clientAddress).toBe('203.0.113.9');
			await trusted.handler.shutdown({ timeoutMs: 1000 });
		} finally {
			trustedPayload.cleanup();
			delete process.env.SAW_P2_ADDRESS_HEADER;
			delete process.env.SAW_P2_TRUSTED_PROXIES;
		}
	});
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});
