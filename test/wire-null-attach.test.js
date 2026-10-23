// A stateful codec whose onAttach returns null for a connection (an older
// client that negotiated the stateless schema) still sends that connection
// binary from sendWire: the codec encodes against a null state and the frame
// carries the codec's baseline schema version. Both runtimes carry the rule,
// so each is driven through platform.sendWire against a scripted socket.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { WS_CAPS } from '../src/runtime/utils/ws-symbols.js';

function codec() {
	/** @type {unknown[]} */
	const states = [];
	return {
		states,
		wire: {
			capability: 'nullattach.stateful:1',
			schemaVersion: 3,
			encode: (/** @type {string} */ _event, /** @type {unknown} */ _data, /** @type {unknown} */ state) => {
				states.push(state);
				return new Uint8Array([7, 9]);
			},
			state: { onAttach: () => null }
		}
	};
}

function scriptedSocket(/** @type {string} */ capability) {
	const ud = { [WS_CAPS]: new Set([capability]) };
	/** @type {Array<{ value: any, binary: boolean }>} */
	const sent = [];
	const ws = {
		getUserData: () => ud,
		getBufferedAmount: () => 0,
		end() {},
		close() {},
		send(/** @type {any} */ value, /** @type {boolean} */ binary) {
			sent.push({ value, binary: !!binary });
			return 1;
		}
	};
	return { ws, sent };
}

/** @param {any} platform */
function exercise(platform) {
	const { states, wire } = codec();
	const { ws, sent } = scriptedSocket(wire.capability);
	platform.sendWire(ws, 'nullattach', 'probe', { n: 1 }, wire);
	expect(states).toEqual([null]);
	expect(sent).toHaveLength(2);
	expect(JSON.parse(sent[0].value)).toEqual({ type: 'wire-id', topic: 'nullattach', id: 1 });
	expect(sent[1].binary).toBe(true);
	const frame = parseBinaryFrame(sent[1].value);
	expect(frame.schemaVersion).toBe(3);
	expect(frame.topicId).toBe(1);
	expect([...frame.payload]).toEqual([7, 9]);
}

describe('sendWire with a null onAttach on the built runtime', () => {
	/** @type {ReturnType<typeof buildRuntime>} */
	let payload;
	/** @type {any} */
	let platform;
	beforeAll(async () => {
		payload = buildRuntime();
		({ platform } = await import(pathToFileURL(path.join(payload.dir, 'handler', 'platform.js')).href));
	});
	afterAll(() => { payload?.cleanup(); });

	it('encodes against a null state and sends the baseline binary frame', () => {
		exercise(platform);
	});
});

describe('sendWire with a null onAttach on createTestServer', () => {
	/** @type {any} */
	let server;
	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
	});
	afterAll(async () => { await server?.close(); });

	it('encodes against a null state and sends the baseline binary frame', () => {
		exercise(server.platform);
	});
});
