import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const prefix = 'HEADER_CLASSIFICATION_TEST_';

function request(value, { upgrade = false, split = false } = {}) {
	const body = 'body:\xc3\xa9\r\nX-Probe: body-only';
	const lines = [
		`${upgrade ? 'GET /ws' : 'POST /inspect'} HTTP/1.1`, 'Host: localhost',
		'Cookie: session=test', 'X-Probe: ' + value,
		...(upgrade ? ['Connection: Upgrade', 'Upgrade: websocket',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13']
			: ['Content-Length: ' + Buffer.byteLength(body, 'latin1')]),
		'', upgrade ? '' : body
	];
	const wire = Buffer.from(lines.join('\r\n'), 'latin1');
	const cut = split ? wire.indexOf('X-Probe:') + 11 : wire.length;
	return [wire.subarray(0, cut), wire.subarray(cut)];
}

function exchange(port, secure, requests) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		const answers = [];
		let pending = Buffer.alloc(0), done = false, splitTimer;
		const finish = error => {
			if (done) return;
			done = true;
			clearTimeout(deadline); clearTimeout(splitTimer); socket.destroy();
			if (error) reject(error); else resolve(answers);
		};
		const deadline = setTimeout(() => finish(new Error('Incomplete header transition exchange')), 5000);
		const send = () => {
			const parts = requests[answers.length];
			socket.write(parts[0]);
			if (parts[1].length) splitTimer = setTimeout(() => socket.write(parts[1]), 15);
		};
		socket.once(secure ? 'secureConnect' : 'connect', send);
		socket.once('error', finish);
		socket.once('close', () => { if (answers.length < requests.length) finish(new Error('Header transition connection closed early')); });
		socket.on('data', bytes => {
			pending = Buffer.concat([pending, bytes]);
			const end = pending.indexOf('\r\n\r\n');
			if (end < 0) return;
			const head = pending.subarray(0, end).toString('latin1');
			const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
			const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);
			if (!Number.isSafeInteger(length)) return finish(new Error('Missing complete response framing'));
			if (pending.length < end + 4 + length) return;
			try { answers.push({ status, data: status === 401 ? pending.subarray(end + 4, end + 4 + length).toString('utf8') : JSON.parse(pending.subarray(end + 4, end + 4 + length).toString('utf8')) }); }
			catch (error) { return finish(error); }
			pending = pending.subarray(end + 4 + length);
			if (pending.length) return finish(new Error('Unexpected extra response bytes'));
			if (answers.length === requests.length) finish(); else send();
		});
	});
}

describe.each([false, true])('complete header classification over TLS=%s', secure => {
	let payload, runtime;
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*' }) },
			serverSource: `export class Server {
				async init() {}
				async respond(request) { return Response.json({ value: request.headers.get('x-probe'), body: await request.text() }); }
			}`,
			wsHandlerSource: `const values = []; export function init() { globalThis[Symbol.for('header-classification-upgrades')] = values; } export function upgrade({ headers }) { values.push(headers['x-probe']); return false; }`
		});
		try { runtime = await bootRuntime(payload); }
		catch (error) { throw new Error('Runtime setup failed: ' + (error?.stack || String(error))); }
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		delete globalThis[Symbol.for('header-classification-upgrades')];
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	it.each([false, true])('reclassifies POST heads independently with split=%s', async split => {
		const values = ['ascii', 'a\xc3\xa9b', 'ascii-again', 'c\xc3\xbfd'];
		const answers = await exchange(runtime.port, secure, values.map(value => request(value, { split })));
		expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200]);
		expect(answers.map(answer => answer.data.value)).toEqual(['ascii', 'a\u00e9b', 'ascii-again', 'c\u00ffd']);
		expect(answers.every(answer => answer.data.body === 'body:\u00e9\r\nX-Probe: body-only')).toBe(true);
	});
	it('reclassifies refused upgrade heads when the HTTP parser is reattached', async () => {
		const answers = await exchange(runtime.port, secure,
			['ascii', 'a\xc3\xa9b', 'again'].map(value => request(value, { upgrade: true })));
		expect(answers.map(answer => answer.status)).toEqual([401, 401, 401]);
		expect(answers.map(answer => answer.data)).toEqual(['Unauthorized', 'Unauthorized', 'Unauthorized']);
		expect(globalThis[Symbol.for('header-classification-upgrades')]).toEqual(['ascii', 'a\u00e9b', 'again']);
	});
});
