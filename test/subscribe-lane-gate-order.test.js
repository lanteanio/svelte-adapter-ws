// The subscribe lanes' post-await gates, driven over real sockets against the
// built runtime. Every gate a lane consults after its hook or resume await
// reads whether wire authorization is ARMED fresh, and each lane answers its
// gates in the order the family's lane of the same shape does: the single
// lane caps before it lands, the batch lane lands before it caps.
//
// The wire authorization gate is runtime-mutable: platform.authorizeWireSubscribe()
// latches it on, and an app arms it while connections are live. A subscribe
// that is parked in its hook or its resume when that happens must land the
// way a subscribe sent after the arming would. Four exits are pinned here:
//
// - single lane, socket full AND gate armed while the hook was parked: the
//   subscription cap answers first, so the client hears RATE_LIMITED, the
//   code its backoff branches on. FORBIDDEN would tell it to give up. (The
//   batch lane answers FORBIDDEN for the same socket, on both adapters.)
// - single lane, gate armed while the RESUME was parked: the landing gate
//   reads it fresh and refuses the install, and the resume buffer the lane
//   opened is discarded on that exit, frames captured in the window included.
// - single lane, gate armed while the HOOK was parked, with a recover offset:
//   the revocation check in front of the resume hook reads the gate fresh,
//   so the hook is never asked for the topic's history.
// - batch lane, the same arming during the hook await: the batch's revocation
//   check reads the gate fresh too, so the denied topic is never handed to
//   the hook. A stale reading served the topic's replay history and then
//   denied the subscription in the same frame.
//
// Arming latches for the life of the runtime, so each case boots its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 16 * 1024 * 1024,
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

// The subscribe hook grants everything, and parks on the one topic the
// connection named. The resume hook records what it was asked about and parks
// when asked to. Both release through the same handle, so a case parks one of
// them at a time. `arm` turns the wire gate on the way an app does at runtime.
const WS_HANDLER = `
const seen = [];
export function subscribe(ws, topic) {
	const ud = ws.getUserData();
	if (ud.__parkTopic !== topic) return true;
	return new Promise((resolve) => { ud.__release = () => resolve(true); });
}
export function resume(ws, { lastSeenSeqs }) {
	seen.push(Object.keys(lastSeenSeqs));
	const ud = ws.getUserData();
	if (!ud.__parkResume) return {};
	return new Promise((resolve) => { ud.__release = () => resolve({}); });
}
export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	const ud = ws.getUserData();
	const reply = (event, extra) => platform.send(ws, 'probe', event, { nonce: msg.nonce, ...extra });
	if (msg.type === 'seen') reply('seen', { seen: seen.map((k) => k.slice()) });
	if (msg.type === 'park-subscribe') { ud.__parkTopic = msg.topic; reply('parked', {}); }
	if (msg.type === 'park-resume') { ud.__parkResume = true; reply('parked', {}); }
	if (msg.type === 'status') reply('status', { parked: typeof ud.__release === 'function' });
	if (msg.type === 'arm') { platform.authorizeWireSubscribe(msg.mode); reply('armed', {}); }
	if (msg.type === 'publish') { platform.publish(msg.topic, 'tick', { n: msg.n }, { seq: false }); reply('published', {}); }
	if (msg.type === 'release') { const fn = ud.__release; ud.__release = null; fn?.(); }
}
`;

/** Boot a fresh runtime with its own module instances. */
async function boot() {
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	const rt = await bootRuntime(payload);
	const dir = pathToFileURL(payload.dir).href;
	const state = await import(`${dir}/handler/state.js`);
	const caps = await import(`${dir}/utils/caps.js`);
	return {
		rt,
		state,
		caps,
		close: async () => {
			await rt.close();
			payload.cleanup();
		}
	};
}

/** @param {number} port */
function connect(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

/** The topic lists the resume hook has been handed so far, in call order. */
async function seenByResume(client, nonce) {
	client.send({ type: 'seen', nonce });
	const frame = await client.next((f) => f.json?.event === 'seen' && f.json.data?.nonce === nonce);
	return frame.json.data.seen;
}

/** Poll until `pred` holds or the budget runs out. */
async function until(pred, ms) {
	const t0 = Date.now();
	while (!(await pred())) {
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, 25));
	}
	return true;
}

/** True once the connection's hook or resume is parked and waiting. */
async function parked(client) {
	let n = 0;
	return until(async () => {
		const nonce = `s${n++}`;
		client.send({ type: 'status', nonce });
		const f = await client.next((x) => x.json?.event === 'status' && x.json.data?.nonce === nonce);
		return f.json.data.parked === true;
	}, 5000);
}

/** The subscription set of the one connection the runtime holds. */
function subscriptionsOf(b) {
	const facades = [...b.state.wsWrappers.values()];
	expect(facades.length, 'one live connection').toBe(1);
	return facades[0].getUserData()[Symbol.for('adapter-uws.ws.subscriptions')];
}

