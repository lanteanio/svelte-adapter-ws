// Static answers larger than one 64 KiB slice are handed to the socket a
// slice at a time. While the client keeps reading, the socket takes every
// slice before the handler returns, so the answer ends in its own turn as a
// single end() would: requests pipelined behind it are served, a pipelined
// refusal follows it, and a closing request still closes after it. Pinned on
// the built runtime over TCP and TLS.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const small = 'small static answer';
const large = 'L'.repeat(256 * 1024 + 7);
const bad = 'GET /bad HTTP/1.0\r\nHost: localhost\r\n\r\n';
const request = (/** @type {string} */ target, headers = '', method = 'GET') =>
	`${method} ${target} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`;

/** @param {string} raw */
function responses(raw) {
	const answers = [];
	while (raw.length) {
		const end = raw.indexOf('\r\n\r\n');
		expect(end).toBeGreaterThanOrEqual(0);
		const head = raw.slice(0, end);
		const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
		const declared = /\r\ncontent-length: (\d+)/i.exec(head);
		const length = declared ? Number(declared[1]) : raw.length - end - 4;
		expect(raw.length, 'an answer must arrive whole').toBeGreaterThanOrEqual(end + 4 + length);
		answers.push({ status, head, body: raw.slice(end + 4, end + 4 + length) });
		raw = raw.slice(end + 4 + length);
	}
	return answers;
}

describe.each([false, true])('large static answers in a pipeline with TLS=%s', (secure) => {
	/** @type {any} */
	let payload;
	/** @type {any} */
	let runtime;
	const prefix = 'STATIC_PIPELINE_LARGE_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix) },
			files: {
				'client/small.txt': small,
				'client/large.txt': large,
				'prerendered/large.html': large
			}
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close();
		payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});

	it.each([
		['large then small', request('/large.txt') + request('/small.txt'), [[200, large], [200, small]]],
		['small then large then small', request('/small.txt') + request('/large.txt') + request('/small.txt'), [[200, small], [200, large], [200, small]]],
		['two large', request('/large.txt').repeat(2), [[200, large], [200, large]]],
		['large range then small', request('/large.txt', 'Range: bytes=3-\r\n') + request('/small.txt'), [[206, large.slice(3)], [200, small]]],
		['large prerendered page then small', request('/large') + request('/small.txt'), [[200, large], [200, small]]]
	])('serves %s', async (_name, input, expected) => {
		const { raw } = await rawConversation(runtime.port, [[0, input]], { secure, wait: 1500 });
		const answers = responses(raw);
		expect(answers.map((answer) => answer.status)).toEqual(expected.map(([status]) => status));
		expect(answers.map((answer) => answer.body)).toEqual(expected.map(([, body]) => body));
	});

	it('answers a large static request before a pipelined refusal', async () => {
		const { raw, closed } = await rawConversation(runtime.port, [[0, request('/large.txt') + bad]], { secure, wait: 2000 });
		expect(closed).toBe(true);
		const answers = responses(raw);
		expect(answers.map((answer) => answer.status)).toEqual([200, 505]);
		expect(answers[0].body).toBe(large);
	});

	it('closes after a large answer to a closing request and serves nothing behind it', async () => {
		const { raw, closed } = await rawConversation(runtime.port, [[0, request('/large.txt', 'Connection: close\r\n') + request('/small.txt')]], { secure, wait: 2000 });
		expect(closed).toBe(true);
		const answers = responses(raw);
		expect(answers.map((answer) => answer.status)).toEqual([200]);
		expect(answers[0].body).toBe(large);
	});
});
