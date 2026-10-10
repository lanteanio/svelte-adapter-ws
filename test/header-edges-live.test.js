import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { createTestServer } from '../src/testing.js';

function probe(port, path, headers, body = '', fragmented = false) {
	return new Promise((resolve, reject) => {
		const wire = Buffer.from(['GET ' + path + ' HTTP/1.1', ...headers, '', body].join('\r\n'), 'latin1');
		let raw = '', closed = false;
		const socket = net.connect(port, '127.0.0.1', () => {
			if (!fragmented) socket.write(wire);
			else {
				const cut = wire.indexOf(0xe9) + 1;
				socket.write(wire.subarray(0, cut));
				setTimeout(() => socket.write(wire.subarray(cut)), 10);
			}
		});
		const timer = setTimeout(() => socket.destroy(), 220);
		socket.on('data', bytes => { raw += bytes.toString('latin1'); });
		socket.on('end', () => { closed = true; });
		socket.on('error', err => { if (err.code === 'ECONNRESET') closed = true; else reject(err); });
		socket.on('close', () => {
			clearTimeout(timer);
			resolve({ status: Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1]), body: raw.slice(raw.indexOf('\r\n\r\n') + 4), raw, closed });
		});
	});
}

let payload, runtime, mirror;
beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', adminAuthAcknowledged: true }) },
		wsHandlerSource: 'export function message() {}\nexport function admin(request) { return Response.json(Object.fromEntries(request.headers)); }'
	});
	runtime = await bootRuntime(payload);
	mirror = await createTestServer({ handler: { admin: request => Response.json(Object.fromEntries(request.headers)) } });
}, 60000);
afterAll(async () => { await runtime?.close(); await mirror?.close(); payload?.cleanup(); });

for (const surface of ['runtime', 'mirror']) {
	describe(`${surface} native header edge parsing`, () => {
		const port = () => surface === 'runtime' ? runtime.port : mirror.port;
		const handshake = key => ['Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + key];
		it('opens a canonical key surrounded by high bytes', async () => {
			const answer = await probe(port(), '/ws', handshake('\xe9 dGhlIHNhbXBsZSBub25jZQ== \xc3\xa9'));
			expect(answer.status, answer.raw).toBe(101);
			expect(answer.raw).toMatch(/sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
		});
		it.each(['\xe9'.repeat(24), 'a'.repeat(22) + '\xc3\xa9'])('routes trimmed non-24-byte key through kept HTTP refusal', async key => {
			const answer = await probe(port(), '/ws', handshake(key));
			expect(answer.status).toBe(400);
			expect(answer.closed, answer.raw).toBe(false);
		});
		it('hands application headers their trimmed values, including Host', async () => {
			const answer = await probe(port(), '/__realtime/inspect', ['Host: \xe9 localhost \xe9', 'X-Probe: \xe9 alpha \xe9', 'Cookie: \xe9 token=abc \xe9', 'Accept: \xe9 application/json \xe9']);
			expect(answer.status, answer.raw).toBe(200);
			expect(JSON.parse(answer.body)).toMatchObject({ host: 'localhost', 'x-probe': 'alpha', cookie: 'token=abc', accept: 'application/json' });
		});
		it.each([
			['Content-Length: \xe9 0 \xe9', ''],
			['Transfer-Encoding: \xe9 chunked \xe9', '0\r\n\r\n']
		])('normalizes %s before node framing decisions', async (header, body) => {
			const answer = await probe(port(), '/healthz', ['Host: localhost', header], body);
			expect(answer.status, answer.raw).toBe(200);
			expect(answer.closed).toBe(false);
		});
		it('normalizes a header split inside its high-byte edge', async () => {
			const answer = await probe(port(), '/__realtime/inspect', ['Host: localhost', 'X-Probe: \xe9 alpha \xe9'], '', true);
			expect(answer.status, answer.raw).toBe(200);
			expect(JSON.parse(answer.body)['x-probe']).toBe('alpha');
		});
		it('preserves ordinary application values', async () => {
			const answer = await probe(port(), '/__realtime/inspect', ['Host: localhost', 'X-Probe: alpha-beta']);
			expect(answer.status).toBe(200);
			expect(JSON.parse(answer.body)['x-probe']).toBe('alpha-beta');
		});
	});
}
