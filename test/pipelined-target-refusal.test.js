import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
let payload, runtime;
beforeAll(async () => { payload = buildRuntime(); runtime = await bootRuntime(payload); });
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });
const bad = 'GET /caf\xc3\xa9 HTTP/1.1\r\nHost: x\r\n\r\n';
describe('refused targets in a pipeline', () => {
	it.each(['GET', 'HEAD'])('answers the %s ahead and then the refused GET with its body', async method => {
		const result = await rawConversation(runtime.port, [[0, method + ' /api/tiny HTTP/1.1\r\nHost: x\r\n\r\n' + bad]]);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 400']);
		expect(result.raw.endsWith('Bad Request')).toBe(true);
		expect(result.closed).toBe(false);
	});
	it('answers a synchronous health probe before the target refusal', async () => {
		const result = await rawConversation(runtime.port, [[0, 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n' + bad]]);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 400']);
		expect(result.raw).toContain('OKHTTP/1.1 400');
		expect(result.closed).toBe(false);
	});
	it('closes an overlapping asynchronous request without misrouting the refusal', async () => {
		const result = await rawConversation(runtime.port, [[0, 'GET /api/slow HTTP/1.1\r\nHost: x\r\n\r\n' + bad]]);
		expect(result.raw).toBe('');
		expect(result.closed).toBe(true);
	});
});
