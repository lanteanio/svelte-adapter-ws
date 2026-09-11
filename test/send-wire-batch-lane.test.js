// sendWireBatch is the per-subscriber twin of publishWireBatch for the culled
// delivery walks, and it takes exactly the contract publishWireBatch's entries
// do not: no seq. One options value cannot be one-seq-per-entry, so the lane
// stamps 0 into the binary batch frame's seq slot whatever an entry carries,
// honours `options.compress` like every other wire lane, and hands a
// connection the per-entry JSON envelopes whenever the codec has no
// per-connection state to batch against. Pinned against the REAL built
// runtime platform over a scripted socket that records what reached it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { buildRuntime } from './helpers/build-runtime.js';

const CAP = 'lane.stateful:1';
const TOPIC = 'culled';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: true,
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
let wrapWebSocket;

/**
 * A connection scripted into the live set, recording every frame and the
 * options the facade handed the raw socket for it.
 * @param {string[]} caps
 */
function connect(caps) {
	/** @type {Array<{ text?: string, binary?: Uint8Array, opts: any }>} */
	const sent = [];
	/** @type {any} */
	const rawWs = {
		readyState: 1,
		bufferedAmount: 0,
		send(payloadOut, opts, cb) {
			if (typeof payloadOut === 'string') sent.push({ text: payloadOut, opts });
			else sent.push({ binary: new Uint8Array(payloadOut), opts });
			cb?.();
		},
		terminate() { this.readyState = 3; },
		close() { this.readyState = 3; },
		_socket: { remoteAddress: '10.0.0.1' }
	};
	const userData = /** @type {any} */ ({ remoteAddress: '10.0.0.1' });
	userData[symbols.WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	userData[symbols.WS_CAPS] = new Set(caps);
	const facade = wrapWebSocket(rawWs, userData, {
		maxBackpressure: 1024 * 1024,
		closeOnBackpressureLimit: false,
		compressionEnabled: true,
		peerFacadeOf: (peer) => state.wsWrappers.get(peer)
	});
	userData[symbols.WS_PLATFORM] = Object.create(platform);
	state.capCounts.adjust(null, userData[symbols.WS_CAPS]);
	registry.registerSocket(rawWs);
	registry.subscribeSocket(rawWs, TOPIC);
	state.wsWrappers.set(rawWs, facade);
	state.wsConnections.add(facade);
	return {
		facade,
		rawWs,
		sent,
		/** Data frames only: the wire-id announce a first binary send emits is asserted on its own. */
		frames() { return sent.filter((f) => !(f.text && f.text.startsWith('{"type":"wire-id"'))); },
		announces() { return sent.filter((f) => f.text && f.text.startsWith('{"type":"wire-id"')); },
		leave() {
			state.wsConnections.delete(facade);
			state.wsWrappers.delete(rawWs);
			registry.unsubscribeSocket(rawWs, TOPIC);
			registry.unregisterSocket(rawWs);
			state.capCounts.adjust(userData[symbols.WS_CAPS], null);
		}
	};
}

/**
 * Decode the 0x03 frame header: tag, schema version, varint topic id, varint seq.
 * @param {Uint8Array} frame
 */
function header(frame) {
	let at = 0;
	const tag = frame[at++];
	const schemaVersion = frame[at++];
	const varint = () => {
		let value = 0, shift = 1;
		for (;;) {
			const b = frame[at++];
			value += (b & 0x7f) * shift;
			if ((b & 0x80) === 0) return value;
			shift *= 128;
		}
	};
	const topicId = varint();
	const seq = varint();
	return { tag, schemaVersion, topicId, seq, payload: frame.subarray(at) };
}

function statefulCodec() {
	return {
		capability: CAP,
		schemaVersion: 1,
		state: { onAttach: () => ({ schemaVersion: 1 }) },
		encode(event, data) {
			return new TextEncoder().encode(JSON.stringify([event, data]));
		}
	};
}

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) }
	});
	const dir = pathToFileURL(payload.dir).href;
	registry = await import(`${dir}/handler/topic-registry.js`);
	state = await import(`${dir}/handler/state.js`);
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	({ wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`));
	({ platform } = await import(`${dir}/handler/platform.js`));
	state.wsConnections.clear();
	state.wsWrappers.clear();
}, 60000);

afterAll(() => {
	payload?.cleanup?.();
});

describe('sendWireBatch', () => {
	it('stamps 0 into the batch frame seq slot whatever an entry carries', () => {
		const conn = connect([CAP]);
		try {
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [
				{ data: { i: 1 }, seq: 41 },
				{ data: { i: 2 }, seq: 42 }
			], statefulCodec());
			expect(result).toBe(1);
			const frames = conn.frames();
			expect(frames).toHaveLength(1);
			expect(frames[0].binary, 'a capable connection receives the binary batch frame').toBeDefined();
			const h = header(/** @type {Uint8Array} */ (frames[0].binary));
			expect(h.tag).toBe(0x03);
			expect(h.seq).toBe(0);
			// The batch form went to the codec, with every entry's payload.
			expect(JSON.parse(new TextDecoder().decode(h.payload))).toEqual(['update-batch', { updates: [{ i: 1 }, { i: 2 }] }]);
			// The topic's wire id was announced before the first frame that uses it.
			expect(conn.announces()).toHaveLength(1);
			expect(conn.sent.indexOf(conn.announces()[0])).toBeLessThan(conn.sent.indexOf(frames[0]));
		} finally {
			conn.leave();
		}
	});

	it('falls back to one binary frame per entry, each with seq 0, when the codec declines the batch form', () => {
		const conn = connect([CAP]);
		try {
			const codec = statefulCodec();
			codec.encode = (event, data) => (event === 'update-batch' ? null : new TextEncoder().encode(JSON.stringify(data)));
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: { i: 1 }, seq: 5 }, { data: { i: 2 }, seq: 6 }], codec);
			expect(result).toBe(1);
			const frames = conn.frames();
			expect(frames.map((f) => f.binary !== undefined)).toEqual([true, true]);
			expect(frames.map((f) => header(/** @type {Uint8Array} */ (f.binary)).seq)).toEqual([0, 0]);
			expect(frames.map((f) => JSON.parse(new TextDecoder().decode(header(/** @type {Uint8Array} */ (f.binary)).payload)))).toEqual([{ i: 1 }, { i: 2 }]);
		} finally {
			conn.leave();
		}
	});

	it('sends the per-entry JSON envelopes when the codec attaches no state to the connection', () => {
		const conn = connect([CAP]);
		try {
			const codec = statefulCodec();
			codec.state = { onAttach: () => null };
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], codec);
			expect(result).toBe(1);
			expect(conn.frames().map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`,
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
		} finally {
			conn.leave();
		}
	});

	it('poisons the capability when the batch frame is shed, and serves JSON from then on', () => {
		const conn = connect([CAP]);
		try {
			const codec = statefulCodec();
			// The announce has to get through, so the ceiling is crossed only
			// after the wire id exists: one warm send, then the socket is buried.
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 0 }], codec)).toBe(1);
			conn.rawWs.bufferedAmount = 2 * 1024 * 1024;
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }], codec)).toBe(2);
			conn.rawWs.bufferedAmount = 0;
			const before = conn.frames().length;
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 2 }, { data: 3 }], codec)).toBe(1);
			// Poisoned: a capable connection is served the envelopes, never a frame
			// its decoder could no longer follow.
			expect(conn.frames().slice(before).map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":2}`,
				`{"topic":"${TOPIC}","event":"update","data":3}`
			]);
		} finally {
			conn.leave();
		}
	});

	it('counts every frame it sends in the connection stats', async () => {
		const dir = pathToFileURL(payload.dir).href;
		const stats = await import(`${dir}/handler/conn-stats.js`);
		const conn = connect([CAP]);
		const plain = connect([]);
		try {
			stats.setStatsEnabled(true);
			const ud = conn.facade.getUserData();
			const pd = plain.facade.getUserData();
			// The runtime's own slot shape, not a two-field stand-in: a lane that
			// touched a field this pair omits would read as untouched here.
			ud[symbols.WS_STATS] = stats.createConnStats(0);
			pd[symbols.WS_STATS] = stats.createConnStats(0);
			platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], statefulCodec());
			platform.sendWireBatch(plain.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], statefulCodec());
			// The capable connection got the announce and one batch frame; the
			// plain one got two envelopes.
			expect(ud[symbols.WS_STATS].messagesOut).toBe(2);
			expect(pd[symbols.WS_STATS].messagesOut).toBe(2);
			expect(ud[symbols.WS_STATS].bytesOut).toBeGreaterThan(0);
			expect(pd[symbols.WS_STATS].bytesOut).toBe(2 * Buffer.byteLength(`{"topic":"${TOPIC}","event":"update","data":1}`));
		} finally {
			stats.setStatsEnabled(false);
			conn.leave();
			plain.leave();
		}
	});

	it('charges one closed-socket abort for a connection that closed under the walk, and stops', async () => {
		const conn = connect([CAP]);
		try {
			const codec = statefulCodec();
			// A codec that declines the batch form and every entry, so the walk
			// has three envelope sends to attempt and no reason of its own to
			// stop early; a closed socket must cost one abort, not three. No
			// wire id is warmed first: a declined entry goes straight to its
			// envelope, so this walk never reaches the announce.
			codec.encode = () => null;
			conn.rawWs.readyState = 3;
			const before = state.counters.closedWsAborts;
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }, { data: 3 }], codec)).toBe(2);
			expect(state.counters.closedWsAborts - before).toBe(1);
		} finally {
			conn.rawWs.readyState = 1;
			conn.leave();
		}
	});

	it('never announces a wire id for a codec that declines every entry', () => {
		const conn = connect([CAP]);
		try {
			// The socket stays OPEN, so an attempted announce WOULD be recorded.
			// On a closed socket this proves nothing: the facade throws before
			// the transport is touched, so nothing lands either way.
			const codec = statefulCodec();
			codec.encode = () => null;
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], codec)).toBe(1);
			expect(conn.announces()).toHaveLength(0);
			expect(conn.frames().map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`,
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
		} finally {
			conn.leave();
		}
	});

	it('builds the declined entry envelope from the payload the codec was handed', () => {
		const conn = connect([CAP]);
		try {
			// A MIXED codec: the batch declines, entry 0 declines to its
			// envelope, entry 1 encodes. That envelope is a third read site,
			// and it is the shape an older codec actually has.
			const codec = statefulCodec();
			const perEntry = codec.encode;
			codec.encode = (event, data) => {
				if (event.endsWith('-batch')) return null;
				return data === 1 ? null : perEntry(event, data);
			};
			let reads = 0;
			const entries = [{ get data() { reads++; return 1; } }, { get data() { reads++; return 2; } }];
			platform.sendWireBatch(conn.facade, TOPIC, 'update', entries, codec);
			expect(reads, 'one read per entry, at the top of the walk').toBe(2);
			expect(conn.frames().filter((f) => f.text).map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`
			]);
		} finally {
			conn.leave();
		}
	});

	it('charges the wire-id announce its own abort when the batch declines and the entries encode', () => {
		const conn = connect([CAP]);
		try {
			const codec = statefulCodec();
			const perEntry = codec.encode;
			// Batch form declined, entries carried: the walk needs a wire id, and
			// the announce is a send of its own onto a socket that is already
			// gone. It charges before the envelope fallback charges again, so
			// this branch costs two: the announce is a send the batch walk never
			// sees, so no guard inside that walk can lower the count.
			codec.encode = (event, data) => (event.endsWith('-batch') ? null : perEntry(event, data));
			conn.rawWs.readyState = 3;
			const before = state.counters.closedWsAborts;
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], codec)).toBe(2);
			expect(state.counters.closedWsAborts - before).toBe(2);
		} finally {
			conn.rawWs.readyState = 1;
			conn.leave();
		}
	});

	it('sends the binary batch for a payload the codec carries and JSON cannot', () => {
		const conn = connect([CAP]);
		try {
			// The envelopes are the FALLBACK. Building them up front costs a
			// JSON.stringify per entry on the path that never sends one, and a
			// BigInt or a cycle throws that eager build out of the call - zero
			// frames sent, where the codec had the frame ready.
			const codec = {
				capability: CAP,
				schemaVersion: 1,
				state: { onAttach: () => ({ schemaVersion: 1 }) },
				encode: (event, data) => new TextEncoder().encode(
					event + ':' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
				)
			};
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1n }, { data: 2n }], codec);
			expect(result).toBe(1);
			const frames = conn.frames();
			expect(frames).toHaveLength(1);
			expect(frames[0].binary).toBeInstanceOf(Uint8Array);
			expect(new TextDecoder().decode(header(frames[0].binary).payload))
				.toBe('update-batch:{"updates":["1n","2n"]}');
		} finally {
			conn.leave();
		}
	});

	it('sends the fallback envelopes from the payloads the batch encode saw, not a second read', () => {
		const conn = connect([CAP]);
		try {
			// Shed exactly one frame, the wire-id announce: ensureWireId then
			// reports -1 and the walk falls back to envelopes. Those must carry
			// the values already handed to the codec, because reading a getter a
			// second time here sends bytes the codec never saw.
			let shed = 1;
			Object.defineProperty(conn.rawWs, 'bufferedAmount', {
				configurable: true,
				get() { return shed-- > 0 ? 2 * 1024 * 1024 : 0; }
			});
			let reads = 0;
			const entries = [{ get data() { return ++reads; } }, { get data() { return ++reads; } }];
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', entries, statefulCodec())).toBe(1);
			expect(reads).toBe(2);
			expect(conn.frames().map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`,
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
		} finally {
			Object.defineProperty(conn.rawWs, 'bufferedAmount', { configurable: true, writable: true, value: 0 });
			conn.leave();
		}
	});

	it('hands the compress option to the transport, and sends plain without it', () => {
		const conn = connect([CAP]);
		try {
			platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }], statefulCodec(), { compress: true });
			platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 2 }], statefulCodec());
			const frames = conn.frames();
			expect(frames).toHaveLength(2);
			expect(frames[0].opts).toEqual({ binary: true, compress: true });
			expect(frames[1].opts).toEqual({ binary: true, compress: false });
		} finally {
			conn.leave();
		}
	});

	it('sends the per-entry JSON envelopes when the codec keeps no per-connection state', () => {
		const conn = connect([CAP]);
		try {
			const stateless = { capability: CAP, schemaVersion: 1, encode: () => new Uint8Array([1]) };
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 1 }, { data: 2 }], stateless, { compress: true });
			expect(result).toBe(1);
			const frames = conn.frames();
			expect(frames.map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`,
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
			expect(frames.every((f) => f.opts.compress === true)).toBe(true);
		} finally {
			conn.leave();
		}
	});

	it('sends the per-entry JSON envelopes to a connection without the capability', () => {
		const conn = connect([]);
		try {
			const result = platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 'a' }, { data: 'b' }], statefulCodec());
			expect(result).toBe(1);
			const frames = conn.frames();
			expect(frames.map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":"a"}`,
				`{"topic":"${TOPIC}","event":"update","data":"b"}`
			]);
			expect(frames.every((f) => f.opts.compress === false)).toBe(true);
		} finally {
			conn.leave();
		}
	});

	it('reads the caller entries one at a time on the JSON-only send', () => {
		const plain = connect([]);
		try {
			let reads = 0;
			const entries = [
				{ get data() { reads++; return 1; } },
				{ get data() { reads++; return 2; } },
				{ get data() { reads++; return 3; } }
			];
			// No capability, so this is the JSON-only walk: it reads each entry as
			// it reaches it and allocates nothing else. The socket dies on the
			// first send, so the two entries after it are never sent - and must
			// never be read either, because reading application data for a frame
			// that will not exist is a side effect the caller did not ask for.
			plain.rawWs.send = () => { throw new Error('gone'); };
			expect(platform.sendWireBatch(plain.facade, TOPIC, 'update', entries, statefulCodec())).toBe(2);
			expect(reads).toBe(1);
		} finally {
			plain.leave();
		}
	});

	it('falls back from a dropped announce to the payloads the codec was handed', () => {
		const conn = connect([CAP]);
		try {
			// Batch declined, entry 0 carried, wire id NOT yet announced: the
			// announce is shed, ensureWireId reports -1, and the walk falls back
			// from entry 0 with the pinned array. Re-reading the entries here
			// would hand this subscriber different bytes than the codec saw.
			let shed = 1;
			Object.defineProperty(conn.rawWs, 'bufferedAmount', {
				configurable: true,
				get() { return shed-- > 0 ? 2 * 1024 * 1024 : 0; }
			});
			const codec = statefulCodec();
			const perEntry = codec.encode;
			codec.encode = (event, data) => (event.endsWith('-batch') ? null : perEntry(event, data));
			let reads = 0;
			const entries = [{ get data() { reads++; return 1; } }, { get data() { reads++; return 2; } }];
			platform.sendWireBatch(conn.facade, TOPIC, 'update', entries, codec);
			expect(reads).toBe(2);
			expect(conn.frames().map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":1}`,
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
		} finally {
			Object.defineProperty(conn.rawWs, 'bufferedAmount', { configurable: true, writable: true, value: 0 });
			conn.leave();
		}
	});

	it('falls back from a shed entry frame to the payloads the codec was handed', () => {
		const conn = connect([CAP]);
		try {
			// Warm the wire id first so the announce is out of the way; the ONE
			// shed frame below is then entry 0's binary frame, which poisons the
			// capability and falls back from entry 1 with the pinned array.
			expect(platform.sendWireBatch(conn.facade, TOPIC, 'update', [{ data: 0 }], statefulCodec())).toBe(1);
			let shed = 1;
			Object.defineProperty(conn.rawWs, 'bufferedAmount', {
				configurable: true,
				get() { return shed-- > 0 ? 2 * 1024 * 1024 : 0; }
			});
			const codec = statefulCodec();
			const perEntry = codec.encode;
			codec.encode = (event, data) => (event.endsWith('-batch') ? null : perEntry(event, data));
			let reads = 0;
			const entries = [{ get data() { reads++; return 1; } }, { get data() { reads++; return 2; } }];
			platform.sendWireBatch(conn.facade, TOPIC, 'update', entries, codec);
			expect(reads).toBe(2);
			// The WHOLE text slice, not just the last: a fallback that resumed
			// from entry 0 instead of entry 1 would re-send the entry whose binary
			// frame the codec already consumed, and a last-element check cannot
			// see that.
			expect(conn.frames().filter((f) => f.text).map((f) => f.text)).toEqual([
				`{"topic":"${TOPIC}","event":"update","data":2}`
			]);
		} finally {
			Object.defineProperty(conn.rawWs, 'bufferedAmount', { configurable: true, writable: true, value: 0 });
			conn.leave();
		}
	});
});
