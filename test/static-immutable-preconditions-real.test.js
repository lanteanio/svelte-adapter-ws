import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const content = 'export const value = 42;\n';
const cases = [
	['no precondition', {}, 200],
	['matching wildcard', { 'If-Match': '*' }, 200],
	['nonmatching wildcard', { 'If-None-Match': '*' }, 304],
	['absent specific validator', { 'If-Match': 'W/"missing"' }, 412],
	['different specific validator', { 'If-None-Match': 'W/"missing"' }, 200],
	['empty matching list', { 'If-Match': ',' }, 412],
	['empty nonmatching list', { 'If-None-Match': ',' }, 200],
	['matching list with empty elements', { 'If-Match': ', , "missing"' }, 412],
	['nonmatching list with empty elements', { 'If-None-Match': ', , "missing"' }, 200],
	['failed match before nonmatch wildcard', { 'If-Match': '"missing"', 'If-None-Match': '*' }, 412],
	['both wildcards', { 'If-Match': '*', 'If-None-Match': '*' }, 304],
	['nonmatch before date', { 'If-None-Match': '"missing"', 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' }, 200],
	['modified date without a stored validator', { 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' }, 200],
	['unmodified date without a stored validator', { 'If-Unmodified-Since': 'Wed, 01 Jan 2020 00:00:00 GMT' }, 200]
];

for (const secure of [false, true]) describe(`immutable preconditions over ${secure ? 'TLS' : 'TCP'}`, () => {
	let payload, runtime;
	const prefix = 'IMMUTABLE_PRECONDITION_TEST_';
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		const dir = path.join(payload.dir, 'client', '_app', 'immutable');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'condition.js'), content);
		try { runtime = await bootRuntime(payload); }
		catch (error) { throw new Error('Runtime setup failed: ' + (error?.stack || String(error))); }
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});
	for (const method of ['GET', 'HEAD']) it.each(cases)(method + ' evaluates %s', async (_label, headers, status) => {
		const response = await new Promise((resolve, reject) => {
			const req = (secure ? https : http).request({
				host: '127.0.0.1', port: runtime.port, method, path: '/_app/immutable/condition.js',
				headers, agent: false, rejectUnauthorized: false
			}, res => {
				const chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.once('error', reject);
				res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
			});
			req.once('error', reject);
			req.end();
		});
		expect(response.status).toBe(status);
		expect(response.body).toBe(status === 200 && method === 'GET' ? content : '');
		expect(response.headers.etag).toBeUndefined();
		expect(response.headers['last-modified']).toBeUndefined();
		if (status === 200) {
			expect(response.headers['content-length']).toBe(String(Buffer.byteLength(content)));
			expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
		} else if (status === 304) {
			expect(response.headers['content-length']).toBeUndefined();
			expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
		} else expect(response.headers['content-length']).toBe('0');
	});
});
