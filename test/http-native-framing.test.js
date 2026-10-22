// Two framing shapes node's parser refuses and the family's native tier
// reads, over raw sockets on the BUILT runtime (TCP and TLS) and on
// createTestServer: Content-Length lines that all carry the same value, and
// chunk data followed by two bytes that are not CRLF. The native tier frames
// the body by the one value and skips the two bytes after chunk data
// whatever they are. A repeated Content-Length then reaches the request
// edge, which refuses the repeated framing header with its own 400 and ends
// the connection; a built asset is served, as the static lane reads one
// header lookup. The neighbouring shapes the native tier also reads -
// differing values, an empty chunk size line after the skipped bytes, bytes
// after the last chunk - keep the parser's 400, and so does DEL in a method
// or target keep the request edge's 400 with the connection open.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import { createTestServer } from '../src/testing.js';

const PARSER_400 = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>';
const FOLLOW = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';
const post = (target, headers, body) => `POST ${target} HTTP/1.1\r\nHost: x\r\n${headers.map(h => h + '\r\n').join('')}\r\n${body}`;
const chunked = (target, body) => post(target, ['Transfer-Encoding: chunked'], body);

/**
 * Split a raw conversation into its answers. Every answer here declares its
 * length, so a body ends where its Content-Length says.
 * @param {string} raw
 */
function answers(raw) {
	const out = [];
	let at = 0;
	while (at < raw.length) {
		const end = raw.indexOf('\r\n\r\n', at);
		if (end < 0) throw new Error('unterminated head: ' + JSON.stringify(raw.slice(at)));
		const lines = raw.slice(at, end).split('\r\n');
		const length = lines.find(line => /^content-length:/i.test(line));
		if (!length) throw new Error('no length: ' + JSON.stringify(lines));
		const size = Number(length.slice(length.indexOf(':') + 1).trim());
		out.push({ statusLine: lines[0], lines: lines.slice(1).map(line => line.toLowerCase()), body: raw.slice(end + 4, end + 4 + size) });
		at = end + 4 + size;
	}
	return out;
}

const REPEATED = [
	['two identical lines', ['Content-Length: 5', 'Content-Length: 5'], 'hello'],
	['names in another case', ['Content-Length: 5', 'content-LENGTH: 5'], 'hello'],
	['whitespace around a value', ['Content-Length: 5', 'Content-Length: \t5  '], 'hello'],
	['a header between them', ['Content-Length: 5', 'X-Probe: a', 'Content-Length: 5'], 'hello'],
	['three lines', ['Content-Length: 5', 'Content-Length: 5', 'Content-Length: 5'], 'hello'],
	['zero twice', ['Content-Length: 0', 'Content-Length: 0'], '']
];

const STILL_REFUSED = [
	['differing values', post('/api/echo', ['Content-Length: 5', 'Content-Length: 6'], 'hello!')],
	['the same number spelled differently', post('/api/echo', ['Content-Length: 5', 'Content-Length: 05'], 'hello')],
	['one line listing the value twice', post('/api/echo', ['Content-Length: 5, 5'], 'hello')],
	['identical lines beside Transfer-Encoding', post('/api/echo', ['Content-Length: 5', 'Content-Length: 5', 'Transfer-Encoding: chunked'], '5\r\nhello\r\n0\r\n\r\n')],
	['a folded line between identical lines', post('/api/echo', ['Content-Length: 5', ' x', 'Content-Length: 5'], 'hello')],
	['the next size line straight after the data', chunked('/api/echo', '5\r\nhello5\r\nworld\r\n0\r\n\r\n')],
	['an empty size line after the two bytes', chunked('/api/echo', '5\r\nhello\n0\r\n\r\n')],
	['bytes after the last chunk', chunked('/api/echo', '5\r\nhello\r\n0\r\nXY')],
	['a space after the chunk size', chunked('/api/echo', '5 \r\nhello\r\n0\r\n\r\n')]
];

