import { describe, expect, it } from 'vitest';
import { normalizeStaticHeaders, normalizeStaticCacheControl } from '../src/build-config.js';

describe('normalizeStaticHeaders', () => {
	it('returns null headers for empty input', () => {
		expect(normalizeStaticHeaders(undefined)).toEqual({ headers: null, dropped: [] });
		expect(normalizeStaticHeaders(null)).toEqual({ headers: null, dropped: [] });
	});

	it('lowercases keys and keeps values', () => {
		const result = normalizeStaticHeaders({ 'X-Frame-Options': 'DENY' });
		expect(result.headers).toEqual({ 'x-frame-options': 'DENY' });
		expect(result.dropped).toEqual([]);
	});

	it('strips reserved transfer and caching headers, reporting them', () => {
		const result = normalizeStaticHeaders({
			'Content-Type': 'text/evil',
			ETag: '"nope"',
			'x-custom': 'kept'
		});
		expect(result.headers).toEqual({ 'x-custom': 'kept' });
		expect(result.dropped.sort()).toEqual(['content-type', 'etag']);
	});

	it('returns null headers when only reserved keys were given', () => {
		const result = normalizeStaticHeaders({ 'cache-control': 'no-store' });
		expect(result.headers).toBeNull();
		expect(result.dropped).toEqual(['cache-control']);
	});

	it('throws on non-object input', () => {
		expect(() => normalizeStaticHeaders('nope')).toThrow(/staticHeaders/);
		expect(() => normalizeStaticHeaders(['a'])).toThrow(/staticHeaders/);
	});

	it('throws on a non-string value', () => {
		expect(() => normalizeStaticHeaders({ 'x-num': 5 })).toThrow(/must be a string/);
	});

	it('refuses header names that are not RFC 7230 tokens', () => {
		expect(() => normalizeStaticHeaders({ 'x-bad name': 'v' })).toThrow(/RFC 7230/);
		expect(() => normalizeStaticHeaders({ 'x-bad:colon': 'v' })).toThrow(/RFC 7230/);
	});

	it('refuses control characters in values (response-splitting shape)', () => {
		const crlf = String.fromCharCode(13) + String.fromCharCode(10);
		expect(() => normalizeStaticHeaders({ 'x-foo': `bar${crlf}set-cookie: evil=1` })).toThrow(/control character/);
		expect(() => normalizeStaticHeaders({ 'x-foo': 'bar' + String.fromCharCode(0) })).toThrow(/control character/);
	});
});

describe('normalizeStaticCacheControl', () => {
	it('returns null for empty input', () => {
		expect(normalizeStaticCacheControl(undefined)).toBeNull();
		expect(normalizeStaticCacheControl(null)).toBeNull();
		expect(normalizeStaticCacheControl([])).toBeNull();
	});

	it('accepts exact and directory rules and sorts most-specific first', () => {
		const rules = normalizeStaticCacheControl([
			{ pattern: '/fonts/', cacheControl: 'public, max-age=604800' },
			{ pattern: '/fonts/brand/', cacheControl: 'public, max-age=31536000' }
		]);
		expect(rules?.[0].pattern).toBe('/fonts/brand/');
		expect(rules?.[1].pattern).toBe('/fonts/');
	});

	it('rejects non-array input', () => {
		expect(() => normalizeStaticCacheControl({})).toThrow(/array/);
	});

	it('rejects unknown keys on a rule', () => {
		expect(() =>
			normalizeStaticCacheControl([{ pattern: '/a', cacheControl: 'x', extra: 1 }])
		).toThrow(/unknown key/);
	});

	it('rejects relative, wildcard, query and traversal patterns', () => {
		for (const pattern of ['a/b', '/a*b', '/a?x=1', '/a#f', '/../etc', '/a/./b', '/a\\b']) {
			expect(() => normalizeStaticCacheControl([{ pattern, cacheControl: 'x' }]), pattern).toThrow();
		}
	});

	it('rejects control characters in pattern and value', () => {
		const ctl = String.fromCharCode(3);
		expect(() => normalizeStaticCacheControl([{ pattern: `/a${ctl}`, cacheControl: 'x' }])).toThrow();
		expect(() => normalizeStaticCacheControl([{ pattern: '/a', cacheControl: `x${ctl}` }])).toThrow();
		const del = String.fromCharCode(127);
		expect(() => normalizeStaticCacheControl([{ pattern: `/a${del}`, cacheControl: 'x' }])).toThrow();
		expect(() => normalizeStaticCacheControl([{ pattern: '/a', cacheControl: `x${del}` }])).toThrow();
	});

	it('rejects duplicate patterns', () => {
		expect(() =>
			normalizeStaticCacheControl([
				{ pattern: '/a', cacheControl: 'x' },
				{ pattern: '/a', cacheControl: 'y' }
			])
		).toThrow(/duplicate/);
	});

	it('trims the cacheControl value', () => {
		const rules = normalizeStaticCacheControl([{ pattern: '/a', cacheControl: '  public ' }]);
		expect(rules?.[0].cacheControl).toBe('public');
	});
});
