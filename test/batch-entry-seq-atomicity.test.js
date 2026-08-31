// A batch is all-or-nothing, and its per-entry seq values are judged in the
// snapshot pass BEFORE anything is stamped, admitted or delivered. The rule is
// not decorative: the entries share one topic sequence, so a batch that
// delivers a prefix and then throws leaves the subscriber holding seqs whose
// successors never arrive, and a client watermark that only advances on a
// strict greater-than discards the retry.
//
// The failure this pins is specifically a value the pre-pass ACCEPTS and the
// stamp later REFUSES. Restating the seq table at the entry site instead of
// calling the shared resolver is how the two disagree.

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmoothWireCodec } from '../src/plugins/smooth/server.js';

/** @type {any} */
let server;

afterEach(async () => { await server?.close(); server = null; });

async function subscriber(url, topic) {
	const ws = new WebSocket(url);
	/** @type {any[]} */
	const json = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		try { json.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
	await new Promise((res) => {
		const tick = () => (json.some((f) => f?.type === 'subscribed') ? res(undefined) : setTimeout(tick, 5));
		tick();
	});
	// Only delivered publishes - the subscribe ack carries the topic too.
	return { ws, json, of: (t) => json.filter((f) => f?.topic === t && f.type !== 'subscribed') };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('a batch entry seq is judged before anything is delivered', () => {
	it('refuses an over-range entry seq with nothing stamped and nothing on the wire', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const codec = createSmoothWireCodec();
		const sub = await subscriber(server.wsUrl, 'room');

		// A clean batch first, so the topic has a live counter to disturb.
		server.platform.publishWireBatch('room', 'update', [
			{ data: { key: 'a', data: { x: 1 } } }
		], codec);
		await settle();
		const before = sub.of('room').map((f) => f.seq);
		expect(before).toHaveLength(1);

		// 2^53 is one past the range the wire's double space carries
		// faithfully. It is a positive integer, so a number-only entry check
		// accepts it and the refusal lands later, mid-stamp.
		expect(() => server.platform.publishWireBatch('room', 'update', [
			{ data: { key: 'b', data: { x: 2 } } },
			{ data: { key: 'c', data: { x: 3 } } },
			{ data: { key: 'd', data: { x: 4 } }, seq: Number.MAX_SAFE_INTEGER + 1 }
		], codec)).toThrow(TypeError);

		await settle();
		// Not one entry of the refused batch reached the subscriber.
		expect(sub.of('room').map((f) => f.seq)).toEqual(before);

		// And the topic counter did not advance for the entries that were
		// never sent: the next publish continues from where the clean batch
		// left off.
		server.platform.publishWireBatch('room', 'update', [
			{ data: { key: 'e', data: { x: 5 } } }
		], codec);
		await settle();
		const after = sub.of('room').map((f) => f.seq);
		expect(after).toHaveLength(2);
		expect(after[1]).toBe(before[0] + 1);

		sub.ws.close();
	});

	it('names the offending entry position, so a long batch says which one', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const codec = createSmoothWireCodec();

		expect(() => server.platform.publishWireBatch('room', 'update', [
			{ data: { key: 'a', data: { x: 1 } } },
			{ data: { key: 'b', data: { x: 2 } } },
			{ data: { key: 'c', data: { x: 3 } }, seq: 'not a seq' }
		], codec)).toThrow(/batch entry 2:/);
	});
});
