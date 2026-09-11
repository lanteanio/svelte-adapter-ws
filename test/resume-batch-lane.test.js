// The subscribe lanes' resume path, driven by a real client over a real
// socket against the built runtime. The bundled client attaches a recover map
// to the subscribe-batch it sends on every reconnect, so the batch lane is the
// one a reconnecting app actually exercises; the single lane is the same
// contract one topic at a time.
//
// What is pinned here is that every resume buffer a lane opens is closed
// again, whichever exit the lane takes. A buffer left registered keeps
// resumeBuffers non-empty for the life of the worker, so every later publish
// on that topic appends to a buffer nobody drains, and the topic stays pinned
// in the seq registry. Nothing on the wire looks wrong while that happens,
// which is why it needs a test. Also pinned: a topic the subscribe hook denies
// opens no buffer and is never handed to the resume hook, and a flush that
// closes the connection stops the batch loop with nothing after it subscribed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	// Low enough that a flush into a client that stopped reading is refused
	// partway, which is what makes the close-under-flush exit reachable.
	maxBackpressure: 4096,
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

// `resume` has to EXIST for the recover lane to engage; it records the topics
// it was asked about, answers nothing covered, and parks when the connection
// asked it to so the capture window stays open for a spill. `subscribe` denies
// one syntactically valid topic, which is the shape of an app-side grant
// refusal (a `__` topic would be refused earlier, before the recover lane).
const DENIED = 'batch-resume-denied';
const WS_HANDLER = `
const seen = [];
export function subscribe(ws, topic) { return topic !== ${JSON.stringify(DENIED)}; }
export function resume(ws, { lastSeenSeqs }) {
	seen.push(Object.keys(lastSeenSeqs));
	const ud = ws.getUserData();
	if (!ud.__park) return {};
	return new Promise((resolve) => { ud.__release = () => resolve({}); });
}
export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'seen') platform.send(ws, 'probe', 'seen', { nonce: msg.nonce, seen: seen.map((k) => k.slice()) });
	if (msg.type === 'park') { ws.getUserData().__park = true; platform.send(ws, 'probe', 'parked', { nonce: msg.nonce }); }
	if (msg.type === 'spill') {
		const payload = 'x'.repeat(msg.bytes);
		for (let i = 0; i < msg.count; i++) platform.publish(msg.topic, 'tick', { i, payload }, { seq: false });
		platform.send(ws, 'probe', 'spilled', { count: msg.count });
	}
	if (msg.type === 'release') { const ud = ws.getUserData(); const fn = ud.__release; ud.__release = null; fn?.(); }
}
`;

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;
/** @type {any} */
let state;
/** @type {any} */
let registry;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
	// The server runs in THIS process, so the built modules the handler
	// mutates are the ones imported here.
	const dir = pathToFileURL(payload.dir).href;
	state = await import(`${dir}/handler/state.js`);
	registry = await import(`${dir}/handler/topic-registry.js`);
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
	/** @type {number[]} */
	const closes = [];
	ws.on('message', (raw) => {
		let json;
		try { json = JSON.parse(raw.toString()); } catch { json = undefined; }
		const frame = { json, raw: raw.toString() };
		frames.push(frame);
		for (const w of waiters.splice(0)) w(frame);
	});
	ws.on('close', (code) => { closes.push(code); });
	return {
		ws,
		frames,
		closes,
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

/** The topic lists the resume hook has been handed so far, in call order. */
async function seenByResume(client, nonce) {
	client.send({ type: 'seen', nonce });
	const frame = await client.next((f) => f.json?.event === 'seen' && f.json.data?.nonce === nonce);
	return frame.json.data.seen;
}

/** Poll until `pred` holds or the budget runs out. */
async function until(pred, ms) {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, 25));
	}
	return true;
}

