import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { createTestServer } from '../src/testing.js';

// Keep the client open so a parser refusal must prove that the server closes.
function probe(port, method, path, hosts, extra = []) {
	return new Promise((resolve, reject) => {
		let raw = '', closed = false;
		const socket = net.connect(port, '127.0.0.1', () => socket.write(
			[`${method} ${path} HTTP/1.1`, ...hosts, ...extra, '', ''].join('\r\n')
		));
		const timer = setTimeout(() => socket.destroy(), 180);
		socket.on('data', chunk => { raw += chunk.toString('latin1'); });
		socket.on('end', () => { closed = true; });
		socket.on('error', err => {
			if (err.code === 'ECONNRESET') closed = true;
			else reject(err);
		});
		socket.on('close', () => {
			clearTimeout(timer);
			resolve({ status: Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1]), closed, raw });
		});
	});
}

let payload, runtime, mirror;
beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', adminAuthAcknowledged: true }) },
		wsHandlerSource: 'export function message() {}\nexport function admin() { return new Response("admin"); }',
		files: { 'client/asset.txt': 'asset' }
	});
	runtime = await bootRuntime(payload);
	mirror = await createTestServer({ handler: { admin: () => new Response('admin') } });
}, 60000);
afterAll(async () => {
	await runtime?.close();
	await mirror?.close();
	payload?.cleanup();
});

for (const surface of ['runtime', 'mirror']) {
	describe(`${surface} Host parsing`, () => {
		const port = () => surface === 'runtime' ? runtime.port : mirror.port;
		it.each([
			['GET', '/healthz', []], ['GET', '/asset.txt', []],
			['GET', '/api/echo', []], ['GET', '/__realtime/introspect', []],
			['HEAD', '/healthz', []], ['CONNECT', '/x', []],
			['TRACK', '/x', []], ['TRACE', '/x', []],
			['GET', '/ws', ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13']]
		])('refuses duplicate Host before %s %s routing', async (method, path, extra) => {
			const answer = await probe(port(), method, path, ['Host: a', 'hOsT: b'], extra);
			expect(answer.status).toBe(400);
			expect(answer.closed, answer.raw).toBe(true);
		});
		it('accepts an empty Host as a present field on routes needing no origin', async () => {
			const answer = await probe(port(), 'GET', '/healthz', ['Host:']);
			expect(answer.status).toBe(200);
			expect(answer.closed).toBe(false);
		});
		it('still refuses an absent Host and closes', async () => {
			const answer = await probe(port(), 'GET', '/healthz', []);
			expect(answer.status).toBe(400);
			expect(answer.closed).toBe(true);
		});
		it('refuses even two empty Host fields', async () => {
			const answer = await probe(port(), 'GET', '/healthz', ['Host:', 'Host:']);
			expect(answer.status).toBe(400);
			expect(answer.closed).toBe(true);
		});
		it('preserves origin validation for an empty Host in an admin request', async () => {
			const answer = await probe(port(), 'GET', '/__realtime/introspect', ['Host:']);
			expect(answer.status).toBe(400);
		});
	});
}
