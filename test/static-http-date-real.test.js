import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { staticLastModifiedTime } from '../src/runtime/handler/static-last-modified.js';

const describeUWS = describe;
const CONTENT = 'A static date validator.\n';

function request(port, method, headers, target = '/date-validation/doc.txt') {
	return new Promise((resolve, reject) => {
		const req = http.request({ port, host: '127.0.0.1', method, path: target, headers }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}

describeUWS('static date validators on the wire', () => {
	let server;
	let dir;
	let payload;
	beforeAll(async () => {
		payload = buildRuntime();
		server = await bootRuntime(payload);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-date-validation-'));
		const file = path.join(dir, 'doc.txt');
		fs.writeFileSync(file, CONTENT);
		fs.utimesSync(file, new Date('2026-01-02T03:04:05Z'), new Date('2026-01-02T03:04:05Z'));
		const { cacheDir } = await import(new URL('file:///' + payload.dir.replaceAll('\\', '/') + '/handler/static-assets.js'));
		const future = path.join(dir, 'future.txt');
		fs.writeFileSync(future, CONTENT);
		const later = new Date(Date.now() + 86400000);
		fs.utimesSync(future, later, later);
		cacheDir(dir, '/date-validation', false);
	}, 400000);
	afterAll(async () => {
		await server?.close();
		payload?.cleanup();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	it('omits a future Last-Modified but keeps its ETag on the wire', async () => {
		const response = await request(server.port, 'GET', { 'If-Modified-Since': 'Sun, 01 Jan 2099 00:00:00 GMT' }, '/date-validation/future.txt');
		expect(response.status).toBe(200);
		expect(response.headers['last-modified']).toBeUndefined();
		expect(response.headers.etag).toMatch(/^W\//);
		expect(response.body).toBe(CONTENT);
	});
	for (const method of ['GET', 'HEAD']) {
		it.each([
			['If-Modified-Since', '2027-01-01'],
			['If-Modified-Since', '2027-01-01T00:00:00Z'],
			['If-Unmodified-Since', '2020-01-01'],
			['If-Unmodified-Since', 'Sun, 01 Jan 1899 00:00:00 GMT'],
			['If-Unmodified-Since', 'January 1, 2020'],
			['If-Unmodified-Since', 'Sat, 30 Feb 2020 00:00:00 GMT']
		])(method + ' ignores invalid %s: %s', async (header, value) => {
			const res = await request(server.port, method, { [header]: value });
			expect(res.status).toBe(200);
			expect(res.body).toBe(method === 'HEAD' ? '' : CONTENT);
		});
		it.each([
			'Fri, 02 Jan 2026 03:04:05 GMT',
			'Friday, 02-Jan-26 03:04:05 GMT',
			'Fri Jan  2 03:04:05 2026'
		])(method + ' accepts %s', async (value) => {
			const res = await request(server.port, method, { 'If-Modified-Since': value });
			expect(res.status).toBe(304);
			expect(res.headers['last-modified']).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
			expect(res.body).toBe('');
		});
		it(method + ' refuses a valid earlier If-Unmodified-Since', async () => {
			const res = await request(server.port, method, { 'If-Unmodified-Since': 'Wed, 01 Jan 2020 00:00:00 GMT' });
			expect(res.status).toBe(412);
			expect(res.body).toBe('');
		});
	}
});

it('omits dates outside the held indexing clock while flooring valid dates', () => {
	const floor = Date.UTC(1900, 0, 1);
	expect(staticLastModifiedTime(floor - 1, 2000000000000)).toBeUndefined();
	expect(staticLastModifiedTime(floor, 2000000000000)).toBe(floor);
	expect(staticLastModifiedTime(1001, 1000)).toBeUndefined();
	expect(staticLastModifiedTime(1999, 1999)).toBe(1000);
});
