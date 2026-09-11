// The batch subscribe lane's resume path, driven by a real client over a real
// socket. Everything else that touches the resume buffers calls the primitives
// directly with a scripted socket, so this lane - the one the bundled client
// actually uses, because it attaches a recover map to the subscribe-batch it
// sends on every reconnect - had no coverage at all.
//
// What is pinned here is the sweep at the end of the lane. A recovered topic
// the loop never flushes has to be closed by something, and only the sweep
// does it: a buffer left registered keeps resumeBuffers non-empty for the life
// of the worker, so every later publish on that topic appends to a buffer
// nobody drains, and the topic stays pinned in the seq registry. Nothing on
// the wire looks wrong while that happens, which is why it needs a test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
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

// `resume` only has to EXIST for the recover lane to engage. Answering no
// covered seqs keeps the flush out of the way of the sweep being pinned.
const WS_HANDLER = `
export function resume() { return {}; }
export function message() {}
`;

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;
/** @type {any} */
let state;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
	// The server runs in THIS process, so the built state module the handler
	// mutates is the one imported here.
	state = await import(`${pathToFileURL(payload.dir).href}/handler/state.js`);
}, 60000);

afterAll(async () => {
	await rt?.close();
	payload?.cleanup();
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

describe('the batch subscribe lane closes every resume buffer it opens', () => {
	it('closes the buffer of a recovered topic the loop acked as already held', async () => {
		const topic = 'batch-resume-held';
		const client = connect();
		await client.open();
		try {
			client.send({ type: 'subscribe', topic, ref: 1 });
			await client.next((f) => f.json?.type === 'subscribed' && f.json.ref === 1);
			expect(state.resumeBuffers.size, 'no buffer is open before the recover batch').toBe(0);

			// The topic is already held, so the recover filter still admits it
			// (revocation needs `!held`) and the lane opens its buffer - but the
			// subscribe loop then takes the held-ack branch and continues,
			// without ever reaching the flush that would deregister it.
			client.send({ type: 'subscribe-batch', topics: [topic], ref: 2, recover: { [topic]: { offset: 0 } } });
			await client.next((f) => f.json?.type === 'subscribed' && f.json.ref === 2);

			expect(state.resumeBuffers.has(topic), 'the sweep must close a buffer the loop never flushed').toBe(false);
			expect(state.resumeBuffers.size).toBe(0);
		} finally {
			client.close();
		}
	});

	it('closes the buffers of recovered topics the grant gate denied', async () => {
		const allowed = 'batch-resume-allowed';
		const client = connect();
		await client.open();
		try {
			client.send({
				type: 'subscribe-batch',
				topics: [allowed, '__internal/denied'],
				ref: 3,
				recover: { [allowed]: { offset: 0 }, '__internal/denied': { offset: 0 } }
			});
			await client.next((f) => f.json?.type === 'subscribed' && f.json.topic === allowed && f.json.ref === 3);
			// Whatever the second topic's verdict, the lane must leave nothing
			// registered once it returns: a denied topic opens no buffer, and a
			// flushed one deregisters its own.
			expect(state.resumeBuffers.size).toBe(0);
		} finally {
			client.close();
		}
	});
});
