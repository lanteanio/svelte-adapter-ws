// Unit-level pins for the two wire refusal paths that never fire under a
// healthy socket: the poison-to-JSON degrade when a stateful 0x03 frame is
// shed by backpressure, and the game-twin cluster gate refusing a frame on
// an unsafe worker topology. The fan-out primitives take an injectable
// io.send and routeGameFrame takes injectable cluster metadata, so both are
// driven here without saturating a real connection.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';
import { deliverStatefulWireBatch, deliverStatelessWireFanout, encodeStatelessWirePayload } from '../src/runtime/handler/wire-fanout.js';
import { routeGameFrame, gameLaneClusterSafe, assertGameLaneClusterSafe, GAME_LANE_CLUSTER_ERROR } from '../src/runtime/handler/game-ingress.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { WS_CAPS, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_STATS } from '../src/runtime/utils/ws-symbols.js';

const CAP = 'test.stateful:1';

// uWS send results: 2 is a frame dropped past maxBackpressure (the shed the
// poison machinery exists for); 1 is a clean synchronous send.
const SHED = 2;
const SENT = 1;

/** wire-state.js sits behind the env/config chain, which only resolves after
 * the build-time placeholder substitution - import it from a built payload
 * (the symbols are Symbol.for, shared with the src imports above). */
/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {any} */
let wireState;

beforeAll(async () => {
	payload = buildRuntime();
	wireState = await import(pathToFileURL(path.join(payload.dir, 'handler', 'wire-state.js')).href);
});

afterAll(() => {
	payload.cleanup();
});

function makeConn() {
	const ud = {
		[WS_CAPS]: new Set([CAP]),
		[WS_SUBSCRIPTIONS]: new Set(['room'])
	};
	/** @type {Array<string | Uint8Array>} */
	const rawSent = [];
	const ws = {
		getUserData: () => ud,
		// ensureWireId announces the wire-id mapping over the raw socket send,
		// outside the injectable io.send.
		send: (/** @type {any} */ value) => { rawSent.push(value); return SENT; }
	};
	return { ws, ud, rawSent };
}

const statefulWire = {
	capability: CAP,
	schemaVersion: 1,
	encode: (/** @type {string} */ event, /** @type {unknown} */ data) =>
		new TextEncoder().encode(JSON.stringify([event, data])),
	state: { onAttach: () => ({}) }
};

/** Drive one stateful batch at a connection through an injected send. */
function deliverStateful(conn, datas, envelopes, seqs, send) {
	return deliverStatefulWireBatch({
		wire: statefulWire,
		event: 'tick',
		datas,
		envelopes,
		seqs,
		state: wireState.ensureWireState(conn.ws, conn.ud, statefulWire) ?? {},
		ws: conn.ws,
		ud: conn.ud,
		topic: 'room',
		ensureId: wireState.ensureWireId,
		poison: wireState.poisonWireState,
		send
	});
}

