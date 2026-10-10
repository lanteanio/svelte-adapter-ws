import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const refusal = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>';
const request = (target, close = false) => 'GET ' + target + ' HTTP/1.1\r\nHost: x\r\n' + (close ? 'Connection: close\r\n' : '') + '\r\n';
const invalidHeads = ['X-\x01: value', 'X-Probe: a\x01b', 'Bad Header'].map(header => 'GET /healthz HTTP/1.1\r\nHost: x\r\n' + header + '\r\n\r\n');
invalidHeads.push('HEAD /healthz HTTP/1.1\r\nHost: x\r\nX-Probe: a\x01b\r\n\r\n', 'POST /body HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n');
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));

function splitFirstAnswer(raw, body) {
	expect(raw).toMatch(/^HTTP\/1\.1 200(?: |\r)/);
	const headEnd = raw.indexOf('\r\n\r\n');
	expect(headEnd).toBeGreaterThan(0);
	expect(raw.slice(0, headEnd)).toMatch(/\r\ncontent-length: 17000(?:\r\n|$)/i);
	expect(raw.slice(headEnd + 4, headEnd + 4 + body.length)).toBe(body);
	return raw.slice(headEnd + 4 + body.length);
}

describe.each([false, true])('generic parser refusal over TLS=%s', secure => {
	let payload, runtime;
	const prefix = 'GENERIC_REFUSAL_';
	beforeAll(async () => {
		if (secure) Object.assign(process.env, {
			[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
			[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
			[prefix + 'SSL_WATCH']: '0'
		});
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix) },
			files: { 'client/large.txt': 's'.repeat(17000) },
			serverSource: "export class Server { async init() {} async respond(request) { if (new URL(request.url).pathname === '/body') return new Response(await request.text()); return new Response('x'.repeat(17000)); } }"
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	it.each(invalidHeads.flatMap((head, shape) => ['', request('/healthz'), request('/healthz', true)].map((before, preceding) => [shape, preceding, before + head])))('uses the exact refusal for shape %i after prefix %i', async (_, __, wire) => {
		expect(await rawConversation(runtime.port, [[0, wire]], { secure, wait: 1500 })).toEqual({ raw: refusal, closed: true });
	});
	it.each([['/large', 'x'.repeat(17000)], ['/large.txt', 's'.repeat(17000)]])('appends its full refusal after completed %s output', async (target, body) => {
		const result = await rawConversation(runtime.port, [[0, request(target) + invalidHeads[1]]], { secure, wait: 1500 });
		expect(result.closed).toBe(true);
		expect(splitFirstAnswer(result.raw, body)).toBe(refusal);
	});
	it.each([['/large', 'x'.repeat(17000)], ['/large.txt', 's'.repeat(17000)]])('adds no refusal after a committed close from %s', async (target, body) => {
		const result = await rawConversation(runtime.port, [[0, request(target, true) + invalidHeads[1]]], { secure, wait: 1500 });
		expect(result.closed).toBe(true);
		expect(splitFirstAnswer(result.raw, body)).toBe('');
	});
	it('serves a fresh connection after parser refusals', async () => {
		const result = await rawConversation(runtime.port, [[0, request('/healthz', true)]], { secure, wait: 1500 });
		expect(result.closed).toBe(true);
		expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(result.raw).toMatch(/\r\n\r\nOK$/);
	});
});
