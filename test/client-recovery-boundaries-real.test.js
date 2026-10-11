import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as client from '../src/client.js';
import { onReplay } from '../src/plugins/replay/client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('client recovery deadline');
		await pause(5);
	}
}

describe('recovery state at actual socket boundaries', () => {
	let server, connection, peers, requests, events, stops, warnings;
	const send = (socket, frame) => socket.send(JSON.stringify(frame));
	beforeEach(async () => {
		peers = []; requests = []; events = []; stops = [];
		warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', bytes => requests.push({ socket, frame: JSON.parse(bytes.toString()) }));
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, reconnectInterval: 5, maxReconnectInterval: 5 });
		stops.push(connection.events.subscribe(event => { if (event) events.push(event); }));
		await client.ready();
		await waitFor(() => peers.length === 1);
	});
	afterEach(async () => {
		for (const stop of stops) stop();
		connection.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		vi.restoreAllMocks();
	});
	async function barrier(socket, data) {
		send(socket, { topic: 'probe', event: 'barrier', data });
		await waitFor(() => events.some(event => event.data === data));
	}
	function subscription(socket) {
		return requests.find(request => request.socket === socket && ['subscribe', 'subscribe-batch'].includes(request.frame.type));
	}
	async function seed() {
		stops.push(connection.on('room').subscribe(() => {}));
		await waitFor(() => subscription(peers[0]));
		send(peers[0], { type: 'subscribed', topic: 'room', ref: subscription(peers[0]).frame.ref, epoch: 7 });
		send(peers[0], { topic: 'room', event: 'put', data: 'initial', seq: 1 });
		await barrier(peers[0], 'seeded');
	}
	async function reconnect() {
		const count = peers.length;
		peers.at(-1).terminate();
		await waitFor(() => peers.length === count + 1 && subscription(peers.at(-1)));
		return subscription(peers.at(-1));
	}
	for (const marker of ['truncated', 'gap', 'rehydrate']) {
		it('discards speculative progress when ' + marker + ' precedes its matching acknowledgement', async () => {
			await seed();
			const pending = await reconnect();
			expect(pending.frame.recover.room).toEqual({ offset: 1, epoch: 7 });
			send(pending.socket, { topic: 'room', event: 'put', data: 'ahead', seq: 10 });
			send(pending.socket, { topic: '__replay:room', event: marker, data: marker === 'rehydrate' ? { epoch: 9 } : null });
			send(pending.socket, { type: 'subscribed', topic: 'room', ref: pending.frame.ref, epoch: marker === 'rehydrate' ? 9 : 7 });
			await barrier(pending.socket, 'acknowledged');
			expect((await reconnect()).frame.recover?.room).toBeUndefined();
		});
	}
	it('records fresh progress after a replaced socket no longer has an offset to recover', async () => {
		await seed();
		const pending = await reconnect();
		send(pending.socket, { topic: '__replay:room', event: 'truncated', data: null });
		await barrier(pending.socket, 'lost');
		const fresh = await reconnect();
		expect(fresh.frame.recover?.room).toBeUndefined();
		send(fresh.socket, { type: 'subscribed', topic: 'room', ref: fresh.frame.ref, epoch: 7 });
		send(fresh.socket, { topic: 'room', event: 'put', data: 'fresh', seq: 20 });
		await barrier(fresh.socket, 'fresh delivered');
		expect((await reconnect()).frame.recover.room).toEqual({ offset: 20, epoch: 7 });
	});
	it('ignores a retained truncation before its replay request is sent', async () => {
		stops.push(connection.on('__replay:chat').subscribe(() => {}));
		send(peers[0], { topic: '__replay:chat', event: 'truncated', data: null });
		await barrier(peers[0], 'old marker delivered');
		const received = [];
		stops.push(onReplay('chat', { since: 1 }).subscribe(event => { if (event) received.push(event); }));
		expect(received).toEqual([]);
		await waitFor(() => requests.some(request => request.frame.type === 'replay'));
		send(peers[0], { topic: '__replay:chat', event: 'truncated', data: null });
		await barrier(peers[0], 'current marker delivered');
		expect(received).toEqual([{ topic: 'chat', event: 'truncated', data: null }]);
	});
	it('ignores truncation after the replay send is refused', async () => {
		const refused = vi.spyOn(connection, 'send').mockReturnValueOnce(false);
		const received = [];
		stops.push(onReplay('chat', { since: 1 }).subscribe(event => { if (event) received.push(event); }));
		await waitFor(() => refused.mock.calls.length === 1);
		expect(refused.mock.calls[0][0].type).toBe('replay');
		expect(requests.filter(request => request.frame.type === 'replay')).toEqual([]);
		refused.mockRestore();
		send(peers[0], { topic: '__replay:chat', event: 'truncated', data: null });
		await barrier(peers[0], 'refused marker delivered');
		expect(received).toEqual([]);
	});
});
