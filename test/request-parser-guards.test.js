import { execFile } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const run = promisify(execFile);
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const oversized = 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n<h1>Request Header Fields Too Large</h1><hr><i>uWebSockets/20 Server</i>';

for (const secure of [false, true]) describe(`oversized request heads over ${secure ? 'TLS' : 'TCP'}`, () => {
	let payload, runtime;
	const prefix = 'PARSER_GUARD_SIZE_';
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});
	it.each([
		['complete head', [[0, 'GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'x'.repeat(4200) + '\r\n\r\n']]],
		['split head', [[0, 'GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'x'.repeat(2100)], [30, 'x'.repeat(2100) + '\r\n\r\n']]],
		['split request line', [[0, 'GET /' + 'x'.repeat(2100)], [30, 'x'.repeat(2100)]]],
		['invalid connection metadata', [[0, '\r\n\r\n' + 'x'.repeat(4200)]]]
	])('uses one complete refusal for an oversized %s', async (_name, writes) => {
		const { raw, closed } = await rawConversation(runtime.port, writes, { secure, wait: 2000 });
		expect(closed).toBe(true);
		expect(raw).toBe(oversized);
	});
});

describe('optional native parser binding', () => {
	let payload, runner;
	beforeAll(() => {
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('PARSER_BINDING_TEST_') } });
		symlinkSync(path.dirname(path.dirname(fileURLToPath(import.meta.resolve('ws/package.json')))), path.join(payload.dir, 'node_modules'), 'junction');
		runner = path.join(payload.dir, 'parser-binding-child.mjs');
		writeFileSync(runner, `
import Module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const mode = process.argv[2];
const secure = process.argv[3] === 'tls';
const originalLoad = Module._load;
let intercepted = 0;
Module._load = function(specifier, parent, isMain) {
	const binding = originalLoad.apply(this, arguments);
	if (specifier !== '_http_common' || mode === 'normal') return binding;
	intercepted++;
	if (mode === 'missing-constructor') return { ...binding, HTTPParser: undefined };
	function ParserView() { return new binding.HTTPParser(); }
	Object.setPrototypeOf(ParserView, binding.HTTPParser);
	ParserView.prototype.execute = mode === 'probe-number' ? () => 0 : undefined;
	return { ...binding, HTTPParser: ParserView };
};
let handler;
try {
	try { handler = await import('./handler.js'); }
	catch (error) {
		console.log('PARSER_BINDING_RESULT ' + JSON.stringify({ intercepted, importError: error.message }));
	}
	if (handler && mode === 'probe-number') {
		console.log('PARSER_BINDING_RESULT ' + JSON.stringify({ intercepted, imported: true }));
	} else if (handler) {
		await handler.start('127.0.0.1', 0);
		const raw = await new Promise((resolve, reject) => {
			const socket = secure ? tls.connect({ host: '127.0.0.1', port: handler.server.address().port, rejectUnauthorized: false }) : net.connect(handler.server.address().port, '127.0.0.1');
			let raw = '';
			const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Healthy request did not finish')); }, 5000);
			socket.once('error', error => { clearTimeout(deadline); reject(error); });
			socket.on('data', chunk => { raw += chunk.toString('latin1'); });
			socket.once('end', () => { clearTimeout(deadline); resolve(raw); });
			socket.once(secure ? 'secureConnect' : 'connect', () => socket.write('GET /healthz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));
		});
		console.log('PARSER_BINDING_RESULT ' + JSON.stringify({ intercepted, raw }));
	}
} finally {
	Module._load = originalLoad;
	if (handler) await handler.shutdown({ timeoutMs: 1000 });
}
`, 'utf8');
	}, 60000);
	afterAll(() => payload?.cleanup());
	async function child(mode, transport = 'tcp') {
		const env = { ...process.env };
		delete env.VITEST;
		if (transport === 'tls') Object.assign(env, {
			PARSER_BINDING_TEST_SSL_CERT: path.join(certs, 'localhost.crt'),
			PARSER_BINDING_TEST_SSL_KEY: path.join(certs, 'localhost.key'),
			PARSER_BINDING_TEST_SSL_WATCH: '0'
		});
		const { stdout } = await run(process.execPath, [runner, mode, transport], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
		const result = stdout.split(/\r?\n/).find(line => line.startsWith('PARSER_BINDING_RESULT '));
		expect(result, stdout).toBeDefined();
		return JSON.parse(result.slice('PARSER_BINDING_RESULT '.length));
	}
	it.each(['tcp', 'tls'])('serves a healthy request with the normal binding over %s', async transport => {
		const result = await child('normal', transport);
		expect(result.importError, JSON.stringify(result)).toBeUndefined();
		expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(result.raw).toMatch(/\r\ncontent-length: 2\r\n/i);
		expect(result.raw).toMatch(/\r\n\r\nOK$/);
	}, 20000);
	it.each(['missing-constructor', 'missing-execute'].flatMap(mode => ['tcp', 'tls'].map(transport => [mode, transport])))
	('serves healthy traffic with %s over %s', async (mode, transport) => {
		const result = await child(mode, transport);
		expect(result.intercepted, JSON.stringify(result)).toBeGreaterThan(0);
		expect(result.importError).toBeUndefined();
		expect(result.raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(result.raw).toMatch(/\r\ncontent-length: 2\r\n/i);
		expect(result.raw).toMatch(/\r\n\r\nOK$/);
	}, 20000);
	it('fails startup if the error probe returns a number', async () => {
		const result = await child('probe-number');
		expect(result.intercepted, JSON.stringify(result)).toBeGreaterThan(0);
		expect(result.importError).toBe('HTTP parser error probe did not return a native Error');
		expect(result.imported).toBeUndefined();
	}, 20000);
});
