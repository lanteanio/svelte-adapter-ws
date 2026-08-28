import { describe, expect, it } from 'vitest';
import { collectRequestHeaders, declareSingleValuedProxyHeaders } from '../src/runtime/utils/request-headers.js';

/** @param {string[]} raw */
function collect(raw) {
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(raw, headers);
	return { headers, ambiguous };
}

describe('collectRequestHeaders', () => {
	it('joins repeated list headers with ", " in arrival order', () => {
		const { headers, ambiguous } = collect(['X-Vendor-Chain', 'a', 'X-Vendor-Chain', 'b', 'X-Vendor-Chain', 'c']);
		expect(ambiguous).toBeNull();
		expect(headers['x-vendor-chain']).toBe('a, b, c');
	});

	it('joins x-forwarded-for lines so every hop survives', () => {
		const { headers } = collect(['X-Forwarded-For', '1.1.1.1', 'X-Forwarded-For', '2.2.2.2']);
		expect(headers['x-forwarded-for']).toBe('1.1.1.1, 2.2.2.2');
	});

	it('joins cookie lines with "; " (HTTP/2 downgrade shape)', () => {
		const { headers } = collect(['Cookie', 'a=1', 'Cookie', 'b=2']);
		expect(headers['cookie']).toBe('a=1; b=2');
	});

	it('keeps the first set-cookie line and drops the rest without refusing', () => {
		const { headers, ambiguous } = collect(['Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'Set-Cookie', 'b=2']);
		expect(ambiguous).toBeNull();
		expect(headers['set-cookie']).toBe('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
	});

	it('keeps the LAST line of every well-known proxy identity header', () => {
		for (const name of [
			'x-forwarded-proto', 'x-forwarded-protocol', 'x-forwarded-scheme',
			'x-forwarded-host', 'x-forwarded-port', 'x-real-ip',
			'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'fly-client-ip'
		]) {
			const { headers, ambiguous } = collect([name, 'client-authored', name, 'proxy-authored']);
			expect(ambiguous, name).toBeNull();
			expect(headers[name], name).toBe('proxy-authored');
		}
	});

	it('refuses every repeated framing/identity singleton', () => {
		for (const name of ['host', 'content-length', 'transfer-encoding', 'content-type', 'authorization', 'proxy-authorization', 'origin']) {
			const { ambiguous } = collect([name, 'a', name, 'b']);
			expect(ambiguous, name).toBe(name);
		}
	});

	it('names the FIRST offender and keeps collecting under the same policy', () => {
		const { headers, ambiguous } = collect(['Host', 'a', 'Origin', 'x', 'Host', 'b', 'Origin', 'y', 'X-Forwarded-Proto', 'p1', 'X-Forwarded-Proto', 'p2']);
		expect(ambiguous).toBe('host');
		// The refused singletons keep their first line; the proxy class still
		// applied last-line-wins.
		expect(headers['host']).toBe('a');
		expect(headers['origin']).toBe('x');
		expect(headers['x-forwarded-proto']).toBe('p2');
	});

	it('handles header names that live on Object.prototype', () => {
		const { headers, ambiguous } = collect(['Constructor', 'one', 'ValueOf', 'two', 'HasOwnProperty', 'three']);
		expect(ambiguous).toBeNull();
		// Keys are lowercased like node's own header bag.
		expect(headers['constructor']).toBe('one');
		expect(headers['valueof']).toBe('two');
		expect(headers['hasownproperty']).toBe('three');
		// A repeat of a prototype-named header still takes the list-join
		// default rather than being misread as a duplicate of the inherited
		// function.
		const twice = collect(['Constructor', 'a', 'Constructor', 'b']);
		expect(twice.headers['constructor']).toBe('a, b');
	});

	it('never corrupts the header bag prototype via a __proto__ header', () => {
		const { headers } = collect(['__proto__', 'evil', 'x-after', 'ok']);
		expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
		expect(headers['x-after']).toBe('ok');
		// The __proto__ line lands nowhere readable - the same fate node's own
		// header bag gives it - rather than becoming an own property carrying
		// attacker input into every later read.
		expect(Object.getOwnPropertyDescriptor(headers, '__proto__')).toBeUndefined();
	});

	it('declareSingleValuedProxyHeaders moves configured names into last-line-wins', () => {
		try {
			declareSingleValuedProxyHeaders(['x-my-lb-ip']);
			const { headers } = collect(['X-My-LB-IP', 'client', 'X-My-LB-IP', 'proxy']);
			expect(headers['x-my-lb-ip']).toBe('proxy');
		} finally {
			declareSingleValuedProxyHeaders([]);
		}
	});

	it('never moves x-forwarded-for out of the join class, even when declared', () => {
		try {
			declareSingleValuedProxyHeaders(['x-forwarded-for']);
			const { headers } = collect(['X-Forwarded-For', '1.1.1.1', 'X-Forwarded-For', '2.2.2.2']);
			expect(headers['x-forwarded-for']).toBe('1.1.1.1, 2.2.2.2');
		} finally {
			declareSingleValuedProxyHeaders([]);
		}
	});

	it('a declaration replaces the previous one', () => {
		declareSingleValuedProxyHeaders(['x-custom-one']);
		declareSingleValuedProxyHeaders([]);
		const { headers } = collect(['X-Custom-One', 'a', 'X-Custom-One', 'b']);
		expect(headers['x-custom-one']).toBe('a, b');
	});
});
