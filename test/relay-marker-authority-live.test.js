// The relay re-entry marker on the BUILT runtime.
//
// test/relay-marker-authority.test.js drives createTestServer, which is the
// harness platform in src/testing.js - a separate implementation of publish,
// publishWire and the batch lanes. Only this file reaches
// src/runtime/handler/platform.js, so it is the half that fails when the
// production marker goes back to being a property on the caller's object.
//
// WHY THIS EXISTS. publishWire has an origin side and a relay side, and one
// boolean picks between them. The relay side skips the cluster sequence-
// authority check, skips the seq value check, skips the egress decision, skips
// the publish counter, stamps the number it was handed instead of drawing the
// topic counter, and does not relay - all correct for a frame a sibling worker
// already published, counted and fanned out, and all wrong for anything else.
//
// WHAT MAKES THESE CASES ABLE TO FAIL. The stamp is the observable projection
// of that boolean: a frame carrying the topic counter's number took the ORIGIN
// arm. So the forgery cases assert the seq a real client received, and the
// ceiling case adds the one refusal a caller observes directly - a publish that
// answers false.

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

/** The number a forgery tries to stamp. Far above any counter these cases draw. */
const FORGED_SEQ = 4242;

/** A codec that declines every frame, so each publish takes the JSON envelope a plain client can read. */
const DECLINING_CODEC = {
	capability: 'test.relay-marker:1',
	schemaVersion: 1,
	encode: () => null
};

/**
 * Guesses at a key: the two the relay half used to carry, two plausible
 * spellings of the constant, and the Symbol forms - the registry lookup a later
 * edit could reintroduce by reaching for `Symbol.for`, and a same-description
 * own Symbol built after reading the source.
 */
function namedForgeries() {
	return [
		{ _isRelay: true, _relaySeq: FORGED_SEQ },
		{ _relaySeq: FORGED_SEQ },
		{ relayOriginSeq: FORGED_SEQ },
		{ RELAY_ORIGIN_SEQ: FORGED_SEQ },
		{ [Symbol.for('adapter-ws.relay-origin-seq')]: FORGED_SEQ },
		{ [Symbol.for('adapter-ws.relay-receive')]: FORGED_SEQ },
		{ [Symbol('adapter-ws.relay-receive')]: FORGED_SEQ }
	];
}

/**
 * Objects that guess nothing and answer for EVERY key, which is what satisfies
 * a property-shaped marker without naming it. A Proxy and a plain prototype
 * getter both, since the second needs no exotic object and a design that only
 * worried about Proxy would still be open.
 *
 * Their seq is not the discriminator, and this is worth being exact about: an
 * object that answers every key also answers `seq`, so `get: () => null` is a
 * caller asking for no seq and `get: () => 4242` is a caller passing an
 * explicit authority - both documented, both allowed, and neither says anything
 * about which arm the call took. The armed-ceiling case is where these shapes
 * are held to account, because a refusal can only come from the origin arm.
 */
function answeringForgeries() {
	return [
		new Proxy({}, { get: () => null }),
		new Proxy({}, { get: () => FORGED_SEQ }),
		Object.create(new Proxy({}, { get: () => null })),
		// The key-echoing family, which is what separates "cannot name the key"
		// from "cannot produce the value": a `get` trap is HANDED the key it is
		// asked for, so echoing it satisfies any test comparing the value to
		// the key. Symbols only - echoing string keys hands `seq` back a string
		// and the call is refused for THAT, which looks like the guard working
		// and is not.
		new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) }),
		Object.create(new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) }))
	];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** @type {WebSocket[]} */
const clients = [];

/**
 * Boot a payload whose WebSocket lane is on, with `wsOptions` merged over the
 * defaults so each suite can arm its own ceiling.
 */
async function bootWith(extraOptions) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...extraOptions })
		},
		wsHandlerSource: 'export function message() {}\n'
	});
	const rt = await bootRuntime(payload);
	return { payload, rt };
}

/** A real client subscribed to `topic`, recording every JSON frame it receives. */
async function connect(rt, topic, caps) {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
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
	return { ws, frames, of: (t) => frames.filter((f) => f?.topic === t && f.type !== 'subscribed') };
}

afterAll(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
});

