import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

let payload;
let runtime;
beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', authPathRequireOrigin: false, authPathRateLimit: 0, adminPath: '/__realtime', adminAuthAcknowledged: true }) },
		wsHandlerSource: `export async function authenticate({ request }) {
			if (new URL(request.url).searchParams.has('read')) await request.text();
		}
		export function admin() { return new Response('ok'); }`,
		serverSource: `export class Server {
			async init() {}
			async respond(request) {
				if (new URL(request.url).searchParams.has('read')) {
					try { await request.text(); } catch { return new Response('too large', { status: 413 }); }
				}
				return new Response('ok');
			}
		}`
	});
	runtime = await bootRuntime(payload);
});
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });

function exchange(target, chunked, bytes = 200000) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(runtime.port, '127.0.0.1');
		let raw = '';
		let sent = false;
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('following request stalled: ' + raw.slice(0, 200))); }, 2500);
		socket.once('error', reject);
		socket.once('connect', () => {
			const body = 'x'.repeat(bytes);
			const framing = chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: ' + body.length;
			socket.write(`POST ${target} HTTP/1.1\r\nHost: localhost\r\n${framing}\r\n\r\n`);
			socket.write(chunked ? body.length.toString(16) + '\r\n' + body + '\r\n0\r\n\r\n' : body);
		});
		socket.on('data', (chunk) => {
			raw += chunk.toString('latin1');
			if (!sent && raw.includes('\r\n\r\n')) {
				sent = true;
				// Wait for the answer before the next request, so the test is
				// about draining unread bodies, not concurrent response policy.
				socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			}
		});
		socket.on('close', () => { clearTimeout(timer); resolve(raw); });
	});
}

describe('unread request bodies on keep-alive connections', () => {
	it.each([false, true])('drains an unread SSR body (chunked=%s)', async (chunked) => {
		const raw = await exchange('/ignore', chunked);
		expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200']);
		expect(raw.endsWith('OK')).toBe(true);
	});
	it('drains an unread admin body', async () => {
		const raw = await exchange('/__realtime/ignore', true);
		expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200']);
	});
	it('drains a streamed SSR body after its size refusal', async () => {
		const raw = await exchange('/ignore?read', true, 1024 * 1024);
		expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 413', 'HTTP/1.1 200']);
	});
	it.each(['', '?read'])('drains a streamed auth body after its answer (%s)', async (query) => {
		const raw = await exchange('/__ws/auth' + query, true);
		expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual([query ? 'HTTP/1.1 413' : 'HTTP/1.1 204', 'HTTP/1.1 200']);
		expect(raw.endsWith('OK')).toBe(true);
	});
});
