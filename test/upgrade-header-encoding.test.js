import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { upgradeResponse } from '../src/upgrade-response.js';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

let payload;
let server;
beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0 }) },
		// Return the tagged object directly to exercise the runtime's own
		// validation even when the helper constructor has been bypassed.
		wsHandlerSource: `export function upgrade({ url }) {
			url = new URL(url, 'http://localhost');
			const value = String.fromCharCode(...url.searchParams.get('units').split(',').map(Number));
			return { __upgradeResponse: true, userData: {}, headers: { 'x-probe': url.searchParams.has('array') ? ['safe', value] : value } };
		}`
	});
	server = await bootRuntime(payload);
});
afterAll(async () => { await server?.close(); payload?.cleanup(); });

function handshake(units, array = false) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(server.port, '127.0.0.1');
		let bytes = Buffer.alloc(0);
		socket.setTimeout(3000, () => socket.destroy(new Error('handshake timed out')));
		socket.on('error', reject);
		socket.on('connect', () => socket.write([
			'GET /ws?units=' + units.join(',') + (array ? '&array' : '') + ' HTTP/1.1',
			'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''
		].join('\r\n')));
		socket.on('data', (chunk) => {
			bytes = Buffer.concat([bytes, chunk]);
			const end = bytes.indexOf('\r\n\r\n');
			if (end !== -1) { socket.destroy(); resolve(bytes.subarray(0, end)); }
		});
		socket.on('close', () => { if (!bytes.includes('\r\n\r\n')) reject(new Error('incomplete handshake')); });
	});
}

const unsupported = [
	['a lone high surrogate', [0xd800]],
	['a lone low surrogate', [0xdc00]],
	['a surrogate pair', [0xd83d, 0xde00]],
	['a code point just above Latin-1', [0x100]]
];

describe('custom handshake header byte boundary', () => {
	it.each(unsupported)('rejects %s at construction', (_name, units) => {
		expect(() => upgradeResponse({}, { 'x-probe': String.fromCharCode(...units) })).toThrow(TypeError);
	});

	it.each(unsupported)('refuses %s before writing a 101', async (_name, units) => {
		for (const array of [false, true]) {
			const head = (await handshake(units, array)).toString('latin1');
			expect(head.split('\r\n')[0]).toBe('HTTP/1.1 500 Internal Server Error');
			expect(head.toLowerCase()).not.toContain('x-probe:');
			expect(head).not.toContain('101 Switching Protocols');
		}
	});

	it.each([
		[[0x41, 0x09, 0x42], '410942'],
		[[0x80], 'c280'],
		[[0xe4, 0xff], 'c3a4c3bf']
	])('writes accepted header bytes for %j', async (units, hex) => {
		const head = await handshake(units);
		expect(head.toString('latin1').split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
		const start = head.indexOf('x-probe: ');
		expect(start).toBeGreaterThan(-1);
		const valueStart = start + 'x-probe: '.length;
		const end = head.indexOf('\r\n', valueStart);
		expect(head.subarray(valueStart, end === -1 ? head.length : end).toString('hex')).toBe(hex);
	});
});
