// A ref-less subscribe gets deliberate silence from every refusal on the
// subscribe path - the client said it would not listen. The recover lane is
// the one exception: a caller replaying an offset that hears nothing cannot
// tell "it took" from "something refused it", so it resumes into a gap with
// nothing on the wire to notice by. These drive the refusal over real sockets
// on the built runtime, and over the in-process harness, so the two surfaces
// are pinned to the same answer rather than to each other.

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
	unsafeSameOriginWithoutHostPin: false
};

// `resume` only has to EXIST for the recover lane to engage. It answers no
// covered seqs, so a refusal cannot be confused with history it served.
const WS_HANDLER = `
export function resume() { return {}; }
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
}, 60000);

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

/** A round trip the server always answers, so "nothing came back" is a fact
 *  rather than a race: anything the frame under test emits would arrive
 *  before this ack, on the same ordered connection. */
async function quiesce(client) {
	client.send({ type: 'subscribe', topic: 'quiesce', ref: 999 });
	await client.next((f) => f.json?.type === 'subscribed' && f.json.ref === 999);
}

describe('a ref-less recover subscribe is refused loudly', () => {
	it('answers the uncorrelatable error frame naming the topic', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe', topic: 'room', recover: { offset: 0 } });
		const frame = await c.next((f) => f.json?.code === 'RECOVER_REQUIRES_REF');
		expect(frame.json).toEqual({ type: 'error', code: 'RECOVER_REQUIRES_REF', topic: 'room' });
		c.close();
	});

	it('installs no membership, so the refusal is not a subscribe in disguise', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe', topic: 'room', recover: { offset: 0 } });
		await c.next((f) => f.json?.code === 'RECOVER_REQUIRES_REF');
		await quiesce(c);
		expect(c.frames.some((f) => f.json?.type === 'subscribed' && f.json.topic === 'room')).toBe(false);
		c.close();
	});

	it('leaves a ref-less subscribe that asks for NO history silent, as the ack policy says', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe', topic: 'room' });
		await quiesce(c);
		expect(c.frames.some((f) => f.json?.code === 'RECOVER_REQUIRES_REF')).toBe(false);
		c.close();
	});

	it('leaves a ref-less subscribe carrying a MALFORMED recover silent, the way the recover lane ignores it', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe', topic: 'room', recover: { offset: -1 } });
		await quiesce(c);
		expect(c.frames.some((f) => f.json?.code === 'RECOVER_REQUIRES_REF')).toBe(false);
		c.close();
	});

	it('does not refuse the same request once it carries a ref', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe', topic: 'room', ref: 7, recover: { offset: 0 } });
		const frame = await c.next((f) => f.json?.ref === 7);
		expect(frame.json.type).toBe('subscribed');
		expect(c.frames.some((f) => f.json?.code === 'RECOVER_REQUIRES_REF')).toBe(false);
		c.close();
	});
});

describe('the batch form refuses the whole frame', () => {
	it('names no single topic, because one missing ref orphaned every history request in the map', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe-batch', topics: ['a', 'b'], recover: { a: { offset: 0 } } });
		const frame = await c.next((f) => f.json?.code === 'RECOVER_REQUIRES_REF');
		expect(frame.json).toEqual({ type: 'error', code: 'RECOVER_REQUIRES_REF', topic: null });
		c.close();
	});

	it('refuses on a recover entry naming a topic the frame does not even list', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe-batch', topics: ['a'], recover: { elsewhere: { offset: 0 } } });
		const frame = await c.next((f) => f.json?.code === 'RECOVER_REQUIRES_REF');
		expect(frame.json.topic).toBe(null);
		c.close();
	});

	it('stays silent for a ref-less batch whose recover map asks for nothing', async () => {
		const c = connect();
		await c.open();
		c.send({ type: 'subscribe-batch', topics: ['a', 'b'], recover: {} });
		await quiesce(c);
		expect(c.frames.some((f) => f.json?.code === 'RECOVER_REQUIRES_REF')).toBe(false);
		c.close();
	});
});

// The harness ships as `svelte-adapter-ws/testing` and carries its own socket
// plumbing, so it can answer a decision differently from production without
// anything noticing. These pin it to the same refusal.
describe('the harness mirror answers the same refusal', () => {
	/** @type {any} */
	let server;

	afterAll(async () => { await server?.close(); server = null; });

	async function collect(url) {
		const ws = new WebSocket(url);
		/** @type {any[]} */
		const frames = [];
		ws.on('message', (raw) => {
			let json;
			try { json = JSON.parse(raw.toString()); } catch { json = undefined; }
			frames.push(json);
		});
		await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
		return { ws, frames };
	}

	it('refuses a ref-less recover subscribe and stays silent without one', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: { resume: () => ({}), message() {} } });
		const { ws, frames } = await collect(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: 'room', recover: { offset: 0 } }));
		// A ref'd subscribe behind it is the ordering barrier: its ack cannot
		// arrive before anything the first frame emitted on the same socket.
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'quiesce', ref: 5 }));
		await new Promise((res) => {
			const tick = () => (frames.some((f) => f?.ref === 5) ? res(undefined) : setTimeout(tick, 10));
			tick();
		});

		expect(frames.find((f) => f?.code === 'RECOVER_REQUIRES_REF'))
			.toEqual({ type: 'error', code: 'RECOVER_REQUIRES_REF', topic: 'room' });
		expect(frames.some((f) => f?.type === 'subscribed' && f.topic === 'room')).toBe(false);

		ws.close();
	});
});
