import { execFile } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

const run = promisify(execFile);
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const testingModule = pathToFileURL(fileURLToPath(new URL('../src/testing.js', import.meta.url))).href;
const refusal = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>';
const versionRefusal = 'HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n<h1>HTTP Version Not Supported</h1><p>This server does not support HTTP/1.0.</p><hr><i>uWebSockets/20 Server</i>';
const oversized = 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n<h1>Request Header Fields Too Large</h1><hr><i>uWebSockets/20 Server</i>';
const pad = 'X-Pad: ' + 'p'.repeat(20000) + '\r\n';
const cases = ['TRACK', 'track', 'connect'].flatMap(method => [false, true].flatMap(pending => [false, true].map(split => ({ method, pending, split, host: 'Host: x\r\nHost: y\r\n', expected: 400 }))));
cases.push(
	{ method: 'GET', host: '', expected: 505, version: '1.0' },
	{ method: 'HEAD', host: '', expected: 505, version: '1.0' },
	{ method: 'GET', host: '', expected: 400 },
	{ method: 'HEAD', host: '', expected: 400 },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 405 },
	{ method: 'GET', host: 'Host: x\r\n', expected: 200 },
	// An answer already held from the same read is replaced by the refusal.
	{ method: 'GET', host: '', expected: 505, version: '1.0', answered: true },
	{ method: 'HEAD', host: '', expected: 505, version: '1.0', answered: true },
	{ method: 'GET', host: '', expected: 400, answered: true },
	{ method: 'HEAD', host: '', expected: 400, answered: true },
	{ method: 'TRACK', host: '', expected: 400, answered: true },
	{ method: 'CONNECT', host: '', expected: 400, answered: true },
	{ method: 'CONNECT', host: 'Host: x\r\n', expected: 505, version: '1.0', answered: true },
	{ raw: 'GET /a\x01b HTTP/1.1\r\nHost: x\r\n\r\n', expected: 505 },
	{ raw: 'GET /a\x01b HTTP/1.1\r\nHost: x\r\n\r\n', expected: 505, answered: true },
	// Behind an answer still waiting, the refusal is written as the head is read.
	{ method: 'GET', host: '', expected: 505, version: '1.0', pending: true },
	{ method: 'HEAD', host: '', expected: 505, version: '1.0', pending: true },
	// A forbidden method: Host and version are read before the 405.
	{ method: 'TRACK', host: '', expected: 400 },
	{ method: 'TRACK', host: '', expected: 400, split: true },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 505, version: '1.0' },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 505, version: '1.0', split: true },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 505, version: '1.0', answered: true },
	{ method: 'TRACK', host: 'Host: x\r\n', expected: 505, version: '1.0', pending: true },
	// A target node's parser refuses, and a head past its header limit.
	{ raw: 'GET /a\x80b HTTP/1.1\r\nHost: x\r\n\r\n', expected: 400 },
	{ raw: 'HEAD /a\x80b HTTP/1.1\r\nHost: x\r\n\r\n', expected: 400 },
	{ method: 'GET', host: 'Host: x\r\n' + pad, expected: 431 },
	{ method: 'TRACK', host: 'Host: x\r\n' + pad, expected: 431, split: true }
);
const childSource = String.raw`
import Module from 'node:module';
import { readFileSync } from 'node:fs';
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
let close;
let port;
try {
	if (process.argv[4] === 'harness') {
		const { createTestServer } = await import(process.argv[5]);
		const server = await createTestServer({ port: 0 });
		close = () => server.close();
		port = server.port;
	} else {
		const handler = await import('./handler.js');
		await handler.start('127.0.0.1', 0);
		close = () => handler.shutdown({ timeoutMs: 1000 });
		port = handler.server.address().port;
	}
	const secure = process.argv[2] === 'tls';
	const results = [];
	let ordinal = 0;
	for (const testCase of JSON.parse(readFileSync(process.argv[3], 'utf8'))) {
		const started = globalThis.__hostFallbackPending || 0;
		const result = await new Promise((resolve) => {
			const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
			let raw = '', closed = false, settled = false;
			const timers = [];
			const finish = error => {
				if (settled) return;
				settled = true;
				for (const timer of timers) clearTimeout(timer);
				socket.destroy();
				resolve(error ? { raw, closed, error: error.message } : { raw, closed });
			};
			timers.push(setTimeout(() => finish(new Error('Host fallback response did not finish')), 3000));
			socket.on('data', bytes => raw += bytes.toString('latin1'));
			socket.on('end', () => { closed = true; finish(); });
			socket.on('error', error => { if (error.code === 'ECONNRESET') { closed = true; finish(); } else finish(error); });
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				const first = testCase.pending ? 'GET /pending-' + ordinal++ + ' HTTP/1.1\r\nHost: x\r\n\r\n'
					: testCase.answered ? 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n' : '';
				const request = testCase.raw || testCase.method + ' /healthz HTTP/' + (testCase.version || '1.1') + '\r\n' + testCase.host + (testCase.expected === 200 ? 'Connection: close\r\n' : '') + '\r\n';
				socket.write(Buffer.from(first + (testCase.split ? request.slice(0, 10) : request), 'latin1'));
				if (testCase.split) timers.push(setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from(request.slice(10), 'latin1')); }, 40));
			});
		});
		results.push({ ...result, pendingStarted: (globalThis.__hostFallbackPending || 0) - started });
	}
	console.log('HOST_FALLBACK_RESULT ' + JSON.stringify({ intercepted, results }));
} finally {
	Module._load = originalLoad;
	if (close) await close();
}
`;

