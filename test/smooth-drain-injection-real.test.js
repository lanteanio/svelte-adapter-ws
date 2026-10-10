import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';
import { createSmoothAuthority } from '../src/plugins/smooth/server.js';

it('drains all trusted injections while retaining the next client command', async () => {
	const authority = createSmoothAuthority({
		maxCommandsPerTick: 1,
		apply(state, command, ctx) {
			ctx.emitEvent('applied', command.label);
			return { x: state.x + command.dx };
		}
	});
	const server = await createTestServer({ handler: {
		message(ws, { data, platform }) {
			const request = JSON.parse(Buffer.from(data).toString());
			let result;
			if (request.operation === 'queue') {
				authority.ensure('entity', ws, { x: 0 });
				authority.enqueue('entity', [1, 2].map(id => ({ id, cmd: { dx: 1, label: id } })));
				for (let i = 1; i <= 3; i++) authority.inject('entity', { dx: 10, label: `trusted-${i}` });
				result = { queued: true };
			} else {
				const tick = authority.drain();
				for (const ack of tick.acks) platform.send(ack.ws, 'smooth', 'ack', { id: ack.id, state: ack.state });
				result = {
					acks: tick.acks.map(({ id, state }) => ({ id, state })),
					updates: tick.updates.map(({ state, commanded }) => ({ state, commanded })),
					events: tick.events.map(({ data, commanded }) => ({ data, commanded }))
				};
			}
			platform.send(ws, 'probe', 'reply', { ...result, nonce: request.nonce });
		}
	} });
	const socket = new WebSocket(server.wsUrl);
	const frames = [];
	socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
	let nonce = 0;
	async function request(operation) {
		const id = ++nonce;
		socket.send(JSON.stringify({ operation, nonce: id }));
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const reply = frames.find(frame => frame.event === 'reply' && frame.data.nonce === id);
			if (reply) return reply.data;
			await new Promise(resolve => setTimeout(resolve, 2));
		}
		throw new Error('authority reply did not reach the client');
	}
	try {
		await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
		expect((await request('queue')).queued).toBe(true);
		const first = await request('tick');
		expect(first.acks).toEqual([{ id: 1, state: { x: 31 } }]);
		expect(first.updates).toEqual([{ state: { x: 31 }, commanded: false }]);
		expect(first.events).toEqual([
			{ data: 1, commanded: true },
			{ data: 'trusted-1', commanded: false },
			{ data: 'trusted-2', commanded: false },
			{ data: 'trusted-3', commanded: false }
		]);
		const second = await request('tick');
		expect(second.acks).toEqual([{ id: 2, state: { x: 32 } }]);
		expect(second.updates).toEqual([{ state: { x: 32 }, commanded: true }]);
		expect(second.events).toEqual([{ data: 2, commanded: true }]);
		expect(frames.filter(frame => frame.event === 'ack').map(frame => frame.data))
			.toEqual([{ id: 1, state: { x: 31 } }, { id: 2, state: { x: 32 } }]);
	} finally {
		socket.terminate();
		await server.close();
	}
});
