// The publish-outcome hook fires once per FAN-OUT, at the sites where the
// family's native tier hands one publish to its transport, and never inside a
// per-connection walk. Every publish here is a JS walk, so the cadence is a
// choice this file pins lane by lane against the REAL built runtime platform
// over scripted sockets: an alert tuned on ws_publish_outcomes_total on one
// adapter has to read the same numbers on the other for the same traffic.
//
// The recorder replaces the hook the metrics lane would install, so what is
// asserted is the sequence of booleans the counter would classify.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { buildRuntime } from './helpers/build-runtime.js';

/** @type {any} */
let payload;
/** @type {any} */
let platform;
/** @type {any} */
let state;
/** @type {any} */
let registry;
/** @type {any} */
let symbols;
/** @type {any} */
let relay;
/** @type {boolean[]} */
let calls = [];

const STATELESS_CAP = 'cadence.stateless:1';
const STATEFUL_CAP = 'cadence.stateful:1';
const SHARED_CAP = 'cadence.shared:1';
const NOBODY_CAP = 'cadence.nobody:1';

/** @type {Array<{ name: string, facade: any, rawWs: any, userData: any }>} */
const connections = [];

/**
 * A connection scripted straight into the live set, below the hello and
 * subscribe handlers: its frames are swallowed, its caps are counted the way
 * the hello handler would count them.
 * @param {string} name
 * @param {string[]} caps
 * @param {string[]} topics
 */
