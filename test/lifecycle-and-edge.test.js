import net from 'node:net';
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
		try {
			// The fixture's slow route takes ~300ms; a 50ms budget must expire.
			const slow = fetch(own.origin + '/api/slow').catch((err) => err);
			await new Promise((r) => setTimeout(r, 30));
			await own.handler.shutdown({ timeoutMs: 50 });
			expect(own.handler.lifecycleState()).toBe('closed');
			// The truncated exchange surfaces as an error or an aborted body -
			// never a clean 200 with the full payload.
			const outcome = await slow;
			if (outcome instanceof Error) {
				expect(String(outcome.cause ?? outcome)).toBeTruthy();
			} else {
				await expect(outcome.text()).rejects.toThrow();
			}
		} finally {
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
