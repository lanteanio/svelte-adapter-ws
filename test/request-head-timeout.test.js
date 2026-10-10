import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

let payload, runtime;
beforeAll(async () => {
	payload = buildRuntime({ serverSource: `export class Server {
		async init() {}
		async respond(request) {
			const path = new URL(request.url).pathname;
			if (path === '/slow') {
				await new Promise(resolve => setTimeout(resolve, 11000));
				return new Response('slow answer complete');
			}
			if (path === '/events') {
				let timer;
				return new Response(new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode('data: first\\n\\n'));
						timer = setInterval(() => controller.enqueue(encoder.encode('data: next\\n\\n')), 40);
					},
					cancel() { clearInterval(timer); }
				}), { headers: { 'content-type': 'text/event-stream' } });
			}
			return new Response('answer');
		}
	}` });
	runtime = await bootRuntime(payload);
	// Isolate the held-head deadline from node's separate keep-alive timeout.
	runtime.handler.server.keepAliveTimeout = 0;
}, 60000);
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });

function observe(path, suffix, wait) {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const socket = net.connect(runtime.port, '127.0.0.1');
		let raw = '', lastDataAt = 0, settled = false;
		const timers = [];
		const finish = (closed, error) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve({ raw, closed, lastDataAt, elapsed: performance.now() - started });
		};
		timers.push(setTimeout(() => finish(false), wait));
		socket.on('data', chunk => { raw += chunk.toString('latin1'); lastDataAt = performance.now() - started; });
		socket.on('end', () => finish(true));
		socket.on('error', error => finish(true, error));
		socket.on('connect', () => {
			if (path) socket.write('GET ' + path + ' HTTP/1.1\r\nHost: x\r\n\r\n');
			timers.push(setTimeout(() => socket.write(suffix), path ? 90 : 0));
		});
	});
}

describe('incomplete heads behind live answers', () => {
	it.concurrent.each(['xyz\r\n\r\n', 'xyz'])('keeps SSE delivering beyond the held-head deadline for %j', async suffix => {
		const result = await observe('/events', suffix, 11400);
		expect(result.closed).toBe(false);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(result.raw.match(/data: next/g)?.length).toBeGreaterThan(20);
		expect(result.lastDataAt).toBeGreaterThan(10600);
	}, 18000);

	it.concurrent('finishes a delayed answer before expiring the idle incomplete head', async () => {
		const result = await observe('/slow', 'xyz', 22500);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(result.raw).toContain('slow answer complete');
		expect(result.closed).toBe(true);
		expect(result.elapsed).toBeGreaterThan(20000);
	}, 28000);

	it.concurrent('still bounds an incomplete head with no answer in progress', async () => {
		const result = await observe(null, 'xyz', 11400);
		expect(result.raw).toBe('');
		expect(result.closed).toBe(true);
		expect(result.elapsed).toBeGreaterThan(9000);
	}, 18000);
});