// A request whose line names any version but HTTP/1.1 is answered 505 and
// its connection closed, before its method, target, headers or route are
// looked at, as the family's native tier answers it: on the BUILT runtime
// over TCP and TLS and on createTestServer, over raw sockets. node parses
// HTTP/1.0, a line with no version and `HTTP/2.0` into a request, and refuses
// the rest in its parser; both paths give the same answer. An HTTP/1.1
// request is answered as before, and so is one node's parser refuses for
// anything else.

import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false,
	adminAuthAcknowledged: true
};

const HANDSHAKE = [
	'Upgrade: websocket',
	'Connection: Upgrade',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
	'Sec-WebSocket-Version: 13'
];

/** Counts the application's upgrade hook, which must never run for a refused version. */
const WS_HANDLER = 'export function message() {}\n' +
	'export function upgrade() { globalThis.__httpVersionUpgrades = (globalThis.__httpVersionUpgrades ?? 0) + 1; return {}; }\n';

/** An HTTP/1.1 request that must go unanswered once the 505 has closed the connection. */
const AFTER = 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n';

/**
 * @typedef {{ statusLine: string, lines: string[], body: string }} Answer
 * @typedef {{ answers: Answer[], rest: string, closed: boolean }} Conversation
 */

/**
 * The whole responses at the front of `raw`, one per method given, and what
 * follows them.
 *
 * @param {string} raw latin1
 * @param {string[]} methods
 */
function parse(raw, methods) {
	/** @type {Answer[]} */
	const answers = [];
	let at = 0;
	while (answers.length < methods.length) {
		const end = raw.indexOf('\r\n\r\n', at);
		if (end < 0) break;
		const [statusLine, ...rest] = raw.slice(at, end).split('\r\n');
		const lines = rest.map((l) => l.toLowerCase());
		const length = Number(lines.find((l) => l.startsWith('content-length:'))?.slice(15).trim() ?? 0);
		const bodyless = methods[answers.length] === 'HEAD' || statusLine.startsWith('HTTP/1.1 101');
		const next = end + 4 + (bodyless ? 0 : length);
		if (raw.length < next) break;
		answers.push({ statusLine, lines, body: raw.slice(end + 4, next) });
		at = next;
	}
	return { answers, rest: raw.slice(at) };
}

/**
 * Writes in order, each after its delay, then everything the server sent
 * until it ended the connection or the wait ran out.
 *
 * @param {() => import('node:net').Socket} connect
 * @param {Array<[number, string]>} writes latin1
 * @param {string[]} methods one per answer expected
 * @returns {Promise<Conversation>}
 */
function converse(connect, writes, methods) {
	return new Promise((resolve) => {
		const socket = connect();
		let raw = '';
		let done = false;
		const finish = (/** @type {boolean} */ closed) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ ...parse(raw, methods), closed });
		};
		const timer = setTimeout(() => finish(false), 2000);
		socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => {
			for (const [at, text] of writes) {
				setTimeout(() => { if (!socket.destroyed && socket.writable) socket.write(Buffer.from(text, 'latin1')); }, at);
			}
		});
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('end', () => finish(true));
		socket.on('error', () => finish(true));
	});
}

/**
 * The 505, whichever door wrote it, as the only answer on a connection the
 * server ended: an HTTP/1.1 request sent after it is never answered.
 *
 * @param {Conversation} conversation
 * @param {string} label
 * @param {{ head?: boolean }} [opts] the refused request was a HEAD
 */
function expect505(conversation, label, opts = {}) {
	const [answer] = conversation.answers;
	expect(answer?.statusLine, label).toBe('HTTP/1.1 505 HTTP Version Not Supported');
	expect(answer.lines.filter((l) => !l.startsWith('date:')).sort(), label).toEqual(['connection: close', 'content-length: 26', 'content-type: text/plain']);
	expect(answer.body, label).toBe(opts.head ? '' : 'HTTP Version Not Supported');
	expect(conversation.answers, label + ': nothing after it').toHaveLength(1);
	expect(conversation.rest, label + ': nothing after it').toBe('');
	expect(conversation.closed, label + ': the connection ended').toBe(true);
}

/**
 * Every request line node parses into a request in a version but 1.1, and
 * every one its parser refuses, each with what follows it on the wire.
 */