describe('a forged relay marker publishes as an ordinary origin frame', () => {
	/** @type {any} */
	let payload;
	/** @type {any} */
	let rt;

	beforeAll(async () => {
		({ payload, rt } = await bootWith({}));
	}, 60000);

	afterAll(async () => {
		await rt?.close();
		payload?.cleanup?.();
	});

	it('cannot stamp its own seq: every delivery carries the topic counter', async () => {
		const c = await connect(rt, 'forge-named');
		const forgeries = namedForgeries();
		for (const options of forgeries) {
			expect(rt.handler.platform.publishWire('forge-named', 'e', { n: 1 }, DECLINING_CODEC, options)).toBe(true);
		}

		await sleep(200);
		const delivered = c.of('forge-named');
		expect(delivered.length, 'every forged publish must still be delivered').toBe(forgeries.length);
		// The counter, drawn once per call, starting from an untouched topic -
		// so the sequence is exactly 1..N and none of it is the forged number.
		expect(delivered.map((f) => f.seq)).toEqual(forgeries.map((_, i) => i + 1));
		expect(delivered.some((f) => f.seq === FORGED_SEQ)).toBe(false);
	});

	it('cannot be reached by passing values in the token position', async () => {
		// The token is an argument now, so the argument itself is worth
		// attacking. Nothing a caller can construct is identical to a Symbol
		// this module never exported - including a registry symbol with the
		// same description, which is the near-miss `Symbol.for` would create.
		const c = await connect(rt, 'forge-token');
		const tokens = [
			true,
			'relay',
			Symbol('adapter-ws.relay-receive'),
			Symbol.for('adapter-ws.relay-receive'),
			Symbol.iterator,
			{}
		];
		for (const token of tokens) {
			expect(rt.handler.platform.publishWire('forge-token', 'e', { n: 1 }, DECLINING_CODEC, undefined, token, FORGED_SEQ)).toBe(true);
		}

		await sleep(200);
		expect(c.of('forge-token').map((f) => f.seq)).toEqual(tokens.map((_, i) => i + 1));
	});

	it('the real relay path still takes the relay arm', async () => {
		// The vacuity guard for every case here: the legitimate internal caller
		// must still be recognised, or a publishWire that had simply stopped
		// honouring any marker would pass them all. Driven through the runtime's
		// own relayPublish - the entry a sibling worker's frame arrives on -
		// rather than by synthesizing a token, because the token is not
		// reachable from here, which is the point.
		rt.handler.platform.registerWireCodec(DECLINING_CODEC);
		const plain = await connect(rt, 'forge-relay');
		// A capable client is what makes the relay re-encode worth entering; the
		// declining codec then sends everyone the JSON envelope, so the seq is
		// readable off the frame the plain client receives.
		await connect(rt, 'forge-relay', [DECLINING_CODEC.capability]);

		rt.handler.relayPublish(
			'forge-relay',
			JSON.stringify({ topic: 'forge-relay', event: 'e', data: { n: 1 }, seq: FORGED_SEQ }),
			false,
			FORGED_SEQ,
			DECLINING_CODEC.capability,
			'e',
			{ n: 1 }
		);
		// An ordinary origin publish after it: its seq proves the relayed frame
		// did not draw the counter.
		expect(rt.handler.platform.publishWire('forge-relay', 'e', { n: 2 }, DECLINING_CODEC)).toBe(true);

		await sleep(200);
		expect(plain.of('forge-relay').map((f) => f.seq)).toEqual([FORGED_SEQ, 1]);
	});
});

describe('a forged relay marker cannot cross an armed egress ceiling', () => {
	/** @type {any} */
	let payload;
	/** @type {any} */
	let rt;

	beforeAll(async () => {
		({ payload, rt } = await bootWith({ egress: { windowMs: 60000, topic: { messages: 1 } } }));
	}, 60000);

	afterAll(async () => {
		await rt?.close();
		payload?.cleanup?.();
	});

	it('answers false for every shape once the ceiling is crossed', async () => {
		// The egress decision is on the same origin arm as the stamp, and it is
		// the one a caller sees answered: a refusal returns false. One message
		// of headroom, spent by a plain publish, so every forgery below meets a
		// ceiling that is already crossed.
		const c = await connect(rt, 'ceil');
		expect(rt.handler.platform.publishWire('ceil', 'e', { n: 1 }, DECLINING_CODEC)).toBe(true);
		for (const options of [...namedForgeries(), ...answeringForgeries()]) {
			expect(rt.handler.platform.publishWire('ceil', 'e', { n: 2 }, DECLINING_CODEC, options)).toBe(false);
		}

		await sleep(200);
		expect(c.of('ceil').map((f) => f.data.n), 'a refused publish delivered a frame').toEqual([1]);
	});
});
