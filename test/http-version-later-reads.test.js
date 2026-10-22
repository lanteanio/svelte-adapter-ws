// A request line in another HTTP version is answered 505 and its connection
// closed as soon as the line shows it, as the family's native tier answers
// it: before its header block has ended, and in any read of the connection,
// not only the first. The head reader sees every request line at its message
// boundary, so a header node's parser would refuse, a forbidden method or a
// header block past the limit behind that line does not turn the 505 into
// node's 400, 405 or 431. Over raw sockets on the BUILT runtime (TCP and TLS)
// and on createTestServer.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import { createTestServer } from '../src/testing.js';

const VERSION_505 = 'HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n<h1>HTTP Version Not Supported</h1><p>This server does not support HTTP/1.0.</p><hr><i>uWebSockets/20 Server</i>';
const HEALTHY = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';
const ANSWERED = /^HTTP\/1\.1 200 OK\r\n[^]*?\r\n\r\nOK/;

const UNENDED = [
	['a line with no CRLF', 'GET / HTTP/1.0'],
	['a line and nothing after it', 'GET / HTTP/1.0\r\n'],
	['a header still arriving', 'GET / HTTP/1.0\r\nHost: x'],
	['another version still arriving', 'GET / HTTP/2.0\r\nHost: x\r\n']
];

const LATER = [
	['a header node refuses', [[100, 'GET /b HTTP/1.0\r\nBad Header: x\r\n\r\n']]],
	['a forbidden method', [[100, 'TRACK /b HTTP/1.0\r\nHost: x\r\n\r\n']]],
	['a header block past the limit', [[100, 'GET /b HTTP/1.0\r\nX-Big: ' + 'a'.repeat(5000) + '\r\n\r\n']]],
	['an unended line', [[100, 'GET /b HTTP/1.0']]],
	['a version split across reads', [[100, 'GET /b HTT'], [160, 'P/1.0\r\nBad Header: x\r\n\r\n']]],
	['HTTP/2.0 and a header node refuses', [[100, 'GET /b HTTP/2.0\r\nBad Header: x\r\n\r\n']]]
];

describe.each(['tcp', 'tls', 'harness'])('another version in any read over %s', transport => {
	let payload, runtime;
	const secure = transport === 'tls';
	const prefix = 'VERSION_READS_';
	beforeAll(async () => {
		if (transport === 'harness') { runtime = await createTestServer(); return; }
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			Object.assign(process.env, {
				[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
				[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
				[prefix + 'SSL_WATCH']: '0'
			});
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});

	it.each(UNENDED)('answers %s at once', async (_, request) => {
		// The window is far below node's header timeout: the answer comes from
		// the line, not from a timer.
		expect(await rawConversation(runtime.port, [[0, request]], { secure, wait: 1500 })).toEqual({ raw: VERSION_505, closed: true });
	});

	it.each(LATER)('answers %s in a later read after an answered request', async (_, writes) => {
		const result = await rawConversation(runtime.port, [[0, HEALTHY], ...writes], { secure, wait: 1500 });
		expect(result.closed).toBe(true);
		expect(result.raw).toMatch(ANSWERED);
		expect(result.raw.replace(ANSWERED, '')).toBe(VERSION_505);
	});
});
