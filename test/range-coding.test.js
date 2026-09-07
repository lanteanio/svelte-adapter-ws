// Byte-exact assertions for ranges cut from negotiated representations - the
// invariant a resuming download manager depends on. Raw node:http requests,
// never fetch(): undici transparently decompresses coded bodies, which is
// exactly the wrong instrument for asserting coded bytes.

import http from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
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
			'client/logo.svg': IDENTITY,
			'client/logo.svg.br': BR,
			'client/logo.svg.gz': GZ,
			'client/empty.txt': ''
		}
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

/**
 * Raw request: exact bytes, no client-side decoding.
 * @param {string} reqPath
 * @param {Record<string, string>} headers
 * @param {string} [method]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }>}
 */
function raw(reqPath, headers = {}, method = 'GET') {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: '127.0.0.1', port: rt.port, path: reqPath, method, headers },
			(res) => {
				/** @type {Buffer[]} */
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => resolve({
					status: /** @type {number} */ (res.statusCode),
					headers: res.headers,
					body: Buffer.concat(chunks)
				}));
			}
		);
		req.on('error', reject);
		req.end();
	});
}

describe('ranges over coded representations', () => {
	it('cuts a brotli range from the brotli bytes, quoting the brotli length', async () => {
		const first = await raw('/logo.svg', { 'accept-encoding': 'br' });
		const brEtag = /** @type {string} */ (first.headers.etag);
		expect(first.headers['content-encoding']).toBe('br');
		expect(first.body.equals(BR)).toBe(true);

		const res = await raw('/logo.svg', { 'accept-encoding': 'br', range: 'bytes=0-4' });
		expect(res.status).toBe(206);
		expect(res.headers['content-encoding']).toBe('br');
		expect(res.headers['content-range']).toBe(`bytes 0-4/${BR.byteLength}`);
		expect(res.headers['content-length']).toBe('5');
		expect(res.body.equals(BR.subarray(0, 5))).toBe(true);
		expect(res.headers.etag).toBe(brEtag);
	});

	it('cuts a gzip range from the gzip bytes', async () => {
		const res = await raw('/logo.svg', { 'accept-encoding': 'gzip', range: `bytes=${GZ.byteLength - 4}-` });
		expect(res.status).toBe(206);
		expect(res.headers['content-range']).toBe(`bytes ${GZ.byteLength - 4}-${GZ.byteLength - 1}/${GZ.byteLength}`);
		expect(res.body.equals(GZ.subarray(GZ.byteLength - 4))).toBe(true);
	});

	it('refuses a range past the end of the SELECTED representation', async () => {
		// Valid against the identity length, but past the end of the brotli copy.
		const res = await raw('/logo.svg', { 'accept-encoding': 'br', range: `bytes=${BR.byteLength + 10}-` });
		expect(res.status).toBe(416);
		expect(res.headers['content-range']).toBe(`bytes */${BR.byteLength}`);
	});

	it('answers a cross-representation If-Range with the full negotiated body', async () => {
		const identity = await raw('/logo.svg', { 'accept-encoding': 'identity' });
		const identityEtag = /** @type {string} */ (identity.headers.etag);

		const res = await raw('/logo.svg', {
			'accept-encoding': 'br',
			range: 'bytes=0-4',
			'if-range': identityEtag
		});
		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('br');
		expect(res.headers['content-range']).toBeUndefined();
		expect(res.body.equals(BR)).toBe(true);
	});

	it('refuses a range whose If-Range carries a weak validator, even the matching one', async () => {
		// RFC 9110 s13.1.5 evaluates If-Range with the STRONG comparison, and a
		// weak validator never strong-matches. This lane issues nothing BUT weak
		// validators (mtime and size), so an If-Range here can never authorise a
		// splice - and authorising one anyway is how a client joins a slice onto
		// a prefix of different octets that happened to share a tag, ending up
		// with a corrupt body under a 206 that says it is fine. Selecting the
		// right representation and being allowed to splice it are different
		// questions, and this case pins both answers.
		const first = await raw('/logo.svg', { 'accept-encoding': 'br' });
		const brEtag = /** @type {string} */ (first.headers.etag);
		expect(brEtag.startsWith('W/'), 'this lane is supposed to issue weak validators').toBe(true);
		const res = await raw('/logo.svg', { 'accept-encoding': 'br', range: 'bytes=0-4', 'if-range': brEtag });
		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('br');
		expect(res.headers['content-range']).toBeUndefined();
		expect(res.body.equals(BR)).toBe(true);
	});

	it('still resumes on a plain Range, which is what a download manager sends', async () => {
		// The other half, and the reason the refusal above costs little: a Range
		// with no If-Range makes no consistency claim, so it is honoured.
		const res = await raw('/logo.svg', { 'accept-encoding': 'br', range: 'bytes=0-4' });
		expect(res.status).toBe(206);
		expect(res.body.equals(BR.subarray(0, 5))).toBe(true);
	});

	it('clamps an over-long end and serves a whole-file suffix over-ask', async () => {
		const size = Buffer.byteLength(IDENTITY);
		const overEnd = await raw('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=0-999999' });
		expect(overEnd.status).toBe(206);
		expect(overEnd.headers['content-range']).toBe(`bytes 0-${size - 1}/${size}`);
		expect(overEnd.body.toString()).toBe(IDENTITY);

		const overSuffix = await raw('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=-999999' });
		expect(overSuffix.status).toBe(206);
		expect(overSuffix.headers['content-range']).toBe(`bytes 0-${size - 1}/${size}`);
	});

	it('treats a zero suffix and a dash-less spec as ignorable (full 200)', async () => {
		for (const range of ['bytes=-0', 'bytes=']) {
			const res = await raw('/logo.svg', { 'accept-encoding': 'identity', range });
			expect(res.status, range).toBe(200);
			expect(res.body.toString(), range).toBe(IDENTITY);
			expect(res.headers['content-range'], range).toBeUndefined();
		}
	});

	it('answers 416 with bytes */0 for a range into an empty file', async () => {
		const res = await raw('/empty.txt', { 'accept-encoding': 'identity', range: 'bytes=0-4' });
		expect(res.status).toBe(416);
		expect(res.headers['content-range']).toBe('bytes */0');
	});

	it('serves HEAD with Range as a bodiless 206', async () => {
		const res = await raw('/logo.svg', { 'accept-encoding': 'identity', range: 'bytes=0-4' }, 'HEAD');
		expect(res.status).toBe(206);
		expect(res.headers['content-range']).toBe(`bytes 0-4/${Buffer.byteLength(IDENTITY)}`);
		expect(res.body.byteLength).toBe(0);
	});

	it('serves HEAD with If-None-Match as a 304', async () => {
		const first = await raw('/logo.svg', { 'accept-encoding': 'identity' });
		const res = await raw('/logo.svg', { 'accept-encoding': 'identity', 'if-none-match': /** @type {string} */ (first.headers.etag) }, 'HEAD');
		expect(res.status).toBe(304);
	});
});
