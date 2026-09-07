// Shared binary fan-out on the PRODUCTION runtime, read off frames real
// clients receive. A stateless codec marked `shared: true` fans a topic out
// by cohort: every binary-capable subscriber is announced ONE server-wide
// wire id (partitioned above the per-connection id space) and receives the
// byte-identical 0x03 frame, everyone else receives the JSON envelope. The
// first shared publish migrates the topic's current subscribers into cohorts;
// a later joiner is cohorted at subscribe time, on the wire and on the
// programmatic lane alike; an unsubscribe leaves the cohort; a publish that
// excludes a socket falls back to the per-connection walk.
//
// The test server mirrors this lane; this file drives the built handler, so
// a production regression cannot hide behind a green harness.

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { SHARED_WIRE_ID_BASE } from '../src/runtime/handler/shared-wire-id.js';

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

const CAP = 'test.shared:1';

// The shared codec's payload is the UTF-8 JSON of { event, data }. Commands
// arrive as JSON text without a `type` field, which the control demux does
// not parse, so the hook decodes them from `data` itself.
const WS_HANDLER = `
const sharedCodec = {
	capability: ${JSON.stringify(CAP)},
	schemaVersion: 1,
	shared: true,
	encode(event, data) {
		return new TextEncoder().encode(JSON.stringify({ event, data }));
	}
};

export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	msg = cmd;
	if (msg.cmd === 'publishShared') {
		platform.publishWire(msg.topic, msg.event, msg.data, sharedCodec, msg.options);
	} else if (msg.cmd === 'publishSharedExcludingMe') {
		platform.publishWire(msg.topic, msg.event, msg.data, sharedCodec, { excludeWs: ws });
	} else if (msg.cmd === 'subscribeMe') {
		await platform.subscribe(ws, msg.topic);
		ws.send(JSON.stringify({ type: 'test-subscribed', topic: msg.topic }));
	} else if (msg.cmd === 'unsubscribeMe') {
		platform.unsubscribe(ws, msg.topic);
		ws.send(JSON.stringify({ type: 'test-unsubscribed', topic: msg.topic }));
	} else if (msg.cmd === 'registerShared') {
		platform.registerWireCodec(sharedCodec);
		ws.send(JSON.stringify({ type: 'test-registered' }));
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

const dec = new TextDecoder();
/** @param {Uint8Array} payloadBytes */
const decodePayload = (payloadBytes) => JSON.parse(dec.decode(payloadBytes));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

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
	const client = {
		ws,
		frames,
		open: () => new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		}),
		/** @param {(f: any) => boolean} match */
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
		/** @param {any} obj */
		send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
		close: () => ws.close(),
		binaries: () => frames.filter((f) => f.binary !== undefined).map((f) => parseBinaryFrame(f.binary)),
		announces: () => frames.filter((f) => f.json?.type === 'wire-id').map((f) => f.json),
		/** @param {string} topic @param {string} event */
		envelopes: (topic, event) => frames.filter((f) => f.json?.topic === topic && f.json?.event === event).map((f) => f.json)
	};
	return client;
}

/**
 * Open a client, optionally advertise the shared capability, and subscribe
 * to `topic` over the wire so the server's own subscribe landing runs.
 * @param {string} topic
 * @param {boolean} capable
 */
async function join(topic, capable) {
	const c = connect();
	await c.open();
	if (capable) c.send({ type: 'hello', caps: [CAP] });
	c.send({ type: 'subscribe', topic, ref: 1 });
	await c.next((f) => f.json?.type === 'subscribed' && f.json?.topic === topic);
	return c;
}

describe('shared binary fan-out via cohorts on the production runtime', () => {
	it('announces one server-wide id to the binary cohort and delivers the same seq on both forms', async () => {
		const topic = 'shared.world';
		const bin = await join(topic, true);
		const json = await join(topic, false);

		json.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 1, n: 42 } });

		const binary = await bin.next((f) => f.binary !== undefined);
		const announces = bin.announces();
		expect(announces.length, 'exactly one announce precedes the first shared frame').toBe(1);
		expect(announces[0].topic).toBe(topic);
		expect(announces[0].id).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		expect(bin.frames.findIndex((f) => f.json?.type === 'wire-id')).toBeLessThan(bin.frames.indexOf(binary));
		const frame = parseBinaryFrame(binary.binary);
		expect(frame).toBeTruthy();
		expect(frame.schemaVersion).toBe(1);
		expect(frame.topicId, 'the frame carries the shared id, not a per-connection one').toBe(announces[0].id);
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 1, n: 42 } });

		const envelope = await json.next((f) => f.json?.topic === topic && f.json?.event === 'snapshot');
		expect(json.binaries().length, 'the JSON cohort never receives a binary frame').toBe(0);
		expect(envelope.json.data).toEqual({ tick: 1, n: 42 });
		expect(frame.seq, 'both cohorts carry the one stamped seq').toBe(envelope.json.seq);
		bin.close();
		json.close();
	});

	it('two binary subscribers receive byte-identical frames under one shared id', async () => {
		const topic = 'shared.identical';
		const a = await join(topic, true);
		const b = await join(topic, true);
		a.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 7 } });
		const fa = await a.next((f) => f.binary !== undefined);
		const fb = await b.next((f) => f.binary !== undefined);
		expect(Buffer.from(fa.binary).equals(Buffer.from(fb.binary))).toBe(true);
		// The same id on both because it is the SERVER-WIDE one, not because
		// two fresh per-connection allocators happened to agree.
		expect(a.announces()[0].id).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		expect(a.announces()[0].id).toBe(b.announces()[0].id);
		a.close();
		b.close();
	});

	it('cohorts a binary joiner that subscribes over the wire after the topic is already shared', async () => {
		const topic = 'shared.late';
		const first = await join(topic, true);
		first.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 1 } });
		await first.next((f) => f.binary !== undefined);

		// Subscribing after the promotion must announce the shared id at
		// subscribe time, before any publish reaches the new joiner.
		const late = await join(topic, true);
		const lateAnnounce = await late.next((f) => f.json?.type === 'wire-id' && f.json?.topic === topic);
		expect(lateAnnounce.json.id).toBe(first.announces()[0].id);

		first.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 2 } });
		const lateFrame = await late.next((f) => f.binary !== undefined);
		expect(decodePayload(parseBinaryFrame(lateFrame.binary).payload)).toEqual({ event: 'snapshot', data: { tick: 2 } });
		expect(parseBinaryFrame(lateFrame.binary).topicId).toBe(lateAnnounce.json.id);
		await first.next((f) => f.binary !== undefined && decodePayload(parseBinaryFrame(f.binary).payload).data.tick === 2);
		expect(first.binaries().length).toBe(2);
		first.close();
		late.close();
	});

	it('cohorts a joiner on the programmatic platform.subscribe lane too', async () => {
		const topic = 'shared.programmatic';
		const first = await join(topic, true);
		first.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 1 } });
		await first.next((f) => f.binary !== undefined);

		const late = connect();
		await late.open();
		late.send({ type: 'hello', caps: [CAP] });
		await late.next((f) => f.json?.type === 'welcome');
		late.send({ cmd: 'subscribeMe', topic });
		await late.next((f) => f.json?.type === 'test-subscribed');
		const announce = await late.next((f) => f.json?.type === 'wire-id' && f.json?.topic === topic);
		expect(announce.json.id).toBe(first.announces()[0].id);

		first.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 2 } });
		const frame = await late.next((f) => f.binary !== undefined);
		expect(parseBinaryFrame(frame.binary).topicId).toBe(announce.json.id);

		// And the programmatic leave drops it from the cohort.
		late.send({ cmd: 'unsubscribeMe', topic });
		await late.next((f) => f.json?.type === 'test-unsubscribed');
		first.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 3 } });
		await first.next((f) => f.binary !== undefined && decodePayload(parseBinaryFrame(f.binary).payload).data.tick === 3);
		await sleep(80);
		expect(late.binaries().length).toBe(1);
		first.close();
		late.close();
	});

	it('an unsubscribed client leaves its cohort and stops receiving shared publishes', async () => {
		const topic = 'shared.leave';
		const a = await join(topic, true);
		const b = await join(topic, true);
		a.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 1 } });
		await a.next((f) => f.binary !== undefined);
		await b.next((f) => f.binary !== undefined);
		expect(b.announces()[0].id, 'b was cohorted under the shared id').toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);

		b.send({ type: 'unsubscribe', topic });
		await sleep(80);
		a.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 2 } });
		await a.next((f) => f.binary !== undefined && decodePayload(parseBinaryFrame(f.binary).payload).data.tick === 2);
		await sleep(80);
		expect(b.binaries().length, 'b left the cohort and must not hear the second publish').toBe(1);
		a.close();
		b.close();
	});

	it('a JSON-only subscriber of a shared topic keeps receiving envelopes after a binary peer leaves', async () => {
		const topic = 'shared.jsonstays';
		const bin = await join(topic, true);
		const json = await join(topic, false);
		bin.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 1 } });
		await json.next((f) => f.json?.topic === topic && f.json?.data?.tick === 1);
		await bin.next((f) => f.binary !== undefined);
		expect(bin.announces()[0].id, 'the binary peer was cohorted under the shared id').toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		bin.close();
		await sleep(80);
		json.send({ cmd: 'publishShared', topic, event: 'snapshot', data: { tick: 2 } });
		const second = await json.next((f) => f.json?.topic === topic && f.json?.data?.tick === 2);
		expect(second.json.data).toEqual({ tick: 2 });
		expect(json.binaries().length).toBe(0);
		json.close();
	});

	it('falls back to the per-connection walk when the publish excludes a socket', async () => {
		const topic = 'shared.exclude';
		const author = await join(topic, true);
		const audience = await join(topic, true);
		author.send({ cmd: 'publishSharedExcludingMe', topic, event: 'snapshot', data: { tick: 1 } });
		const frame = await audience.next((f) => f.binary !== undefined);
		expect(decodePayload(parseBinaryFrame(frame.binary).payload)).toEqual({ event: 'snapshot', data: { tick: 1 } });
		await sleep(80);
		expect(author.binaries().length, 'the excluded author hears nothing').toBe(0);
		expect(author.envelopes(topic, 'snapshot').length).toBe(0);
		author.close();
		audience.close();
	});

	it('a relayed shared publish re-runs the cohort split on the receiving worker', async () => {
		const topic = 'shared.relayed';
		const bin = await join(topic, true);
		const json = await join(topic, false);
		bin.send({ cmd: 'registerShared' });
		await bin.next((f) => f.json?.type === 'test-registered');

		// A sibling worker's frame carrying the codec fields: this worker
		// re-derives the shared codec from its registry and cohorts locally.
		const envelope = JSON.stringify({ topic, event: 'snapshot', data: { tick: 9 }, seq: 77 });
		rt.handler.relayPublish(topic, envelope, false, 77, CAP, 'snapshot', { tick: 9 });

		const frame = await bin.next((f) => f.binary !== undefined);
		const parsed = parseBinaryFrame(frame.binary);
		expect(parsed.topicId).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		expect(parsed.seq, 'the origin seq is preserved across the relay').toBe(77);
		expect(decodePayload(parsed.payload)).toEqual({ event: 'snapshot', data: { tick: 9 } });
		const env = await json.next((f) => f.json?.topic === topic && f.json?.event === 'snapshot');
		expect(env.json.data).toEqual({ tick: 9 });
		expect(json.binaries().length).toBe(0);
		bin.close();
		json.close();
	});
});
