import { describe, expect, it } from 'vitest';
import { createTrustedProxyMatcher, createClientIpResolver } from '../src/runtime/utils/trusted-proxies.js';

describe('createTrustedProxyMatcher', () => {
	it('returns null for an empty spec', () => {
		expect(createTrustedProxyMatcher('')).toBeNull();
		expect(createTrustedProxyMatcher('  ,  ')).toBeNull();
	});

	it('matches exact IPv4 addresses and CIDR ranges', () => {
		const m = createTrustedProxyMatcher('10.0.0.0/8, 172.16.0.5');
		expect(m?.match('10.1.2.3')).toBe(true);
		expect(m?.match('172.16.0.5')).toBe(true);
		expect(m?.match('172.16.0.6')).toBe(false);
		expect(m?.match('11.0.0.1')).toBe(false);
	});

	it('matches /0 and /32 edge prefixes', () => {
		expect(createTrustedProxyMatcher('0.0.0.0/0')?.match('203.0.113.7')).toBe(true);
		const m32 = createTrustedProxyMatcher('192.168.1.1/32');
		expect(m32?.match('192.168.1.1')).toBe(true);
		expect(m32?.match('192.168.1.2')).toBe(false);
	});

	it('matches IPv6 addresses, ranges and the unspecified-prefix form', () => {
		const m = createTrustedProxyMatcher('2001:db8::/32, ::1');
		expect(m?.match('2001:db8:1234::9')).toBe(true);
		expect(m?.match('2001:db9::1')).toBe(false);
		expect(m?.match('::1')).toBe(true);
		expect(createTrustedProxyMatcher('::/0')?.match('fe80::42')).toBe(true);
	});

	it('unwraps IPv4-mapped IPv6, brackets and zone ids before matching', () => {
		const m = createTrustedProxyMatcher('127.0.0.1');
		expect(m?.match('::ffff:127.0.0.1')).toBe(true);
		expect(m?.match('[127.0.0.1]')).toBe(true);
		const v6 = createTrustedProxyMatcher('fe80::1');
		expect(v6?.match('fe80::1%eth0')).toBe(true);
	});

	it('throws on malformed entries rather than failing open or closed', () => {
		expect(() => createTrustedProxyMatcher('not-an-ip')).toThrow(/not a valid IP/);
		expect(() => createTrustedProxyMatcher('10.0.0.0/33')).toThrow(/prefix length/);
		expect(() => createTrustedProxyMatcher('2001:db8::/129')).toThrow(/prefix length/);
	});
});

describe('createClientIpResolver', () => {
	it('returns the socket address without a configured header', () => {
		const resolve = createClientIpResolver({ addressHeader: '', xffDepth: 1, matcher: null });
		expect(resolve('9.9.9.9', { 'x-forwarded-for': '1.1.1.1' })).toBe('9.9.9.9');
	});

	it('resolves the XFF hop the depth names, counting from the right', () => {
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 2, matcher: null });
		expect(resolve('9.9.9.9', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })).toBe('2.2.2.2');
	});

	it('answers the socket peer for a chain shorter than the configured depth', () => {
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 3, matcher: null });
		expect(resolve('9.9.9.9', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })).toBe('9.9.9.9');
	});

	it('ignores the claim when the direct peer is untrusted', () => {
		let warned = 0;
		const resolve = createClientIpResolver({
			addressHeader: 'x-forwarded-for',
			xffDepth: 1,
			matcher: createTrustedProxyMatcher('10.0.0.0/8'),
			onUntrusted: () => { warned++; }
		});
		expect(resolve('203.0.113.1', { 'x-forwarded-for': '1.1.1.1' })).toBe('203.0.113.1');
		expect(warned).toBe(1);
	});

	it('honors the claim when the direct peer is trusted', () => {
		const resolve = createClientIpResolver({
			addressHeader: 'x-forwarded-for',
			xffDepth: 1,
			matcher: createTrustedProxyMatcher('10.0.0.0/8')
		});
		expect(resolve('10.5.5.5', { 'x-forwarded-for': '1.1.1.1' })).toBe('1.1.1.1');
	});

	it('truncates an over-long XFF from the head, keeping the proxy tail', () => {
		const resolve = createClientIpResolver({ addressHeader: 'x-forwarded-for', xffDepth: 1, matcher: null });
		const padding = ('x'.repeat(60) + ', ').repeat(200); // > 8192 bytes
		expect(resolve('9.9.9.9', { 'x-forwarded-for': padding + '2.2.2.2' })).toBe('2.2.2.2');
	});

	it('truncates an over-long single-address header keeping the LEADING bytes', () => {
		const resolve = createClientIpResolver({ addressHeader: 'x-real-ip', xffDepth: 1, matcher: null });
		const value = '1.2.3.4' + 'x'.repeat(300);
		const resolved = resolve('9.9.9.9', { 'x-real-ip': value });
		expect(resolved.length).toBe(128);
		expect(resolved.startsWith('1.2.3.4')).toBe(true);
	});
});