/**
 * Grow the connection's membership to `target` topics over the wire. The
 * frames are ref-less, so they are silent: the acks of an acked fill come
 * to a few hundred KiB short of the 4 MiB control-frame egress window, and
 * one late wave trips it and closes the socket. Each wave stays under the
 * in-flight subscribe budget and is confirmed by the membership count before
 * the next, since frames dispatch concurrently.
 */
async function fillTo(client, b, target) {
	const subs = subscriptionsOf(b);
	const perFrame = 256;
	const perWave = 8;
	let n = 0;
	while (subs.size < target) {
		const want = Math.min(target, subs.size + perFrame * perWave);
		while (n < want) {
			const topics = [];
			for (let i = 0; i < perFrame && n < want; i++) topics.push(`gate-order-fill:${n++}`);
			client.send({ type: 'subscribe-batch', topics });
		}
		expect(await until(() => subs.size >= want, 5000), `membership reached ${want}`).toBe(true);
	}
	expect(subs.size).toBe(target);
}

describe('single lane: a full socket whose gate was armed mid-hook hears RATE_LIMITED', () => {
	/** @type {Awaited<ReturnType<typeof boot>>} */
	let b;
	beforeAll(async () => { b = await boot(); }, 60000);
	afterAll(async () => { await b?.close(); });

	it('answers the cap before the landing gate, as the single lane of the lead does', async () => {
		const max = b.caps.MAX_SUBSCRIPTIONS_PER_CONNECTION;
		const gated = 'gate-order-parked';
		const client = connect(b.rt.port);
		await client.open();
		try {
			client.send({ type: 'park-subscribe', topic: gated, nonce: 'p' });
			await client.next((f) => f.json?.event === 'parked');
			client.send({ type: 'subscribe', topic: gated, ref: 1 });
			expect(await parked(client), 'the subscribe reached its parked hook').toBe(true);

			// While it is parked the connection fills to the cap over the wire,
			// then the app arms the gate. Both are ordinary traffic the runtime
			// accepts during another subscribe's await.
			await fillTo(client, b, max);
			client.send({ type: 'arm', mode: 'strict', nonce: 'a' });
			await client.next((f) => f.json?.event === 'armed');

			client.send({ type: 'release' });
			const answer = await client.next((f) => f.json?.ref === 1 && f.json.topic === gated);
			expect(answer.json.type).toBe('subscribe-denied');
			// The socket is both full and unauthorized. The cap is the answer
			// on this lane: RATE_LIMITED tells the client to back off and
			// retry, FORBIDDEN would tell it the topic is closed to it.
			expect(answer.json.reason).toBe('RATE_LIMITED');
		} finally {
			try { client.send({ type: 'release' }); } catch { /* already gone */ }
			client.close();
		}
	}, 60000);
});

describe('single lane: a gate armed during the resume await refuses the install', () => {
	/** @type {Awaited<ReturnType<typeof boot>>} */
	let b;
	beforeAll(async () => { b = await boot(); }, 60000);
	afterAll(async () => { await b?.close(); });

	it('denies FORBIDDEN after the resume, closes the buffer and installs nothing', async () => {
		const topic = 'gate-order-resumed';
		const client = connect(b.rt.port);
		await client.open();
		try {
			client.send({ type: 'park-resume', nonce: 'p' });
			await client.next((f) => f.json?.event === 'parked');
			client.send({ type: 'subscribe', topic, ref: 2, recover: { offset: 0 } });
			// The lane opened its buffer and is parked in the resume hook.
			expect(await until(() => b.state.resumeBuffers.has(topic), 5000), 'the lane reached its parked resume').toBe(true);
			expect(await parked(client)).toBe(true);
			// A publish landing inside the window is captured into the buffer.
			// The refused exit must discard it with the buffer: flushing it
			// would deliver a frame to a socket that was just told FORBIDDEN.
			// `{ seq: false }` stamps null, which a flush's watermark floor
			// never skips, so a flushed frame would reach the socket.
			client.send({ type: 'publish', topic, n: 0, nonce: 'inwindow' });
			await client.next((f) => f.json?.event === 'published' && f.json.data?.nonce === 'inwindow');
			expect([...b.state.resumeBuffers.get(topic)][0].frames.length, 'the window captured the frame').toBe(1);

			client.send({ type: 'arm', mode: 'strict', nonce: 'a' });
			await client.next((f) => f.json?.event === 'armed');
			client.send({ type: 'release' });

			const answer = await client.next((f) => f.json?.ref === 2 && f.json.topic === topic);
			expect(answer.json.type, 'the landing gate reads the armed gate after the await').toBe('subscribe-denied');
			expect(answer.json.reason).toBe('FORBIDDEN');
			// That exit closes the buffer the lane opened.
			expect(b.state.resumeBuffers.size, 'no resume buffer survives the refusal').toBe(0);

			// And no membership was installed: a publish on the topic reaches
			// nobody on this socket. The probe after it bounds the wait, since
			// sends to one socket stay in order. The filter also catches the
			// captured frame, had the exit flushed instead of discarded.
			client.send({ type: 'publish', topic, n: 1, nonce: 'pub' });
			await client.next((f) => f.json?.event === 'published' && f.json.data?.nonce === 'pub');
			const leaked = client.frames.filter((f) => f.json?.topic === topic && f.json?.event === 'tick');
			expect(leaked, 'the refused topic must not deliver').toEqual([]);
		} finally {
			try { client.send({ type: 'release' }); } catch { /* already gone */ }
			client.close();
		}
	}, 30000);
});

