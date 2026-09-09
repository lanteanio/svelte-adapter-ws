// The binary wire end-to-end over real sockets: capability-negotiated 0x03
// fan-out with the wire-id announce ordering, JSON delivery for everyone
// else, and the client-to-server ingress lane.

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { encodeValue } from '../src/runtime/wire-value.js';
import { buildBinaryFrame, parseBinaryFrame } from '../src/runtime/wire.js';

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

// A stateless test codec: the payload is the UTF-8 JSON of [event, data].
// A stateful twin counts encodes in its per-connection state and prefixes
// the count byte, proving per-connection codec state is really per-connection.
const WS_HANDLER = `
const statelessCodec = {
	capability: 'test.codec:1',
	schemaVersion: 1,
	encode(event, data) {
		return new TextEncoder().encode(JSON.stringify([event, data]));
	}
};
const statefulCodec = {
	capability: 'test.stateful:1',
	schemaVersion: 1,
	encode(event, data, state) {
		state.count++;
		const body = new TextEncoder().encode(JSON.stringify([event, data]));
		const out = new Uint8Array(body.length + 1);
		out[0] = state.count;
		out.set(body, 1);
		return out;
	},
	state: {
		onAttach() { return { count: 0 }; }
	}
};

export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'publishWire') {
		platform.publishWire(cmd.topic, cmd.event, cmd.data, statelessCodec, cmd.options);
	} else if (cmd.cmd === 'publishWireStateful') {
		platform.publishWire(cmd.topic, cmd.event, cmd.data, statefulCodec, cmd.options);
	} else if (cmd.cmd === 'sendWire') {
		platform.sendWire(ws, cmd.topic, cmd.event, cmd.data, statelessCodec);
	} else if (cmd.cmd === 'grant') {
		platform.grantPublish(ws, cmd.topic);
	} else if (cmd.cmd === 'publishWireBatch') {
		platform.publishWireBatch(cmd.topic, cmd.event, cmd.entries, statelessCodec, cmd.options);
	} else if (cmd.cmd === 'publishWireBatchExcluding') {
		// 'me' is this socket, 'peer' the topic's other subscriber: the
		// entries and options name real server-side sockets.
		let peer = null;
		platform.forEachSubscriber(cmd.topic, (sub) => { if (sub !== ws) peer = sub; });
		const resolve = (v) => (v === 'me' ? ws : v === 'peer' ? peer : v);
		const entries = cmd.entries.map((e) => ('excludeWs' in e ? { ...e, excludeWs: resolve(e.excludeWs) } : e));
		const options = cmd.options && 'excludeWs' in cmd.options ? { ...cmd.options, excludeWs: resolve(cmd.options.excludeWs) } : cmd.options;
		platform.publishWireBatch(cmd.topic, cmd.event, entries, statelessCodec, options);
	}
}
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
	/** @type {Array<{ json?: any, binary?: Uint8Array }>} */
	const frames = [];
	/** @type {Array<(f: any) => void>} */
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		/** @type {any} */
		let frame;
		if (isBinary) {
			frame = { binary: new Uint8Array(/** @type {Buffer} */ (raw)) };
		} else {
			try { frame = { json: JSON.parse(raw.toString()) }; } catch { frame = { raw: raw.toString() }; }
		}
		frames.push(frame);
		for (const waiter of waiters.splice(0)) waiter(frame);
	});
	return {
		ws,
		frames,
		open: () => new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		}),
		next: (match) => new Promise((resolve, reject) => {
			const existing = frames.find(match);
			if (existing) { resolve(existing); return; }
			const timer = setTimeout(() => reject(new Error('frame timeout: ' + JSON.stringify(frames))), 3000);
			const check = (frame) => {
				if (match(frame)) { clearTimeout(timer); resolve(frame); }
				else waiters.push(check);
			};
			waiters.push(check);
		}),
		send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
		sendBinary: (bytes) => ws.send(bytes),
		close: () => ws.close()
	};
}

describe('binary egress', () => {
	it('announces the wire-id before the first 0x03 frame and delivers the codec payload', async () => {
		const capable = connect();
		const plain = connect();
		await capable.open();
		await plain.open();
		capable.send({ type: 'hello', caps: ['test.codec:1'] });
		capable.send({ type: 'subscribe', topic: 'binroom', ref: 1 });
		plain.send({ type: 'subscribe', topic: 'binroom', ref: 1 });
		await capable.next((f) => f.json?.type === 'subscribed');
		await plain.next((f) => f.json?.type === 'subscribed');

		plain.send(JSON.stringify({ cmd: 'publishWire', topic: 'binroom', event: 'tick', data: { n: 1 } }));

		const announce = await capable.next((f) => f.json?.type === 'wire-id');
		expect(announce.json.topic).toBe('binroom');
		const binary = await capable.next((f) => f.binary !== undefined);
		// The announce precedes the first binary frame on the same socket.
		expect(capable.frames.indexOf(announce)).toBeLessThan(capable.frames.indexOf(binary));
		const parsed = parseBinaryFrame(binary.binary);
		expect(parsed?.topicId).toBe(announce.json.id);
		expect(parsed?.schemaVersion).toBe(1);
		expect(parsed?.seq).toBeGreaterThan(0);
		expect(JSON.parse(new TextDecoder().decode(parsed.payload))).toEqual(['tick', { n: 1 }]);

		// The JSON subscriber got the envelope with the SAME seq.
		const envelope = await plain.next((f) => f.json?.topic === 'binroom' && f.json?.event === 'tick');
		expect(envelope.json.seq).toBe(parsed.seq);
		capable.close();
		plain.close();
	});

	it('keeps stateful codec state per connection', async () => {
		const a = connect();
		const b = connect();
		await a.open();
		await b.open();
		a.send({ type: 'hello', caps: ['test.stateful:1'] });
		b.send({ type: 'hello', caps: ['test.stateful:1'] });
		a.send({ type: 'subscribe', topic: 'stateroom', ref: 1 });
		b.send({ type: 'subscribe', topic: 'stateroom', ref: 1 });
		await a.next((f) => f.json?.type === 'subscribed');
		await b.next((f) => f.json?.type === 'subscribed');

		a.send(JSON.stringify({ cmd: 'publishWireStateful', topic: 'stateroom', event: 'up', data: 1 }));
		const firstA = await a.next((f) => f.binary !== undefined);
		const firstB = await b.next((f) => f.binary !== undefined);
		// Both connections see encode-count 1: each has its own state.
		expect(parseBinaryFrame(firstA.binary)?.payload[0]).toBe(1);
		expect(parseBinaryFrame(firstB.binary)?.payload[0]).toBe(1);

		a.send(JSON.stringify({ cmd: 'publishWireStateful', topic: 'stateroom', event: 'up', data: 2 }));
		const secondA = await a.next((f) => f.binary !== undefined && f !== firstA);
		expect(parseBinaryFrame(secondA.binary)?.payload[0]).toBe(2);
		a.close();
		b.close();
	});

	it('sendWire targets one connection with the negotiated form', async () => {
		const capable = connect();
		await capable.open();
		capable.send({ type: 'hello', caps: ['test.codec:1'] });
		await capable.next((f) => f.json?.type === 'welcome');
		capable.send(JSON.stringify({ cmd: 'sendWire', topic: 'direct', event: 'hi', data: 'there' }));
		const binary = await capable.next((f) => f.binary !== undefined);
		const parsed = parseBinaryFrame(binary.binary);
		expect(parsed?.seq).toBe(0);
		expect(JSON.parse(new TextDecoder().decode(parsed.payload))).toEqual(['hi', 'there']);
		capable.close();
	});
});

describe('binary ingress (game twin)', () => {
	it('binds an ingress id and relays a 0x03 game frame to the room', async () => {
		const sender = connect();
		const receiver = connect();
		await sender.open();
		await receiver.open();

		sender.send({ type: 'hello', caps: ['wire.ingress:1'] });
		await sender.next((f) => f.json?.type === 'ingress-ok');
		sender.send({ type: 'subscribe', topic: 'arena', ref: 1 });
		receiver.send({ type: 'subscribe', topic: 'arena', ref: 1 });
		await sender.next((f) => f.json?.type === 'subscribed');
		await receiver.next((f) => f.json?.type === 'subscribed');
		sender.send(JSON.stringify({ cmd: 'grant', topic: 'arena' }));
		sender.send({ type: 'ingress-bind', id: 1, kind: 'game:1' });
		await sender.next((f) => f.json?.type === 'ingress-bound' && f.json?.id === 1);

		const payloadBytes = encodeValue(['move', { x: 3 }, 'input-7']);
		sender.sendBinary(buildBinaryFrame(1, 1, 1, payloadBytes));

		const relayed = await receiver.next((f) => f.json?.topic === 'arena' && f.json?.event === 'move');
		expect(relayed.json.data).toEqual({ x: 3 });
		expect(relayed.json.id).toBe('input-7');
		expect(typeof relayed.json.seq).toBe('number');
		// Sender is excluded from its own fan-out.
		expect(sender.frames.find((f) => f.json?.event === 'move')).toBeUndefined();
		sender.close();
		receiver.close();
	});

	it('denies an ungranted ingress game frame', async () => {
		const sender = connect();
		await sender.open();
		sender.send({ type: 'hello', caps: ['wire.ingress:1'] });
		await sender.next((f) => f.json?.type === 'ingress-ok');
		sender.send({ type: 'ingress-bind', id: 2, kind: 'game:1' });
		await sender.next((f) => f.json?.type === 'ingress-bound');
		sender.sendBinary(buildBinaryFrame(1, 2, 1, encodeValue(['move', {}, 9])));
		const denied = await sender.next((f) => f.json?.type === 'game-denied');
		expect(denied.json.reason).toBe('FORBIDDEN');
		expect(denied.json.id).toBe(9);
		sender.close();
	});
});

describe('publish option contracts', () => {
	it('publishWireBatch under { seq: false } stamps nothing and leaves the counter untouched', async () => {
		const sub = connect();
		await sub.open();
		sub.send({ type: 'subscribe', topic: 'noseq.room', ref: 1 });
		await sub.next((f) => f.json?.type === 'subscribed');

		sub.send(JSON.stringify({
			cmd: 'publishWireBatch', topic: 'noseq.room', event: 'tick',
			entries: [{ data: 1 }, { data: 2 }], options: { seq: false }
		}));
		const first = await sub.next((f) => f.json?.event === 'tick' && f.json?.data === 1);
		const second = await sub.next((f) => f.json?.event === 'tick' && f.json?.data === 2);
		// The batch renounced the counter: no seq on the wire...
		expect(first.json.seq).toBeUndefined();
		expect(second.json.seq).toBeUndefined();

		// ...and no counter advance behind the scenes: the topic's first
		// SEQUENCED publish still stamps 1.
		sub.send(JSON.stringify({ cmd: 'publishWire', topic: 'noseq.room', event: 'stamped', data: null }));
		const stamped = await sub.next((f) => f.json?.event === 'stamped');
		expect(stamped.json.seq).toBe(1);
		sub.close();
	});

	it('publishWireBatch through a stateless codec reaches a capable subscriber as one 0x03 frame per entry', async () => {
		// A stateless codec gains nothing from a batched walk, so the batch
		// is rerouted through publishWire entry by entry: a capable
		// subscriber receives N per-entry binary frames (never one
		// `<event>-batch` frame), a JSON subscriber the N envelopes, each
		// entry stamped with its own seq, in entry order.
		const capable = connect();
		const plain = connect();
		await capable.open();
		await plain.open();
		capable.send({ type: 'hello', caps: ['test.codec:1'] });
		capable.send({ type: 'subscribe', topic: 'statelessbatch', ref: 1 });
		plain.send({ type: 'subscribe', topic: 'statelessbatch', ref: 1 });
		await capable.next((f) => f.json?.type === 'subscribed');
		await plain.next((f) => f.json?.type === 'subscribed');

		plain.send(JSON.stringify({
			cmd: 'publishWireBatch', topic: 'statelessbatch', event: 'tick',
			entries: [{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]
		}));

		const third = await plain.next((f) => f.json?.event === 'tick' && f.json?.data?.n === 3);
		const envelopes = plain.frames.filter((f) => f.json?.topic === 'statelessbatch' && f.json?.event === 'tick').map((f) => f.json);
		expect(envelopes.map((e) => e.data.n)).toEqual([1, 2, 3]);
		expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(third.json.seq).toBe(3);

		await capable.next((f) => f.binary !== undefined && parseBinaryFrame(f.binary)?.seq === 3);
		const frames = capable.frames.filter((f) => f.binary !== undefined).map((f) => parseBinaryFrame(f.binary));
		expect(frames.length, 'one binary frame per entry, not one batch frame').toBe(3);
		const announce = capable.frames.find((f) => f.json?.type === 'wire-id' && f.json?.topic === 'statelessbatch');
		expect(announce).toBeDefined();
		for (const frame of frames) expect(frame?.topicId).toBe(announce.json.id);
		expect(frames.map((f) => f?.seq)).toEqual([1, 2, 3]);
		// Each frame carries ONE entry through the codec's per-event encode,
		// the shape a batch frame (`tick-batch` over an array) never has.
		expect(frames.map((f) => JSON.parse(new TextDecoder().decode(f.payload)))).toEqual([
			['tick', { n: 1 }], ['tick', { n: 2 }], ['tick', { n: 3 }]
		]);
		expect(capable.frames.some((f) => f.json?.event === 'tick-batch'), 'no batch envelope on the stateless lane').toBe(false);
		capable.close();
		plain.close();
	});

	it('publishWireBatch through a stateless codec honours a call-level exclusion with a per-entry override', async () => {
		const author = connect();
		const audience = connect();
		await author.open();
		await audience.open();
		author.send({ type: 'hello', caps: ['test.codec:1'] });
		audience.send({ type: 'hello', caps: ['test.codec:1'] });
		author.send({ type: 'subscribe', topic: 'statelessexclude', ref: 1 });
		audience.send({ type: 'subscribe', topic: 'statelessexclude', ref: 1 });
		await author.next((f) => f.json?.type === 'subscribed');
		await audience.next((f) => f.json?.type === 'subscribed');

		// The handler resolves 'me' to the sending socket and 'peer' to the
		// other subscriber, so the entries can name real server-side sockets.
		author.send(JSON.stringify({
			cmd: 'publishWireBatchExcluding', topic: 'statelessexclude', event: 'tick',
			entries: [{ data: { n: 0 } }, { data: { n: 1 }, excludeWs: 'peer' }, { data: { n: 2 } }, { data: { n: 3 }, excludeWs: null }],
			options: { seq: false, excludeWs: 'me' }
		}));
		const received = (c) => c.frames.filter((f) => f.binary !== undefined)
			.map((f) => JSON.parse(new TextDecoder().decode(parseBinaryFrame(f.binary).payload))[1].n);
		await audience.next((f) => f.binary !== undefined && JSON.parse(new TextDecoder().decode(parseBinaryFrame(f.binary).payload))[1].n === 3);
		expect(received(audience), 'the audience receives all but its own override entry').toEqual([0, 2, 3]);
		await author.next((f) => f.binary !== undefined);
		await new Promise((r) => setTimeout(r, 60));
		expect(received(author), 'the author hears only the entry that overrode the default').toEqual([1]);
		author.close();
		audience.close();
	});

});
