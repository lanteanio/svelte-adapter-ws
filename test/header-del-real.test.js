import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import { createTestServer } from '../src/testing.js';

const prefix = 'HEADER_DEL_TEST_';
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const inspect = request => Response.json({ value: request.headers.get('x-probe'), cookie: request.headers.get('cookie') });
function request(target, headers) {
	return Buffer.from('GET ' + target + ' HTTP/1.1\r\nHost: localhost\r\n' + headers.join('\r\n') + '\r\n\r\n', 'latin1');
}
function exchange(port, secure, requests) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		let pending = Buffer.alloc(0), done = false, splitTimer;
		const answers = [];
		const finish = error => {
			if (done) return;
			done = true; clearTimeout(deadline); clearTimeout(splitTimer); socket.destroy();
			if (error) reject(error); else resolve(answers);
		};
		const deadline = setTimeout(() => finish(new Error('Incomplete DEL header exchange')), 5000);
		const send = () => {
			const parts = requests[answers.length]; socket.write(parts[0]);
			if (parts[1]?.length) splitTimer = setTimeout(() => socket.write(parts[1]), 10);
		};
		socket.once(secure ? 'secureConnect' : 'connect', send);
		socket.once('error', finish);
		socket.once('close', () => { if (!done) finish(new Error('DEL connection closed before all responses')); });
		socket.on('data', bytes => {
			pending = Buffer.concat([pending, bytes]);
			const end = pending.indexOf('\r\n\r\n'); if (end < 0) return;
			const head = pending.subarray(0, end).toString('latin1');
			const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);
			if (!Number.isSafeInteger(length)) return finish(new Error('Missing response length: ' + head));
			if (pending.length < end + 4 + length) return;
			answers.push({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), body: pending.subarray(end + 4, end + 4 + length).toString('utf8') });
			pending = pending.subarray(end + 4 + length);
			if (pending.length) return finish(new Error('Unexpected response bytes'));
			if (answers.length === requests.length) finish(); else send();
		});
	});
}

describe.each(['runtime', 'tls', 'mirror'])('DEL header values on %s', surface => {
	let payload, runtime;
	const secure = surface === 'tls';
	beforeAll(async () => {
		if (surface === 'mirror') { runtime = await createTestServer({ handler: { admin: inspect } }); return; }
		if (secure) Object.assign(process.env, {
			[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
			[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'), [prefix + 'SSL_WATCH']: '0'
		});
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', adminAuthAcknowledged: true, upgradeRateLimit: 0 }) },
			serverSource: 'export class Server { async init() {} async respond(request) { return Response.json({value:request.headers.get("x-probe"),cookie:request.headers.get("cookie")}); } }',
			wsHandlerSource: 'export function admin(request) { return Response.json({value:request.headers.get("x-probe"),cookie:request.headers.get("cookie")}); }'
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	for (const target of surface === 'mirror' ? ['/__realtime/inspect'] : ['/inspect', '/__realtime/inspect']) {
		it.each([false, true])('preserves values and reuse at ' + target + ' with split=%s', async split => {
			const values = ['plain', '\x7falpha', 'a\x7fb', 'alpha\x7f', '~\x7f~', '\xffa\xc3\xa9\x7fb\xff', 'again'];
			const expected = ['plain', '\x7falpha', 'a\x7fb', 'alpha\x7f', '~\x7f~', 'a\u00e9\x7fb', 'again'];
			const requests = values.map(value => {
				const wire = request(target, ['X-Probe: ' + value]);
				const cut = split ? wire.indexOf('X-Probe:') + 11 : wire.length;
				return [wire.subarray(0, cut), wire.subarray(cut)];
			});
			const answers = await exchange(runtime.port, secure, requests);
			expect(answers.map(answer => answer.status)).toEqual(values.map(() => 200));
			expect(answers.map(answer => JSON.parse(answer.body).value)).toEqual(expected);
		});
	}
	it('restores repeated values and cookie joining independently', async () => {
		const answers = await exchange(runtime.port, secure, [[request('/__realtime/inspect', [
			'X-Probe: \t~\x7f~ \t', 'X-Probe: second\x7f', 'Cookie: a=\x7f', 'Cookie: b=~'
		])]]);
		expect(answers[0].status).toBe(200);
		expect(JSON.parse(answers[0].body)).toEqual({ value: '~\x7f~, second\x7f', cookie: 'a=\x7f; b=~' });
	});
	it('keeps the original head byte limit for many DEL bytes', async () => {
		const value = '\x7f'.repeat(3000);
		const answers = await exchange(runtime.port, secure, [[request('/__realtime/inspect', ['X-Probe: ' + value])]]);
		expect(answers[0].status).toBe(200);
		expect(JSON.parse(answers[0].body).value).toBe(value);
	});
	it.each(['X-Probe: a\x7f\x00b', 'X-Probe: a\x7f\x01b', 'X-Probe: a\x7f\x1fb', 'X-\x7fProbe: value', 'Content-Length: 0\x7f', 'X-Probe: a\x7f\r\n continuation'])('still refuses invalid header %j', async header => {
		const result = await rawConversation(runtime.port, [[0, request('/__realtime/inspect', [header])]], { secure, wait: 1000 });
		expect(result.raw).toMatch(/^HTTP\/1\.1 400(?: |\r\n)/);
		expect(result.closed).toBe(true);
	});
});