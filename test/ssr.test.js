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

	it('compresses the real-world parameterized content type, preferring brotli', async () => {
		const res = await req('/api/charset', { headers: { 'accept-encoding': 'br, gzip' } });
		expect(res.headers.get('content-encoding')).toBe('br');
		expect(await res.text()).toBe('<html>' + 'c'.repeat(4096) + '</html>');
	});

	it('streams a multi-chunk body uncompressed and complete', async () => {
		// POST so the exchange bypasses dedup (which buffers anonymous GETs
		// into single-chunk responses); the read-ahead must reassemble the
		// stream untouched instead of buffering it for compression.
		const res = await req('/api/chunked', { method: 'POST', headers: { 'accept-encoding': 'gzip' } });
		expect(res.headers.get('content-encoding')).toBeNull();
		const text = await res.text();
		for (let i = 0; i < 4; i++) {
			expect(text).toContain('chunk-' + i + '-');
		}
		expect(text.length).toBe(4 * ('chunk-0-'.length + 2048));
	});

	it('compresses the single chunk a dedup-buffered chunked GET collapses to', async () => {
		const res = await req('/api/chunked', { headers: { 'accept-encoding': 'gzip' } });
		expect(res.headers.get('content-encoding')).toBe('gzip');
		const text = await res.text();
		expect(text.length).toBe(4 * ('chunk-0-'.length + 2048));
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

	it('never shares a response that sets cookies - each waiter renders its own', async () => {
		const before = /** @type {any} */ (globalThis).__renders ?? 0;
		const responses = await Promise.all([
			req('/api/cookie-counted'),
			req('/api/cookie-counted'),
			req('/api/cookie-counted')
		]);
		for (const res of responses) {
			expect(res.headers.getSetCookie()).toEqual(['per=request; Path=/']);
			await res.arrayBuffer();
		}
		const after = /** @type {any} */ (globalThis).__renders ?? 0;
		expect(after - before).toBe(3);
	});

	it('never shares a response personalized by a non-encoding Vary', async () => {
		const before = /** @type {any} */ (globalThis).__renders ?? 0;
		await Promise.all([req('/api/vary-lang'), req('/api/vary-lang')])
			.then((rs) => Promise.all(rs.map((r) => r.arrayBuffer())));
		const after = /** @type {any} */ (globalThis).__renders ?? 0;
		expect(after - before).toBe(2);
	});

	it('stops buffering at the share cap and streams the remainder', async () => {
		const before = /** @type {any} */ (globalThis).__renders ?? 0;
		const res = await req('/api/huge', { headers: { 'accept-encoding': 'identity' } });
		const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
		let received = 0;
		let bulkAt = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (bulkAt === 0 && received >= 9 * 65536) bulkAt = Date.now();
		}
		const endAt = Date.now();
		expect(received).toBe(9 * 65536 + 4);
		// The early bulk (over the 512K cap) reached the client while the
		// render was still parked on its tail: the leader streamed the overrun
		// instead of holding the whole body in memory until the size check.
		expect(endAt - bulkAt).toBeGreaterThanOrEqual(250);

		// An overrun body is marked non-shareable, so a concurrent waiter
		// renders its own instead of receiving a truncated share.
		const pair = await Promise.all([
			req('/api/huge', { headers: { 'accept-encoding': 'identity' } }),
			req('/api/huge', { headers: { 'accept-encoding': 'identity' } })
		]);
		const sizes = await Promise.all(pair.map(async (r) => (await r.arrayBuffer()).byteLength));
		expect(sizes).toEqual([9 * 65536 + 4, 9 * 65536 + 4]);
		expect((/** @type {any} */ (globalThis).__renders ?? 0) - before).toBe(3);
	}, 15000);

	it('serves concurrent SSE requests without parking on a buffering leader', async () => {
		const responses = await Promise.all([
			req('/api/sse'), req('/api/sse'), req('/api/sse')
		]);
		for (const res of responses) {
			const reader = /** @type {ReadableStream} */ (res.body).getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain('data: 1');
			await reader.cancel();
		}
	});
});