describe('the subscribe lanes close every resume buffer they open', () => {
	it('batch: closes the buffer of a recovered topic the loop acked as already held', async () => {
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

	it('single: closes the buffer of a recovered topic that turns out to be already held', async () => {
		const topic = 'single-resume-held';
		const client = connect();
		await client.open();
		try {
			client.send({ type: 'subscribe', topic, ref: 1 });
			await client.next((f) => f.json?.type === 'subscribed' && f.json.ref === 1);
			expect(state.resumeBuffers.size).toBe(0);
			// A recover request skips the pre-await held check (live membership
			// arriving during the await carries no history), opens the window,
			// and only after the resume await finds the topic held: that exit
			// acks and must close the window it opened.
			client.send({ type: 'subscribe', topic, ref: 2, recover: { offset: 0 } });
			await client.next((f) => f.json?.type === 'subscribed' && f.json.ref === 2);
			expect(state.resumeBuffers.has(topic), 'the held-ack exit must close its buffer').toBe(false);
			expect(state.resumeBuffers.size).toBe(0);
		} finally {
			client.close();
		}
	});

	it('batch: a topic the subscribe hook denies opens no buffer and is never handed to the resume hook', async () => {
		const allowed = 'batch-resume-allowed';
		const client = connect();
		await client.open();
		try {
			const before = (await seenByResume(client, 'before')).length;
			// Park the resume hook so the buffers can be read while the lane is
			// inside it: that is the only moment "never opened" is distinguishable
			// from "opened and swept at the end".
			client.send({ type: 'park', nonce: 'p' });
			await client.next((f) => f.json?.event === 'parked');
			client.send({
				type: 'subscribe-batch',
				topics: [allowed, DENIED],
				ref: 3,
				recover: { [allowed]: { offset: 0 }, [DENIED]: { offset: 0 } }
			});
			expect(await until(() => state.resumeBuffers.has(allowed), 5000), 'the lane reached its parked hook').toBe(true);
			// The denial is decided BEFORE the recover set is built: the admitted
			// topic holds a buffer, the denied one never got one.
			expect(state.resumeBuffers.has(allowed)).toBe(true);
			expect(state.resumeBuffers.has(DENIED), 'a denied topic opens no buffer').toBe(false);
			expect(state.resumeBuffers.size).toBe(1);
			client.send({ type: 'release' });
			await client.next((f) => f.json?.type === 'subscribed' && f.json.topic === allowed && f.json.ref === 3);
			const denied = await client.next((f) => f.json?.type === 'subscribe-denied' && f.json.topic === DENIED && f.json.ref === 3);
			expect(denied.json.reason).toBe('FORBIDDEN');
			// And the hook served history for the admitted topic only.
			const seen = await seenByResume(client, 'after');
			expect(seen.slice(before)).toEqual([[allowed]]);
			expect(state.resumeBuffers.size).toBe(0);
		} finally {
			// A failure above may leave the lane parked; let it finish so its
			// buffers close and no later case reads them.
			try { client.send({ type: 'release' }); } catch { /* already gone */ }
			client.close();
		}
	});

	it('batch: a flush that closes the connection stops the loop, and the sweep closes the rest', async () => {
		const first = 'batch-resume-spill';
		const second = 'batch-resume-after-spill';
		const bystander = connect();
		await bystander.open();
		const victim = connect();
		await victim.open();
		try {
			// Park the resume hook so the capture window stays open while the
			// spill lands in it.
			victim.send({ type: 'park', nonce: 'p' });
			await victim.next((f) => f.json?.event === 'parked');
			victim.send({
				type: 'subscribe-batch',
				topics: [first, second],
				ref: 4,
				recover: { [first]: { offset: 0 }, [second]: { offset: 0 } }
			});
			// Both buffers are open once the lane has reached its parked hook;
			// the spill sent after that lands in the first topic's buffer.
			expect(await until(() => state.resumeBuffers.has(first) && state.resumeBuffers.has(second), 5000), 'both recovered topics hold a buffer while the hook is parked').toBe(true);
			// Enough held bytes to bury a reader that stopped: the flush pushes
			// all of them in one synchronous loop.
			victim.send({ type: 'spill', topic: first, count: 160, bytes: 32 * 1024 });
			await victim.next((f) => f.json?.event === 'spilled');
			expect([...state.resumeBuffers.get(first)][0].frames.length, 'the spill was captured, not sent live').toBe(160);

			// Stop reading, then release: the flush of the FIRST topic finds the
			// socket past its ceiling, refuses the rest and the marker, and
			// closes the connection. The loop must stop there.
			victim.ws._socket.pause();
			const aborts = state.counters.closedWsAborts;
			victim.send({ type: 'release' });
			expect(await until(() => state.resumeBuffers.size === 0, 10000), 'the lane returned and swept').toBe(true);
			victim.ws._socket.resume();
			expect(await until(() => victim.closes.length > 0, 10000), 'the victim saw its close').toBe(true);
			// The close frame is written after the frames the socket accepted
			// (a refused frame is never queued), so on this transport the victim
			// does read the flush's own code.
			expect(victim.closes, 'the flush closed the connection, nothing else did').toEqual([1013]);

			// The topic after the closing flush was never subscribed: nothing
			// touched the dead socket, so nothing was charged for it either.
			expect(registry.numSubscribers(second), 'the loop stopped before the second topic').toBe(0);
			expect(registry.numSubscribers(first)).toBe(0);
			expect(state.counters.closedWsAborts - aborts).toBe(0);
			// The worker is still serving.
			bystander.send({ type: 'seen', nonce: 'alive' });
			const alive = await bystander.next((f) => f.json?.event === 'seen' && f.json.data?.nonce === 'alive');
			expect(alive).toBeDefined();
		} finally {
			try { victim.ws._socket.resume(); } catch { /* already gone */ }
			try { victim.send({ type: 'release' }); } catch { /* already gone */ }
			victim.close();
			bystander.close();
		}
	}, 30000);
});
