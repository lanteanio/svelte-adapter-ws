import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let serial = 0;
async function boot(env = {}, websocket = false) {
	const prefix = `PP_${serial++}_`;
	for (const [key, value] of Object.entries(env)) process.env[prefix + key] = value;
	const payload = buildRuntime({
		replace: { ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: JSON.stringify(websocket), WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0, authPathRateLimit: 0 }) },
		serverSource: `export class Server { async init() {} async respond(req, opts) { return new Response(JSON.stringify({ ip: opts.getClientAddress(), body: await req.text() }), { headers: { 'content-type': 'application/json' } }); } }`,
		wsHandlerSource: `export function upgrade({ remoteAddress }) { return { __upgradeResponse: true, userData: {}, headers: { 'x-proxy-ip': remoteAddress } }; } export function authenticate({ remoteAddress }) { return Response.json({ token: remoteAddress }); }`
	});
	cleanups.push(() => { payload.cleanup(); for (const key of Object.keys(env)) delete process.env[prefix + key]; });
	const rt = await bootRuntime(payload);
	cleanups.push(() => rt.close());
	return rt;
}
function frame(source = '203.0.113.99', { version = 0x21, family = 0x11, length = 12 } = {}) {
	const data = Buffer.alloc(16 + length);
	Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]).copy(data);
	data[12] = version;
	data[13] = family;
	data.writeUInt16BE(length, 14);
	if (family === 0x21) Buffer.from(source.replaceAll(':', ''), 'hex').copy(data, 16);
	else source.split('.').forEach((v, i) => { if (16 + i < data.length) data[16 + i] = Number(v); });
	return data;
}
const get = (extra = '', close = true) => Buffer.from(`GET /address HTTP/1.1\r\nHost: example.test\r\n${extra}${close ? 'Connection: close\r\n' : ''}\r\n`);
async function exchange(rt, chunks, secure = false) {
	return new Promise((resolve, reject) => {
		const received = [];
		const socket = secure ? tls.connect({ host: '127.0.0.1', port: rt.port, rejectUnauthorized: false }) : net.connect(rt.port, '127.0.0.1');
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('socket timeout')); }, 4000);
		socket.on(secure ? 'secureConnect' : 'connect', async () => {
			for (const chunk of chunks) { socket.write(chunk); if (chunks.length > 1) await new Promise((r) => setTimeout(r, 3)); }
		});
		socket.on('data', (chunk) => { received.push(chunk); const raw = Buffer.concat(received).toString(); if (raw.startsWith('HTTP/1.1 101 ') && raw.includes('\r\n\r\n')) socket.destroy(); });
		socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
		socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(received).toString()); });
	});
}
function bodies(raw) { return [...raw.matchAll(/\{"ip":"([^"]*)","body":"((?:\\.|[^"\\])*)"\}/g)].map((m) => JSON.parse(m[0])); }

describe('PROXY protocol on the production transport', () => {
	it('uses a trusted source and accepts ordinary direct requests on the same listener', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1', TRUSTED_PROXIES: '127.0.0.1' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame(), get()])]))[0].ip).toBe('203.0.113.99');
		expect(bodies(await exchange(rt, [get()]))[0].ip).toBe('127.0.0.1');
	});
	it('consumes metadata without substituting when the flag is disabled', async () => {
		const rt = await boot();
		expect(bodies(await exchange(rt, [Buffer.concat([frame(), get()])]))[0].ip).toBe('127.0.0.1');
	});
	it('ignores untrusted claims and does not let their source authorize a forwarded header', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1', TRUSTED_PROXIES: '203.0.113.0/24', ADDRESS_HEADER: 'x-forwarded-for' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame(), get('X-Forwarded-For: 198.51.100.8\r\n')])]))[0].ip).toBe('127.0.0.1');
	});
	it('honors a trusted forwarded header after the transport substitution', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1', TRUSTED_PROXIES: '127.0.0.1', ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '2' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame(), get('X-Forwarded-For: 198.51.100.8, 10.0.0.2\r\n')])]))[0].ip).toBe('198.51.100.8');
	});
	it('accepts fragmented IPv6 metadata in native address spelling', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const source = '2001:0db8:0000:0000:0000:0000:0000:0007';
		const bytes = Buffer.concat([frame(source, { family: 0x21, length: 36 }), get()]);
		const chunks = [...bytes.subarray(0, 52)].map((b) => Buffer.from([b]));
		chunks.push(bytes.subarray(52));
		expect(bodies(await exchange(rt, chunks))[0].ip).toBe(source);
	});
	it('consumes a LOCAL/UNSPEC frame without replacing the peer', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame('', { version: 0x20, family: 0, length: 0 }), get()])]))[0].ip).toBe('127.0.0.1');
	});
	it('retains the first claim across pipelined repeated preambles', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const raw = await exchange(rt, [Buffer.concat([frame(), get('', false), frame('198.51.100.7'), get()])]);
		expect(bodies(raw).map((b) => b.ip)).toEqual(['203.0.113.99', '203.0.113.99']);
	});
	it('accepts the first preamble on a later request and across packet boundaries', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const bytes = frame();
		const raw = await exchange(rt, [Buffer.concat([get('', false), bytes.subarray(0, 3)]), Buffer.concat([bytes.subarray(3), get()])]);
		expect(bodies(raw).map((b) => b.ip)).toEqual(['127.0.0.1', '203.0.113.99']);
	});
	it('keeps preamble bytes in fixed-length and chunked request bodies', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const content = frame();
		for (const chunked of [false, true]) {
			const head = Buffer.from(`POST /address HTTP/1.1\r\nHost: example.test\r\n${chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${content.length}`}\r\n\r\n`);
			const body = chunked ? Buffer.concat([Buffer.from(content.length.toString(16) + '\r\n'), content, Buffer.from('\r\n0\r\n\r\n')]) : content;
			const raw = await exchange(rt, [Buffer.concat([head, body, frame('198.51.100.8'), get()])]);
			const replies = bodies(raw);
			expect(replies).toHaveLength(2);
			expect(replies[0]).toEqual({ ip: '127.0.0.1', body: content.toString() });
			expect(replies[1].ip).toBe('198.51.100.8');
		}
	});
	it.each([
		['signature', () => { const b = frame(); b[5] = 0; return b; }],
		['version', () => frame(undefined, { version: 0x11 })],
		['payload ceiling', () => frame(undefined, { length: 37 })]
	])('does not dispatch a malformed %s preamble', async (_name, make) => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const socket = net.connect(rt.port, '127.0.0.1');
		cleanups.push(() => socket.destroy());
		let raw = '';
		let closed = false;
		socket.on('data', (chunk) => { raw += chunk; });
		socket.on('close', () => { closed = true; });
		await new Promise((resolve) => socket.once('connect', resolve));
		const bytes = Buffer.concat([make(), get()]);
		socket.write(bytes);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(raw).toBe('');
		expect(closed).toBe(false);
		const ended = new Promise((resolve) => socket.once('close', resolve));
		socket.write(Buffer.alloc(4096 - bytes.length, 65));
		await ended;
		expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 431 Request Header Fields Too Large');
		expect(bodies(raw)).toEqual([]);
	});
	it('accepts the payload ceiling and retains an empty first claim', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame(undefined, { length: 36 }), get()])]))[0].ip).toBe('203.0.113.99');
		const raw = await exchange(rt, [Buffer.concat([frame('', { family: 0, length: 0 }), get('', false), frame(), get()])]);
		expect(bodies(raw).map((b) => b.ip)).toEqual(['127.0.0.1', '127.0.0.1']);
	});
	it('closes an incomplete preamble during shutdown', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' });
		const socket = net.connect(rt.port, '127.0.0.1');
		cleanups.push(() => socket.destroy());
		const closed = new Promise((resolve) => socket.once('close', resolve));
		await new Promise((resolve) => socket.once('connect', resolve));
		socket.write(frame().subarray(0, 10));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await rt.close()).toBe(true);
		await closed;
	});
	it('consumes a preamble in the test server without exposing a claimed address', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({ handler: { message() {} } });
		cleanups.push(() => server.close());
		const port = Number(new URL(server.wsUrl).port);
		const raw = await exchange({ port }, [Buffer.concat([frame(), Buffer.from('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')])]);
		expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
	});
	it('reads the preamble inside TLS before HTTP', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1', SSL_CERT: fileURLToPath(new URL('./fixtures/tls/localhost.crt', import.meta.url)), SSL_KEY: fileURLToPath(new URL('./fixtures/tls/localhost.key', import.meta.url)), SSL_WATCH: '0' });
		expect(bodies(await exchange(rt, [Buffer.concat([frame(), get()])], true))[0].ip).toBe('203.0.113.99');
	});
	it('hands the effective address to authentication', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1', TRUSTED_PROXIES: '127.0.0.1' }, true);
		const request = Buffer.from('POST /__ws/auth HTTP/1.1\r\nHost: example.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
		const raw = await exchange(rt, [Buffer.concat([frame(), request])]);
		expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
		expect(JSON.parse(raw.split('\r\n\r\n')[1]).token).toBe('203.0.113.99');
	});
	it('hands the effective address to the WebSocket upgrade hook', async () => {
		const rt = await boot({ PROXY_PROTOCOL: '1' }, true);
		const upgrade = Buffer.from('GET /ws HTTP/1.1\r\nHost: example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n');
		const raw = await exchange(rt, [Buffer.concat([frame(), upgrade])]);
		expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
		expect(raw.toLowerCase().split('\r\n')).toContain('x-proxy-ip: 203.0.113.99');
	});
});