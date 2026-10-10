import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function splitThenReuse(port, method, secure) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		let raw = '', sentFollowup = false, suffixTimer;
		const deadline = setTimeout(() => { socket.destroy(); reject(new Error('split-target reuse timed out')); }, 3000);
		const cleanup = () => { clearTimeout(deadline); clearTimeout(suffixTimer); };
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			socket.write(method + ' /caf');
			suffixTimer = setTimeout(() => socket.write('\xc3\xa9 HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1'), 25);
		});
		socket.on('data', chunk => {
			raw += chunk.toString('latin1');
			const end = raw.indexOf('\r\n\r\n');
			if (!sentFollowup && end !== -1 && raw.length >= end + 4 + (method === 'HEAD' ? 0 : 11)) {
				sentFollowup = true;
				socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
			}
		});
		socket.on('error', error => { cleanup(); reject(error); });
		socket.on('close', () => { cleanup(); resolve(raw); });
	});
}

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
		const raw = await splitThenReuse(runtime.port, method, secure);
		expect(raw.match(/HTTP\/1\.1 \d{3}[^\r]*/g)).toEqual(['HTTP/1.1 400 Bad Request', 'HTTP/1.1 200 OK']);
		const bodyStart = raw.indexOf('\r\n\r\n') + 4;
		expect(raw.slice(0, bodyStart).toLowerCase()).toContain('content-length: 11\r\n');
		const followupStart = bodyStart + (method === 'HEAD' ? 0 : 11);
		expect(raw.slice(bodyStart, followupStart)).toBe(method === 'HEAD' ? '' : 'Bad Request');
		const followup = raw.slice(followupStart);
		expect(followup).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(followup.slice(followup.indexOf('\r\n\r\n') + 4)).toBe('OK');
	});
});
