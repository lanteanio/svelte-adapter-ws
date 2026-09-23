// The shipped range parser (src/runtime/utils/byte-range.js), the one
// serveStatic calls. The cases are the family's parseRange suite.

import { describe, it, expect } from 'vitest';
import { parseRange } from '../src/runtime/utils/byte-range.js';

describe('parseRange', () => {
	it('parses a simple byte range', () => {
		expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
	});

	it('a zero-length suffix (bytes=-0) is unsatisfiable, not ignorable', () => {
		// RFC 9110 14.2: a suffix range is satisfiable only with a NON-ZERO
		// length. null is the 416 outcome; false would have served the whole
		// body for a request that asked for none of it.
		expect(parseRange('bytes=-0', 1000)).toBeNull();
		expect(parseRange('bytes=-00', 1000)).toBeNull();
		expect(parseRange('bytes=-1', 1000)).toEqual({ start: 999, end: 999 });
	});

	it('a suffix longer than the representation is the whole representation', () => {
		expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
	});

	it('a bare dash is malformed, not a zero suffix', () => {
		expect(parseRange('bytes=-', 1000)).toBe(false);
	});

	it('parses an open-ended range (bytes=N-)', () => {
		expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
	});

	it('parses a suffix range (bytes=-N)', () => {
		expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
	});

	it('returns false for multi-range (comma-separated)', () => {
		expect(parseRange('bytes=0-499,600-699', 1000)).toBe(false);
	});

	it('returns null for unsatisfiable range (start >= fileSize)', () => {
		expect(parseRange('bytes=1000-1099', 1000)).toBeNull();
	});

	it('returns false for bad prefix', () => {
		expect(parseRange('units=0-499', 1000)).toBe(false);
	});

	it('clamps end to fileSize - 1', () => {
		expect(parseRange('bytes=0-9999', 100)).toEqual({ start: 0, end: 99 });
	});

	it('returns false for malformed end token (bytes=0-1oops)', () => {
		expect(parseRange('bytes=0-1oops', 1000)).toBe(false);
	});

	it('returns false for malformed start token (bytes=1oops-100)', () => {
		expect(parseRange('bytes=1oops-100', 1000)).toBe(false);
	});

	it('returns false for malformed suffix token (bytes=-1oops)', () => {
		expect(parseRange('bytes=-1oops', 1000)).toBe(false);
	});

	it('accepts leading zeros (bytes=007-100 is valid per RFC grammar)', () => {
		expect(parseRange('bytes=007-100', 1000)).toEqual({ start: 7, end: 100 });
	});

	it('null and false have distinct semantics (null = 416, false = 200 fallback)', () => {
		// null: syntactically valid, start >= fileSize -> 416
		expect(parseRange('bytes=1000-1099', 1000)).toBeNull();
		// false: syntactically invalid -> 200 fallback
		expect(parseRange('bytes=0-1oops', 1000)).toBe(false);
		// both are falsy but only null should trigger 416
		expect(parseRange('bytes=1000-1099', 1000) === null).toBe(true);
		expect(parseRange('bytes=0-1oops', 1000) === false).toBe(true);
	});
});
