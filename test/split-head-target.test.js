import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe.each([false, true])('split HEAD target with TLS=%s', secure => {
	let payload, runtime;
	const prefix = 'HEAD_SPLIT_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
	});
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});
	it.each(['HEAD', 'GET'])('keeps the %s response framing when the bad byte arrives later', async method => {
		const { raw, closed } = await rawConversation(runtime.port, [[0, method + ' /caf'], [25, '\xc3\xa9 HTTP/1.1\r\nHost: x\r\n\r\n']], { secure });
		expect(raw).toContain('HTTP/1.1 400 Bad Request');
		expect(raw.toLowerCase()).toContain('content-length: 11\r\n');
		expect(raw.slice(raw.indexOf('\r\n\r\n') + 4)).toBe(method === 'HEAD' ? '' : 'Bad Request');
		expect(closed).toBe(false);
	});
});
