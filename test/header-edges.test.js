import { describe, expect, it } from 'vitest';
import { normalizeHeaderEdges } from '../src/runtime/handler/header-edges.js';

const head = headers => Buffer.from(`GET / HTTP/1.1\r\n${headers}\r\n\r\n`, 'latin1');

describe('native header edge normalization', () => {
	it('keeps ordinary ASCII requests without copying', () => {
		const bytes = head('Host: localhost\r\nContent-Length: 0\r\nAccept: \t application/json \t');
		expect(normalizeHeaderEdges(bytes)).toBe(bytes);
	});
	it('normalizes every high byte at both edges without moving offsets', () => {
		for (let byte = 128; byte <= 255; byte++) {
			const value = String.fromCharCode(byte);
			const bytes = head(`X-Probe: ${value}\t alpha \t${value}`);
			const original = Buffer.from(bytes);
			const normalized = normalizeHeaderEdges(bytes);
			expect(normalized).toEqual(head('X-Probe:  \t alpha \t '));
			expect(normalized.length).toBe(bytes.length);
			expect(bytes).toEqual(original);
		}
	});
	it.each(['Content-Length: \xe9 0 \xe9', 'Transfer-Encoding: \xe9 chunked \xe9', 'Sec-WebSocket-Key: \xe9 dGhlIHNhbXBsZSBub25jZQ== \xe9'])('normalizes parser-owned %s', header => {
		expect(normalizeHeaderEdges(head(header))).toEqual(head(header.replaceAll('\xe9', ' ')));
	});
	it('preserves interior high bytes, DEL, invalid controls and header names', () => {
		const bytes = head('X-\xe9: value\r\nX-Interior: a\xe9b\r\nX-Del: \x7f\r\nX-Control: \x01\xe9value\x01');
		expect(normalizeHeaderEdges(bytes)).toBe(bytes);
	});
	it('leaves request targets and following body bytes untouched', () => {
		const bytes = Buffer.from('GET /\xe9 HTTP/1.1\r\nX-Probe: \xe9value\xe9\r\n\r\nbody: \xe9\r\n', 'latin1');
		expect(normalizeHeaderEdges(bytes)).toEqual(Buffer.from('GET /\xe9 HTTP/1.1\r\nX-Probe:  value \r\n\r\nbody: \xe9\r\n', 'latin1'));
	});
	it('normalizes an entirely high-byte value to an empty field', () => {
		expect(normalizeHeaderEdges(head('X-Probe: '+ '\xe9'.repeat(24)))).toEqual(head('X-Probe: '+ ' '.repeat(24)));
	});
});