const REFUSED = /** @type {Array<[string, string]>} */ ([
	['HTTP/1.0', 'GET /api/tiny HTTP/1.0\r\n\r\n'],
	['HTTP/1.0 asking to keep the connection', 'GET /api/tiny HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'],
	['HTTP/1.0 accepting chunked', 'GET /api/tiny HTTP/1.0\r\nTE: chunked\r\n\r\n'],
	['an HTTP/1.0 POST with a body', 'POST /api/tiny HTTP/1.0\r\nContent-Length: 5\r\n\r\nhello'],
	['the liveness probe in HTTP/1.0', 'GET /healthz HTTP/1.0\r\n\r\n'],
	['a built asset in HTTP/1.0', 'GET /asset.txt HTTP/1.0\r\n\r\n'],
	['the WebSocket path in HTTP/1.0', 'GET /ws HTTP/1.0\r\n\r\n'],
	['OPTIONS * in HTTP/1.0', 'OPTIONS * HTTP/1.0\r\n\r\n'],
	['a request line with no version', 'GET /\r\n\r\n'],
	['HTTP/2.0 sent as text', 'GET / HTTP/2.0\r\nHost: x\r\n\r\n'],
	['HTTP/1.2', 'GET / HTTP/1.2\r\nHost: x\r\n\r\n'],
	['a version in lower case', 'GET / http/1.1\r\nHost: x\r\n\r\n'],
	['a space after the version', 'GET / HTTP/1.1 \r\nHost: x\r\n\r\n'],
	['a request line ending in LF alone', 'GET / HTTP/1.1\nHost: x\r\n\r\n']
]);

/** HTTP/1.0 requests that are wrong in some other way as well: the version is answered first. */
const REFUSED_FIRST = /** @type {Array<[string, string]>} */ ([
	['TRACE', 'TRACE / HTTP/1.0\r\n\r\n'],
	['TRACK', 'TRACK / HTTP/1.0\r\n\r\n'],
	['CONNECT', 'CONNECT 127.0.0.1:9 HTTP/1.0\r\n\r\n'],
	['PROPFIND', 'PROPFIND / HTTP/1.0\r\n\r\n'],
	['a target byte outside visible ASCII', 'GET /\x01 HTTP/1.0\r\n\r\n'],
	['a fragment in the target', 'GET /healthz#x HTTP/1.0\r\n\r\n'],
	['a header block past the limit', 'GET / HTTP/1.0\r\nX-Pad: ' + 'p'.repeat(20000) + '\r\n\r\n'],
	['a header name node refuses', 'GET / HTTP/1.0\r\nBad Header: x\r\n\r\n'],
	['a Transfer-Encoding other than chunked', 'POST /api/tiny HTTP/1.0\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n']
]);

/** @param {number} port */
const tcp = (port) => () => net.connect(port, '127.0.0.1');

/**
 * @param {() => import('node:net').Socket} connect
 * @param {string} request
 * @param {string} [method]
 */
const refusal = (connect, request, method = 'GET') => converse(connect, [[0, request], [150, AFTER]], [method, 'GET']);

describe('the built runtime', () => {
	/** @type {any} */ let open;

	beforeAll(async () => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: WS_HANDLER,
			files: { 'client/asset.txt': 'asset' }
		});
		open = { payload, rt: await bootRuntime(payload) };
	}, 60000);

	afterAll(async () => {
		await open?.rt.close();
		open?.payload.cleanup();
	});

	it('answers every version but HTTP/1.1 with 505 and ends the connection', async () => {
		for (const [label, request] of REFUSED) {
			expect505(await refusal(tcp(open.rt.port), request), label);
		}
	});

	it('answers an HTTP/1.0 HEAD with the head alone, its length included', async () => {
		expect505(await refusal(tcp(open.rt.port), 'HEAD /api/tiny HTTP/1.0\r\n\r\n', 'HEAD'), 'HEAD', { head: true });
		expect505(await refusal(tcp(open.rt.port), 'HEAD /api/tiny HTTP/1.0\r\nBad Header: x\r\n\r\n', 'HEAD'), 'HEAD refused by the parser', { head: true });
	});

	it('answers the version before the method, the target, the headers and the framing', async () => {
		for (const [label, request] of REFUSED_FIRST) {
			expect505(await refusal(tcp(open.rt.port), request), label);
		}
	});

	it('refuses an HTTP/1.0 handshake without running the upgrade hook', async () => {
		const before = /** @type {any} */ (globalThis).__httpVersionUpgrades ?? 0;
		expect505(await refusal(tcp(open.rt.port), ['GET /ws HTTP/1.0', 'Host: x', ...HANDSHAKE].join('\r\n') + '\r\n\r\n'), 'handshake');
		expect(/** @type {any} */ (globalThis).__httpVersionUpgrades ?? 0, 'the hook never ran').toBe(before);
		// The same handshake in HTTP/1.1 opens, and runs the hook once.
		const opened = await converse(tcp(open.rt.port), [[0, ['GET /ws HTTP/1.1', 'Host: x', ...HANDSHAKE].join('\r\n') + '\r\n\r\n']], ['GET']);
		expect(opened.answers[0]?.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
		expect(/** @type {any} */ (globalThis).__httpVersionUpgrades).toBe(before + 1);
	});

	it('answers the HTTP/1.1 requests ahead of it first', async () => {
		const ahead = 'GET /api/tiny HTTP/1.1\r\nHost: x\r\n\r\n';
		for (const [label, writes] of /** @type {Array<[string, Array<[number, string]>]>} */ ([
			['in one write', [[0, ahead + 'GET /healthz HTTP/1.0\r\n\r\n']]],
			['in a later write', [[0, ahead], [150, 'GET /healthz HTTP/1.0\r\n\r\n']]]
		])) {
			const conversation = await converse(tcp(open.rt.port), writes, ['GET', 'GET']);
			expect(conversation.answers.map((a) => a.statusLine), label).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 505 HTTP Version Not Supported']);
			expect(conversation.answers[0].body, label).toBe('ok');
			expect(conversation.closed, label).toBe(true);
		}
	});

	it('keeps the parser\'s own answer for an HTTP/1.1 request whose fault arrives in a later read', async () => {
		// The read that fails starts inside the request, so its first line is a
		// header; the request line, which named HTTP/1.1, came before it.
		const conversation = await converse(tcp(open.rt.port), [
			[0, 'GET / HTTP/1.1\r\nHost: x\r\n'],
			[150, 'Bad Header: x\r\n\r\n']
		], ['GET']);
		expect(conversation.answers[0]?.statusLine).toBe('HTTP/1.1 400 Bad Request');
		const whole = await converse(tcp(open.rt.port), [[0, 'GET / HTTP/1.1\r\nHost: x\r\nBad Header: x\r\n\r\n']], ['GET']);
		expect(whole.answers[0]?.statusLine).toBe('HTTP/1.1 400 Bad Request');
	});
});

