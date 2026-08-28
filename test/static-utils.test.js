import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludedDotPath } from '../src/runtime/utils/dot-path.js';
import { mimeLookup } from '../src/runtime/utils/mime.js';
import {
	mergeStaticHeaders,
	resolveStaticCacheControl,
	RESERVED_STATIC_HEADER_KEYS
} from '../src/runtime/utils/static-headers.js';
import { listExcludedDotPaths } from '../src/static-scan.js';
import { parse_as_bytes, parse_origin } from '../src/runtime/utils/parse.js';

describe('excludedDotPath', () => {
	it('refuses any dot segment', () => {
		expect(excludedDotPath('.env')).toBe(true);
		expect(excludedDotPath('a/.hidden/b')).toBe(true);
		expect(excludedDotPath('a/b/.git')).toBe(true);
	});

	it('serves normal paths', () => {
		expect(excludedDotPath('index.html')).toBe(false);
		expect(excludedDotPath('a/b/c.css')).toBe(false);
	});

	it('exempts a top-level .well-known but not its dotfiles or nested forms', () => {
		expect(excludedDotPath('.well-known/security.txt')).toBe(false);
		expect(excludedDotPath('.well-known/.hidden')).toBe(true);
		expect(excludedDotPath('x/.well-known/y')).toBe(true);
	});
});

describe('mimeLookup', () => {
	it('maps common extensions', () => {
		expect(mimeLookup('a.html')).toBe('text/html');
		expect(mimeLookup('a.js')).toBe('text/javascript');
		expect(mimeLookup('a.wasm')).toBe('application/wasm');
		expect(mimeLookup('a.woff2')).toBe('font/woff2');
	});

	it('is case-insensitive and defaults to octet-stream', () => {
		expect(mimeLookup('A.PNG')).toBe('image/png');
		expect(mimeLookup('noext')).toBe('application/octet-stream');
		expect(mimeLookup('weird.xyzzy')).toBe('application/octet-stream');
	});
});

describe('mergeStaticHeaders', () => {
	const base = /** @type {[string, string][]} */ ([
		['x-content-type-options', 'nosniff'],
		['vary', 'Accept-Encoding']
	]);

	it('returns the base untouched when no overrides exist', () => {
		expect(mergeStaticHeaders(base, null)).toBe(base);
	});

	it('appends new keys and replaces existing non-reserved keys in place', () => {
		const merged = mergeStaticHeaders(base, {
			'X-Content-Type-Options': 'nosniff, custom',
			'x-frame-options': 'DENY'
		});
		expect(merged).toContainEqual(['x-content-type-options', 'nosniff, custom']);
		expect(merged).toContainEqual(['x-frame-options', 'DENY']);
		// input untouched
		expect(base).toContainEqual(['x-content-type-options', 'nosniff']);
	});

	it('never merges reserved keys', () => {
		for (const key of RESERVED_STATIC_HEADER_KEYS) {
			const merged = mergeStaticHeaders(base, { [key]: 'evil' });
			expect(merged.find(([k, v]) => k === key && v === 'evil')).toBeUndefined();
		}
	});
});

describe('resolveStaticCacheControl', () => {
	const rules = [
		{ pattern: '/fonts/brand/', cacheControl: 'brand' },
		{ pattern: '/fonts/', cacheControl: 'fonts' },
		{ pattern: '/logo.svg', cacheControl: 'logo' }
	];

	it('picks the most specific matching rule', () => {
		expect(resolveStaticCacheControl('fonts/brand/a.woff2', rules)).toBe('brand');
		expect(resolveStaticCacheControl('fonts/other.woff2', rules)).toBe('fonts');
	});

	it('treats non-slash patterns as exact matches', () => {
		expect(resolveStaticCacheControl('logo.svg', rules)).toBe('logo');
		expect(resolveStaticCacheControl('logo.svg.bak', rules)).toBe('');
	});

	it('returns empty string without rules', () => {
		expect(resolveStaticCacheControl('a.css', null)).toBe('');
		expect(resolveStaticCacheControl('a.css', [])).toBe('');
	});
});

describe('listExcludedDotPaths', () => {
	/** @type {string[]} */
	const cleanup = [];
	afterEach(() => {
		for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it('names refused files and collapses refused directories', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-scan-'));
		cleanup.push(dir);
		writeFileSync(path.join(dir, '.env'), 'SECRET=1');
		mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
		writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
		mkdirSync(path.join(dir, '.well-known'));
		writeFileSync(path.join(dir, '.well-known', 'security.txt'), 'ok');
		writeFileSync(path.join(dir, '.well-known', '.hidden'), 'no');
		writeFileSync(path.join(dir, 'app.css'), 'ok');
		writeFileSync(path.join(dir, 'app.css.br'), 'compressed sibling');

		const refused = listExcludedDotPaths(dir);
		expect(refused).toContain('.env');
		expect(refused).toContain('.git/');
		expect(refused).toContain('.well-known/.hidden');
		expect(refused).not.toContain('.well-known');
		expect(refused.some((p) => p.startsWith('.git/') && p !== '.git/')).toBe(false);
		expect(refused).not.toContain('app.css');
		expect(refused).not.toContain('app.css.br');
	});
});

describe('parse_as_bytes', () => {
	it('parses plain numbers and K/M/G suffixes with optional B', () => {
		expect(parse_as_bytes('1024')).toBe(1024);
		expect(parse_as_bytes('512K')).toBe(512 * 1024);
		expect(parse_as_bytes('512KB')).toBe(512 * 1024);
		expect(parse_as_bytes('2M')).toBe(2 * 1024 * 1024);
		expect(parse_as_bytes('1G')).toBe(1024 ** 3);
	});

	it('rejects negative and non-finite values as NaN', () => {
		expect(parse_as_bytes('-100')).toBeNaN();
		expect(parse_as_bytes('Infinity')).toBeNaN();
		expect(parse_as_bytes('junk')).toBeNaN();
	});
});

describe('parse_origin', () => {
	it('passes through undefined', () => {
		expect(parse_origin(undefined)).toBeUndefined();
	});

	it('normalizes to the URL origin', () => {
		expect(parse_origin('https://example.com/some/path')).toBe('https://example.com');
	});

	it('rejects invalid URLs and non-http protocols', () => {
		expect(() => parse_origin('nonsense')).toThrow(/Invalid ORIGIN/);
		expect(() => parse_origin('ftp://example.com')).toThrow(/http/);
	});
});
