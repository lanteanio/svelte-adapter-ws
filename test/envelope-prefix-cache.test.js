// Every JSON envelope this runtime builds takes its prefix from the envelope
// prefix cache, so the cache-size signal the observability manifest reports
// for `envelopePrefixCache` is a real number and the family's native tier and
// this runtime build the same bytes the same way. Pinned against the real
// built platform over scripted sockets: each lane's first frame on a new
// topic+event pair adds exactly that pair, the bytes on the wire equal the
// inline build, and the cache evicts at its bound instead of growing.

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
/** @type {any} */
let cache;

const STATELESS_CAP = 'prefix.stateless:1';
const STATEFUL_CAP = 'prefix.stateful:1';
const NOBODY_CAP = 'prefix.nobody:1';

/** @type {Array<{ name: string, facade: any, rawWs: any, userData: any, frames: string[] }>} */
const connections = [];

/**
 * A connection scripted into the live set whose transport records every
 * text frame it is handed, as a string.
 * @param {string} name
 * @param {string[]} caps
 * @param {string[]} topics
 */
async function connect(name, caps, topics) {
	const dir = pathToFileURL(payload.dir).href;
	const { wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`);
	/** @type {string[]} */
	const frames = [];
	/** @type {any} */
	const rawWs = {
		readyState: 1,
		bufferedAmount: 0,
		send(data, _opts, cb) { if (typeof data === 'string') frames.push(data); cb?.(); },
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
	const conn = { name, facade, rawWs, userData, frames };
	connections.push(conn);
	return conn;
}

/** The cache key the module uses for a pair. */
function keyOf(topic, event) {
	return topic + '\0' + event;
}

/** The inline prefix the sites used to build by hand. */
function inlinePrefix(topic, event) {
	return '{"topic":' + JSON.stringify(topic) + ',"event":' + JSON.stringify(event) + ',"data":';
}

/** Run `fn` and return the cache keys it added. */
function addedBy(fn) {
	const before = new Set(state.envelopePrefixCache.keys());
	fn();
	return [...state.envelopePrefixCache.keys()].filter((k) => !before.has(k));
}

beforeAll(async () => {
	payload = buildRuntime();
	const dir = pathToFileURL(payload.dir).href;
	registry = await import(`${dir}/handler/topic-registry.js`);
	state = await import(`${dir}/handler/state.js`);
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	cache = await import(`${dir}/handler/envelope-cache.js`);
	relay = await import(`${dir}/handler/platform.js`);
	platform = relay.platform;
	state.topicSeqs.clear();
	state.wsConnections.clear();
	state.wsWrappers.clear();
	state.envelopePrefixCache.clear();
	await connect('plain', [], ['room']);
	await connect('capable', [STATELESS_CAP, STATEFUL_CAP], ['room']);
	// batchy decodes the batch frame and is the only holder of 'uniform', so
	// a batch into it takes the fast path and builds its envelopes there.
	await connect('batchy', ['batch'], ['uniform']);
}, 60000);

afterAll(() => {
	payload?.cleanup?.();
});

describe('every envelope build goes through the prefix cache', () => {
	it('publish adds the pair once and the frame equals the inline build', () => {
		const plain = connections.find((c) => c.name === 'plain');
		plain.frames.length = 0;
		expect(addedBy(() => platform.publish('room', 'p1', { n: 1 }))).toEqual([keyOf('room', 'p1')]);
		expect(addedBy(() => platform.publish('room', 'p1', { n: 2 })), 'the second publish reuses the entry').toEqual([]);
		expect(plain.frames[0].startsWith(inlinePrefix('room', 'p1'))).toBe(true);
		expect(JSON.parse(plain.frames[0])).toMatchObject({ topic: 'room', event: 'p1', data: { n: 1 } });
	});

	it('send and sendTo', () => {
		const plain = connections.find((c) => c.name === 'plain');
		expect(addedBy(() => platform.send(plain.facade, 'room', 's1', { n: 1 }))).toEqual([keyOf('room', 's1')]);
		expect(addedBy(() => platform.sendTo((ud) => ud === plain.userData, 'room', 's2', { n: 1 }))).toEqual([keyOf('room', 's2')]);
	});

	it('publishWire on the JSON fast path, the stateful walk, and the JSON degrade of sendWire', () => {
		const plain = connections.find((c) => c.name === 'plain');
		const nobody = { capability: NOBODY_CAP, schemaVersion: 1, encode(e, d) { return new TextEncoder().encode(JSON.stringify([e, d])); } };
		const stateful = { capability: STATEFUL_CAP, schemaVersion: 1, state: { onAttach: () => ({ schemaVersion: 1 }) }, encode() { return new Uint8Array([1]); } };
		expect(addedBy(() => platform.publishWire('room', 'w1', { x: 1 }, nobody))).toEqual([keyOf('room', 'w1')]);
		expect(addedBy(() => platform.publishWire('room', 'w2', { x: 1 }, stateful))).toEqual([keyOf('room', 'w2')]);
		expect(addedBy(() => platform.sendWire(plain.facade, 'room', 'w3', { x: 1 }, nobody))).toEqual([keyOf('room', 'w3')]);
	});

	it('publishWireBatch and sendWireBatch', () => {
		const plain = connections.find((c) => c.name === 'plain');
		const nobody = { capability: NOBODY_CAP, schemaVersion: 1, encode(e, d) { return new TextEncoder().encode(JSON.stringify([e, d])); } };
		const stateful = { capability: STATEFUL_CAP, schemaVersion: 1, state: { onAttach: () => ({ schemaVersion: 1 }) }, encode() { return new Uint8Array([1]); } };
		expect(addedBy(() => platform.publishWireBatch('room', 'b1', [{ data: 1 }, { data: 2 }], nobody))).toEqual([keyOf('room', 'b1')]);
		expect(addedBy(() => platform.publishWireBatch('room', 'b2', [{ data: 1 }, { data: 2 }], stateful))).toEqual([keyOf('room', 'b2')]);
		expect(addedBy(() => platform.sendWireBatch(plain.facade, 'room', 'b3', [{ data: 1 }, { data: 2 }], nobody))).toEqual([keyOf('room', 'b3')]);
		expect(addedBy(() => platform.sendWireBatch(plain.facade, 'room', 'b4', [{ data: 1 }, { data: 2 }], stateful))).toEqual([keyOf('room', 'b4')]);
		// A capable target whose stateful codec declines both the batch form
		// and every entry is served the per-entry JSON degrade.
		const capable = connections.find((c) => c.name === 'capable');
		const declining = { capability: STATEFUL_CAP, schemaVersion: 1, state: { onAttach: () => ({ schemaVersion: 1 }) }, encode() { return null; } };
		capable.frames.length = 0;
		expect(addedBy(() => platform.sendWireBatch(capable.facade, 'room', 'b5', [{ data: 1 }, { data: 2 }], declining))).toEqual([keyOf('room', 'b5')]);
		expect(capable.frames.filter((f) => f.startsWith(inlinePrefix('room', 'b5'))).length, 'two JSON entries reached the target').toBe(2);
	});

	it('publishGame', () => {
		const plain = connections.find((c) => c.name === 'plain');
		plain.frames.length = 0;
		expect(addedBy(() => platform.publishGame(null, 'room', 'g1', { n: 1 }))).toEqual([keyOf('room', 'g1')]);
		expect(plain.frames[0].startsWith(inlinePrefix('room', 'g1'))).toBe(true);
	});

	it('the coalesced drain', () => {
		const plain = connections.find((c) => c.name === 'plain');
		plain.frames.length = 0;
		// sendCoalesced drains synchronously on an unblocked socket, so the
		// build happens inside the call.
		expect(addedBy(() => platform.sendCoalesced(plain.facade, { key: 'k', topic: 'room', event: 'c1', data: { n: 1 } }))).toEqual([keyOf('room', 'c1')]);
		expect(plain.frames[0].startsWith(inlinePrefix('room', 'c1'))).toBe(true);
	});

	it('the relayed batch arrives built, and publishBatched builds on both of its paths', () => {
		const plain = connections.find((c) => c.name === 'plain');
		const batchy = connections.find((c) => c.name === 'batchy');
		plain.frames.length = 0;
		const env = '{"topic":"room","event":"r0","data":1}';
		expect(addedBy(() => relay.relayPublishBatched([{ topic: 'room', env, seq: null }], false)), 'a relayed envelope is delivered as it came').toEqual([]);
		expect(plain.frames).toContain(env);
		// The slow path publishes per event; the fast path builds the envelopes
		// itself for the one shared batch frame.
		expect(addedBy(() => platform.publishBatched([{ topic: 'room', event: 'r1', data: 1 }, { topic: 'room', event: 'r2', data: 2 }])))
			.toEqual([keyOf('room', 'r1'), keyOf('room', 'r2')]);
		batchy.frames.length = 0;
		expect(addedBy(() => platform.publishBatched([{ topic: 'uniform', event: 'u1', data: 1 }, { topic: 'uniform', event: 'u2', data: 2 }])))
			.toEqual([keyOf('uniform', 'u1'), keyOf('uniform', 'u2')]);
		expect(batchy.frames.length, 'one shared batch frame').toBe(1);
		expect(batchy.frames[0]).toContain(inlinePrefix('uniform', 'u1'));
	});

	it('evicts at the bound rather than growing', () => {
		for (let i = 0; i < cache.ENVELOPE_CACHE_MAX + 10; i++) platform.publish('room', 'ev' + i, null);
		expect(state.envelopePrefixCache.size).toBe(cache.ENVELOPE_CACHE_MAX);
		expect(state.envelopePrefixCache.has(keyOf('room', 'ev' + (cache.ENVELOPE_CACHE_MAX + 9)))).toBe(true);
	});
});
