// A connection's messagesOut / bytesOut count DIRECT sends and nothing a
// broadcast fans out to it, which is what the CloseContext declaration says
// and what the family's native tier can do: its publish has no per-connection
// hook, so an app reading its close context must get the same figures here
// for the same traffic. Every broadcast lane is driven against the real built
// platform over scripted sockets that carry the runtime's own stats slot, and
// every direct lane beside it, so a fan-out that starts charging again on any
// lane, or a direct send that stops, reads red.

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
let stats;
/** @type {any} */
let relay;

const STATELESS_CAP = 'accounting.stateless:1';
const STATEFUL_CAP = 'accounting.stateful:1';
const SHARED_CAP = 'accounting.shared:1';
const NOBODY_CAP = 'accounting.nobody:1';

/** @type {Array<{ name: string, facade: any, rawWs: any, userData: any }>} */
const connections = [];

/**
 * A connection scripted straight into the live set with the runtime's own
 * stats slot, the way the open handler seeds it.
 * @param {string} name
 * @param {string[]} caps
 * @param {string[]} topics
 */
async function connect(name, caps, topics) {
	const dir = pathToFileURL(payload.dir).href;
	const { wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`);
	/** @type {any[]} */
	const sent = [];
	/** @type {any} */
	const rawWs = {
		readyState: 1,
		bufferedAmount: 0,
		send(payload, _opts, cb) { sent.push(payload); cb?.(); },
		terminate() { this.readyState = 3; },
		close() { this.readyState = 3; },
		_socket: { remoteAddress: '10.0.0.1' }
	};
	const userData = /** @type {any} */ ({ remoteAddress: '10.0.0.1' });
	userData[symbols.WS_SUBSCRIPTIONS] = new Set();
	userData[symbols.WS_CAPS] = new Set(caps);
	userData[symbols.WS_STATS] = stats.createConnStats(0);
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
	const conn = { name, facade, rawWs, userData, sent };
	connections.push(conn);
	return conn;
}

/** The out counters of every connection, by name. */
function outCounts() {
	/** @type {Record<string, { messagesOut: number, bytesOut: number }>} */
	const out = {};
	for (const c of connections) {
		const s = c.userData[symbols.WS_STATS];
		out[c.name] = { messagesOut: s.messagesOut, bytesOut: s.bytesOut };
	}
	return out;
}

/** Zero every connection's out counters. */
function resetOut() {
	for (const c of connections) {
		const s = c.userData[symbols.WS_STATS];
		s.messagesOut = 0;
		s.bytesOut = 0;
	}
}

/**
 * Run a broadcast twice and assert the second charged nobody. The first run
 * may announce a wire id to a capable subscriber, a control frame the family
 * counts as direct on every adapter; the second run has nothing to announce.
 * Returns the first run's counters so a case can pin that announce.
 * @param {string} why
 * @param {() => unknown} broadcast
 */
function expectBroadcastFree(why, broadcast) {
	resetOut();
	broadcast();
	const first = outCounts();
	resetOut();
	broadcast();
	expectNothingCharged(why);
	return first;
}

/** The first run charged exactly the announce to `name`, and nobody else. */
function expectOnlyAnnounce(first, name, why) {
	for (const [n, s] of Object.entries(first)) {
		expect(s.messagesOut, `${why}: first run, ${n}`).toBe(n === name ? 1 : 0);
	}
}

/** Every connection reports zero direct traffic. */
function expectNothingCharged(why) {
	for (const [name, s] of Object.entries(outCounts())) {
		expect(s.messagesOut, `${why}: ${name} messagesOut`).toBe(0);
		expect(s.bytesOut, `${why}: ${name} bytesOut`).toBe(0);
	}
}

/** @param {string} topic */
function envelope(topic, event, data) {
	return JSON.stringify({ topic, event, data });
}

const stateless = {
	capability: STATELESS_CAP,
	schemaVersion: 1,
	encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
};
const stateful = {
	capability: STATEFUL_CAP,
	schemaVersion: 1,
	state: { onAttach: () => ({ schemaVersion: 1 }) },
	encode() { return new Uint8Array([1, 2, 3]); }
};
const shared = {
	capability: SHARED_CAP,
	schemaVersion: 1,
	shared: true,
	encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
};
const nobody = {
	capability: NOBODY_CAP,
	schemaVersion: 1,
	encode(event, data) { return new TextEncoder().encode(JSON.stringify([event, data])); }
};

beforeAll(async () => {
	payload = buildRuntime();
	const dir = pathToFileURL(payload.dir).href;
	registry = await import(`${dir}/handler/topic-registry.js`);
	state = await import(`${dir}/handler/state.js`);
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	stats = await import(`${dir}/handler/conn-stats.js`);
	relay = await import(`${dir}/handler/platform.js`);
	platform = relay.platform;
	state.topicSeqs.clear();
	state.wsConnections.clear();
	state.wsWrappers.clear();
	// The counters exist only when the app exports a close hook; the open
	// handler flips this the same way.
	stats.setStatsEnabled(true);

	// capable decodes every codec; plain decodes none. Both hold 'room'.
	// batchy decodes the batch frame only and is the sole holder of 'uniform',
	// so a batch into it travels as one shared frame.
	await connect('capable', [STATELESS_CAP, STATEFUL_CAP, SHARED_CAP], ['room', 'shared-room']);
	await connect('plain', [], ['room', 'shared-room', 'plain-room']);
	await connect('batchy', ['batch'], ['uniform']);
	// gamer decodes the game lane's binary fan-out frame, which is the one
	// per-viewer walk that still charges, and the only way into its binary arm.
	await connect('gamer', ['game.fanout:1'], ['room']);
}, 60000);

afterAll(() => {
	stats?.setStatsEnabled(false);
	payload?.cleanup?.();
});

describe('broadcast lanes charge no per-connection counter', () => {
	it('publish', () => {
		resetOut();
		expect(platform.publish('room', 'e', { n: 1 })).toBe(true);
		expectNothingCharged('publish');
	});

	it('batch and publishBatched, shared frame and per-event alike', () => {
		resetOut();
		platform.batch([{ topic: 'room', event: 'a', data: 1 }, { topic: 'room', event: 'b', data: 2 }]);
		expectNothingCharged('batch');
		platform.publishBatched([{ topic: 'room', event: 'a', data: 1 }, { topic: 'plain-room', event: 'b', data: 2 }]);
		expectNothingCharged('publishBatched per event');
		platform.publishBatched([{ topic: 'uniform', event: 'a', data: 1 }, { topic: 'uniform', event: 'b', data: 2 }]);
		expectNothingCharged('publishBatched shared frame');
	});

	it('publishWire on every exit: JSON fast path, stateless walk, stateful walk, shared cohorts, declined frame, excluding walk', () => {
		const plain = connections.find((c) => c.name === 'plain');
		const declining = { capability: STATELESS_CAP, schemaVersion: 1, encode() { return null; } };
		expectBroadcastFree('publishWire JSON fast path', () => expect(platform.publishWire('room', 'pos', { x: 1 }, nobody)).toBe(true));
		// The first stateless frame on a topic announces the wire id to the
		// capable subscriber: one control frame, charged as the family charges
		// it. The shared cohorts announce the shared id the same way.
		expectOnlyAnnounce(expectBroadcastFree('publishWire stateless walk', () => expect(platform.publishWire('room', 'pos', { x: 1 }, stateless)).toBe(true)), 'capable', 'stateless walk');
		expectBroadcastFree('publishWire stateful walk', () => expect(platform.publishWire('room', 'pos', { x: 1 }, stateful)).toBe(true));
		expectOnlyAnnounce(expectBroadcastFree('publishWire shared cohorts', () => expect(platform.publishWire('shared-room', 'pos', { x: 1 }, shared)).toBe(true)), 'capable', 'shared cohorts');
		expectBroadcastFree('publishWire declined frame', () => expect(platform.publishWire('room', 'pos', { x: 1 }, declining)).toBe(true));
		expectBroadcastFree('publishWire excluding walk', () => expect(platform.publishWire('room', 'pos', { x: 1 }, stateless, { excludeWs: plain.facade })).toBe(true));
	});

	it('publishWireBatch on the JSON fast path and on the per-connection walk', () => {
		expectBroadcastFree('publishWireBatch JSON fast path', () => expect(platform.publishWireBatch('room', 'pos', [{ data: 1 }, { data: 2 }], nobody)).toBe(true));
		// A capable subscriber forces the walk; plain takes its JSON arm.
		expectBroadcastFree('publishWireBatch walk', () => expect(platform.publishWireBatch('room', 'pos', [{ data: 1 }, { data: 2 }], stateful)).toBe(true));
	});

	it('the relay receive half', () => {
		expectBroadcastFree('relay receive', () => {
			relay.relayPublish('room', envelope('room', 'e', 1), false, null);
			relay.relayPublishBatched([
				{ topic: 'room', env: envelope('room', 'a', 1), seq: null },
				{ topic: 'room', env: envelope('room', 'b', 2), seq: null }
			], false);
			relay.relayPublishBatched([
				{ topic: 'uniform', env: envelope('uniform', 'a', 1), seq: null },
				{ topic: 'uniform', env: envelope('uniform', 'b', 2), seq: null }
			], false);
		});
	});
});

describe('direct lanes charge the one connection they address', () => {
	it('send, sendTo and sendWire in both forms', () => {
		const capable = connections.find((c) => c.name === 'capable');
		const plain = connections.find((c) => c.name === 'plain');
		resetOut();
		platform.send(plain.facade, 'room', 'hello', { n: 1 });
		let out = outCounts();
		expect(out.plain.messagesOut).toBe(1);
		expect(out.plain.bytesOut).toBe(Buffer.byteLength(envelope('room', 'hello', { n: 1 })));
		expect(out.capable.messagesOut, 'the other connection is untouched').toBe(0);

		// The first binary send on a topic announces the wire id, a control
		// frame that counts on every adapter; warm it so the case reads the
		// send alone whatever ran before it.
		platform.sendWire(capable.facade, 'direct-room', 'pos', { x: 0 }, stateless);
		resetOut();
		platform.sendWire(plain.facade, 'direct-room', 'pos', { x: 1 }, stateless);
		platform.sendWire(capable.facade, 'direct-room', 'pos', { x: 1 }, stateless);
		out = outCounts();
		expect(out.plain.messagesOut, 'a JSON-degraded direct wire send counts').toBe(1);
		expect(out.plain.bytesOut).toBe(Buffer.byteLength(envelope('direct-room', 'pos', { x: 1 })));
		expect(out.capable.messagesOut, 'a binary direct wire send counts').toBe(1);
		const lastFrame = capable.sent[capable.sent.length - 1];
		expect(lastFrame instanceof Uint8Array, 'the capable socket took a binary frame').toBe(true);
		expect(out.capable.bytesOut, 'in the bytes of the frame on the socket, header included').toBe(lastFrame.byteLength);
		expect(lastFrame.byteLength, 'which is more than the codec payload alone').toBeGreaterThan(stateless.encode('pos', { x: 1 }).byteLength);

		resetOut();
		platform.sendTo((ud) => ud === plain.userData, 'room', 'e', { n: 2 });
		out = outCounts();
		expect(out.plain.messagesOut).toBe(1);
		expect(out.capable.messagesOut).toBe(0);
	});

	it('the coalesced drain charges an accepted send and not a shed one', () => {
		const plain = connections.find((c) => c.name === 'plain');
		resetOut();
		// Past the ceiling the drain sheds the entry, keeps it for the next
		// drain, and charges nothing; once the socket drains, the retry that
		// delivers is charged once.
		plain.rawWs.bufferedAmount = 2 * 1024 * 1024;
		platform.sendCoalesced(plain.facade, { key: 'k', topic: 'room', event: 'c', data: { n: 1 } });
		relay.flushCoalescedFor(plain.facade, plain.userData);
		expect(outCounts().plain.messagesOut, 'a shed coalesced send is not charged').toBe(0);
		plain.rawWs.bufferedAmount = 0;
		relay.flushCoalescedFor(plain.facade, plain.userData);
		expect(outCounts().plain.messagesOut, 'the retry that delivered is charged once').toBe(1);
	});

	it('publishGame charges each viewer it walks, as the family does', () => {
		// The game lane is a per-viewer walk on every adapter, so it is the one
		// fan-out that still charges: every viewer takes one frame, JSON or
		// binary. The first walk announces a wire id to the capable viewer, so
		// warm it and read the walk alone.
		platform.publishGame(null, 'room', 'warm', { n: 0 });
		resetOut();
		const { delivered } = platform.publishGame(null, 'room', 'g', { n: 1 });
		expect(delivered).toBe(3);
		const out = outCounts();
		expect(out.plain.messagesOut).toBe(1);
		expect(out.capable.messagesOut).toBe(1);
		expect(out.gamer.messagesOut).toBe(1);
		expect(out.batchy.messagesOut, 'a socket that does not hold the topic').toBe(0);
	});

	it('a game-capable viewer is charged the binary frame, not the payload inside it', () => {
		// The binary arm of the same walk. The charge has to be the frame on
		// the socket: the payload alone leaves the header uncounted, which is
		// what the family counts and what an operator compares against.
		const gamer = connections.find((c) => c.name === 'gamer');
		platform.publishGame(null, 'room', 'warm2', { n: 0 });
		resetOut();
		gamer.sent.length = 0;
		platform.publishGame(null, 'room', 'g2', { n: 2 });
		const frame = gamer.sent[gamer.sent.length - 1];
		expect(frame instanceof Uint8Array, 'the game-capable viewer took a binary frame').toBe(true);
		const out = outCounts();
		expect(out.gamer.messagesOut).toBe(1);
		expect(out.gamer.bytesOut, 'the frame on the socket, header included').toBe(frame.byteLength);
	});
});
