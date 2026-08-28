import { gzipSync, brotliCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const IDENTITY = '<svg>' + 'identity-payload-'.repeat(64) + '</svg>';
const BR = brotliCompressSync(Buffer.from(IDENTITY));
const GZ = gzipSync(Buffer.from(IDENTITY));

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		files: {
			'client/_app/immutable/chunk-abc.js': 'export const immutable = true;',
			'client/logo.svg': IDENTITY,
			'client/logo.svg.br': BR,
			'client/logo.svg.gz': GZ,
			'client/download.zip': 'PK-fake-zip-bytes',
			'client/.env': 'SECRET=1',
			'client/.well-known/security.txt': 'Contact: mailto:security@example.com',
			'client/hello.txt': 'hello from read()',
			'prerendered/about.html': '<html>about page</html>',
			'prerendered/docs/index.html': '<html>docs index</html>'
		}
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

/** @param {string} path @param {Record<string, string>} [headers] */
function get(path, headers = {}) {
	return fetch(rt.origin + path, { headers, redirect: 'manual' });
}

describe('static serving', () => {
	it('serves a mutable asset with validator, vary and hardening headers', async () => {
		const res = await get('/logo.svg', { 'accept-encoding': 'identity' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(IDENTITY);
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('vary')).toBe('Accept-Encoding');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-z.]+-[0-9a-z]+"$/);
		expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(IDENTITY)));
	});

	it('serves the immutable tree with a year-long cache policy and no validator', async () => {
		const res = await get('/_app/immutable/chunk-abc.js', { 'accept-encoding': 'identity' });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('etag')).toBeNull();
	});

	it('negotiates brotli with a per-representation validator', async () => {
		const res = await get('/logo.svg', { 'accept-encoding': 'br, gzip' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-encoding')).toBe('br');
		const etag = res.headers.get('etag');
		expect(etag?.endsWith('-br"')).toBe(true);
		// fetch() transparently decompresses; equality with the identity bytes
		// proves the brotli representation decoded back to the original.
		expect(await res.text()).toBe(IDENTITY);
		expect(res.headers.get('content-length')).toBe(String(BR.byteLength));
	});

	it('falls back to gzip when brotli is not accepted', async () => {
		const res = await get('/logo.svg', { 'accept-encoding': 'gzip' });
		expect(res.headers.get('content-encoding')).toBe('gzip');
		expect(res.headers.get('etag')?.endsWith('-gzip"')).toBe(true);
		expect(await res.text()).toBe(IDENTITY);
		expect(res.headers.get('content-length')).toBe(String(GZ.byteLength));
	});

	it('answers 304 against the representation validator, not the identity one', async () => {
		const first = await get('/logo.svg', { 'accept-encoding': 'br' });
		const brEtag = /** @type {string} */ (first.headers.get('etag'));
		await first.arrayBuffer();

		const revalidated = await get('/logo.svg', { 'accept-encoding': 'br', 'if-none-match': brEtag });
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get('etag')).toBe(brEtag);
		expect(revalidated.headers.get('vary')).toBe('Accept-Encoding');
		expect(revalidated.headers.get('cache-control')).toBe('no-cache');

		// The identity client presenting the brotli validator must NOT get a 304
		const cross = await get('/logo.svg', { 'accept-encoding': 'identity', 'if-none-match': brEtag });
		expect(cross.status).toBe(200);
		await cross.arrayBuffer();
	});

	it('serves single byte ranges in the negotiated representation coordinates', async () => {
		const res = await get('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=0-4' });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe(IDENTITY.slice(0, 5));
		expect(res.headers.get('content-range')).toBe(`bytes 0-4/${Buffer.byteLength(IDENTITY)}`);
	});

	it('serves suffix and open-ended ranges', async () => {
		const size = Buffer.byteLength(IDENTITY);
		const suffix = await get('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=-6' });
		expect(suffix.status).toBe(206);
		expect(await suffix.text()).toBe(IDENTITY.slice(-6));
		const open = await get('/logo.svg', { 'accept-encoding': 'identity', range: `bytes=${size - 3}-` });
		expect(open.status).toBe(206);
		expect(await open.text()).toBe(IDENTITY.slice(-3));
	});

	it('ignores malformed and multi-ranges (full 200), refuses unsatisfiable (416)', async () => {
		for (const range of ['bytes=1oops-4', 'bytes=0-4,10-14', 'chars=0-4', 'bytes=4-2']) {
			const res = await get('/logo.svg', { 'accept-encoding': 'identity', range });
			expect(res.status, range).toBe(200);
			await res.arrayBuffer();
		}
		const res = await get('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=999999-' });
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${Buffer.byteLength(IDENTITY)}`);
	});

	it('falls back to a full 200 when If-Range names a stale validator', async () => {
		const res = await get('/logo.svg', {
			'accept-encoding': 'identity',
			range: 'bytes=0-4',
			'if-range': 'W/"stale"'
		});
		expect(res.status).toBe(200);
		await res.arrayBuffer();
	});

	it('never serves ranges from immutable (validator-less) assets', async () => {
		const res = await get('/_app/immutable/chunk-abc.js', { 'accept-encoding': 'identity', range: 'bytes=0-4' });
		expect(res.status).toBe(200);
		await res.arrayBuffer();
	});

	it('answers HEAD with headers and no body', async () => {
		const res = await fetch(rt.origin + '/logo.svg', {
			method: 'HEAD',
			headers: { 'accept-encoding': 'identity' }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(IDENTITY)));
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it('marks non-renderable downloads as attachments', async () => {
		const res = await get('/download.zip', { 'accept-encoding': 'identity' });
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="download.zip"');
		await res.arrayBuffer();
	});

	it('refuses dotfiles but serves a top-level .well-known', async () => {
		// The dotfile never entered the index, so the request falls through to
		// SSR - proving static serving does not expose it.
		const dot = await get('/.env');
		expect(await dot.text()).toBe('SSR:/.env');

		const wellKnown = await get('/.well-known/security.txt', { 'accept-encoding': 'identity' });
		expect(wellKnown.status).toBe(200);
		expect(await wellKnown.text()).toContain('security@example.com');
	});
});

describe('prerendered pages', () => {
	it('serves a file-style page on its bare path and redirects the slash form', async () => {
		const page = await get('/about');
		expect(page.status).toBe(200);
		expect(await page.text()).toBe('<html>about page</html>');

		const redirected = await get('/about/?q=1');
		expect(redirected.status).toBe(308);
		expect(redirected.headers.get('location')).toBe('/about?q=1');
	});

	it('serves a directory-style page on its slash path and redirects the bare form', async () => {
		const page = await get('/docs/');
		expect(page.status).toBe(200);
		expect(await page.text()).toBe('<html>docs index</html>');

		const redirected = await get('/docs?a=b');
		expect(redirected.status).toBe(308);
		expect(redirected.headers.get('location')).toBe('/docs/?a=b');
	});

	it('refuses malformed percent-encoding with 400', async () => {
		const res = await get('/%zz');
		expect(res.status).toBe(400);
	});

	it('does not serve static entries under encoded spellings', async () => {
		const res = await get('/logo%2Esvg');
		// The static fast path keys on the raw undecoded pathname, so the
		// encoded spelling misses the cache and reaches SSR with the raw URL.
		expect(await res.text()).toBe('SSR:/logo%2Esvg');
	});
});
