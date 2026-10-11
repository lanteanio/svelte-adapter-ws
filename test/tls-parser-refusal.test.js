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
	payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('REFUSAL_TEST_') } });
	// Plain child processes resolve the emitted payload's ordinary dependencies.
	symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(payload.dir, 'node_modules'), 'junction');
	runner = path.join(payload.dir, 'refusal-runner.mjs');
	writeFileSync(runner, `
import net from 'node:net';
import tls from 'node:tls';
import * as handler from './handler.js';
const secure = process.argv[2] === 'tls';
const shape = process.argv[3];
const size = Number(process.argv[4]);
await handler.start('127.0.0.1', 0);
const port = handler.server.address().port;
function request(wire, allowReset = false) {
	return new Promise((resolve, reject) => {
		const socket = secure ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		let raw = '';
		const deadline = setTimeout(() => { socket.destroy(); reject(new Error('No terminal response')); }, 5000);
		socket.on('data', chunk => { raw += chunk.toString('latin1'); });
		socket.on('error', error => {
			clearTimeout(deadline);
			if (allowReset && error.code === 'ECONNRESET') resolve({ raw, reset: true });
			else reject(error);
		});
		socket.on('close', () => { clearTimeout(deadline); resolve({ raw, reset: false }); });
		socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(wire));
	});
}
try {
	const wire = shape === 'extension'
		? 'POST /healthz HTTP/1.1\\r\\nHost: x\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n1;' + 'x'.repeat(size) + '\\r\\na\\r\\n0\\r\\n\\r\\n'
		: 'POST /healthz HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: ' + size + '\\r\\n\\r\\n' + 'x'.repeat(size) + 'GET /x HTTP/1.1\\r\\nHost: x\\r\\nBad Header\\r\\n\\r\\n';
	const result = await request(wire, secure && shape === 'extension' && size === 200000);
	const healthy = await request('GET /healthz HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
	console.log('REFUSAL_RESULT ' + JSON.stringify({ ...result, healthy }));
} finally { await handler.shutdown({ timeoutMs: 1000 }); }
`, 'utf8');
}, 60000);
afterAll(() => payload?.cleanup());

it.each([
	['tls', 'extension', 20000], ['tls', 'extension', 200000],
	['tls', 'bad-header', 20000], ['tls', 'bad-header', 200000],
	['tcp', 'extension', 20000], ['tcp', 'bad-header', 20000],
	['tls', 'bad-header', 4096]
])('survives a %s %s parser refusal after %i bytes', async (transport, shape, size) => {
	const env = { ...process.env };
	if (transport === 'tls') Object.assign(env, {
		REFUSAL_TEST_SSL_CERT: path.join(certs, 'localhost.crt'),
		REFUSAL_TEST_SSL_KEY: path.join(certs, 'localhost.key'), REFUSAL_TEST_SSL_WATCH: '0'
	});
	delete env.VITEST;
	const { stdout, stderr } = await run(process.execPath, [runner, transport, shape, String(size)], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
	expect(stderr).not.toMatch(/Assertion failed|current_write_/);
	const line = stdout.split(/\r?\n/).find(value => value.startsWith('REFUSAL_RESULT '));
	expect(line, stdout + stderr).toBeDefined();
	const { raw, reset, healthy } = JSON.parse(line.slice('REFUSAL_RESULT '.length));
	// A reset can discard refusal bytes when the peer still has unread input.
	// The child must survive and serve a separate connection in either case.
	if (reset) {
		expect([transport, shape, size]).toEqual(['tls', 'extension', 200000]);
		const status = 'HTTP/1.1 413';
		expect(raw === '' || status.startsWith(raw) || raw.startsWith(status)).toBe(true);
	} else {
		expect(raw).toMatch(shape === 'extension' ? /HTTP\/1\.1 413/ : /HTTP\/1\.1 400/);
	}
	expect(healthy.reset).toBe(false);
	expect(healthy.raw).toMatch(/^HTTP\/1\.1 200/);
}, 20000);
