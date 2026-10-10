import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('store lifetime deadline');
		await pause(5);
	}
}

describe('module store ownership across nested replacement and disposal', () => {
	let client, server, connection, peers, frames, stops;
	beforeEach(async () => {
		vi.resetModules();
		client = await import('../src/client.js');
		peers = []; frames = []; stops = [];
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', bytes => frames.push({ socket, frame: JSON.parse(bytes.toString()) }));
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
		await client.ready();
	});
	afterEach(async () => {
		for (const stop of stops) stop();
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
	});
	function reconnect() {
		connection.close();
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
	}
	async function roundTrip(label) {
		expect(connection.send({ type: 'probe', label })).toBe(true);
		await waitFor(() => frames.some(value => value.socket === peers.at(-1) && value.frame.label === label));
	}
	it('unsubscribes the current socket when the initial store callback replaces its connection', async () => {
		let armed = true;
		const stop = client.on('room').subscribe(value => {
			if (armed && value === null) {
				armed = false;
				reconnect();
			}
		});
		stops.push(stop);
		await client.ready();
		await waitFor(() => peers.length === 2 && frames.some(value => value.socket === peers[1] &&
			(value.frame.topic === 'room' || value.frame.topics?.includes('room'))));
		stop();
		// The probe follows unsubscribe on the same client socket, so its server
		// receipt proves the assertion is independent of network scheduling.
		await roundTrip('released nested follower');
		expect(frames.filter(value => value.socket === peers[1] && value.frame.type === 'unsubscribe').map(value => value.frame.topic)).toEqual(['room']);
	});
	it('does not register a disposed ingress handle on a later explicit replacement', async () => {
		const binding = client.bindIngress('probe:1', { topic: 'room' });
		stops.push(() => binding.dispose());
		peers[0].send(JSON.stringify({ type: 'ingress-ok' }));
		await waitFor(() => frames.some(value => value.socket === peers[0] && value.frame.type === 'ingress-bind'));
		const original = frames.find(value => value.socket === peers[0] && value.frame.type === 'ingress-bind').frame;
		peers[0].send(JSON.stringify({ type: 'ingress-bound', id: original.id }));
		await waitFor(() => binding.live());
		binding.dispose();
		reconnect();
		await client.ready();
		await waitFor(() => peers.length === 2);
		const events = [];
		stops.push(connection.events.subscribe(value => { if (value) events.push(value); }));
		peers[1].send(JSON.stringify({ type: 'ingress-ok' }));
		peers[1].send(JSON.stringify({ topic: 'probe', event: 'barrier', data: 'announcements complete' }));
		await waitFor(() => events.some(value => value.data === 'announcements complete'));
		await roundTrip('disposed handle stays released');
		expect(frames.filter(value => value.socket === peers[1] && value.frame.type === 'ingress-bind')).toEqual([]);
		expect(binding.live()).toBe(false);
		expect(binding.send(1, new Uint8Array([1]))).toBe(false);
	});
});
