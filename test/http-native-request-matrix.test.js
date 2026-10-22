// Request lines, pipelines and connection closes as the family's native tier
// answers them, measured against it and held here as one matrix: the status
// of every answer on the wire, in order, and whether the server ended the
// connection. Over raw sockets on the BUILT runtime (TCP and TLS) and on
// createTestServer, whose routes answer 404 where the built app answers.
//
// The shapes: doubled separators and a space in front of the line; a
// version refused in the first read, behind an answer, past a TLS record or
// in a later read; requests behind an answer still waiting, finished in a
// microtask, a setImmediate or a timer; requests behind a request or an answer
// marked Connection: close; forbidden methods, whole or split inside their
// name; leading empty lines, a bare LF, a CR before the version and lines
// that stop before their version, which the native tier holds without an
// answer.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import { createTestServer } from '../src/testing.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024, idleTimeout: 120, maxBackpressure: 1024 * 1024, closeOnBackpressureLimit: false,
	sendPingsAutomatically: true, compression: false, allowedOrigins: '*', upgradeTimeout: 5, upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10, authPathRateLimit: 0, authPathRateLimitWindow: 10, allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false, allowNonAsciiTopics: false, authPathRequireOrigin: true,
	compressCredentialedResponses: false, unsafeSameOriginWithoutHostPin: false, adminAuthAcknowledged: true
};

const SERVER = `export class Server {
	async init() {}
	async respond(request) {
		const name = new URL(request.url).pathname.slice(3);
		const headers = { 'cache-control': 'no-store', 'content-type': 'text/plain' };
		if (name === 'micro') { await Promise.resolve(); return new Response('micro', { headers }); }
		if (name === 'immediate') { await new Promise(r => setImmediate(r)); return new Response('immediate', { headers }); }
		if (name === 'async') { await new Promise(r => setTimeout(r, 50)); return new Response('late', { headers }); }
		if (name === 'slow') { await new Promise(r => setTimeout(r, 300)); return new Response('slow', { headers }); }
		if (name === 'server-close') return new Response('closed', { headers: { ...headers, connection: 'close' } });
		if (name === 'big') return new Response('x'.repeat(17000), { headers });
		return new Response('ok', { headers });
	}
}`;

const H = 'Host: x\r\n';
const g = (path, extra = '', version = '1.1', method = 'GET') => `${method} ${path} HTTP/${version}\r\n${H}${extra}\r\n`;
const ok = g('/p/ok');
const close = 'Connection: close\r\n';
const handshake = 'GET /ws HTTP/1.1\r\n' + H + 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

