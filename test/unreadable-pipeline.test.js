import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
let payload, runtime;
beforeAll(async () => {
	payload = buildRuntime({ serverSource: `export class Server {
		async init() {}
		async respond(request) {
			if (new URL(request.url).pathname === '/slow') await new Promise(resolve => setTimeout(resolve, 90));
			if (new URL(request.url).pathname === '/events') {
				let timer; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: first\\n\\n')); timer = setInterval(() => c.enqueue(new TextEncoder().encode('data: next\\n\\n')), 30); }, cancel() { clearInterval(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
			}
			return new Response('answer');
		}
	}` });
	runtime = await bootRuntime(payload);
});
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });
describe('unreadable bytes after a request', () => {
	it('preserves an answered request in the same read', async () => {
		const result = await rawConversation(runtime.port, [[0, 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\nxyz\r\n\r\n']]);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(result.raw.endsWith('OK')).toBe(true);
		expect(result.closed).toBe(false);
	});
	it('lets the preceding asynchronous response finish', async () => {
		const result = await rawConversation(runtime.port, [[0, 'GET /slow HTTP/1.1\r\nHost: x\r\n\r\n'], [30, 'xyz\r\n\r\n']]);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(result.raw.endsWith('answer')).toBe(true);
		expect(result.closed).toBe(false);
	});
	it('leaves an existing event stream alive', async () => {
		const result = await rawConversation(runtime.port, [[0, 'GET /events HTTP/1.1\r\nHost: x\r\n\r\n'], [90, 'xyz\r\n\r\n']], { wait: 220 });
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(result.raw.match(/data: next/g).length).toBeGreaterThanOrEqual(5);
		expect(result.closed).toBe(false);
	});
});
