// createTestServer's sendCoalesced throws a value it flushes at once to its
// caller as production does: a native error by identity, anything else thrown
// as a TypeError.

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
});

async function exchange(kind) {
	const { createTestServer } = await import('../src/testing.js');
	const server = await createTestServer({
		handler: {
			message(ws, { platform }) {
				const boom = new RangeError('boom');
				const data = { toJSON() { if (kind === 'native') throw boom; throw 'not an error'; } };
				let outcome;
				try {
					platform.sendCoalesced(ws, { key: 'k', topic: 'probe', event: 'value', data });
					outcome = { threw: false };
				} catch (err) {
					outcome = { threw: true, same: err === boom, name: err?.name, message: err?.message };
				}
				platform.send(ws, 'probe', 'outcome', outcome);
			}
		}
	});
	teardown.push(() => server.close());
	const ws = new WebSocket(server.wsUrl);
	teardown.push(() => ws.terminate());
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const reply = new Promise((resolve) => {
		ws.on('message', (raw) => {
			const frame = JSON.parse(raw.toString());
			if (frame.event === 'outcome') resolve(frame.data);
		});
	});
	ws.send(JSON.stringify({ type: 'go' }));
	return reply;
}

describe('createTestServer sendCoalesced caller failures', () => {
	it('rethrows a native serializer error by identity', async () => {
		const outcome = await exchange('native');
		expect(outcome).toEqual({ threw: true, same: true, name: 'RangeError', message: 'boom' });
	});

	it('wraps any other thrown value in a TypeError', async () => {
		const outcome = await exchange('string');
		expect(outcome).toEqual({ threw: true, same: false, name: 'TypeError', message: 'sendCoalesced data has no JSON form' });
	});
});
