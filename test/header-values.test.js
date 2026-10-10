import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { decodeRequestHeaders, webSocketKeyByteLength } from '../src/runtime/handler/header-values.js';

function request(rawHeaders) {
	const req = new IncomingMessage(new Socket());
	req._addHeaderLines(rawHeaders, rawHeaders.length);
	return req;
}

describe('native JavaScript header values', () => {
	it('decodes valid UTF-8 and resets previously materialized node views', () => {
		const req = request(['X-Probe', 'a\xc3\xa9b']);
		expect(req.headers['x-probe']).toBe('a\xc3\xa9b');
		expect(req.headersDistinct['x-probe']).toEqual(['a\xc3\xa9b']);
		decodeRequestHeaders(req);
		expect(req.rawHeaders).toEqual(['X-Probe', 'a\u00e9b']);
		expect(req.headers['x-probe']).toBe('a\u00e9b');
		expect(req.headersDistinct['x-probe']).toEqual(['a\u00e9b']);
		decodeRequestHeaders(req);
		expect(req.headers['x-probe']).toBe('a\u00e9b');
	});
	it.each([
		['a\xe9b', 'a\ufffdb'], ['a\xe2\x82b', 'a\ufffdb'],
		['a\xc0\xafb', 'a\ufffd\ufffdb'], ['a\xf0\x9f\x98\x80b', 'a\ud83d\ude00b']
	])('decodes bytes %s as the native string boundary', (bytes, value) => {
		const req = request(['X-Probe', bytes]);
		decodeRequestHeaders(req);
		expect(req.headers['x-probe']).toBe(value);
	});
	it('keeps byte-based key routing when decoded string length changes', () => {
		const req = request(['Sec-WebSocket-Key', 'a'.repeat(11) + '\xc3\xa9' + 'a'.repeat(11)]);
		decodeRequestHeaders(req);
		expect(req.rawHeaders[1]).toHaveLength(23);
		expect(webSocketKeyByteLength(req.rawHeaders)).toBe(24);
	});
	it('uses the first repeated key line even when only a later key needs decoding', () => {
		const req = request(['Sec-WebSocket-Key', 'short', 'Sec-WebSocket-Key', 'a'.repeat(11) + '\xc3\xa9' + 'a'.repeat(11)]);
		decodeRequestHeaders(req);
		expect(webSocketKeyByteLength(req.rawHeaders)).toBe(5);
	});
	it('leaves ASCII arrays and cached header objects unchanged', () => {
		const req = request(['Host', 'localhost']);
		const cached = req.headers;
		decodeRequestHeaders(req);
		expect(req.headers).toBe(cached);
		expect(Object.getOwnPropertySymbols(req.rawHeaders)).toEqual([]);
	});
});
