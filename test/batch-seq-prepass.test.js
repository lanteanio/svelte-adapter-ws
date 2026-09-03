// `platform.batch` and `platform.publishBatched` judge every entry's seq VALUE
// in their pre-pass, before one entry can draw a topic counter or reach a
// subscriber.
//
// The authority question was already answered up there; the value question used
// to happen inside each per-message publish, and the two have different
// consequences:
//
//   - batch() delivers as it loops, so an unstampable third entry delivered the
//     first two and then threw. The entries share one topic sequence, so the
//     subscriber holds seqs whose successors never arrive.
//   - publishBatched() sends after its stamping loop, so it loses no frame -
//     but the entries ahead of the bad one have already drawn the counter and
//     written max-seen. The counter then skips a number nothing was sent under,
//     a client watermark can sit above a value no client ever saw, and
//     republishing that seq once the payload is fixed reads as already-seen.
//     Nothing on the wire marks it.
//
// The pre-pass has to be independent of topology: the cluster authority check
// returns accepted without reading the value whenever the runtime is not
// multi-worker, so on a default single-process deployment it vetted nothing the
// caller wrote.

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

/** @type {any} */
let server;

afterEach(async () => { await server?.close(); server = null; });

/**
 * A subscriber that advertises the batch capability.
 *
 * The capability is load-bearing rather than incidental: publishBatched picks
 * its lane from the SUBSCRIBERS, and degrades to a per-event publish loop if
 * any interested connection cannot decode a shared frame. A client that
 * advertises nothing therefore exercises the slow lane, and the stamping loop
 * under test never runs.
 */
async function batchSubscriber(url, topics) {
	const ws = new WebSocket(url);
	/** @type {any[]} */
	const json = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		try { json.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	ws.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
	for (const topic of topics) ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
	await new Promise((res) => {
		const tick = () => (
			topics.every((t) => json.some((f) => f?.type === 'subscribed' && f.topic === t))
				? res(undefined)
				: setTimeout(tick, 5)
		);
		tick();
	});
	return {
		ws,
		json,
		/** Delivered publishes on a topic, the subscribe ack excluded. */
		of: (t) => json.filter((f) => f?.topic === t && f.type !== 'subscribed'),
		/** Every seq the client actually saw for a topic, batch frames included. */
		seqsOf: (t) => {
			const out = [];
			for (const f of json) {
				if (f?.type === 'batch' && Array.isArray(f.events)) {
					for (const e of f.events) if (e?.topic === t && e.seq != null) out.push(e.seq);
				} else if (f?.topic === t && f.type !== 'subscribed' && f.seq != null) {
					out.push(f.seq);
				}
			}
			return out;
		}
	};
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('a batch judges every entry seq before it stamps or delivers', () => {
	it('refuses a batch() whose later entry is unstampable, with nothing delivered', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const sub = await batchSubscriber(server.wsUrl, ['bt']);
		try {
			expect(() => server.platform.batch([
				{ topic: 'bt', event: 'a', data: 1 },
				{ topic: 'bt', event: 'b', data: 2 },
				{ topic: 'bt', event: 'c', data: 3, options: { seq: '5' } }
			])).toThrow(TypeError);
			await settle();
			// The prefix is the defect: two frames on the wire whose successor
			// never arrives.
			expect(sub.of('bt')).toEqual([]);
		} finally {
			sub.ws.close();
		}
	});

	it('leaves the topic counter untouched when publishBatched refuses', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		// The guard runs on its OWN topic. Sharing one with the case under test
		// draws the counter from the guard's own entries and makes the expected
		// value wrong rather than the assertion meaningful.
		const sub = await batchSubscriber(server.wsUrl, ['skip', 'guard']);
		try {
			// Vacuity guard: an accepted batch DOES draw the counter, so the
			// assertion below is about the refusal and not about the counter
			// never moving at all.
			server.platform.publishBatched([
				{ topic: 'guard', event: 'a', data: 1, options: { seq: true } },
				{ topic: 'guard', event: 'b', data: 2, options: { seq: true } }
			]);
			await settle();
			expect(sub.seqsOf('guard')).toEqual([1, 2]);
			// A batch frame proves the FAST lane ran - the shared-frame path
			// with the stamping loop, not the per-event fallback.
			expect(sub.json.some((f) => f?.type === 'batch')).toBe(true);

			// The lane under test: entry 0 is stampable, entry 1 is not.
			expect(() => server.platform.publishBatched([
				{ topic: 'skip', event: 'a', data: 1, options: { seq: true } },
				{ topic: 'skip', event: 'b', data: 2, options: { seq: 1.5 } }
			])).toThrow(TypeError);
			await settle();
			expect(sub.of('skip')).toEqual([]);

			// Assert the COUNTER, not delivery. The refusal throws before its
			// send whether the counter advanced or not, so a delivery-only
			// assertion passes against the defect. The next accepted publish is
			// what reveals a skipped number.
			server.platform.publish('skip', 'e', 9, { seq: true });
			await settle();
			expect(sub.seqsOf('skip')).toEqual([1]);
		} finally {
			sub.ws.close();
		}
	});
});