async function connect(name, caps, topics) {
	const dir = pathToFileURL(payload.dir).href;
	const { wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`);
	/** @type {any} */
	const rawWs = {
		readyState: 1,
		bufferedAmount: 0,
		send(_payload, _opts, cb) { cb?.(); },
		terminate() { this.readyState = 3; },
		close() { this.readyState = 3; },
		_socket: { remoteAddress: '10.0.0.1' }
	};
	const userData = /** @type {any} */ ({ remoteAddress: '10.0.0.1' });
	userData[symbols.WS_SUBSCRIPTIONS] = new Set();
	userData[symbols.WS_CAPS] = new Set(caps);
	const facade = wrapWebSocket(rawWs, userData, {
		maxBackpressure: 1024 * 1024,
		closeOnBackpressureLimit: false,
		compressionEnabled: false,
		peerFacadeOf: (peer) => state.wsWrappers.get(peer)
	});
	userData[symbols.WS_PLATFORM] = Object.create(platform);
	state.capCounts.adjust(null, userData[symbols.WS_CAPS]);
	registry.registerSocket(rawWs);
	state.wsWrappers.set(rawWs, facade);
	state.wsConnections.add(facade);
	for (const topic of topics) {
		facade.subscribe(topic);
		userData[symbols.WS_SUBSCRIPTIONS].add(topic);
	}
	const conn = { name, facade, rawWs, userData };
	connections.push(conn);
	return conn;
}

/** The recorded outcomes since the last take, in call order. */
function take() {
	const out = calls;
	calls = [];
	return out;
}

/** @param {string} topic */
function envelope(topic, event, data) {
	return JSON.stringify({ topic, event, data });
}

beforeAll(async () => {
	payload = buildRuntime();
	const dir = pathToFileURL(payload.dir).href;
	registry = await import(`${dir}/handler/topic-registry.js`);
	state = await import(`${dir}/handler/state.js`);
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	relay = await import(`${dir}/handler/platform.js`);
	platform = relay.platform;
	state.topicSeqs.clear();
	state.wsConnections.clear();
	state.wsWrappers.clear();
	state.counters.publishOutcomeHook = (delivered) => { calls.push(delivered); };

	// capable: decodes the batch frame and the stateless, stateful and shared
	// codecs. plain: nothing. capableToo: the batch frame only.
	await connect('capable', ['batch', STATELESS_CAP, STATEFUL_CAP, SHARED_CAP], ['mixed', 'wired', 'shared']);
	await connect('plain', [], ['mixed', 'wired', 'shared']);
	await connect('capableToo', ['batch'], ['uniform']);
	// 'uniform' is held by batch-capable sockets only; 'mixed' by a capable and
	// a plain one; 'nobody' by no socket at all.
	await connect('capableThree', ['batch'], ['uniform']);
	// 'buried' is held by one socket sitting past its backpressure ceiling, so
	// every send to it is shed.
	const shed = await connect('shed', [], ['buried']);
	shed.rawWs.bufferedAmount = 2 * 1024 * 1024;
}, 60000);

afterAll(() => {
	if (state) state.counters.publishOutcomeHook = null;
	payload?.cleanup?.();
});

describe('the single-publish lane', () => {
	it('reports one outcome per publish, classified by whether the topic has a subscriber', () => {
		take();
		platform.publish('mixed', 'e', 1);
		platform.publish('nobody', 'e', 1);
		expect(take()).toEqual([true, false]);
	});

	it('reports a subscriber past its backpressure ceiling as reached, while the publish itself reports no send', () => {
		// A shed frame is a fan-out that reached a subscriber and delivered
		// nothing: the outcome family says reached, the return value says not
		// sent, and the two must not be read off one bit.
		const shed = connections.find((c) => c.name === 'shed');
		expect(shed, 'the buried subscriber is scripted in').toBeDefined();
		const stateless = {
			capability: NOBODY_CAP,
			schemaVersion: 1,
			encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
		};
		take();
		// The lanes that read the outcome off the walk itself: the wire fast
		// path and the relay receive half.
		expect(platform.publishWire('buried', 'pos', { x: 1 }, stateless)).toBe(false);
		relay.relayPublish('buried', envelope('buried', 'e', 1), false, null);
		expect(take()).toEqual([true, true]);
		// And the single-publish lane's return value says not sent.
		expect(platform.publish('buried', 'e', 1)).toBe(false);
		take();
	});

	it('reports one outcome per message of a batch(), which is N publishes', () => {
		take();
		platform.batch([
			{ topic: 'mixed', event: 'a', data: 1 },
			{ topic: 'mixed', event: 'b', data: 2 },
			{ topic: 'nobody', event: 'c', data: 3 }
		]);
		expect(take()).toEqual([true, true, false]);
	});
});

describe('the batched lane', () => {
	it('reports one outcome for a batch that travels as one shared frame', () => {
		take();
		platform.publishBatched([
			{ topic: 'uniform', event: 'a', data: 1 },
			{ topic: 'uniform', event: 'b', data: 2 },
			{ topic: 'uniform', event: 'c', data: 3 }
		]);
		expect(take()).toEqual([true]);
	});

	it('reports one outcome per event when a subscriber cannot decode the frame', () => {
		// The slow path is N publish() calls, and each is its own fan-out.
		take();
		platform.publishBatched([
			{ topic: 'mixed', event: 'a', data: 1 },
			{ topic: 'mixed', event: 'b', data: 2 }
		]);
		expect(take()).toEqual([true, true]);
	});

	it('reports one outcome per event when subscriber views differ', () => {
		take();
		platform.publishBatched([
			{ topic: 'uniform', event: 'a', data: 1 },
			{ topic: 'nobody', event: 'b', data: 2 }
		]);
		// uniform's subscribers hold uniform but not nobody: not all-see-all.
		expect(take()).toEqual([true, false]);
	});

	it('reports one no_subscribers outcome for a batch into an empty topic', () => {
		take();
		platform.publishBatched([
			{ topic: 'nobody', event: 'a', data: 1 },
			{ topic: 'nobody', event: 'b', data: 2 }
		]);
		expect(take()).toEqual([false]);
	});

	it('does not count a subscriber whose send threw as reached', async () => {
		const doomed = await connect('doomed', ['batch'], ['doomed-topic']);
		const transport = doomed.rawWs.send;
		// readyState stays OPEN, so the walk gets as far as the send and the
		// transport itself throws - what a socket freed under the walk does.
		doomed.rawWs.send = () => { throw new Error('gone'); };
		const before = state.counters.closedWsAborts;
		try {
			take();
			platform.publishBatched([
				{ topic: 'doomed-topic', event: 'a', data: 1 },
				{ topic: 'doomed-topic', event: 'b', data: 2 }
			]);
			expect(take(), 'one shared frame, and it reached nobody').toEqual([false]);
			expect(state.counters.closedWsAborts - before).toBe(1);
		} finally {
			doomed.rawWs.send = transport;
			// The only connection built outside beforeAll: take it back out of every
			// set it entered, or a later case asserting on a connection or cap total
			// inherits it.
			state.wsConnections.delete(doomed.facade);
			state.wsWrappers.delete(doomed.rawWs);
			registry.unsubscribeSocket(doomed.rawWs, 'doomed-topic');
			registry.unregisterSocket(doomed.rawWs);
			state.capCounts.adjust(doomed.userData[symbols.WS_CAPS], null);
			connections.splice(connections.indexOf(doomed), 1);
		}
	});

	it('ignores a registered socket with no facade rather than judging it', () => {
		// A socket is registered and wrapped in one synchronous block, so an
		// un-wrapped one is not a live connection. Judging it would make the
		// batch ineligible for the fast path, and the same traffic would then
		// report one outcome per event instead of one for the shared frame.
		/** @type {any} */
		const orphan = {
			readyState: 1,
			bufferedAmount: 0,
			send(_payloadOut, _opts, cb) { cb?.(); },
			terminate() { this.readyState = 3; },
			close() { this.readyState = 3; },
			_socket: { remoteAddress: '10.0.0.2' }
		};
		registry.registerSocket(orphan);
		registry.subscribeSocket(orphan, 'uniform');
		try {
			take();
			platform.publishBatched([
				{ topic: 'uniform', event: 'a', data: 1 },
				{ topic: 'uniform', event: 'b', data: 2 }
			]);
			expect(take()).toEqual([true]);
		} finally {
			registry.unsubscribeSocket(orphan, 'uniform');
			registry.unregisterSocket(orphan);
		}
	});
});

describe('the wire lane', () => {
	const stateless = {
		capability: NOBODY_CAP,
		schemaVersion: 1,
		encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
	};

	it('reports one outcome on the JSON fast path, when nobody advertised the codec', () => {
		take();
		platform.publishWire('mixed', 'pos', { x: 1 }, stateless);
		platform.publishWire('nobody', 'pos', { x: 1 }, stateless);
		expect(take()).toEqual([true, false]);
	});

	it('reports nothing for an excluding publish, which is a per-socket walk', () => {
		const plain = connections.find((c) => c.name === 'plain');
		take();
		platform.publishWire('mixed', 'pos', { x: 1 }, stateless, { excludeWs: plain?.facade });
		expect(take()).toEqual([]);
	});

	it('reports nothing for a stateless walk with a capable subscriber', () => {
		const capableStateless = {
			capability: STATELESS_CAP,
			schemaVersion: 1,
			encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
		};
		take();
		platform.publishWire('wired', 'pos', { x: 1 }, capableStateless);
		expect(take()).toEqual([]);
	});

	it('reports one outcome for a declined frame with no exclusion: the envelope to everyone', () => {
		const declining = {
			capability: STATELESS_CAP,
			schemaVersion: 1,
			encode() { return null; }
		};
		take();
		platform.publishWire('wired', 'pos', { x: 1 }, declining);
		platform.publishWire('nobody', 'pos', { x: 1 }, declining);
		expect(take()).toEqual([true, false]);
	});

	it('reports nothing for a stateful walk', () => {
		const stateful = {
			capability: STATEFUL_CAP,
			schemaVersion: 1,
			state: { onAttach: () => ({ schemaVersion: 1 }) },
			encode() { return new Uint8Array([1]); }
		};
		take();
		platform.publishWire('wired', 'pos', { x: 1 }, stateful);
		expect(take()).toEqual([]);
	});

	it('reports the binary cohort and the JSON cohort of a shared publish separately', () => {
		const shared = {
			capability: SHARED_CAP,
			schemaVersion: 1,
			shared: true,
			encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
		};
		take();
		platform.publishWire('shared', 'pos', { x: 1 }, shared);
		// capable joined the binary cohort, plain the JSON cohort: two fan-outs.
		expect(take()).toEqual([true, true]);
	});
});

describe('the wire batch lane', () => {
	const stateful = {
		capability: NOBODY_CAP,
		schemaVersion: 1,
		state: { onAttach: () => ({ schemaVersion: 1 }) },
		encode() { return new Uint8Array([1]); }
	};

	it('reports one outcome per entry on the JSON fast path', () => {
		take();
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2 }, { data: 3 }], stateful);
		expect(take()).toEqual([true, true, true]);
	});

	it('reports one no_subscribers outcome per entry for a batch into an empty topic', () => {
		take();
		platform.publishWireBatch('nobody', 'pos', [{ data: 1 }, { data: 2 }], stateful);
		expect(take()).toEqual([false, false]);
	});

	it('reports nothing once any entry excludes a socket', () => {
		const plain = connections.find((c) => c.name === 'plain');
		take();
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2, excludeWs: plain?.facade }], stateful);
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2 }], stateful, { excludeWs: plain?.facade });
		expect(take()).toEqual([]);
	});

	it('reports nothing for the per-connection walk a capable subscriber forces', () => {
		const capableStateful = {
			capability: STATEFUL_CAP,
			schemaVersion: 1,
			state: { onAttach: () => ({ schemaVersion: 1 }) },
			encode() { return new Uint8Array([1]); }
		};
		take();
		platform.publishWireBatch('wired', 'pos', [{ data: 1 }, { data: 2 }], capableStateful);
		expect(take()).toEqual([]);
	});

	it('reports one outcome per entry of a stateless batch, which reroutes entry by entry through publishWire', () => {
		const stateless = {
			capability: NOBODY_CAP,
			schemaVersion: 1,
			encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
		};
		const plain = connections.find((c) => c.name === 'plain');
		take();
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2 }], stateless);
		expect(take()).toEqual([true, true]);
		// An excluding entry, or an excluding call, is an excluding publishWire
		// per entry: a walk, reported by neither.
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2, excludeWs: plain?.facade }], stateless);
		expect(take()).toEqual([true]);
		platform.publishWireBatch('mixed', 'pos', [{ data: 1 }, { data: 2 }], stateless, { excludeWs: plain?.facade });
		expect(take()).toEqual([]);
	});
});

describe('the game lane', () => {
	it('reports no outcome: it is a per-connection walk', () => {
		const capable = connections.find((c) => c.name === 'capable');
		platform.grantPublish(capable?.facade, 'mixed');
		take();
		const result = platform.publishGame(capable?.facade, 'mixed', 'move', { x: 1 }, 'input-1');
		// The walk ran: plain holds the topic and the sender is excluded.
		expect(result.delivered).toBe(1);
		expect(take()).toEqual([]);
	});
});

describe('the relay receive half', () => {
	it('reports the receiving worker\'s fan-out of a relayed publish', () => {
		take();
		relay.relayPublish('mixed', envelope('mixed', 'e', 1), false, null);
		relay.relayPublish('nobody', envelope('nobody', 'e', 1), false, null);
		expect(take()).toEqual([true, false]);
	});

	it('reports one outcome for a relayed batch it fans out as one frame', () => {
		take();
		relay.relayPublishBatched([
			{ topic: 'uniform', env: envelope('uniform', 'a', 1), seq: null },
			{ topic: 'uniform', env: envelope('uniform', 'b', 2), seq: null }
		], false);
		expect(take()).toEqual([true]);
		// The shape most receiving workers see: no local subscriber, so the
		// fast path is trivially eligible and its one frame reaches nobody.
		relay.relayPublishBatched([
			{ topic: 'nobody', env: envelope('nobody', 'a', 1), seq: null },
			{ topic: 'nobody', env: envelope('nobody', 'b', 2), seq: null }
		], false);
		expect(take()).toEqual([false]);
	});

	it('reports one outcome per event for a relayed batch it fans out per event', () => {
		take();
		relay.relayPublishBatched([
			{ topic: 'mixed', env: envelope('mixed', 'a', 1), seq: null },
			{ topic: 'mixed', env: envelope('mixed', 'b', 2), seq: null }
		], false);
		expect(take()).toEqual([true, true]);
	});

	it('classifies a declined relayed frame by the topic\'s subscriber count', () => {
		// The relay half computes no recipient count of its own, so this arm
		// reads the registry instead. Reading the local count here reports a
		// fan-out that reached two subscribers as reaching nobody.
		// The registration below is PERMANENT - the codec registry has no
		// unregister - so this case has to stay last in the file and the file has
		// to keep running in declaration order.
		platform.registerWireCodec({ capability: SHARED_CAP, schemaVersion: 1, encode() { return null; } });
		take();
		expect(relay.relayPublishWire('shared', 'pos', { x: 1 }, SHARED_CAP, null, false)).toBe(true);
		expect(relay.relayPublishWire('nobody', 'pos', { x: 1 }, SHARED_CAP, null, false)).toBe(true);
		expect(take()).toEqual([true, false]);
	});
});