describe('the built runtime over TLS', () => {
	const prefix = 'SAW_HV_TLS_';
	const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
	/** @type {any} */ let secure;

	beforeAll(async () => {
		process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
		process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
		process.env[prefix + 'SSL_WATCH'] = '0';
		const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		secure = { payload, rt: await bootRuntime(payload) };
	}, 60000);

	afterAll(async () => {
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
		await secure?.rt.close();
		secure?.payload.cleanup();
	});

	it('answers 505 from the request listener and from the parser alike', async () => {
		const connect = () => tls.connect({ host: '127.0.0.1', port: secure.rt.port, rejectUnauthorized: false });
		expect505(await refusal(connect, 'GET /api/tiny HTTP/1.0\r\n\r\n'), 'HTTP/1.0');
		expect505(await refusal(connect, 'TRACK / HTTP/1.0\r\n\r\n'), 'TRACK');
		const split = await converse(connect, [[0, 'GET / HTTP/1.1\r\nHost: x\r\n'], [150, 'Bad Header: x\r\n\r\n']], ['GET']);
		expect(split.answers[0]?.statusLine).toBe('HTTP/1.1 400 Bad Request');
	});
});

describe('createTestServer', () => {
	/** @type {any} */ let mirror;
	let upgrades = 0;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({ handler: { upgrade: () => { upgrades++; return {}; } } });
	});

	afterAll(async () => {
		await mirror?.close();
	});

	it('answers the same 505 through every door', async () => {
		for (const [label, request] of [...REFUSED, ...REFUSED_FIRST]) {
			expect505(await refusal(tcp(mirror.port), request), label);
		}
		expect505(await refusal(tcp(mirror.port), 'HEAD / HTTP/1.0\r\n\r\n', 'HEAD'), 'HEAD', { head: true });
	});

	it('refuses an HTTP/1.0 handshake without running the upgrade handler', async () => {
		expect505(await refusal(tcp(mirror.port), ['GET /ws HTTP/1.0', 'Host: x', ...HANDSHAKE].join('\r\n') + '\r\n\r\n'), 'handshake');
		expect(upgrades).toBe(0);
		const opened = await converse(tcp(mirror.port), [[0, ['GET /ws HTTP/1.1', 'Host: x', ...HANDSHAKE].join('\r\n') + '\r\n\r\n']], ['GET']);
		expect(opened.answers[0]?.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
		expect(upgrades).toBe(1);
	});

	it('keeps the parser\'s own answer for an HTTP/1.1 request whose fault arrives in a later read', async () => {
		const conversation = await converse(tcp(mirror.port), [[0, 'GET / HTTP/1.1\r\nHost: x\r\n'], [150, 'Bad Header: x\r\n\r\n']], ['GET']);
		expect(conversation.answers[0]?.statusLine).toBe('HTTP/1.1 400 Bad Request');
	});
});
