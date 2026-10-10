import { execFile } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

const run = promisify(execFile);
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const badHead = 'HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\ncontent-length: 11\r\nconnection: close\r\n\r\n';
const cases = ['TRACK', 'track', 'connect'].flatMap(method => [false, true].flatMap(pending => [false, true].map(split => ({ method, pending, split, host: 'Host: x\r\nHost: y\r\n', expected: 400 }))));
cases.push(
	{ method: 'GET', host: '', expected: 400 },
	{ method: 'HEAD', host: '', expected: 400 },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 405 },
	{ method: 'GET', host: 'Host: x\r\n', expected: 200 }
);
const childSource = String.raw`
import Module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const originalLoad = Module._load;
let intercepted = 0;
Module._load = function(specifier) {
	const binding = originalLoad.apply(this, arguments);
	if (specifier !== '_http_common') return binding;
	intercepted++;
	function ParserView() { return new binding.HTTPParser(); }
	Object.setPrototypeOf(ParserView, binding.HTTPParser);
	ParserView.prototype.execute = undefined;
	return { ...binding, HTTPParser: ParserView };
};
let handler;
try {
	handler = await import('./handler.js');
	await handler.start('127.0.0.1', 0);
	const secure = process.argv[2] === 'tls';
	const results = [];
	let ordinal = 0;
	for (const testCase of JSON.parse(process.argv[3])) {
		const started = globalThis.__hostFallbackPending || 0;
		const result = await new Promise((resolve, reject) => {
			const socket = secure ? tls.connect({ host: '127.0.0.1', port: handler.server.address().port, rejectUnauthorized: false }) : net.connect(handler.server.address().port, '127.0.0.1');
			let raw = '', closed = false, settled = false;
			const timers = [];
			const finish = error => {
				if (settled) return;
				settled = true;
				for (const timer of timers) clearTimeout(timer);
				socket.destroy();
				if (error) reject(error); else resolve({ raw, closed });
			};
			timers.push(setTimeout(() => finish(new Error('Host fallback response did not finish')), 3000));
			socket.on('data', bytes => raw += bytes.toString('latin1'));
			socket.on('end', () => { closed = true; finish(); });
			socket.on('error', error => { if (error.code === 'ECONNRESET') { closed = true; finish(); } else finish(error); });
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				const first = testCase.pending ? 'GET /pending-' + ordinal++ + ' HTTP/1.1\r\nHost: x\r\n\r\n' : '';
				const request = testCase.method + ' /healthz HTTP/1.1\r\n' + testCase.host + (testCase.expected === 200 ? 'Connection: close\r\n' : '') + '\r\n';
				socket.write(first + (testCase.split ? request.slice(0, 10) : request));
				if (testCase.split) timers.push(setTimeout(() => { if (!socket.destroyed) socket.write(request.slice(10)); }, 40));
			});
		});
		results.push({ ...result, pendingStarted: (globalThis.__hostFallbackPending || 0) - started });
	}
	console.log('HOST_FALLBACK_RESULT ' + JSON.stringify({ intercepted, results }));
} finally {
	Module._load = originalLoad;
	if (handler) await handler.shutdown({ timeoutMs: 1000 });
}
`;

describe.each(['tcp', 'tls'])('Host validation with optional native execute absent over %s', transport => {
	let payload, results;
	beforeAll(async () => {
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify('HOST_FALLBACK_') },
			serverSource: `export class Server { async init() {} respond(request) {
				if (new URL(request.url).pathname.startsWith('/pending-')) { globalThis.__hostFallbackPending = (globalThis.__hostFallbackPending || 0) + 1; return new Promise(() => {}); }
				return new Response('ok');
			} }`
		});
		const modules = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('ws/package.json'))));
		symlinkSync(modules, path.join(payload.dir, 'node_modules'), 'junction');
		const runner = path.join(payload.dir, 'host-fallback.mjs');
		writeFileSync(runner, childSource, 'utf8');
		const env = { ...process.env };
		delete env.VITEST;
		if (transport === 'tls') Object.assign(env, {
			HOST_FALLBACK_SSL_CERT: path.join(certs, 'localhost.crt'),
			HOST_FALLBACK_SSL_KEY: path.join(certs, 'localhost.key'),
			HOST_FALLBACK_SSL_WATCH: '0'
		});
		const { stdout } = await run(process.execPath, [runner, transport, JSON.stringify(cases)], { env, timeout: 20000, maxBuffer: 1024 * 1024 });
		const line = stdout.split(/\r?\n/).find(value => value.startsWith('HOST_FALLBACK_RESULT '));
		expect(line, stdout).toBeDefined();
		const report = JSON.parse(line.slice('HOST_FALLBACK_RESULT '.length));
		expect(report.intercepted).toBeGreaterThan(0);
		expect(report.results).toHaveLength(cases.length);
		results = report.results;
	}, 60000);
	afterAll(() => payload?.cleanup());
	it.each(cases.map((testCase, index) => [index, testCase]))('preserves refusal %i: %j', (index, testCase) => {
		const result = results[index];
		expect(result.closed).toBe(true);
		expect(result.pendingStarted).toBe(testCase.pending ? 1 : 0);
		if (testCase.expected === 400) expect(result.raw).toBe(badHead + (testCase.method === 'HEAD' ? '' : 'Bad Request'));
		else if (testCase.expected === 405) {
			expect(result.raw).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\n/);
			expect(result.raw).toContain('\r\ncontent-length: 18\r\n');
			expect(result.raw).toMatch(/\r\n\r\nMethod Not Allowed$/);
		} else {
			expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
			expect(result.raw).toMatch(/\r\ncontent-length: 2\r\n/i);
			expect(result.raw).toMatch(/\r\n\r\nOK$/);
		}
	});
});
