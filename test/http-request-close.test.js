import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const request = (method = 'GET', target = '/healthz', connection = '', extra = '') =>
	method + ' ' + target + ' HTTP/1.1\r\nHost: x\r\n' +
	(connection ? 'Connection: ' + connection + '\r\n' : '') + extra + '\r\n';
const health = request();
const closing = request('GET', '/healthz', 'close');

function conversation(port, secure, writes, count, closed) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		const answers = [];
		const timers = [];
		let pending = Buffer.alloc(0), settled = false, probing = false;
		const finish = error => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			socket.destroy();
			if (error) reject(error); else resolve(answers);
		};
		timers.push(setTimeout(() => finish(new Error('Request-close conversation did not complete: ' + answers.length + ' responses')), 5000));
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			for (const [delay, bytes] of writes) timers.push(setTimeout(() => socket.write(bytes, 'latin1'), delay));
		});
		socket.on('error', finish);
		socket.on('end', () => {
			if (!closed || answers.length !== count || pending.length !== 0) finish(new Error('Unexpected peer close after ' + answers.length + ' responses'));
			else finish();
		});
		socket.on('data', bytes => {
			pending = Buffer.concat([pending, bytes]);
			for (;;) {
				const end = pending.indexOf('\r\n\r\n');
				if (end < 0) break;
				const header = pending.toString('latin1', 0, end);
				const status = Number(/^HTTP\/1\.1 (\d+)/.exec(header)?.[1]);
				const length = Number(/\r\ncontent-length: (\d+)(?:\r\n|$)/i.exec(header)?.[1]);
				if (!Number.isSafeInteger(length)) return finish(new Error('Response has no complete length framing'));
				if (pending.length < end + 4 + length) break;
				answers.push({ status, body: pending.toString('utf8', end + 4, end + 4 + length) });
				pending = pending.subarray(end + 4 + length);
			}
			if (closed) return;
			if (answers.length === count && !probing) {
				probing = true;
				socket.write(health);
			} else if (probing && answers.length === count + 1) {
				if (pending.length || answers.at(-1).status !== 200 || answers.at(-1).body !== 'OK') return finish(new Error('Keep-alive probe failed'));
				answers.pop();
				finish();
			}
		});
	});
}

