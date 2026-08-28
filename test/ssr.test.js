import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		files: { 'client/hello.txt': 'hello from read()' }
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

/** @param {string} path @param {RequestInit} [init] */
function req(path, init = {}) {
	return fetch(rt.origin + path, init);
}

describe('SSR dispatch', () => {
	it('routes through server.respond with platform and client address', async () => {
		const res = await req('/api/echo');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.method).toBe('GET');
		expect(body.clientAddress).toContain('127.0.0.1');
		expect(body.isWarmup).toBe(false);
		expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('honors a well-formed x-request-id and refuses a smuggled one', async () => {
		const honored = await req('/api/echo', { headers: { 'x-request-id': 'trace-me-42' } });
		expect((await honored.json()).requestId).toBe('trace-me-42');

		const refused = await req('/api/echo', { headers: { 'x-request-id': 'bad id with spaces' } });
		expect((await refused.json()).requestId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('streams request bodies to the app', async () => {
		const res = await req('/api/echo', { method: 'POST', body: 'ping-pong' });
		expect((await res.json()).body).toBe('ping-pong');
	});

	it('refuses a body over BODY_SIZE_LIMIT with 413', async () => {
		const big = 'x'.repeat(600 * 1024); // over the 512K default
		const res = await req('/api/echo', { method: 'POST', body: big });
		expect(res.status).toBe(413);
	});

	it('default-fills x-content-type-options on SSR responses', async () => {
		const res = await req('/api/tiny');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('serves platform read() streams through the client asset dir', async () => {
		const res = await req('/api/read');
		expect(await res.text()).toBe('hello from read()');
	});

	it('answers 500 with the request id when the app throws', async () => {
		const res = await req('/api/error', { headers: { 'x-request-id': 'boom-1' } });
		expect(res.status).toBe(500);
		expect(res.headers.get('x-request-id')).toBe('boom-1');
	});

	it('writes multiple set-cookie headers intact', async () => {
		const res = await req('/api/cookie');
		expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		await res.arrayBuffer();
	});
});

describe('dynamic compression', () => {
	it('compresses large compressible responses', async () => {
		const res = await req('/api/big', { headers: { 'accept-encoding': 'gzip' } });
		expect(res.headers.get('content-encoding')).toBe('gzip');
		expect(res.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
		// fetch() transparently decompresses; the coded body must round-trip,
		// and the declared length must be the compressed one (smaller).
		const text = await res.text();
		expect(text).toContain('<html>');
		expect(Number(res.headers.get('content-length'))).toBeLessThan(text.length);
	});

	it('leaves small responses uncompressed', async () => {
		const res = await req('/api/tiny', { headers: { 'accept-encoding': 'gzip' } });
		expect(res.headers.get('content-encoding')).toBeNull();
		await res.arrayBuffer();
	});

	it('never compresses credentialed responses (BREACH defense)', async () => {
		const res = await req('/api/big', {
			headers: { 'accept-encoding': 'gzip', cookie: 'session=abc' }
		});
		expect(res.headers.get('content-encoding')).toBeNull();
		await res.arrayBuffer();
	});

	it('streams SSE untouched', async () => {
		const res = await req('/api/sse', { headers: { 'accept-encoding': 'gzip' } });
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('content-encoding')).toBeNull();
		const reader = /** @type {ReadableStream} */ (res.body).getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain('data: 1');
		await reader.cancel();
	});
});

describe('SSR dedup', () => {
	it('coalesces concurrent anonymous GETs for the same URL into one render', async () => {
		const before = /** @type {any} */ (globalThis).__renders ?? 0;
		// The fixture render takes ~100ms, so ten concurrent requests overlap.
		const responses = await Promise.all(
			Array.from({ length: 10 }, () => req('/api/counted'))
		);
		const bodies = await Promise.all(responses.map((r) => r.text()));
		for (const [i, res] of responses.entries()) {
			expect(res.status).toBe(200);
			expect(bodies[i]).toBe(bodies[0]);
		}
		const after = /** @type {any} */ (globalThis).__renders ?? 0;
		expect(after - before).toBe(1);
	});

	it('does not coalesce credentialed requests', async () => {
		const before = /** @type {any} */ (globalThis).__renders ?? 0;
		await Promise.all([
			req('/api/counted', { headers: { cookie: 's=1' } }),
			req('/api/counted', { headers: { cookie: 's=2' } })
		]).then((rs) => Promise.all(rs.map((r) => r.arrayBuffer())));
		const after = /** @type {any} */ (globalThis).__renders ?? 0;
		expect(after - before).toBe(2);
	});
});
