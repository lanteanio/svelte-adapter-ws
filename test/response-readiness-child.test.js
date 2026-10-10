import { execFile } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

const run = promisify(execFile);
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
let payload, runner;
beforeAll(() => {
	payload = buildRuntime({
		replace: { ENV_PREFIX: JSON.stringify('READINESS_CHILD_') },
		serverSource: `export class Server {
			async init() {}
			async respond(request) {
				const route = new URL(request.url).pathname;
				if (route === '/micro') await Promise.resolve();
				if (route === '/chain') {
					let index = 0;
					return new Response(new ReadableStream({
						async pull(controller) {
							for (let i = 0; i < 8; i++) await Promise.resolve();
							if (index++ < 4) controller.enqueue(new TextEncoder().encode('x'.repeat(4250)));
							else controller.close();
						}
					}), { headers: { 'content-type': 'text/plain' } });
				}
				return new Response('x'.repeat(17000));
			}
		}`
	});
	symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(payload.dir, 'node_modules'), 'junction');
	runner = path.join(payload.dir, 'readiness-runner.mjs');
	// The server runs outside the test VM: its parser checkpoint must drain the
	// same native promise queue that owns Response readers and continuations.
	writeFileSync(runner, `
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import * as handler from './handler.js';
const secure = process.argv[2] === 'tls';
await handler.start('127.0.0.1', 0);
const port = handler.server.address().port;
function request(wire) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		let raw = '';
		const deadline = setTimeout(() => { socket.destroy(); reject(new Error('No terminal response')); }, 5000);
		socket.on('data', chunk => { raw += chunk.toString('latin1'); });
		socket.on('error', error => { clearTimeout(deadline); reject(error); });
		socket.on('close', () => { clearTimeout(deadline); resolve(raw); });
		socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(wire));
	});
}
const tails = [
	'GET /healthz HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n',
	'GET /healthz HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n',
	'GET /healthz HTTP/1.1\\r\\nHost: x\\r\\nBad Header\\r\\n\\r\\n',
	'POST /body HTTP/1.1\\r\\nHost: x\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nz\\r\\n'
];
let checks = 0;
try {
	for (const [route, cookie] of [['/large', ''], ['/large', 'Cookie: session=test\\r\\n'], ['/micro', ''], ['/chain', '']]) {
		for (const tail of tails) {
			const raw = await request('GET ' + route + ' HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n' + cookie + '\\r\\n' + tail);
			const split = raw.indexOf('\\r\\n\\r\\n');
			const headers = raw.slice(0, split);
			assert.match(headers, /^HTTP\\/1\\.1 200(?: |\\r)/, route + ' status');
			assert.match(headers, /\\r\\ncontent-length: 17000(?:\\r\\n|$)/i, route + ' finite framing');
			assert.doesNotMatch(headers, /transfer-encoding:/i, route + ' must remain finite');
			assert.equal(raw.slice(split + 4), 'x'.repeat(17000), route + ' complete body before later request');
			checks++;
		}
	}
	const healthy = await request('GET /healthz HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
	assert.match(healthy, /^HTTP\\/1\\.1 200/);
	assert.equal(healthy.slice(healthy.indexOf('\\r\\n\\r\\n') + 4), 'OK');
	console.log('READINESS_RESULT ' + JSON.stringify({ checks, healthy: true }));
} finally { await handler.shutdown({ timeoutMs: 1000 }); }
`, 'utf8');
});
afterAll(() => payload?.cleanup());

it.each(['tcp', 'tls'])('keeps microtask-ready SSR responses in the parser checkpoint over %s', async transport => {
	const env = { ...process.env };
	if (transport === 'tls') Object.assign(env, {
		READINESS_CHILD_SSL_CERT: path.join(certs, 'localhost.crt'),
		READINESS_CHILD_SSL_KEY: path.join(certs, 'localhost.key'), READINESS_CHILD_SSL_WATCH: '0'
	});
	delete env.VITEST;
	const { stdout, stderr } = await run(process.execPath, [runner, transport], { env, timeout: 20000, maxBuffer: 1024 * 1024 });
	expect(stderr).not.toMatch(/Assertion failed|current_write_/);
	const line = stdout.split(/\r?\n/).find(value => value.startsWith('READINESS_RESULT '));
	expect(line, stdout + stderr).toBeDefined();
	expect(JSON.parse(line.slice('READINESS_RESULT '.length))).toEqual({ checks: 16, healthy: true });
}, 25000);
