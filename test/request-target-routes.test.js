// The realtime routes' exact paths - the auth path, both waiting-room paths and
// the WebSocket path behind a ceiling - are refused for a spelling that
// resolves onto them or asks SvelteKit for their data, as the probes are
// (request-target-real.test.js pins those). And the test server refuses a
// fragment on the routes it mirrors: node's parser refuses a raw byte before
// any route runs, so a `#` is what reaches the mirror's own check.
//
// Raw sockets, because every client library encodes or refuses exactly the
// bytes under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeReal = hasUWS ? describe : describe.skip;

/**
 * @param {number} port
 * @param {string} target
 * @returns {Promise<{ status: number, body: string }>}
 */
function answer(port, target) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
		});
		socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('no response within 10s')); });
		socket.on('data', (c) => chunks.push(c));
		socket.on('error', reject);
		socket.on('close', () => {
			const text = Buffer.concat(chunks).toString('latin1');
			resolve({ status: parseInt(text.split(' ')[1], 10), body: text.slice(text.indexOf('\r\n\r\n') + 4) });
		});
	});
}

const REALTIME_PATHS = ['/__ws/auth', '/__admit-check', '/__waiting-room', '/ws'];

describeReal('a target that resolves onto a realtime route', () => {
	/** @type {any} */
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'waitingdefault' }); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it('answers each route for its own spelling', async () => {
		// The routes exist on this build, so a 400 below is the resolution check
		// and not a path nothing answers.
		for (const path of REALTIME_PATHS) {
			const direct = await answer(server.port, path);
			expect(direct.status, path).not.toBe(400);
			expect(direct.status, path).not.toBe(404);
		}
	});

	it('refuses a dot segment, an escape and a data request onto each', async () => {
		for (const path of REALTIME_PATHS) {
			for (const target of ['/x/..' + path, '/%' + path.charCodeAt(1).toString(16) + path.slice(2), path + '/__data.json']) {
				const refused = await answer(server.port, target);
				expect(refused.status, target).toBe(400);
				expect(refused.body, target).toBe('Bad Request');
			}
		}
	});
});

describeReal('the request target on createTestServer', () => {
	it('refuses a fragment in the query of a route it mirrors', async () => {
		// The path still matches the mirrored route, so the answer is the route
		// guard's; a `#` in the path misses every route instead.
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({});
		try {
			expect((await answer(server.port, '/healthz?probe=1')).status).toBe(200);
			const refused = await answer(server.port, '/healthz?probe=1#x');
			expect(refused.status).toBe(400);
			expect(refused.body).toBe('Bad Request');
		} finally {
			await server.close();
		}
	});
});
