import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
let payload, runtime;
beforeAll(async () => { payload = buildRuntime(); runtime = await bootRuntime(payload); });
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });
function exchange(writes, wait = 180) {
	return new Promise(resolve => {
		let raw = '', closed = false;
		const socket = net.connect(runtime.port, '127.0.0.1');
		const timers = [];
		const finish = () => { for (const timer of timers) clearTimeout(timer); socket.destroy(); resolve({ raw, closed }); };
		timers.push(setTimeout(finish, wait));
		socket.on('data', chunk => raw += chunk.toString('latin1'));
		socket.on('error', () => {});
		socket.on('end', () => { closed = true; finish(); });
		socket.on('connect', () => { for (const [delay, text] of writes) timers.push(setTimeout(() => socket.write(text, 'latin1'), delay)); });
	});
}
const healthy = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';
describe('request lines across socket reads', () => {
	it.each([
		[[0, 'GET / HTTP/1.0']],
		[[0, 'GET / HTTP/1.'], [20, '0']],
		[[0, 'GE'], [20, '\tT / HTTP/1.1\r\nHost: x\r\n\r\n']],
		[[0, 'GET  / HTTP/1.1\r\nHost: x\r\n\r\n']],
		[[0, 'GET /  HTTP/1.1\r\nHost: x\r\n\r\n']],
		[[0, '\n' + healthy]],
		[[0, healthy], [30, 'GET / HTTP/1.0\r\nBad Header: x\r\n\r\n']]
	])('refuses a non-native request line %j', async (...args) => {
		const result = await exchange(args);
		expect(result.raw).toContain('505 HTTP Version Not Supported');
		expect(result.closed).toBe(true);
	});
	it.each(['TRACK', 'CONNECT', 'track', 'connect'])('keeps %s refusals in HTTP framing', async method => {
		const result = await exchange([[0, method.slice(0, 2)], [20, method.slice(2) + ' / HTTP/1.1\r\nHost: x\r\n\r\n'], [50, healthy]]);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 405', 'HTTP/1.1 200']);
		expect(result.closed).toBe(false);
	});
	it.each(['xyz\r\n\r\n', '\r\n' + healthy, 'G\rT / HTTP/1.1\r\nHost: x\r\n\r\n'])('holds unreadable bytes %j', async text => {
		const result = await exchange([[0, text]]);
		expect(result.raw).toBe('');
		expect(result.closed).toBe(false);
	});
});

describe('request framing bounds', () => {
	it('refuses oversized ordinary ASCII heads on the fast path', async () => {
		const result = await exchange([[0, 'GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'x'.repeat(4200) + '\r\n\r\n']]);
		expect(result.raw).toContain('431 Request Header Fields Too Large');
		expect(result.closed).toBe(true);
	});
	it('streams split chunk extensions and trailers before the following request', async () => {
		const result = await exchange([[0, 'POST /api/echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5;'], [20, 'x=y\r'], [40, '\nhello\r\n0\r\nX-T: value\r'], [60, '\n\r'], [80, '\n'], [100, healthy]], 300);
		expect(result.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200']);
		expect(result.raw).toContain('"body":"hello"');
	});
	it('lets node reject an unterminated chunk extension without accumulating it', async () => {
		const result = await exchange([[0, 'POST /api/echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5;'], [20, 'x'.repeat(20000)]]);
		expect(result.closed).toBe(true);
		expect(result.raw).toContain('413 Content Too Large');
	});
});