describe.each([false, true])('request close ownership over TLS=%s', secure => {
	let payload, runtime;
	const prefix = 'REQUEST_CLOSE_TEST_';
	beforeAll(async () => {
		if (secure) Object.assign(process.env, {
			[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
			[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
			[prefix + 'SSL_WATCH']: '0'
		});
		payload = buildRuntime({ files: { 'client/static.txt': 's'.repeat(17000) }, replace: { ENV_PREFIX: JSON.stringify(prefix) }, serverSource:
			"export class Server { async init() {} async respond(request) { const path = new URL(request.url).pathname;" +
			"if (path === '/body') return new Response(await request.text());" +
			"if (path === '/connection') return new Response(request.headers.get('connection') || 'absent');" +
			"if (path === '/async') { await new Promise(resolve => setTimeout(resolve, 50)); return new Response('late'); }" +
			"if (path === '/micro') { await Promise.resolve(); return new Response('micro'); }" +
			"if (path === '/large') return new Response('x'.repeat(17000));" +
			"if (path === '/server-close') return new Response('closed', { headers: { connection: 'close' } });" +
			"return new Response('OK'); } }"
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	const run = (writes, count, closed = false) => conversation(runtime.port, secure, writes, count, closed);
	it.each(['GET', 'CONNECT', 'connect', 'TRACK', 'trace'])('serves a complete same-read %s after a close request', async method => {
		const answers = await run([[0, closing + request(method)]], 2);
		expect(answers).toEqual([{ status: 200, body: 'OK' }, { status: method === 'GET' ? 200 : 405, body: method === 'GET' ? 'OK' : 'Method Not Allowed' }]);
	});
	it('uses the final complete head in a three-request read', async () => {
		expect(await run([[0, health + closing + health]], 3)).toEqual(Array(3).fill({ status: 200, body: 'OK' }));
	});
	it.each(['close', 'Close', 'abcde', 'a\xc3\xa9bc'])('closes a standalone five-byte Connection value %s', async value => {
		const answers = await run([[0, request('GET', '/connection', value)]], 1, true);
		expect(answers).toEqual([{ status: 200, body: Buffer.from(value, 'latin1').toString('utf8') }]);
	});
	it.each(['keep-alive, close', 'close, keep-alive', 'cl0se, CLOSE', 'abcdef'])('preserves a nonclosing Connection value %s', async value => {
		expect(await run([[0, request('GET', '/connection', value)]], 1)).toEqual([{ status: 200, body: value }]);
	});
	it('uses the first duplicate Connection field and restores both values', async () => {
		expect(await run([[0, request('GET', '/connection', 'keep-alive', 'Connection: Close\r\n')]], 1)).toEqual([{ status: 200, body: 'keep-alive, Close' }]);
	});
	it('closes after the final complete request requests closure', async () => {
		expect(await run([[0, closing + closing]], 2, true)).toEqual(Array(2).fill({ status: 200, body: 'OK' }));
	});
	it.each(['G', 'GET /healthz HTTP/1.1\r\nHost:', 'GET /x\ry HTTP/1.1\r\nHost: x\r\n\r\n'])('does not replace closure with an incomplete next head: %s', async tail => {
		expect(await run([[0, closing + tail]], 1, true)).toEqual([{ status: 200, body: 'OK' }]);
	});
	it.each([false, true])('keeps a fixed body and its next head in order with split=%s', async split => {
		const head = request('POST', '/body', 'close', 'Content-Length: 3\r\n');
		const writes = split ? [[0, head + 'a'], [30, 'bc' + health]] : [[0, head + 'abc' + health]];
		expect(await run(writes, 2)).toEqual([{ status: 200, body: 'abc' }, { status: 200, body: 'OK' }]);
	});
	it.each([false, true])('keeps a chunked body and its next head in order with split=%s', async split => {
		const first = request('POST', '/body', 'close', 'Transfer-Encoding: chunked\r\n') + '3\r\nabc\r\n';
		const last = '0\r\n\r\n' + health;
		expect(await run(split ? [[0, first], [30, last]] : [[0, first + last]], 2)).toEqual([{ status: 200, body: 'abc' }, { status: 200, body: 'OK' }]);
	});
	it('closes after a split body ends before an incomplete next head', async () => {
		const head = request('POST', '/body', 'close', 'Content-Length: 3\r\n');
		expect(await run([[0, head + 'a'], [30, 'bcGET /healthz HTTP/1.1\r\nHost:']], 1, true)).toEqual([{ status: 200, body: 'abc' }]);
	});
	it('closes after a standalone asynchronous response finishes', async () => {
		expect(await run([[0, request('GET', '/async', 'close')]], 1, true)).toEqual([{ status: 200, body: 'late' }]);
	});
	it('closes without serving a pipeline behind a pending asynchronous response', async () => {
		expect(await run([[0, request('GET', '/async', 'close') + health]], 0, true)).toEqual([]);
	});
	it.each([['/micro', 'micro'], ['/server-close', 'closed']])('preserves the next request after %s', async (target, body) => {
		expect(await run([[0, request('GET', target, 'close') + health]], 2)).toEqual([{ status: 200, body }, { status: 200, body: 'OK' }]);
	});
	it.each([
		['next request', health],
		['version refusal', 'GET /healthz HTTP/1.0\r\nHost: x\r\n\r\n'],
		['invalid field name', 'GET /healthz HTTP/1.1\r\nHost: x\r\nX-\x01: value\r\n\r\n'],
		['invalid field value', 'GET /healthz HTTP/1.1\r\nHost: x\r\nX-Probe: a\x01b\r\n\r\n'],
		['duplicate length', 'POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na'],
		['invalid chunk', 'POST /body HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n']
	])('closes after an uncorked answer before a %s', async (_, tail) => {
		for (const [target, body] of [['/large', 'x'.repeat(17000)], ['/static.txt', 's'.repeat(17000)]]) {
			expect(await run([[0, request('GET', target, 'close') + tail]], 1, true)).toEqual([{ status: 200, body }]);
		}
	});
	it.each(['X-\x01: value', 'X-Probe: a\x01b'])('leaves a following parser error to its terminal handler: %s', async header => {
		const tail = 'GET /healthz HTTP/1.1\r\nHost: x\r\n' + header + '\r\n\r\n';
		const result = await rawConversation(runtime.port, [[0, closing + tail]], { secure, wait: 500 });
		expect(result).toEqual({ raw: 'HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n', closed: true });
	});

});
