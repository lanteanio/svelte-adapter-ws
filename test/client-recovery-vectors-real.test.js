import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as client from '../src/client.js';

const vectors = JSON.parse(readFileSync(new URL('../test-vectors/webtransport-stream.json', import.meta.url), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('recovery vector deadline');
		await pause(5);
	}
}
function truncationVector(withRehydrate = false, inline = false) {
	const selected = vectors.recoveryTruncation.find(candidate => {
		const requests = candidate.transcript.filter(entry => entry.client);
		return requests.length === 1 && requests[0].client.type === 'subscribe' && requests[0].recovers.length === 1 &&
			candidate.written.some(message => inline ? message.frame?.event === 'end' && message.frame.data?.truncated : message.frame?.event === 'truncated') &&
			!candidate.thenResets && candidate.written.some(message => message.frame?.event === 'rehydrate') === withRehydrate;
	});
	expect(selected, 'the independent protocol transcript exists').toBeDefined();
	const request = selected.transcript.find(entry => entry.client).client;
	const frames = selected.written.map(message => message.frame);
	return { request, frames, topic: request.topic, ackAt: frames.findIndex(frame => frame.type === 'subscribed') };
}

async function recoverAfterFrames(vector, count, withoutMarker = false) {
	const { request, topic, frames } = vector;
	const peers = [], requests = [], events = [];
	const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	let connection, unsubscribe;
	const send = (socket, frame) => socket.send(JSON.stringify(frame));
	async function reconnect() {
		const previousCount = peers.length;
		peers.at(-1).terminate();
		await waitFor(() => peers.length === previousCount + 1 && requests.some(value => value.socket === peers.at(-1)));
		return requests.find(value => value.socket === peers.at(-1));
	}
	try {
		await new Promise(resolve => server.once('listening', resolve));
		server.on('connection', socket => {
			peers.push(socket);
			socket.on('message', bytes => {
				const frame = JSON.parse(bytes.toString());
				if (frame.type === 'subscribe' || frame.type === 'subscribe-batch') requests.push({ socket, frame });
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, reconnectInterval: 5, maxReconnectInterval: 5 });
		connection.events.subscribe(event => { if (event) events.push(event); });
		unsubscribe = connection.on(topic).subscribe(() => {});
		await waitFor(() => requests.length === 1);
		send(peers[0], { type: 'subscribed', topic, ref: requests[0].frame.ref, epoch: request.recover.epoch });
		send(peers[0], { topic, event: 'seed', data: 'ready', seq: request.recover.offset });
		await waitFor(() => events.some(event => event.data === 'ready'));
		const recovering = await reconnect();
		expect(recovering.frame.recover[topic], 'the real reconnect asks for the vector offset').toEqual(request.recover);
		for (const frame of frames.slice(0, count)) {
			if (withoutMarker && (frame.event === 'truncated' || (frame.event === 'end' && frame.data?.truncated))) continue;
			send(recovering.socket, frame.type === 'subscribed' ? { ...frame, ref: recovering.frame.ref } : frame);
		}
		// A wire barrier proves every preceding vector frame reached the actual
		// client before the server drops this unanswered or completed recovery.
		send(recovering.socket, { topic: 'probe', event: 'barrier', data: 'vector delivered' });
		await waitFor(() => events.some(event => event.data === 'vector delivered'));
		const next = await reconnect();
		return { recover: next.frame.recover?.[topic], markers: events.filter(event => event.topic === '__replay:' + topic).map(event => event.event) };
	} finally {
		unsubscribe?.();
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		warnings.mockRestore();
	}
}

it('clears the real reconnect offset on standalone protocol truncation, with a marker-free control', async () => {
	const vector = truncationVector();
	expect(vector.ackAt).toBeGreaterThan(0);
	const before = vector.frames.slice(0, vector.ackAt).filter(frame => frame.topic === vector.topic && typeof frame.seq === 'number');
	expect(before.length).toBeGreaterThan(0);
	const result = await recoverAfterFrames(vector, vector.ackAt + 1);
	expect(result.markers).toContain('truncated');
	expect(result.recover).toBeUndefined();
	const control = await recoverAfterFrames(vector, vector.ackAt + 1, true);
	expect(control.recover).toEqual({ offset: before.at(-1).seq, epoch: vector.frames[vector.ackAt].epoch });
});

it('clears the real reconnect offset on inline protocol truncation before acknowledgement', async () => {
	const vector = truncationVector(false, true);
	const endAt = vector.frames.findIndex(frame => frame.event === 'end' && frame.data?.truncated);
	expect(endAt).toBeGreaterThanOrEqual(0);
	expect(endAt).toBeLessThan(vector.ackAt);
	const result = await recoverAfterFrames(vector, endAt + 1);
	expect(result.markers).toContain('end');
	expect(result.recover).toBeUndefined();
	const control = await recoverAfterFrames(vector, endAt + 1, true);
	expect(control.recover).toEqual(vector.request.recover);
});

it('uses post-acknowledgement protocol progress and the replacement epoch on the real reconnect', async () => {
	const vector = truncationVector(true);
	const live = vector.frames.slice(vector.ackAt + 1).filter(frame => frame.topic === vector.topic && typeof frame.seq === 'number');
	expect(live.length).toBeGreaterThan(0);
	expect(vector.frames[vector.ackAt].epoch).not.toBe(vector.request.recover.epoch);
	const result = await recoverAfterFrames(vector, vector.frames.length);
	expect(result.recover).toEqual({ offset: live.at(-1).seq, epoch: vector.frames[vector.ackAt].epoch });
});
