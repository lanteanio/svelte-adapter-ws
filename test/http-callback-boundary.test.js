import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const APP = `export class Server {
	async init() {}
	respond(request) {
		const url = new URL(request.url);
		const kind = url.pathname.slice(1);
		const answer = () => new Response(kind === 'empty' ? null : kind, {
			status: kind === 'empty' ? 204 : 200,
			headers: url.searchParams.has('close') ? { connection: 'close' } : {}
		});
		if (kind === 'micro') return Promise.resolve().then(answer);
		if (kind === 'deep') {
			let pending = Promise.resolve();
			for (let i = 0; i < 40; i++) pending = pending.then(() => {});
			return pending.then(answer);
		}
		if (kind === 'tick') return new Promise(resolve => process.nextTick(() => Promise.resolve().then(() => resolve(answer()))));
		if (kind === 'immediate') return new Promise(resolve => setImmediate(() => resolve(answer())));
		if (kind === 'delay') return new Promise(resolve => setTimeout(() => resolve(answer()), 30));
		return answer();
	}
}`;
const request = (route, method = 'GET') => `${method} /${route} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
const handshake = 'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

function converse(port, secure, first, second, separate = false) {
	return new Promise((resolve, reject) => {
		const socket = secure
			? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
			: net.connect(port, '127.0.0.1');
		let raw = '';
		let sent = !separate;
		let settled = false;
		const finish = (closed) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ raw, closed });
		};
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('response timed out: ' + raw)); }, 2000);
		socket.on('error', error => { if (error.code === 'ECONNRESET') finish(true); else reject(error); });
		socket.on('close', () => finish(true));
		socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(first + (separate ? '' : second)));
		socket.on('data', chunk => {
			raw += chunk.toString('latin1');
			if (!sent && raw.includes('\r\n\r\n')) { sent = true; socket.write(second); }
			if (raw.endsWith('\r\n\r\nfinal') || raw.includes('101 Switching Protocols\r\n')) finish(false);
		});
	});
}

for (const secure of [false, true]) describe(`HTTP callback boundaries over ${secure ? 'TLS' : 'TCP'}`, () => {
	let payload;
	let server;
	const prefix = 'CALLBACK_BOUNDARY_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0 }) },
			serverSource: APP,
			wsHandlerSource: '// No admission hook.\n'
		});
		server = await bootRuntime(payload);
	});
	afterAll(async () => {
		await server?.close();
		payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});
	it.each(['micro', 'deep', 'tick'])('completes %s jobs before reading the next request', async route => {
		const result = await converse(server.port, secure, request(route), request('final'));
		expect(result.raw.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
		expect(result.closed).toBe(false);
	});
	it.each(['immediate', 'delay'])('closes before an application %s callback can answer', async route => {
		expect(await converse(server.port, secure, request(route), request('final'))).toEqual({ raw: '', closed: true });
	});
	it.each(['sync', 'micro', 'empty'])('keeps a pipeline after the %s application close header', async route => {
		const result = await converse(server.port, secure, request(route + '?close'), request('final'));
		expect(result.raw).toContain('connection: close\r\n');
		expect(result.raw.match(/HTTP\/1\.1 (?:200|204)/g)).toHaveLength(2);
		expect(result.closed).toBe(false);
	});
	it('keeps a later request after an application close header', async () => {
		const result = await converse(server.port, secure, request('sync?close'), request('final'), true);
		expect(result.raw.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
		expect(result.closed).toBe(false);
	});
	it('keeps a handshake after a microtask response with an application close header', async () => {
		const result = await converse(server.port, secure, request('micro?close'), handshake);
		expect(result.raw).toContain('200 OK');
		expect(result.raw).toContain('101 Switching Protocols');
	});
});
