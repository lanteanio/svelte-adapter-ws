// Publish-egress ceilings over real sockets on the built runtime: what a
// CALLER of the platform observes (return values, delivered frames) plus the
// snapshot's refusal window - never internal state reached around the API.

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
	// Three messages per topic per second, and a tenant pool of five: small
	// enough to cross in one test tick, large enough that setup traffic
	// (subscribes) never touches it - subscribes are not publishes.
	egress: { windowMs: 60000, topic: { messages: 3 }, tenant: { messages: 5 } }
};

// The tenant resolver rides the handler module, the one function carrier.
const WS_HANDLER = `
export function egressTenantOf(topic) {
	return topic.startsWith('t1.') ? 'tenant-one' : null;
}
export function message() {}
`;

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
	/** @type {any[]} */
	const frames = [];
	/** @type {Array<(f: any) => void>} */
	const waiters = [];
	ws.on('message', (raw) => {
		let json;
		try { json = JSON.parse(raw.toString()); } catch { json = undefined; }
		const frame = { json, raw: raw.toString() };
		frames.push(frame);
		for (const w of waiters.splice(0)) w(frame);
	});
	return {
		ws,
		frames,
		open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
		send: (obj) => ws.send(JSON.stringify(obj)),
		next: (pred) => new Promise((res) => {
			const hit = frames.find(pred);
			if (hit) return res(hit);
			const check = (f) => { if (pred(f)) res(f); else waiters.push(check); };
			waiters.push(check);
		}),
		close: () => ws.close()
	};
}

async function subscribed(client, topic) {
	client.send({ type: 'subscribe', topic, ref: 1 });
	await client.next((f) => f.json?.type === 'subscribed' && f.json.topic === topic);
}

describe('publish-egress ceilings (live)', () => {
	it('refuses the publish over the topic ceiling: false to the caller, nothing on the wire, a counted refusal', async () => {
		const sub = connect();
		await sub.open();
		await subscribed(sub, 'capped.a');

		const results = [];
		for (let i = 0; i < 5; i++) {
			results.push(rt.handler.platform.publish('capped.a', 'tick', { n: i }));
		}
		// Three admitted, the fourth and fifth refused - the return value is
		// the caller's only signal, and it must say so.
		expect(results.slice(0, 3)).toEqual([true, true, true]);
		expect(results.slice(3)).toEqual([false, false]);

		await sub.next((f) => f.json?.event === 'tick' && f.json.data?.n === 2);
		const ticks = sub.frames.filter((f) => f.json?.event === 'tick');
		expect(ticks.map((f) => f.json.data.n)).toEqual([0, 1, 2]);
		// A refused publish stamps no seq: the delivered stream is gapless.
		expect(ticks.map((f) => f.json.seq)).toEqual([1, 2, 3]);

		// The refusal window reaches the snapshot on the next sampler tick.
		await new Promise((r) => setTimeout(r, 1300));
		expect(rt.handler.platform.pressure.egress.refusedTopic).toBeGreaterThanOrEqual(2);
		sub.close();
	});

	it('pools a tenant ceiling across its topics via the handler egressTenantOf export', async () => {
		const sub = connect();
		await sub.open();
		await subscribed(sub, 't1.x');
		await subscribed(sub, 't1.y');

		// Five messages admitted across BOTH topics of tenant-one (its pool),
		// even though each topic is under its own ceiling of three.
		const results = [];
		for (let i = 0; i < 3; i++) results.push(rt.handler.platform.publish('t1.x', 'e', i));
		for (let i = 0; i < 3; i++) results.push(rt.handler.platform.publish('t1.y', 'e', i));
		expect(results.filter(Boolean).length).toBe(5);
		expect(results[5]).toBe(false);
		sub.close();
	});
});
