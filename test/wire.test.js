// The binary wire in isolation: frame layout against the family conformance
// vector, varint 64-bit safety, and the announce/poison state machine pieces
// that are pure.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBinaryFrame, parseBinaryFrame, allocWireId, wireIdAnnounce, WIRE_BINARY_TAG } from '../src/runtime/wire.js';
import { WS_TOPIC_IDS } from '../src/runtime/utils/ws-symbols.js';
import { encodeValue, decodeValue } from '../src/runtime/wire-value.js';

const vector = JSON.parse(readFileSync(new URL('../test-vectors/binary.json', import.meta.url), 'utf8'));

describe('0x03 frame conformance', () => {
	it('parses the family conformance vector byte-exactly', () => {
		const bytes = Uint8Array.from(Buffer.from(vector.hexFrame, 'hex'));
		const frame = parseBinaryFrame(bytes);
		expect(frame).not.toBeNull();
		expect(bytes[0]).toBe(WIRE_BINARY_TAG);
		expect(frame.schemaVersion).toBe(vector.decoded.schemaVersion);
		expect(frame.topicId).toBe(vector.decoded.topicId);
		expect(frame.seq).toBe(vector.decoded.seq);
		expect(Buffer.from(frame.payload).toString('hex')).toBe(vector.decoded.payloadHex);
	});

	it('rebuilds the conformance vector byte-exactly', () => {
		const rebuilt = buildBinaryFrame(
			vector.decoded.schemaVersion,
			vector.decoded.topicId,
			vector.decoded.seq,
			Uint8Array.from(Buffer.from(vector.decoded.payloadHex, 'hex'))
		);
		expect(Buffer.from(rebuilt).toString('hex')).toBe(vector.hexFrame);
	});

	it('round-trips topic ids above 2^32 (division math, never shifts)', () => {
		for (const topicId of [1, 127, 128, 0xffffffff, 0x100000001, 2 ** 45 + 17]) {
			const frame = buildBinaryFrame(2, topicId, 7, new Uint8Array([1, 2]));
			const parsed = parseBinaryFrame(frame);
			expect(parsed?.topicId, String(topicId)).toBe(topicId);
		}
	});

	it('drops truncated and mistagged frames as null', () => {
		expect(parseBinaryFrame(new Uint8Array([]))).toBeNull();
		expect(parseBinaryFrame(new Uint8Array([0x03]))).toBeNull();
		expect(parseBinaryFrame(new Uint8Array([0x02, 1, 1, 1]))).toBeNull();
		// A varint cut mid-continuation is a truncation, not a crash.
		expect(parseBinaryFrame(new Uint8Array([0x03, 1, 0x80]))).toBeNull();
	});
});

describe('per-connection topic ids', () => {
	it('allocates monotonically from 1 and never reclaims', () => {
		const ud = {};
		const a = allocWireId(ud, WS_TOPIC_IDS, 'alpha');
		const b = allocWireId(ud, WS_TOPIC_IDS, 'beta');
		const aAgain = allocWireId(ud, WS_TOPIC_IDS, 'alpha');
		expect(a).toEqual({ id: 1, isNew: true });
		expect(b).toEqual({ id: 2, isNew: true });
		expect(aAgain).toEqual({ id: 1, isNew: false });
	});

	it('announces the mapping as a compact type-first control frame', () => {
		expect(wireIdAnnounce('room', 3)).toBe('{"type":"wire-id","topic":"room","id":3}');
	});
});

describe('value codec', () => {
	it('round-trips the game payload shapes', () => {
		for (const value of [['move', { x: 1, y: 2 }], ['fire', null, 42], ['s', 'text', 'id-1']]) {
			expect(decodeValue(encodeValue(value))).toEqual(value);
		}
	});
});
