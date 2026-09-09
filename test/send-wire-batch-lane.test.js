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
		sent,
		/** Frames after the wire-id announce, which is the subscribe's, not this send's. */
		frames() { return sent.filter((f) => !(f.text && f.text.startsWith('{"type":"wire-id"'))); },
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
		} finally {
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
});