describe('poison on a shed stateful frame', () => {
	it('poisons the capability and degrades later fan-outs to JSON until reconnect', () => {
		const shedded = makeConn();
		const healthy = makeConn();

		// The shed: the connection's 0x03 batch frame comes back 2.
		/** @type {Array<{ value: any, binary: boolean }>} */
		const shedCalls = [];
		const shedBinary = (/** @type {any} */ _ws, /** @type {any} */ value, /** @type {boolean} */ binary) => {
			shedCalls.push({ value, binary });
			return binary ? SHED : SENT;
		};
		const result = deliverStateful(
			shedded,
			[{ n: 1 }],
			['{"topic":"room","event":"tick","data":{"n":1},"seq":1}'],
			[1],
			shedBinary
		);
		expect(result).toBe(SHED);
		expect(shedCalls.filter((c) => c.binary)).toHaveLength(1);

		// (a) The poison marker is set for the capability on this connection,
		// and the state slot is disposed: ensureWireState now answers null,
		// which is what routes every later publish to the JSON envelope.
		expect(wireState.wireStatePoisoned(shedded.ud, CAP)).toBe(true);
		expect(wireState.ensureWireState(shedded.ws, shedded.ud, statefulWire)).toBe(null);
		expect(wireState.wireStatePoisoned(healthy.ud, CAP)).toBe(false);

		// (b) The next fan-out - the shared walk, wired with the same
		// isPoisoned/poison predicates the platform injects - hands the
		// poisoned connection the JSON envelope and the healthy one the
		// 0x03 frame.
		const envelope = '{"topic":"room","event":"tick","data":{"n":2},"seq":2}';
		/** @type {Array<{ ws: any, value: any, binary: boolean }>} */
		const deliveries = [];
		deliverStatelessWireFanout(statefulWire, encodeStatelessWirePayload(statefulWire, 'tick', { n: 2 }), {
			topic: 'room',
			envelope,
			seq: 2,
			connections: [shedded.ws, healthy.ws],
			ensureId: wireState.ensureWireId,
			isPoisoned: wireState.wireStatePoisoned,
			poison: wireState.poisonWireState,
			send: (/** @type {any} */ ws, /** @type {any} */ value, /** @type {boolean} */ binary) => {
				deliveries.push({ ws, value, binary });
				return SENT;
			}
		});
		const toShedded = deliveries.filter((d) => d.ws === shedded.ws);
		const toHealthy = deliveries.filter((d) => d.ws === healthy.ws);
		expect(toShedded).toHaveLength(1);
		expect(toShedded[0].binary).toBe(false);
		expect(toShedded[0].value).toBe(envelope);
		expect(toHealthy).toHaveLength(1);
		expect(toHealthy[0].binary).toBe(true);
		const frame = parseBinaryFrame(toHealthy[0].value);
		expect(frame?.seq).toBe(2);
		expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual(['tick', { n: 2 }]);
	});

	it('sheds mid-batch: the remaining entries of the same batch fall back to JSON', () => {
		// A codec that declines the combined batch payload forces the
		// per-entry walk; the second entry's frame is shed.
		const conn = makeConn();
		const perEntryWire = {
			...statefulWire,
			encode: (/** @type {string} */ event, /** @type {unknown} */ data) =>
				event.endsWith('-batch') ? null : new TextEncoder().encode(JSON.stringify([event, data]))
		};
		const envelopes = [
			'{"topic":"room","event":"tick","data":1,"seq":1}',
			'{"topic":"room","event":"tick","data":2,"seq":2}',
			'{"topic":"room","event":"tick","data":3,"seq":3}'
		];
		/** @type {Array<{ value: any, binary: boolean }>} */
		const calls = [];
		let binarySends = 0;
		const shedSecondBinary = (/** @type {any} */ _ws, /** @type {any} */ value, /** @type {boolean} */ binary) => {
			calls.push({ value, binary });
			if (binary) return ++binarySends === 2 ? SHED : SENT;
			return SENT;
		};
		deliverStatefulWireBatch({
			wire: perEntryWire,
			event: 'tick',
			datas: [1, 2, 3],
			envelopes,
			seqs: [1, 2, 3],
			state: wireState.ensureWireState(conn.ws, conn.ud, perEntryWire) ?? {},
			ws: conn.ws,
			ud: conn.ud,
			topic: 'room',
			ensureId: wireState.ensureWireId,
			poison: wireState.poisonWireState,
			send: shedSecondBinary
		});
		// Two 0x03 attempts (the second shed), then the third entry as JSON.
		expect(calls.map((c) => c.binary)).toEqual([true, true, false]);
		expect(calls[2].value).toBe(envelopes[2]);
		expect(wireState.wireStatePoisoned(conn.ud, CAP)).toBe(true);
	});
});

