// A batch is admitted whole or not at all, and the marker that carries that
// decision has to survive the COPY the per-entry lanes make.
//
// The harness in src/testing.js has two lanes that copy: publishWireBatch's
// stateless walk rebuilds an entry's options when the entry overrides an
// exclusion or a seq, and publishBatched's per-event fallback builds a fresh
// object per message. An entry whose copy lost the marker re-takes a decision
// its batch has already made. The first of those is driven by the vendored
// test/egress-ceilings.test.js; this file carries the second, and the vacuity
// floor both of them rest on.
//
// WHY THE BYTES CEILING IS THE ONE THAT SHOWS IT. Messages and deliveries are
// compared as `usage + this call`, so N per-entry decisions sum to exactly what
// the batch's one decision allowed and re-deciding reaches the same answer.
// Bytes are compared as `usage >= limit` against what is ALREADY charged, so
// the answer depends on when it is asked: the batch decides while the window
// holds nothing and is admitted, and by the last entry the earlier ones have
// charged past the ceiling. That entry is refused, the batch delivers a prefix
// and drops its tail, and the marker exists to prevent exactly that.
//
// The production half is test/egress-batch-marker-live.test.js: this file
// drives createTestServer, which is a separate implementation.

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';

/** Bytes are the only dimension whose answer depends on when it is asked. */
const BYTES_CEILING = { windowMs: 60000, topic: { bytes: 1 } };

/** @type {Array<{ close(): void }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

afterEach(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(30);
	for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
	await sleep(30);
});

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

async function connect(url, topic) {
	const ws = new WebSocket(url);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
	await sleep(120);
	return { ws, frames, of: (t) => frames.filter((f) => f?.topic === t && f.event === 'e') };
}

describe('the batch decision survives the per-entry copy', () => {
	it('arms a bytes ceiling that a second single publish already crosses', async () => {
		// The vacuity floor for every case below. `bytes: 1` has to be a
		// ceiling that one publish crosses, or "the whole batch was delivered"
		// is a statement about a ceiling nothing ever met and the cases would
		// pass with the marker deleted.
		const server = await boot({ egress: BYTES_CEILING });
		const c = await connect(server.wsUrl, 'solo');
		expect(server.platform.publish('solo', 'e', { n: 1 })).toBe(true);
		expect(server.platform.publish('solo', 'e', { n: 2 }), 'the bytes ceiling never bit').toBe(false);
		await sleep(120);
		expect(c.of('solo').map((f) => f.data.n)).toEqual([1]);
	});

	// The harness publishWireBatch lane is covered by the vendored
	// test/egress-ceilings.test.js, which drives the same three-entry shape with
	// the override on the last entry. What is left here is the lane that file
	// does not reach.
	it('publishBatched: every message rides the one decision the batch took', async () => {
		// The per-event fallback builds a FRESH options object per message
		// rather than copying the caller's, so the marker is written there or
		// nowhere.
		const server = await boot({ egress: BYTES_CEILING });
		const c = await connect(server.wsUrl, 'bat');
		server.platform.publishBatched([
			{ topic: 'bat', event: 'e', data: { n: 1 } },
			{ topic: 'bat', event: 'e', data: { n: 2 } },
			{ topic: 'bat', event: 'e', data: { n: 3 } }
		]);
		await sleep(150);
		expect(c.of('bat').map((f) => f.data.n), 'the batch delivered a prefix').toEqual([1, 2, 3]);
	});
});