describe.each(['tcp', 'tls'])('native framing shapes on the built runtime over %s', transport => {
	let payload, runtime;
	const secure = transport === 'tls';
	const prefix = 'NATIVE_FRAMING_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			Object.assign(process.env, {
				[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
				[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
				[prefix + 'SSL_WATCH']: '0'
			});
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) }, files: { 'client/test.txt': 'static control' } });
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	const converse = (writes, wait = 600) => rawConversation(runtime.port, writes, { secure, wait });

	it.each(REPEATED)('answers a repeated Content-Length (%s) with the request edge 400 and ends the connection', async (_, headers, body) => {
		const result = await converse([[0, post('/api/echo', headers, body)], [150, FOLLOW]]);
		const [answer, ...rest] = answers(result.raw);
		expect(answer.statusLine).toBe('HTTP/1.1 400 Bad Request');
		expect(answer.lines).toContain('content-type: text/plain');
		expect(answer.lines).toContain('connection: close');
		expect(answer.body).toBe('Bad Request');
		expect(rest).toEqual([]);
		expect(result.closed).toBe(true);
	});

	it('serves a built asset whose request repeats an identical Content-Length, and reads past its body', async () => {
		const result = await converse([[0, 'GET /test.txt HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nAA' + FOLLOW]]);
		const served = answers(result.raw);
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		expect(served.map(a => a.body)).toEqual(['static control', 'OK']);
		expect(result.closed).toBe(false);
	});

	it.each([
		['two other bytes', 'XX'],
		['a byte and LF', 'X\n'],
		['CR and a byte', '\rX'],
		['the bytes of a request line', 'GE']
	])('serves chunk data followed by %s and the request behind it', async (_, end) => {
		const result = await converse([[0, chunked('/api/echo', '5\r\nhello' + end + '0\r\n\r\n') + FOLLOW]]);
		const served = answers(result.raw);
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		expect(JSON.parse(served[0].body).body).toBe('hello');
		expect(served[1].body).toBe('OK');
		expect(result.closed).toBe(false);
	});

	it('reads every chunk of a body whose chunks all end in other bytes', async () => {
		const result = await converse([[0, chunked('/api/echo', '3\r\nabcYY2\r\nde\nZ0\r\n\r\n') + FOLLOW]]);
		const served = answers(result.raw);
		expect(JSON.parse(served[0].body).body).toBe('abcde');
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
	});

	it.each([
		['after the data', [[0, chunked('/api/echo', '5\r\nhello')], [80, 'XX'], [160, '0\r\n\r\n' + FOLLOW]]],
		['between the two bytes', [[0, chunked('/api/echo', '5\r\nhelloX')], [80, 'X0\r\n\r\n'], [160, FOLLOW]]],
		['inside the data', [[0, chunked('/api/echo', '5\r\nhel')], [80, 'loXX0\r\n'], [160, '\r\n' + FOLLOW]]]
	])('skips the two bytes after chunk data with a read boundary %s', async (_, writes) => {
		const result = await converse(writes);
		const served = answers(result.raw);
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		expect(JSON.parse(served[0].body).body).toBe('hello');
		expect(result.closed).toBe(false);
	});

	it.each(STILL_REFUSED)('keeps the parser 400 for %s', async (_, request) => {
		expect(await converse([[0, request + FOLLOW]])).toEqual({ raw: PARSER_400, closed: true });
	});

	it.each([
		['method', 'G\x7fT /api/echo HTTP/1.1\r\nHost: x\r\n\r\n'],
		['target', 'GET /api/ec\x7fho HTTP/1.1\r\nHost: x\r\n\r\n']
	])('answers DEL in the %s with the request edge 400 and keeps the connection', async (_, request) => {
		const result = await converse([[0, request + FOLLOW]]);
		const served = answers(result.raw);
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 400 Bad Request', 'HTTP/1.1 200 OK']);
		expect(served[0].body).toBe('Bad Request');
		expect(served[0].lines).not.toContain('connection: close');
		expect(served[1].body).toBe('OK');
		expect(result.closed).toBe(false);
	});
});

describe('native framing shapes on createTestServer', () => {
	let server;
	beforeAll(async () => { server = await createTestServer(); });
	afterAll(async () => { await server?.close(); });
	const converse = (writes) => rawConversation(server.port, writes, { wait: 600 });

	it('routes a request that repeats an identical Content-Length, and reads past its body', async () => {
		const result = await converse([[0, post('/healthz', ['Content-Length: 5', 'Content-Length: 5'], 'hello') + 'GET /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n']]);
		const served = answers(result.raw);
		expect(served.map(a => a.statusLine)).toEqual(['HTTP/1.1 404 File Not Found', 'HTTP/1.1 200 OK']);
		expect(served[1].body).toBe('OK');
		expect(result.closed).toBe(false);
	});

	it('reads chunk data followed by two other bytes', async () => {
		const result = await converse([[0, chunked('/healthz', '5\r\nhelloXX0\r\n\r\n') + FOLLOW]]);
		expect(answers(result.raw).map(a => a.statusLine)).toEqual(['HTTP/1.1 404 File Not Found', 'HTTP/1.1 200 OK']);
		expect(result.closed).toBe(false);
	});

	it.each(STILL_REFUSED)('keeps the parser 400 for %s', async (_, request) => {
		expect(await converse([[0, request.replace('/api/echo', '/healthz') + FOLLOW]])).toEqual({ raw: PARSER_400, closed: true });
	});
});
