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
	});

	it('the coalesced drain', () => {
		const plain = connections.find((c) => c.name === 'plain');
		plain.frames.length = 0;
		expect(addedBy(() => {
			platform.sendCoalesced(plain.facade, { key: 'k', topic: 'room', event: 'c1', data: { n: 1 } });
			relay.flushCoalescedFor(plain.facade, plain.userData);
		})).toEqual([keyOf('room', 'c1')]);
	});

	it('the relayed batch', () => {
		expect(addedBy(() => relay.relayPublishBatched([
			{ topic: 'room', env: '{"topic":"room","event":"r0","data":1}', seq: null }
		], false)), 'a relayed envelope arrives built').toEqual([]);
		expect(addedBy(() => platform.publishBatched([{ topic: 'room', event: 'r1', data: 1 }, { topic: 'room', event: 'r2', data: 2 }])))
			.toEqual([keyOf('room', 'r1'), keyOf('room', 'r2')]);
	});

	it('evicts at the bound rather than growing', () => {
		for (let i = 0; i < cache.ENVELOPE_CACHE_MAX + 10; i++) platform.publish('room', 'ev' + i, null);
		expect(state.envelopePrefixCache.size).toBe(cache.ENVELOPE_CACHE_MAX);
		expect(state.envelopePrefixCache.has(keyOf('room', 'ev' + (cache.ENVELOPE_CACHE_MAX + 9)))).toBe(true);
	});
});