describe('game-twin cluster gate', () => {
	function makeGameConn(grant) {
		const stats = { messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0 };
		const ud = { [WS_PUBLISH_GRANT]: grant, [WS_STATS]: stats };
		/** @type {string[]} */
		const sent = [];
		// A denial that reached the socket directly would be an uncharged
		// control frame; the route must hand it to the surface's sender, which
		// here records it and counts it out the way the budgeted sender does.
		const ws = { getUserData: () => ud, send: () => { throw new Error('the denial bypassed the control sender'); } };
		const sendControl = (/** @type {any} */ target, /** @type {string} */ frame) => {
			if (target !== ws) throw new Error('the denial was sent to another socket');
			sent.push(frame);
			stats.messagesOut++;
			stats.bytesOut += frame.length;
			return SENT;
		};
		return { ws, ud, sent, stats, sendControl };
	}

	it('refuses a granted frame FORBIDDEN when the lane is not cluster-safe', () => {
		const conn = makeGameConn('arena');
		const published = [];
		const platform = { publishGame: (...args) => { published.push(args); } };
		// A compute worker owns no sockets: relaying from it would fork the
		// room sequencer, so the frame is refused even though grant and
		// event are valid.
		routeGameFrame(conn.ws, undefined, { event: 'move', data: { x: 1 }, id: 7 }, platform, 1, conn.sendControl, { role: 'compute' });
		expect(published).toHaveLength(0);
		expect(conn.sent).toEqual(['{"type":"game-denied","reason":"FORBIDDEN","id":7}']);
		expect(conn.stats.messagesOut).toBe(1);

		// Without an echoed client id the denial carries none.
		routeGameFrame(conn.ws, undefined, { event: 'move', data: {}, id: undefined }, platform, 2, conn.sendControl, { ioWorkers: 2 });
		expect(conn.sent[1]).toBe('{"type":"game-denied","reason":"FORBIDDEN"}');
		expect(published).toHaveLength(0);
	});

	it('relays the identical frame when the topology is safe', () => {
		const conn = makeGameConn('arena');
		const published = [];
		const platform = { publishGame: (...args) => { published.push(args); } };
		routeGameFrame(conn.ws, undefined, { event: 'move', data: { x: 1 }, id: 7 }, platform, 1, conn.sendControl, { ioWorkers: 1, role: 'io' });
		expect(conn.sent).toHaveLength(0);
		expect(published).toEqual([[conn.ws, 'arena', 'move', { x: 1 }, 7]]);
	});

	it('keeps INVALID for bad frames on a safe topology, FORBIDDEN for the unsafe one', () => {
		const conn = makeGameConn('arena');
		const platform = { publishGame: () => {} };
		// Safe topology, valid grant, non-string event: the frame is bad.
		routeGameFrame(conn.ws, undefined, { event: 42, data: null, id: 1 }, platform, 1, conn.sendControl, { ioWorkers: 1, role: 'io' });
		expect(conn.sent[0]).toBe('{"type":"game-denied","reason":"INVALID","id":1}');
		// Unsafe topology masks everything as FORBIDDEN: there is no valid
		// grant on a worker that must not relay.
		routeGameFrame(conn.ws, undefined, { event: 42, data: null, id: 2 }, platform, 1, conn.sendControl, { role: 'compute' });
		expect(conn.sent[1]).toBe('{"type":"game-denied","reason":"FORBIDDEN","id":2}');
	});

	it('derives safety from role and I/O worker count', () => {
		expect(gameLaneClusterSafe({ ioWorkers: 2, role: 'io' })).toBe(false);
		expect(gameLaneClusterSafe({ ioWorkers: 1, role: 'compute' })).toBe(false);
		expect(gameLaneClusterSafe({ ioWorkers: 1, role: 'io' })).toBe(true);
		// Single process without cluster metadata has no role and is safe.
		expect(gameLaneClusterSafe({})).toBe(true);
		expect(() => assertGameLaneClusterSafe({ role: 'compute' })).toThrow(GAME_LANE_CLUSTER_ERROR);
		expect(() => assertGameLaneClusterSafe({})).not.toThrow();
	});
});
