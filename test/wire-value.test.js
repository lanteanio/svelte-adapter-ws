// wireValue spells a header value as the bytes uWS 20.69.0 writes for the same
// JS string: its UTF-8 bytes, a lone surrogate as its three bytes (WTF-8), each
// byte one latin1 character for node's header writer.

import { describe, it, expect } from 'vitest';
import { wireValue } from '../src/runtime/handler/http-helpers.js';

const hex = (/** @type {string} */ value) => Buffer.from(wireValue(value), 'latin1').toString('hex');

describe('wireValue', () => {
	it('leaves ASCII as it is', () => {
		expect(wireValue('max-age=60, public')).toBe('max-age=60, public');
	});

	it('writes the UTF-8 bytes uWS writes', () => {
		expect(hex('caf' + String.fromCharCode(0xe9))).toBe('636166c3a9');
		expect(hex(String.fromCharCode(0x20ac))).toBe('e282ac');
		expect(hex(String.fromCharCode(0x85))).toBe('c285');
		expect(hex(String.fromCharCode(0xd83d, 0xde00))).toBe('f09f9880');
		expect(hex(String.fromCharCode(0xff, 0x100))).toBe('c3bfc480');
	});

	it('writes a lone surrogate as its three bytes, as uWS does', () => {
		expect(hex('a' + String.fromCharCode(0xd800) + 'b')).toBe('61eda08062');
		expect(hex('x' + String.fromCharCode(0xdc00))).toBe('78edb080');
		// A pair beside a lone half is still one four-byte character.
		expect(hex(String.fromCharCode(0xd83d, 0xde00, 0xd800))).toBe('f09f9880eda080');
		expect(hex(String.fromCharCode(0xd800, 0xd83d, 0xde00))).toBe('eda080f09f9880');
	});
});
