// The batch's egress decision on the BUILT runtime.
//
// test/egress-batch-marker.test.js drives createTestServer, which is the
// harness platform in src/testing.js. Only this file reaches
// src/runtime/handler/platform.js, whose per-event fallback builds a fresh
// options object per message - so the marker is written there or nowhere, and
// this is the half that fails when it stops being written.
//
// The bytes ceiling is the dimension that makes a lost marker observable:
// messages and deliveries are compared as `usage + this call`, so N per-entry
// decisions sum to what the batch's one decision allowed, while bytes are
// compared against what is ALREADY charged. The batch is admitted while the
// window holds nothing; by the second entry the first has charged past the
// ceiling, and an entry that re-decides there is refused.

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false,
	egress: { windowMs: 60000, topic: { bytes: 1 } }
};

/** @type {any} */
let payload;
/** @type {any} */
let rt;
/** @type {WebSocket[]} */
const clients = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: 'export function message() {}\n'
	});
	rt = await bootRuntime(payload);
}, 60000);

afterAll(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await rt?.close();
	payload?.cleanup?.();
});

async function connect(topic) {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
	await new Promise((resolve, reject) => {
		const deadline = Date.now() + 3000;
		const tick = () => {
			if (frames.some((f) => f?.type === 'subscribed' && f.topic === topic)) return resolve(undefined);
			if (Date.now() > deadline) return reject(new Error('never subscribed to ' + topic));
			setTimeout(tick, 5);
		};
		tick();
	});
	return { ws, frames, of: (t) => frames.filter((f) => f?.topic === t && f.event === 'e') };
}

describe('the production batch decision survives the per-message rebuild', () => {
	it('arms a bytes ceiling that a second single publish already crosses', async () => {
		// The vacuity floor. `bytes: 1` has to be a ceiling one publish
		// crosses, or "the whole batch was delivered" says nothing about a
		// ceiling that was never met, and the case below would pass with the
		// marker deleted.
		const c = await connect('psolo');
		expect(rt.handler.platform.publish('psolo', 'e', { n: 1 })).toBe(true);
		expect(rt.handler.platform.publish('psolo', 'e', { n: 2 }), 'the bytes ceiling never bit').toBe(false);
		await sleep(150);
		expect(c.of('psolo').map((f) => f.data.n)).toEqual([1]);
	});

	it('delivers every message of a batch that its own entries would refuse', async () => {
		// The per-event fallback is reached by a batch whose topics are not all
		// held by every interested socket - each client here holds exactly one
		// of the two, which is what makes the all-see-all shared-frame path
		// impossible and sends the call down the lane that rebuilds options per
		// message.
		const a = await connect('pa');
		const b = await connect('pb');
		rt.handler.platform.publishBatched([
			{ topic: 'pa', event: 'e', data: { n: 1 } },
			{ topic: 'pa', event: 'e', data: { n: 2 } },
			{ topic: 'pb', event: 'e', data: { n: 3 } }
		]);
		await sleep(200);
		expect(a.of('pa').map((f) => f.data.n), 'the batch delivered a prefix').toEqual([1, 2]);
		expect(b.of('pb').map((f) => f.data.n)).toEqual([3]);
	});
});