/** name, writes, built runtime answer, createTestServer answer */
const MATRIX = [
	['a doubled space before the target', [[0, 'GET  /p/ok HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['a doubled space before the version', [[0, 'GET /p/ok  HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['a POST with a doubled space', [[0, 'POST  /p/ok HTTP/1.1\r\n' + H + 'Content-Length: 0\r\n\r\n']], '505 closed', '505 closed'],
	['an absolute target before its line ends', [[0, 'GET http://x/a HTTP/1.1']], '505 closed', '505 closed'],
	['an asterisk target before its head ends', [[0, 'OPTIONS * HTTP/1.1\r\n' + H]], '505 closed', '505 closed'],
	['a target not in origin form before its version', [[0, 'GET x']], '505 closed', '505 closed'],
	['TRACK in HTTP/1.0 behind a request in one read', [[0, ok + g('/', '', '1.0', 'TRACK')]], '505 closed', '505 closed'],
	['HTTP/1.0 with a header block past a TLS record', [[0, 'GET / HTTP/1.0\r\nX: ' + 'a'.repeat(20000) + '\r\n\r\n']], '505 closed', '505 closed'],
	['a request behind an answer finished in a microtask', [[0, g('/p/micro') + ok]], '200,200 open', '404,404 open'],
	['a request behind an answer finished in a timer', [[0, g('/p/async') + ok]], ' closed', '404,404 open'],
	['a request behind an answer finished in a setImmediate', [[0, g('/p/immediate') + ok]], ' closed', '404,404 open'],
	['HTTP/1.0 behind an answer finished in a setImmediate', [[0, g('/p/immediate') + g('/p/ok', '', '1.0')]], '505 closed', '505 closed'],
	['a request behind a built asset', [[0, g('/test.txt') + ok]], '200,200 open', '404,404 open'],
	['HTTP/1.0 behind a small answer', [[0, ok + g('/p/ok', '', '1.0')]], '505 closed', '505 closed'],
	['a request behind one still waiting', [[0, ok + g('/p/slow') + ok]], ' closed', '404,404,404 open'],
	['HTTP/1.0 behind an answer past the cork', [[0, g('/p/big') + g('/p/ok', '', '1.0')]], '200,505 closed', '505 closed'],
	['an empty line before the request', [[0, '\r\n' + ok]], ' open', ' open'],
	['two empty lines before the request', [[0, '\r\n\r\n' + ok]], ' open', ' open'],
	['a line that stops inside its target', [[0, 'GET /']], ' open', ' open'],
	['a line with no version', [[0, 'GET /\r\n']], '505 closed', '505 closed'],
	['a target past the header limit', [[0, 'GET /' + 'a'.repeat(20000)]], '431 closed', '431 closed'],
	['TRACK in a later read', [[0, ok], [100, g('/p/ok', '', '1.1', 'TRACK')]], '200,405 open', '404,404 open'],
	['a malformed line in a later read', [[0, ok], [100, 'GET /p/ok HTTP/1.1 x\r\n' + H + '\r\n']], '200,505 closed', '404,505 closed'],
	['a malformed header in a later read', [[0, ok], [100, 'GET /p/ok HTTP/1.1\r\nBad Header: x\r\n\r\n']], '200,400 closed', '404,400 closed'],
	['a space in front of the target', [[0, ' /p/ok HTTP/1.1\r\n' + H + '\r\n']], '400 open', '404 open'],
	['a space in front of the method', [[0, ' GET /a HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['two spaces in front of the target', [[0, '  / HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['a space in front of an asterisk', [[0, ' * HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['a bare LF before the request', [[0, '\n' + ok]], '505 closed', '505 closed'],
	['a bare LF before a malformed request', [[0, '\nGET /p/ok HTTP/1.1\r\nBad Header: x\r\n\r\n']], '505 closed', '505 closed'],
	['a CR inside the method', [[0, 'G\rT / HTTP/1.1\r\n' + H + '\r\n']], ' open', ' open'],
	['a CR inside the target', [[0, 'GET /a\rb HTTP/1.1\r\n' + H + '\r\n']], ' open', ' open'],
	['a line with no version and a header', [[0, 'GET /abc\r\n' + H]], '505 closed', '505 closed'],
	['a line with no target', [[0, 'GETXYZ\r\n']], ' open', ' open'],
	['a line with no version ending the head', [[0, 'GET /\r\n\r\n']], '505 closed', '505 closed'],
	['a longer line with no version ending the head', [[0, 'GET /abc\r\n\r\n']], '505 closed', '505 closed'],
	['a tab after a split method', [[0, 'GE'], [100, '\tT / HTTP/1.1\r\n' + H + '\r\n']], '505 closed', '505 closed'],
	['a version split across reads', [[0, 'GET / HTTP/1.'], [100, '0']], '505 closed', '505 closed'],
	['a request behind TRACK', [[0, g('/p/ok', '', '1.1', 'TRACK') + ok]], '405,200 open', '404,404 open'],
	['a request behind CONNECT', [[0, 'CONNECT /p/ok HTTP/1.1\r\n' + H + '\r\n' + ok]], '405,200 open', '404,404 open'],
	['a request in a later read behind TRACK', [[0, g('/p/ok', '', '1.1', 'TRACK')], [150, ok]], '405,200 open', '404,404 open'],
	['a request behind an answer marked close', [[0, g('/p/server-close') + ok]], '200,200 open', '404,404 open'],
	['a request in a later read behind an answer marked close', [[0, g('/p/server-close')], [150, ok]], '200,200 open', '404,404 open'],
	['a request behind a closing request answered in a microtask', [[0, g('/p/micro', close) + ok]], '200,200 open', '404,404 open'],
	['HTTP/1.0 behind a closing request still waiting', [[0, g('/p/slow', close) + g('/p/ok', '', '1.0')]], '505 closed', '505 closed'],
	['a request without Host behind a closing request still waiting', [[0, g('/p/slow', close) + 'GET /p/ok HTTP/1.1\r\n\r\n']], '400 closed', '400 closed'],
	['an answer marked close behind one still waiting', [[0, g('/p/slow') + g('/p/server-close') + ok]], ' closed', '404,404,404 open'],
	['a request behind a closing request', [[0, g('/p/ok', close) + ok]], '200,200 open', '404,404 open'],
	['a request behind a closing request answered marked close', [[0, g('/p/server-close', close) + ok]], '200,200 open', '404,404 open'],
	['a request in a later read behind a closing request', [[0, g('/p/ok', close)], [150, ok]], '200 closed', '404 closed'],
	['a request behind a closing request answered in a timer', [[0, g('/p/async', close) + ok]], ' closed', '404,404 open'],
	['a handshake behind an answer marked close', [[0, g('/p/server-close') + handshake]], '200,101 open', '404,101 open'],
	['an answer marked close behind one finished in a timer', [[0, g('/p/async') + g('/p/server-close') + ok]], ' closed', '404,404,404 open'],
	['TRACK split inside its name', [[0, 'TRAC'], [100, 'K / HTTP/1.1\r\n' + H + '\r\n']], '405 open', '404 open'],
	['a lowercase track split after its first letter', [[0, 't'], [100, 'rack / HTTP/1.1\r\n' + H + '\r\n']], '405 open', '404 open'],
	['a lowercase connect split inside its name', [[0, 'con'], [100, 'nect /x HTTP/1.1\r\n' + H + '\r\n']], '405 open', '404 open'],
	['a space-slash line ending the head with a byte after it', [[0, ' /\r\n\r\nx']], '505 closed', '505 closed'],
	['a space-slash line whose head ends in a later read', [[0, ' /\r\n'], [100, '\r\n']], '505 closed', '505 closed'],
	['a space-slash line ending the head with a request after it', [[0, ' /\r\n\r\n' + ok]], ' open', ' open']
];

/** @param {{ raw: string, closed: boolean }} result */
const outcome = result => [...result.raw.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(m => m[1]).join(',') + (result.closed ? ' closed' : ' open');

describe.each(['tcp', 'tls'])('the native request matrix on the built runtime over %s', transport => {
	let payload, runtime;
	const secure = transport === 'tls';
	const prefix = 'NATIVE_MATRIX_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			Object.assign(process.env, {
				[prefix + 'SSL_CERT']: path.join(certs, 'localhost.crt'),
				[prefix + 'SSL_KEY']: path.join(certs, 'localhost.key'),
				[prefix + 'SSL_WATCH']: '0'
			});
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify(WS_OPTS) },
			files: { 'client/test.txt': 'static control' },
			serverSource: SERVER
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	it.each(MATRIX)('%s', async (_, writes, expected) => {
		expect(outcome(await rawConversation(runtime.port, writes, { secure, wait: 800 }))).toBe(expected);
	});
});

describe('the native request matrix on createTestServer', () => {
	let server;
	beforeAll(async () => { server = await createTestServer(); });
	afterAll(async () => { await server?.close(); });
	it.each(MATRIX)('%s', async (_, writes, __, expected) => {
		expect(outcome(await rawConversation(server.port, writes, { wait: 800 }))).toBe(expected);
	});
});
