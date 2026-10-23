// A wire-id announce that does not reach the socket retires the mapping, so a
// second codec capability on the same connection and topic announces a fresh
// id before it sends binary, instead of sending frames under an id the client
// never learned. Both runtimes carry the rule (the built handler's
// wire-state.js and createTestServer's own ensureWireIdT), so each is driven
// here through platform.sendWire against a scripted socket that refuses the
// first announce it is handed.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';
import { allocWireId, retireWireId, parseBinaryFrame } from '../src/runtime/wire.js';
import { WS_CAPS } from '../src/runtime/utils/ws-symbols.js';

const STATELESS = {
	capability: 'retire.stateless:1',
	schemaVersion: 1,
	encode: () => new Uint8Array([0xa5, 42])
};
const STATEFUL = {
	capability: 'retire.stateful:1',
	schemaVersion: 1,
	encode: () => new Uint8Array([0xa5, 42]),
	state: { onAttach: () => ({}) }
};
const CODECS = { stateless: STATELESS, stateful: STATEFUL };

/** A socket whose first wire-id announce is refused past backpressure. */
function scriptedSocket() {
	const ud = { [WS_CAPS]: new Set([STATELESS.capability, STATEFUL.capability]) };
	/** @type {Array<{ value: any, binary: boolean, result: number }>} */
	const sent = [];
	let refuseAnnounce = true;
	const ws = {
		getUserData: () => ud,
		getBufferedAmount: () => 0,
		end() {},
		close() {},
		send(/** @type {any} */ value, /** @type {boolean} */ binary) {
			const announce = !binary && typeof value === 'string' && JSON.parse(value).type === 'wire-id';
			const result = announce && refuseAnnounce ? 2 : 1;
			if (announce) refuseAnnounce = false;
			sent.push({ value, binary: !!binary, result });
			return result;
		}
	};
	return { ws, sent };
}

/** @param {{ value: any, binary: boolean, result: number }} entry */
function parsed(entry) {
	return entry.binary ? null : JSON.parse(entry.value);
}

/**
 * @param {any} platform
 * @param {'stateless' | 'stateful'} firstKind
 */
function exercise(platform, firstKind) {
	const secondKind = firstKind === 'stateless' ? 'stateful' : 'stateless';
	const { ws, sent } = scriptedSocket();
	const topic = 'retire:' + firstKind;

	platform.sendWire(ws, topic, 'probe', 1, CODECS[firstKind]);
	// The refused announce, then the JSON envelope for this frame.
	expect(sent.map((s) => s.result)).toEqual([2, 1]);
	expect(parsed(sent[0])).toEqual({ type: 'wire-id', topic, id: 1 });
	expect(parsed(sent[1])).toMatchObject({ topic, event: 'probe' });

	sent.length = 0;
	platform.sendWire(ws, topic, 'probe', 2, CODECS[secondKind]);
	expect(sent).toHaveLength(2);
	expect(parsed(sent[0])).toEqual({ type: 'wire-id', topic, id: 2 });
	expect(sent[1].binary).toBe(true);
	const frame = parseBinaryFrame(sent[1].value);
	expect(frame.topicId).toBe(2);
	expect([...frame.payload]).toEqual([0xa5, 42]);

	// The refused capability stays on JSON; the healthy one reuses its
	// delivered mapping with no second announce.
	sent.length = 0;
	platform.sendWire(ws, topic, 'probe', 3, CODECS[firstKind]);
	platform.sendWire(ws, topic, 'probe', 4, CODECS[secondKind]);
	expect(sent).toHaveLength(2);
	expect(parsed(sent[0])).toMatchObject({ topic, event: 'probe', data: 3 });
	expect(sent[1].binary).toBe(true);
	expect(parseBinaryFrame(sent[1].value).topicId).toBe(2);
}

describe('retireWireId', () => {
	it('retired ids are never reused and leave other topics and connections alone', () => {
		const slot = Symbol('topic-ids');
		const first = {};
		const second = {};
		retireWireId(first, slot, 'a');
		expect(allocWireId(first, slot, 'a').id).toBe(1);
		expect(allocWireId(first, slot, 'b').id).toBe(2);
		expect(allocWireId(second, slot, 'a').id).toBe(1);
		retireWireId(first, slot, 'a');
		retireWireId(first, slot, 'a');
		expect(allocWireId(first, slot, 'a')).toEqual({ id: 3, isNew: true });
		expect(allocWireId(first, slot, 'b')).toEqual({ id: 2, isNew: false });
		expect(allocWireId(second, slot, 'a')).toEqual({ id: 1, isNew: false });
	});
});

describe('wire-id recovery across capabilities on the built runtime', () => {
	/** @type {ReturnType<typeof buildRuntime>} */
	let payload;
	/** @type {any} */
	let platform;
	beforeAll(async () => {
		payload = buildRuntime();
		({ platform } = await import(pathToFileURL(path.join(payload.dir, 'handler', 'platform.js')).href));
	});
	afterAll(() => { payload?.cleanup(); });

	it.each(['stateless', 'stateful'])('re-announces after the %s capability loses its first announcement', (firstKind) => {
		exercise(platform, /** @type {any} */ (firstKind));
	});
});

describe('wire-id recovery across capabilities on createTestServer', () => {
	/** @type {any} */
	let server;
	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
	});
	afterAll(async () => { await server?.close(); });

	it.each(['stateless', 'stateful'])('re-announces after the %s capability loses its first announcement', (firstKind) => {
		exercise(server.platform, /** @type {any} */ (firstKind));
	});
});