/**
 * @param {string} transport
 * @param {string} surface
 * @param {any[]} list
 */
function fallbackSuite(transport, surface, list) {
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
		const caseFile = path.join(payload.dir, 'host-fallback-cases.json');
		writeFileSync(caseFile, JSON.stringify(list), 'utf8');
		const env = { ...process.env };
		delete env.VITEST;
		if (transport === 'tls') Object.assign(env, {
			HOST_FALLBACK_SSL_CERT: path.join(certs, 'localhost.crt'),
			HOST_FALLBACK_SSL_KEY: path.join(certs, 'localhost.key'),
			HOST_FALLBACK_SSL_WATCH: '0'
		});
		const { stdout } = await run(process.execPath, [runner, transport, caseFile, surface, testingModule], { env, timeout: 30000, maxBuffer: 1024 * 1024 });
		const line = stdout.split(/\r?\n/).find(value => value.startsWith('HOST_FALLBACK_RESULT '));
		expect(line, stdout).toBeDefined();
		const report = JSON.parse(line.slice('HOST_FALLBACK_RESULT '.length));
		expect(report.intercepted).toBeGreaterThan(0);
		expect(report.results).toHaveLength(list.length);
		results = report.results;
	}, 60000);
	afterAll(() => payload?.cleanup());
	it.each(list.map((testCase, index) => [index, testCase]))('preserves refusal %i: %j', (index, testCase) => {
		const result = results[index];
		expect(result.error).toBeUndefined();
		expect(result.closed).toBe(true);
		if (surface === 'runtime') expect(result.pendingStarted).toBe(testCase.pending ? 1 : 0);
		if (testCase.expected === 400) expect(result.raw).toBe(refusal);
		else if (testCase.expected === 505) expect(result.raw).toBe(versionRefusal);
		else if (testCase.expected === 431) expect(result.raw).toBe(oversized);
		else if (testCase.expected === 405) {
			expect(result.raw).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\n/);
			expect(result.raw.split('\r\n')).toContain('content-length: 18');
			expect(result.raw).toMatch(/\r\n\r\nMethod Not Allowed$/);
		} else {
			expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
			expect(result.raw.split('\r\n').map(value => value.toLowerCase())).toContain('content-length: 2');
			expect(result.raw).toMatch(/\r\n\r\nOK$/);
		}
	});
}

describe.each(['tcp', 'tls'])('Host validation with optional native execute absent over %s', transport => {
	fallbackSuite(transport, 'runtime', cases);
});

// The harness has no route that keeps its answer waiting.
describe('createTestServer with optional native execute absent', () => {
	fallbackSuite('tcp', 'harness', cases.filter(testCase => !testCase.pending && testCase.expected !== 200));
});
