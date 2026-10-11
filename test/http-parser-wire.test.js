import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import { createTestServer } from '../src/testing.js';

const bad = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>';
const version = 'HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n<h1>HTTP Version Not Supported</h1><p>This server does not support HTTP/1.0.</p><hr><i>uWebSockets/20 Server</i>';
const healthy = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';
const cases = [
	['incomplete version', 'GET / HTTP/1.0', version],
	['HEAD version', 'HEAD / HTTP/1.0\r\n\r\n', version],
	['version before bad header', 'GET / HTTP/1.0\r\nBad Header: x\r\n\r\n', version],
	['missing Host', 'GET / HTTP/1.1\r\n\r\n', bad],
	['HEAD missing Host', 'HEAD / HTTP/1.1\r\n\r\n', bad],
	['duplicate Host', 'GET / HTTP/1.1\r\nHost: x\r\nHost: y\r\n\r\n', bad],
	['bare LF header', 'GET / HTTP/1.1\r\nHost: x\n\n', bad],
	['malformed header', 'GET / HTTP/1.1\r\nHost: x\r\nBad Header: x\r\n\r\n', bad]
];

describe.each(['tcp', 'tls', 'harness'])('native parser refusal bytes over %s', transport => {
	let payload, runtime;
	const secure = transport === 'tls';
	const prefix = 'PARSER_WIRE_';
	beforeAll(async () => {
		if (transport === 'harness') { runtime = await createTestServer(); return; }
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			Object.assign(process.env, {
				[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
				[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
				[prefix + 'SSL_WATCH']: '0'
			});
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	it.each(cases.flatMap(([name, request, answer]) => ['', healthy].map(before => [name, before.length > 0, before + request, answer])))('sends exact %s bytes after buffered answer=%s', async (_, __, request, answer) => {
		expect(await rawConversation(runtime.port, [[0, request]], { secure, wait: 2000 })).toEqual({ raw: answer, closed: true });
	});
	it('refuses a split version after a completed answer on the same connection', async () => {
		const result = await rawConversation(runtime.port, [[0, healthy], [100, 'HEAD / HTTP/1.'], [130, '0']], { secure, wait: 2000 });
		expect(result.closed).toBe(true);
		expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(result.raw.slice(result.raw.indexOf('\r\n\r\n') + 4)).toBe('OK' + version);
	});
});
