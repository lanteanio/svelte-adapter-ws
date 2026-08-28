import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../src/runtime/utils/request-id.js';
import { isDedupBufferable } from '../src/runtime/handler/ssr-dedup.js';

describe('resolveRequestId', () => {
	it('accepts a printable token up to 128 chars, trimmed', () => {
		expect(resolveRequestId('abc-123')).toBe('abc-123');
		expect(resolveRequestId('  x  ')).toBe('x');
		expect(resolveRequestId('a'.repeat(128))).toBe('a'.repeat(128));
	});

	it('refuses empty, over-long and non-string input', () => {
		expect(resolveRequestId('')).toBeNull();
		expect(resolveRequestId('   ')).toBeNull();
		expect(resolveRequestId('a'.repeat(129))).toBeNull();
		expect(resolveRequestId(undefined)).toBeNull();
		expect(resolveRequestId(null)).toBeNull();
	});

	it('refuses every smuggled control or non-ASCII character', () => {
		const cr = String.fromCharCode(13);
		const lf = String.fromCharCode(10);
		const esc = String.fromCharCode(27);
		const nul = String.fromCharCode(0);
		expect(resolveRequestId(`trace${cr}${lf}x-injected: 1`)).toBeNull();
		expect(resolveRequestId(`trace${esc}[31m`)).toBeNull();
		expect(resolveRequestId(`trace${nul}`)).toBeNull();
		expect(resolveRequestId('tra e'.replace(' ', String.fromCharCode(0xe7)))).toBeNull();
		expect(resolveRequestId('with space')).toBeNull();
	});
});

describe('isDedupBufferable', () => {
	it('refuses every spelling of an event stream', () => {
		for (const ct of ['text/event-stream', 'text/event-stream; charset=utf-8', 'TEXT/EVENT-STREAM']) {
			expect(isDedupBufferable(new Response('x', { headers: { 'content-type': ct } })), ct).toBe(false);
		}
	});

	it('buffers finite content types, including responses without one', () => {
		expect(isDedupBufferable(new Response('x', { headers: { 'content-type': 'text/html' } }))).toBe(true);
		expect(isDedupBufferable(new Response('x', { headers: { 'content-type': 'application/json' } }))).toBe(true);
		expect(isDedupBufferable(new Response('x'))).toBe(true);
	});
});
