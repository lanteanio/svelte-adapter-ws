import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

function admin(request) {
	const status = Number(new URL(request.url).pathname.split('/').at(-1));
	if (status === 0) return Response.error();
	const response = new Response('private body', { headers: {
		'x-private': 'must-not-leak', 'set-cookie': 'secret=value', 'content-type': 'text/plain'
	} });
	Object.defineProperty(response, 'status', { value: status });
	return response;
}

let mirror;
let runtime;
let payload;
beforeAll(async () => {
	mirror = await createTestServer({ handler: { admin }, adminAuthAcknowledged: true });
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({
			allowedOrigins: ['http://localhost'], adminPath: '/__realtime', adminAuthAcknowledged: true
		}) },
		wsHandlerSource: 'export ' + admin.toString()
	});
	runtime = await bootRuntime(payload);
});
afterAll(async () => {
	await mirror?.close();
	await runtime?.close();
	payload?.cleanup();
});

describe.each(['mirror', 'runtime'])('%s admin status refusal', (lane) => {
	it.each([0, 99, 1000])('answers status %i with a clean 500', async (status) => {
		const port = lane === 'mirror' ? mirror.port : runtime.port;
		const response = await fetch(`http://127.0.0.1:${port}/__realtime/${status}`);
		expect(response.status).toBe(500);
		expect(response.headers.get('x-private')).toBeNull();
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.text()).toBe('{"error":"internal error"}');
	});

	it('still serves a valid application status and headers', async () => {
		const port = lane === 'mirror' ? mirror.port : runtime.port;
		const response = await fetch(`http://127.0.0.1:${port}/__realtime/201`);
		expect(response.status).toBe(201);
		expect(response.headers.get('x-private')).toBe('must-not-leak');
		expect(await response.text()).toBe('private body');
	});
});
