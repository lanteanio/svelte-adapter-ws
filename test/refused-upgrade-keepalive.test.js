import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { restoreUpgradeOption, UPGRADE_OPTION_MODES } from './helpers/upgrade-option.js';

afterAll(restoreUpgradeOption);

function exchange(port, secure, { query = '', version = 13, pipeline = false, extraHeaders = [], nextHeaders = [] } = {}) {
	return new Promise((resolve, reject) => {
		const socket = secure
			? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
			: net.connect(port, '127.0.0.1');
		let raw = '';
		let sent = pipeline;
		const next = ['GET /healthz HTTP/1.1', 'Host: localhost', ...nextHeaders, '', ''].join('\r\n');
		const finish = () => { socket.destroy(); resolve(raw); };
		socket.setTimeout(2000, () => {
			socket.destroy();
			reject(new Error('response timeout: ' + raw));
		});
		socket.on('error', (error) => { if (error.code === 'ECONNRESET') finish(); else reject(error); });
		socket.on('close', finish);
		socket.on(secure ? 'secureConnect' : 'connect', () => socket.write([
			'GET /ws?' + query + ' HTTP/1.1', 'Host: localhost',
			'Connection: Upgrade', 'Upgrade: websocket',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version: ' + version, ...extraHeaders, '', ''
		].join('\r\n') + (pipeline ? next : '')));
		socket.on('data', (chunk) => {
			raw += chunk.toString();
			if (raw.includes('\r\n\r\n') && !sent) { sent = true; socket.write(next); }
			if (raw.includes('\r\n\r\nOK')) finish();
		});
	});
}

for (const { name, build } of UPGRADE_OPTION_MODES) {
	for (const secure of [false, true]) describe(`refused upgrades over ${secure ? 'TLS' : 'TCP'}, ${name}`, () => {
		let payload;
		let server;
		const prefix = 'REFUSED_WS_';
		beforeAll(async () => {
			if (secure) {
				const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
				process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
				process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
				process.env[prefix + 'SSL_WATCH'] = '0';
			}
			payload = buildRuntime({
				replace: {
					ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true',
					WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0 })
				},
				wsHandlerSource: `export async function upgrade({ url }) {
					if (url.includes('delay')) await new Promise(resolve => setTimeout(resolve, 100));
					if (url.includes('throw')) throw Error('refused');
					return false;
				}`
			});
			server = await build(() => bootRuntime(payload));
		});
		afterAll(async () => {
			await server?.close();
			payload?.cleanup();
			for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
		});
		it.each([false, true])('keeps a malformed handshake connection, pipelined=%s', async (pipeline) => {
			const raw = await exchange(server.port, secure, { version: 12, pipeline });
			expect(raw).toContain('426 Upgrade Required');
			expect(raw).toContain('200 OK');
			expect(raw).not.toContain('Connection: close');
		});
		it.each(['', 'delay', 'throw'])('keeps the connection after hook refusal %s', async (query) => {
			const raw = await exchange(server.port, secure, { query });
			expect(raw).toContain(query === 'throw' ? '500 Internal Server Error' : '401 Unauthorized');
			expect(raw).toContain('200 OK');
			expect(raw).not.toContain('Connection: close');
		});
		it('allows a microtask refusal before the pipelined request', async () => {
			const raw = await exchange(server.port, secure, { pipeline: true });
			expect(raw).toContain('401 Unauthorized');
			expect(raw).toContain('200 OK');
		});
		it('closes when a request is pipelined behind a pending hook', async () => {
			expect(await exchange(server.port, secure, { query: 'delay', pipeline: true })).toBe('');
		});
		it('reinstalls upgrade routing for the next HTTP request', async () => {
			const raw = await exchange(server.port, secure, {
				version: 12, nextHeaders: ['Connection: Upgrade', 'Upgrade: h2c']
			});
			expect(raw).toContain('426 Upgrade Required');
			expect(raw).toContain('200 OK');
		});
		it('closes an ambiguous framing refusal before reading another request', async () => {
			const raw = await exchange(server.port, secure, { pipeline: true, extraHeaders: ['Transfer-Encoding: gzip'] });
			expect(raw).toContain('400 Bad Request');
			expect(raw).toContain('Connection: close');
			expect(raw).not.toContain('200 OK');
		});
	});
}
