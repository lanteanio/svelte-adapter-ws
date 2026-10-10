import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

for (const secure of [false, true]) describe(`first declined upgrade with an external ${secure ? 'TLS' : 'TCP'} reader`, () => {
	let payload;
	let runtime;
	let observed = 0;
	const prefix = `EXTERNAL_READER_${secure}_`;
	beforeAll(async () => {
		if (secure) {
			const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
		runtime.handler.server.on(secure ? 'secureConnection' : 'connection', (socket) => {
			socket.on('data', (chunk) => { observed += chunk.length; });
		});
	}, 60000);
	afterAll(async () => {
		await runtime?.close();
		payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});
	it('answers the request behind the first complete declined upgrade in the same read', async () => {
		const request = 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n' +
			'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';
		const raw = await new Promise((resolve, reject) => {
			const socket = secure ? tls.connect({ host: '127.0.0.1', port: runtime.port, rejectUnauthorized: false }) : net.connect(runtime.port, '127.0.0.1');
			let received = '';
			const timer = setTimeout(() => { socket.destroy(); reject(new Error('pipelined response lost')); }, 1500);
			socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(request));
			socket.on('data', (chunk) => { received += chunk.toString(); });
			socket.on('error', reject);
			socket.on('close', () => { clearTimeout(timer); resolve(received); });
		});
		expect([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1])).toEqual(['200', '200']);
		expect(observed).toBe(Buffer.byteLength(request));
	});
});