describe('single lane: a gate armed during the hook await keeps the resume hook from the denied topic', () => {
	/** @type {Awaited<ReturnType<typeof boot>>} */
	let b;
	beforeAll(async () => { b = await boot(); }, 60000);
	afterAll(async () => { await b?.close(); });

	it('reads the gate fresh in front of the resume hook, so no history is served for the denied topic', async () => {
		const control = 'gate-order-single-control';
		const topic = 'gate-order-single-fresh';
		const client = connect(b.rt.port);
		await client.open();
		try {
			// The control proves the recover lane engages for this frame shape:
			// with the gate off, the resume hook is handed the topic.
			client.send({ type: 'subscribe', topic: control, ref: 1, recover: { offset: 0 } });
			expect((await client.next((f) => f.json?.ref === 1)).json.type).toBe('subscribed');
			const seenBefore = await seenByResume(client, 'before');
			expect(seenBefore[seenBefore.length - 1]).toEqual([control]);

			client.send({ type: 'park-subscribe', topic, nonce: 'p' });
			await client.next((f) => f.json?.event === 'parked');
			client.send({ type: 'subscribe', topic, ref: 2, recover: { offset: 0 } });
			expect(await parked(client), 'the subscribe reached its parked hook').toBe(true);

			client.send({ type: 'arm', mode: 'strict', nonce: 'a' });
			await client.next((f) => f.json?.event === 'armed');
			client.send({ type: 'release' });

			const answer = await client.next((f) => f.json?.ref === 2 && f.json.topic === topic);
			expect(answer.json.type).toBe('subscribe-denied');
			expect(answer.json.reason).toBe('FORBIDDEN');
			// The resume hook was never asked about the denied topic: a stale
			// reading of the gate would have served its history first.
			const seen = await seenByResume(client, 'after');
			expect(seen.slice(seenBefore.length)).toEqual([]);
			expect(b.state.resumeBuffers.size).toBe(0);
		} finally {
			try { client.send({ type: 'release' }); } catch { /* already gone */ }
			client.close();
		}
	}, 30000);
});

describe('batch lane: a gate armed during the hook await keeps the resume hook from the denied topic', () => {
	/** @type {Awaited<ReturnType<typeof boot>>} */
	let b;
	beforeAll(async () => { b = await boot(); }, 60000);
	afterAll(async () => { await b?.close(); });

	it('reads the gate fresh in front of the resume hook, not from the pre-await snapshot', async () => {
		const fresh = 'gate-order-batch-fresh';
		const held = 'gate-order-batch-held';
		const client = connect(b.rt.port);
		await client.open();
		try {
			// A membership held before the batch: under the armed gate it is
			// the one topic whose gap-fill is still legitimate, which is what
			// proves the resume hook ran for this frame at all.
			client.send({ type: 'subscribe', topic: held, ref: 1 });
			expect((await client.next((f) => f.json?.ref === 1)).json.type).toBe('subscribed');
			const before = (await seenByResume(client, 'before')).length;

			client.send({ type: 'park-subscribe', topic: fresh, nonce: 'p' });
			await client.next((f) => f.json?.event === 'parked');
			client.send({
				type: 'subscribe-batch',
				topics: [fresh, held],
				ref: 3,
				recover: { [fresh]: { offset: 0 }, [held]: { offset: 0 } }
			});
			expect(await parked(client), 'the batch reached its parked hook').toBe(true);

			client.send({ type: 'arm', mode: 'strict', nonce: 'a' });
			await client.next((f) => f.json?.event === 'armed');
			client.send({ type: 'release' });

			const denied = await client.next((f) => f.json?.ref === 3 && f.json.topic === fresh);
			expect(denied.json.type).toBe('subscribe-denied');
			expect(denied.json.reason).toBe('FORBIDDEN');
			const acked = await client.next((f) => f.json?.ref === 3 && f.json.topic === held);
			expect(acked.json.type, 'the held topic is still acked').toBe('subscribed');

			// The resume hook ran for this frame, and was handed the held
			// topic only. A stale reading of the gate hands it both, serving
			// the denied topic's history in the same frame that denies it.
			const seen = await seenByResume(client, 'after');
			expect(seen.slice(before)).toEqual([[held]]);
			expect(b.state.resumeBuffers.size).toBe(0);
		} finally {
			try { client.send({ type: 'release' }); } catch { /* already gone */ }
			client.close();
		}
	}, 30000);
});
