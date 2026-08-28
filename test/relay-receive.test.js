// The cross-worker relay receive half over real sockets: relayPublish
// delivers a sibling worker's pre-stamped envelope to local subscribers
// without re-stamping, the codec carry re-encodes binary locally for capable
// subscribers, and relayPublishBatched re-runs the fast/slow batch detection
// against THIS worker's subscriber set.

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';

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

// The codec-carry path re-derives the codec from the receiving worker's
// registry, so the handler registers one at init exactly as a plugin would.
const WS_HANDLER = `
export function init({ platform }) {
	platform.registerWireCodec({
		capability: 'relay.codec:1',
		schemaVersion: 1,
		encode(event, data) {
			return new TextEncoder().encode(JSON.stringify([event, data]));
		}
	});
}
export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'publish') {
		platform.publish(cmd.topic, cmd.event, cmd.data);
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
	/** @type {Array<{ json?: any, binary?: Uint8Array, raw?: string }>} */
	const frames = [];
	/** @type {Array<(f: any) => void>} */
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		/** @type {any} */
		let frame;
		if (isBinary) {
			frame = { binary: new Uint8Array(/** @type {Buffer} */ (raw)), raw: raw.toString('latin1') };
		} else {
			try { frame = { json: JSON.parse(raw.toString()), raw: raw.toString() }; } catch { frame = { raw: raw.toString() }; }
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
		close: () => ws.close()
	};
}

/** Subscribe and await the ack. */
async function subscribed(client, topic) {
	client.send({ type: 'subscribe', topic, ref: 1 });
	await client.next((f) => f.json?.type === 'subscribed' && f.json?.topic === topic);
}

describe('relayPublish', () => {
	it('delivers the pre-serialized envelope verbatim and never re-stamps the topic seq', async () => {
		const sub = connect();
		await sub.open();
		await subscribed(sub, 'relay.t1');

		// A sibling worker's frame: seq 41 was stamped THERE.
		const envelope = '{"topic":"relay.t1","event":"tick","data":{"n":1},"seq":41}';
		rt.handler.relayPublish('relay.t1', envelope, false, 41);
		const got = await sub.next((f) => f.json?.event === 'tick');
		expect(got.raw).toBe(envelope);

		// The relayed frame advanced no local counter: this worker's first
		// LOCAL publish on the topic stamps from its own sequence space.
		sub.send(JSON.stringify({ cmd: 'publish', topic: 'relay.t1', event: 'local', data: null }));
		const local = await sub.next((f) => f.json?.event === 'local');
		expect(local.json.seq).toBe(1);
		sub.close();
	});

	it('re-encodes binary locally from the codec carry for capable subscribers', async () => {
		const capable = connect();
		const plain = connect();
		await capable.open();
		await plain.open();
		capable.send({ type: 'hello', caps: ['relay.codec:1'] });
		await subscribed(capable, 'relay.t2');
		await subscribed(plain, 'relay.t2');

		const envelope = '{"topic":"relay.t2","event":"tick","data":{"n":2},"seq":7}';
		rt.handler.relayPublish('relay.t2', envelope, false, 7, 'relay.codec:1', 'tick', { n: 2 });

		const binary = await capable.next((f) => f.binary !== undefined);
		const parsed = parseBinaryFrame(binary.binary);
		// The carried seq rides the binary frame verbatim - the origin's stamp.
		expect(parsed?.seq).toBe(7);
		expect(JSON.parse(new TextDecoder().decode(parsed.payload))).toEqual(['tick', { n: 2 }]);
		// The caps-less subscriber gets the JSON envelope from the re-encode walk.
		const json = await plain.next((f) => f.json?.event === 'tick');
		expect(json.json.seq).toBe(7);
		capable.close();
		plain.close();
	});

	it('falls back to the JSON envelope when no local connection advertises the capability', async () => {
		const sub = connect();
		await sub.open();
		await subscribed(sub, 'relay.t3');

		const envelope = '{"topic":"relay.t3","event":"tick","data":null,"seq":3}';
		rt.handler.relayPublish('relay.t3', envelope, false, 3, 'relay.codec:1', 'tick', null);
		const got = await sub.next((f) => f.json?.event === 'tick');
		expect(got.raw).toBe(envelope);
		expect(got.binary).toBeUndefined();
		sub.close();
	});
});

describe('relayPublishBatched', () => {
	it('hands batch-capable subscribers one shared frame and the rest per-event envelopes', async () => {
		const capable = connect();
		const plain = connect();
		await capable.open();
		await plain.open();
		capable.send({ type: 'hello', caps: ['batch'] });
		await subscribed(capable, 'relay.b1');
		await subscribed(plain, 'relay.b1');

		const events = [
			{ topic: 'relay.b1', env: '{"topic":"relay.b1","event":"a","data":1,"seq":10}', seq: 10 },
			{ topic: 'relay.b1', env: '{"topic":"relay.b1","event":"b","data":2,"seq":11}', seq: 11 }
		];
		rt.handler.relayPublishBatched(events, false);

		// Everyone interested holds the topic and someone lacks the batch cap,
		// so the receive-side detection serves each connection by ITS caps:
		// the capable one decodes the shared batch frame...
		const batch = await capable.next((f) => f.json?.type === 'batch');
		expect(batch.json.events.map((e) => e.seq)).toEqual([10, 11]);
		// ...and the caps-less one receives the per-event envelopes in order.
		const first = await plain.next((f) => f.json?.event === 'a');
		const second = await plain.next((f) => f.json?.event === 'b');
		expect(first.json.seq).toBe(10);
		expect(second.json.seq).toBe(11);
		capable.close();
		plain.close();
	});

	it('takes the per-event slow path when subscriber sets are disjoint across batch topics', async () => {
		const only1 = connect();
		const only2 = connect();
		await only1.open();
		await only2.open();
		only1.send({ type: 'hello', caps: ['batch'] });
		only2.send({ type: 'hello', caps: ['batch'] });
		await subscribed(only1, 'relay.d1');
		await subscribed(only2, 'relay.d2');

		rt.handler.relayPublishBatched([
			{ topic: 'relay.d1', env: '{"topic":"relay.d1","event":"x","data":null,"seq":1}', seq: 1 },
			{ topic: 'relay.d2', env: '{"topic":"relay.d2","event":"y","data":null,"seq":1}', seq: 1 }
		], false);

		// Neither connection sees the other topic's event, and neither gets a
		// batch frame (a shared frame would leak the other topic's payload).
		const x = await only1.next((f) => f.json?.event === 'x');
		const y = await only2.next((f) => f.json?.event === 'y');
		expect(x.json.topic).toBe('relay.d1');
		expect(y.json.topic).toBe('relay.d2');
		expect(only1.frames.some((f) => f.json?.type === 'batch')).toBe(false);
		expect(only2.frames.some((f) => f.json?.type === 'batch')).toBe(false);
		subFramesHaveNo(only1, 'relay.d2');
		subFramesHaveNo(only2, 'relay.d1');
		only1.close();
		only2.close();
	});
});

/** Assert no frame for `topic` reached this client. */
function subFramesHaveNo(client, topic) {
	expect(client.frames.some((f) => f.json?.topic === topic)).toBe(false);
}
