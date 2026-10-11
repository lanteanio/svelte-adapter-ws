import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const slot = Symbol.for('head-response-body-test');
describe('HEAD response body ownership', () => {
	let payload, runtime;
	beforeAll(async () => {
		payload = buildRuntime({ serverSource: `
		const state = { calls: 0, reads: 0, cancels: 0 };
		globalThis[Symbol.for('head-response-body-test')] = state;
		export class Server {
			async init() {}
			async respond(request) {
				if (new URL(request.url).pathname !== '/head') return new Response('ok');
				state.calls++;
				await new Promise(resolve => setTimeout(resolve, 20));
				return new Response(new ReadableStream({
					pull() { state.reads++; return new Promise(() => {}); },
					cancel() { state.cancels++; }
				}, { highWaterMark: 0 }), { headers: { 'content-length': '200000', 'transfer-encoding': 'chunked' } });
			}
		}` });
		runtime = await bootRuntime(payload);
	});
	afterAll(async () => { await runtime?.close(); payload?.cleanup(); delete globalThis[slot]; });
	it('answers concurrent anonymous HEAD requests without reading or sharing their bodies', async () => {
		const head = () => new Promise((resolve, reject) => {
			const req = request(runtime.origin + '/head', { method: 'HEAD' }, response => {
				let bytes = 0;
				response.on('data', chunk => { bytes += chunk.length; });
				response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes }));
				response.on('error', reject);
			});
			req.setTimeout(2000, () => req.destroy(new Error('HEAD waited for response body')));
			req.on('error', reject); req.end();
		});
		const responses = await Promise.all([head(), head()]);
		for (const response of responses) {
			expect(response.status).toBe(200);
			expect(response.bytes).toBe(0);
			expect(response.headers['content-length']).toBe('200000');
			expect(response.headers['transfer-encoding']).toBeUndefined();
		}
		expect(globalThis[slot]).toEqual({ calls: 2, reads: 0, cancels: 2 });
	});
});
