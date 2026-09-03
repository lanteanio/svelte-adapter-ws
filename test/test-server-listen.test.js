// The harness listen seam: createTestServer reads the bound port and closes the
// listen socket through the same two helpers the simulator overrides, so one
// dispatch serves both the real node:http + ws transport and the in-memory app.
//
// The default helpers must answer from the token they are HANDED, not from a
// server captured when the helper bundle was built. Two harness servers live in
// one process routinely (a test that dials a second instance, a suite file with
// two fixtures), and a captured-server lookup reports the first one's port for
// both - which reads as a dial against the wrong server rather than as an
// error, so nothing fails where the mistake is made.

import { describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';

describe('the harness listen seam answers from the token it is handed', () => {
	it('gives two concurrent servers their own bound ports', async () => {
		const first = await createTestServer({ handler: {} });
		const second = await createTestServer({ handler: {} });
		try {
			expect(first.port).toBeGreaterThan(0);
			expect(second.port).toBeGreaterThan(0);
			expect(second.port, 'the second server reported the first one\'s port').not.toBe(first.port);
			// The advertised URLs are built from the same number, so a wrong port
			// would send every dial in the test to the other server.
			expect(first.url).toBe(`http://localhost:${first.port}`);
			expect(second.wsUrl).toBe(`ws://localhost:${second.port}/ws`);
		} finally {
			await second.close();
			await first.close();
		}
	});

	it('closes the token it is handed and leaves the other server listening', async () => {
		// The failure this guards is a close routed to a captured token rather
		// than the passed one: closing the first server would then take the
		// second one's listener down with it. Asserting the survivor still
		// serves says that directly, and needs no port to be rebound - the
		// suite runs four workers and every other harness server binds port 0,
		// so any freed port can be taken by a sibling between close and re-bind.
		const first = await createTestServer({ handler: {} });
		const second = await createTestServer({ handler: {} });
		try {
			await first.close();
			const alive = await fetch(second.url + '/__nonexistent');
			expect(alive.status).toBeGreaterThan(0);
			// Whether the first port is now refused is deliberately NOT asserted:
			// once released it can be handed to a sibling worker, which would
			// answer and fail this for a reason that has nothing to do with the
			// seam. The survivor is the half that discriminates.
		} finally {
			await second.close();
		}
	});

	it('takes an injected helper bundle over the default one', async () => {
		const seen = [];
		const server = await createTestServer({
			handler: {},
			__uws: {
				us_socket_local_port: (socket) => {
					seen.push('port');
					return socket.port;
				},
				us_listen_socket_close: (socket) => {
					seen.push('close');
					socket.close();
				}
			}
		});
		expect(seen).toEqual(['port']);
		await server.close();
		expect(seen).toEqual(['port', 'close']);
	});
});
