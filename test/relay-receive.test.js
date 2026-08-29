// The cross-worker relay receive half over real sockets: relayPublish
// delivers a sibling worker's pre-stamped envelope to local subscribers
// without re-stamping, the codec carry re-encodes binary locally for capable
// subscribers, and relayPublishBatched re-runs the fast/slow batch detection
// against THIS worker's subscriber set.

import WebSocket from 'ws';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

	it('refuses a batch carrying one malformed entry before any entry fans out (hard tier, like the single lane)', async () => {
		const sub = connect();
		await sub.open();
		await subscribed(sub, 'relay.c1');

		// Entry 1 is corrupt (env lost in serialization). The whole batch is the
		// fault unit: the sibling's serialization is broken, so entry 0 - itself
		// well-formed - must not be delivered either.
		expect(() => rt.handler.relayPublishBatched([
			{ topic: 'relay.c1', env: '{"topic":"relay.c1","event":"ok","data":null,"seq":1}', seq: 1 },
			{ topic: 'relay.c1', env: undefined, seq: 2 }
		], false)).toThrow(/relay\.batched-env-type/);
		expect(() => rt.handler.relayPublishBatched([
			{ topic: 42, env: '{"topic":"relay.c1","event":"bad","data":null,"seq":3}', seq: 3 }
		], false)).toThrow(/relay\.batched-topic-type/);

		// Nothing reached the subscriber from either refused batch.
		await new Promise((r) => setTimeout(r, 50));
		expect(sub.frames.some((f) => f.json?.event === 'ok' || f.json?.event === 'bad')).toBe(false);
		sub.close();
	});

	it('production tier: the refused batch delivers nothing in the frame before the deferred exit', async () => {
		// In test env fatal throws, so the early return after a failed vet is
		// production-only code. Exercise it for real: the assertions module
		// re-reads the env per call and takes an injectable exit sink for
		// exactly this. A lost element (null entry) is the corruption shape.
		const assertions = await import(pathToFileURL(join(payload.dir, 'utils', 'assertions.js')).href);
		const sub = connect();
		await sub.open();
		await subscribed(sub, 'relay.p1');

		/** @type {number[]} */
		const exits = [];
		assertions.setFatalSink({ exit: (code) => { exits.push(code); } });
		const savedVitest = process.env.VITEST;
		const savedNodeEnv = process.env.NODE_ENV;
		delete process.env.VITEST;
		process.env.NODE_ENV = 'production';
		try {
			expect(() => rt.handler.relayPublishBatched([
				{ topic: 'relay.p1', env: '{"topic":"relay.p1","event":"leak","data":null,"seq":9}', seq: 9 },
				null
			], false)).not.toThrow();
			// The exit is DEFERRED to a microtask, so the sink must stay
			// installed across the settle; resetting it earlier would hand the
			// exit back to the real process.exit under vitest.
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			if (savedVitest !== undefined) process.env.VITEST = savedVitest;
			if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
			else delete process.env.NODE_ENV;
			assertions.resetFatalSink();
		}
		// One deferred exit per failed check (the null entry fails both), all
		// with the invariant-violation code, and the well-formed first entry
		// was NOT delivered while the process died.
		expect(exits.length).toBeGreaterThan(0);
		expect(exits.every((code) => code === 78)).toBe(true);
		expect(sub.frames.some((f) => f.json?.event === 'leak')).toBe(false);
		sub.close();
	});
});

/** Assert no frame for `topic` reached this client. */
function subFramesHaveNo(client, topic) {
	expect(client.frames.some((f) => f.json?.topic === topic)).toBe(false);
}
