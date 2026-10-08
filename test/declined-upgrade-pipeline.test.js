// A request a client pipelines behind one whose upgrade the server declines,
// in the same packet, is answered, on the BUILT runtime (over TCP and TLS) and
// on createTestServer. The declined request is answered as an ordinary one,
// then the pipelined one, and the connection stays open for the next. The
// family's native tier answers both; node's parser stops the read at the end
// of the declined request and hands the rest on only for an upgrade it took.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { resumeAfterDeclinedUpgrade } from '../src/runtime/handler/http-helpers.js';

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

const H2C = ['Connection: Upgrade, HTTP2-Settings', 'Upgrade: h2c', 'HTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA'];
const HANDSHAKE = [
	'Upgrade: websocket',
	'Connection: Upgrade',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
	'Sec-WebSocket-Version: 13'
];

/**
 * @typedef {{ status: string, lines: string[], body: string }} Answer
 */

/**
 * The whole responses at the front of `raw`, one per request method given.
 *
 * @param {string} raw latin1
 * @param {string[]} methods
 * @returns {Answer[]}
 */
function parseAnswers(raw, methods) {
	/** @type {Answer[]} */
	const out = [];
	let at = 0;
	while (out.length < methods.length) {
		const end = raw.indexOf('\r\n\r\n', at);
		if (end < 0) break;
		const [statusLine, ...rest] = raw.slice(at, end).split('\r\n');
		const status = statusLine.slice(9, 12);
		const lines = rest.map((l) => l.toLowerCase());
		/** @param {string} name */
		const header = (name) => lines.find((l) => l.startsWith(name + ':'))?.slice(name.length + 1).trim();
		let next = end + 4;
		let body = '';
		if (methods[out.length] === 'HEAD' || status === '101' || status === '204' || status === '304') {
			// No payload.
		} else if (header('transfer-encoding') === 'chunked') {
			for (;;) {
				const nl = raw.indexOf('\r\n', next);
				if (nl < 0) return out;
				const size = Number.parseInt(raw.slice(next, nl), 16);
				if (raw.length < nl + 2 + size + 2) return out;
				body += raw.slice(nl + 2, nl + 2 + size);
				next = nl + 2 + size + 2;
				if (size === 0) break;
			}
		} else {
			const length = Number(header('content-length') || 0);
			if (raw.length < next + length) break;
			body = raw.slice(next, next + length);
			next += length;
		}
		out.push({ status, lines, body });
		at = next;
	}
	return out;
}

/**
 * @typedef {{ lines: string[], body?: string }} Ask
 */

/**
 * Every request in ONE write - or in two, split right after the first
 * `splitAfter` - then, once each is answered, a GET for the liveness probe on
 * the same connection. Resolves with every answer that arrived within the
 * wait, the probe's last unless the connection stopped answering.
 *
 * @param {() => import('node:net').Socket} connect
 * @param {number} port
 * @param {Ask[]} asks
 * @param {{ splitAfter?: string }} [opts]
 * @returns {Promise<Answer[]>}
 */
function pipelined(connect, port, asks, opts = {}) {
	const all = [...asks, { lines: ['GET /healthz HTTP/1.1'] }];
	const methods = all.map((a) => a.lines[0].slice(0, a.lines[0].indexOf(' ')));
	/** @param {Ask} ask */
	const wire = (ask) => [...ask.lines, `Host: 127.0.0.1:${port}`].join('\r\n') + '\r\n\r\n' + (ask.body ?? '');
	const payload = asks.map(wire).join('');
	const cut = opts.splitAfter === undefined ? payload.length : payload.indexOf(opts.splitAfter) + opts.splitAfter.length;
	if (opts.splitAfter !== undefined && (payload.indexOf(opts.splitAfter) < 0 || cut >= payload.length)) {
		throw new Error('splitAfter must fall inside the payload');
	}
	return new Promise((resolve, reject) => {
		const socket = connect();
		let raw = '';
		let followed = false;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(parseAnswers(raw, methods));
		};
		// node's own answer to the dropped request was silence and an idle
		// close after about six seconds; the wait stays well under that.
		const timer = setTimeout(finish, 2500);
		socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => {
			socket.write(Buffer.from(payload.slice(0, cut), 'latin1'));
			if (cut < payload.length) setTimeout(() => socket.write(Buffer.from(payload.slice(cut), 'latin1')), 60);
		});
		socket.on('data', (chunk) => {
			raw += chunk.toString('latin1');
			const answered = parseAnswers(raw, methods);
			if (answered.length === all.length || answered.at(-1)?.status === '101') finish();
			else if (!followed && answered.length === asks.length) {
				followed = true;
				socket.write(Buffer.from(wire(all[all.length - 1]), 'latin1'));
			}
		});
		socket.on('end', finish);
		socket.on('error', (err) => {
			if (/** @type {any} */ (err).code === 'ECONNRESET') { finish(); return; }
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** A masked client ping carrying "hi", which the server answers with a pong. */
const PING = '\x89\x82\x01\x02\x03\x04' + String.fromCharCode('h'.charCodeAt(0) ^ 1, 'i'.charCodeAt(0) ^ 2);
const PONG = '\x8a\x02hi';

/**
 * The asks, a handshake for the WebSocket route and a ping frame, all in one
 * write. Resolves with what came back once the pong arrives, or at the wait.
 * The pong proves the WebSocket got the ping's bytes, and only those, as the
 * first bytes after its handshake.
 *
 * @param {() => import('node:net').Socket} connect
 * @param {number} port
 * @param {Ask[]} asks
 * @returns {Promise<string>} latin1
 */
function pingBehind(connect, port, asks) {
	/** @param {Ask} ask */
	const wire = (ask) => [...ask.lines, `Host: 127.0.0.1:${port}`].join('\r\n') + '\r\n\r\n' + (ask.body ?? '');
	const payload = [...asks, { lines: ['GET /ws HTTP/1.1', ...HANDSHAKE] }].map(wire).join('') + PING;
	return new Promise((resolve) => {
		const socket = connect();
		let raw = '';
		const finish = () => { clearTimeout(timer); socket.destroy(); resolve(raw); };
		const timer = setTimeout(finish, 2500);
		socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => socket.write(Buffer.from(payload, 'latin1')));
		socket.on('data', (chunk) => {
			raw += chunk.toString('latin1');
			if (raw.includes(PONG)) finish();
		});
		socket.on('error', finish);
		socket.on('end', finish);
	});
}

/** @param {number} port */
const tcp = (port) => () => net.connect(port, '127.0.0.1');

/** @param {Answer[]} answers */
const statuses = (answers) => answers.map((a) => a.status);

/** @param {Answer[]} answers */
const bodies = (answers) => answers.map((a) => a.body);

/** @param {Record<string, unknown>} [replace] */
async function boot(replace = {}) {
	const payload = buildRuntime({ replace, wsHandlerSource: 'export function message() {}\n' });
	return { payload, rt: await bootRuntime(payload) };
}

describe('the built runtime answers a request pipelined behind a declined upgrade', () => {
	/** @type {any} */ let open;

	beforeAll(async () => {
		open = await boot({ WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) });
	}, 60000);

	afterAll(async () => {
		await open?.rt.close();
		open?.payload.cleanup();
	});

	it('behind an h2c upgrade, keeping the connection', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		]);
		expect(statuses(answers)).toEqual(['200', '200', '200']);
		expect(bodies(answers)).toEqual(['OK', 'ok', 'OK']);
	});

	it('behind a complete handshake on a path the WebSocket route does not take', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /api/tiny HTTP/1.1', ...HANDSHAKE] },
			{ lines: ['GET /healthz HTTP/1.1'] }
		]);
		expect(bodies(answers)).toEqual(['ok', 'OK', 'OK']);
	});

	it('behind a declined POST, reading past its body', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Content-Length: 5'], body: 'hello' },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		]);
		expect(bodies(answers)).toEqual(['SSR:/ws', 'ok', 'OK']);
	});

	it('behind a declined POST whose body arrives in a later read', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Content-Length: 5'], body: 'hello' },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		], { splitAfter: '\r\n\r\nhe' });
		expect(bodies(answers)).toEqual(['SSR:/ws', 'ok', 'OK']);
	});

	it('behind a declined chunked POST whose body arrives in a later read', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Transfer-Encoding: chunked'], body: '5\r\nhello\r\n0\r\n\r\n' },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		], { splitAfter: '5\r\nhel' });
		expect(bodies(answers)).toEqual(['SSR:/ws', 'ok', 'OK']);
	});

	it('behind two declined upgrades in a row', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /api/tiny HTTP/1.1', ...H2C] },
			{ lines: ['GET /healthz HTTP/1.1'] }
		]);
		expect(bodies(answers)).toEqual(['OK', 'ok', 'OK', 'OK']);
	});

	it('behind a second declined request whose body arrives in a later read', async () => {
		// The first decline moves the connection to node's JS read path; the
		// second request's body ends in the next read there.
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Content-Length: 5'], body: 'hello' },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		], { splitAfter: '\r\n\r\nhe' });
		expect(bodies(answers)).toEqual(['OK', 'SSR:/ws', 'ok', 'OK']);
	});

	it('hands a handshake behind two declined upgrades exactly its own bytes', async () => {
		const raw = await pingBehind(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /api/tiny HTTP/1.1', ...H2C] }
		]);
		expect(raw.split('HTTP/1.1 101 ').length - 1).toBe(1);
		expect(raw).toContain(PONG);
	});

	it('in order, behind a declined request answered late', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /api/slow HTTP/1.1', ...H2C] },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		]);
		expect(bodies(answers)).toEqual(['slow-done', 'ok', 'OK']);
	});

	it('and opens a WebSocket handshake pipelined behind one', async () => {
		const answers = await pipelined(tcp(open.rt.port), open.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /ws HTTP/1.1', ...HANDSHAKE] }
		]);
		expect(statuses(answers)).toEqual(['200', '101']);
	});
});

describe('the built runtime without a WebSocket route', () => {
	/** @type {any} */ let plain;

	beforeAll(async () => {
		plain = await boot();
	}, 60000);

	afterAll(async () => {
		await plain?.rt.close();
		plain?.payload.cleanup();
	});

	it('answers a request pipelined behind a handshake it declines', async () => {
		const answers = await pipelined(tcp(plain.rt.port), plain.rt.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...HANDSHAKE] },
			{ lines: ['GET /api/tiny HTTP/1.1'] }
		]);
		expect(bodies(answers)).toEqual(['OK', 'ok', 'OK']);
	});
});

describe('the built runtime over TLS', () => {
	const prefix = 'SAW_DUP_TLS_';
	const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
	/** @type {any} */ let secure;

	beforeAll(async () => {
		process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
		process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
		process.env[prefix + 'SSL_WATCH'] = '0';
		secure = await boot({ ENV_PREFIX: JSON.stringify(prefix) });
	}, 60000);

	afterAll(async () => {
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
		await secure?.rt.close();
		secure?.payload.cleanup();
	});

	it('answers a request pipelined behind a declined upgrade', async () => {
		const port = secure.rt.port;
		const answers = await pipelined(
			() => tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }),
			port,
			[{ lines: ['GET /healthz HTTP/1.1', ...H2C] }, { lines: ['GET /api/tiny HTTP/1.1'] }]
		);
		expect(bodies(answers)).toEqual(['OK', 'ok', 'OK']);
	});

	it('behind a declined POST whose body arrives in a later read', async () => {
		const port = secure.rt.port;
		const answers = await pipelined(
			() => tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }),
			port,
			[
				{ lines: ['POST /api/tiny HTTP/1.1', ...H2C, 'Content-Length: 5'], body: 'hello' },
				{ lines: ['GET /api/tiny HTTP/1.1'] }
			],
			{ splitAfter: '\r\n\r\nhe' }
		);
		expect(bodies(answers)).toEqual(['ok', 'ok', 'OK']);
	});
});

describe('createTestServer answers a request pipelined behind a declined upgrade', () => {
	/** @type {any} */ let mirror;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({ handler: { upgrade: () => ({}) } });
	});

	afterAll(async () => {
		await mirror?.close();
	});

	it('behind an h2c upgrade, keeping the connection', async () => {
		const answers = await pipelined(tcp(mirror.port), mirror.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /healthz HTTP/1.1'] }
		]);
		expect(statuses(answers)).toEqual(['200', '200', '200']);
	});

	it('behind two declined upgrades in a row', async () => {
		const answers = await pipelined(tcp(mirror.port), mirror.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Content-Length: 5'], body: 'hello' },
			{ lines: ['GET /healthz HTTP/1.1'] }
		]);
		expect(answers).toHaveLength(4);
		expect(answers[3].status).toBe('200');
	});

	it('and opens a WebSocket handshake pipelined behind one', async () => {
		const answers = await pipelined(tcp(mirror.port), mirror.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /ws HTTP/1.1', ...HANDSHAKE] }
		]);
		expect(statuses(answers)).toEqual(['200', '101']);
	});

	it('behind a declined POST whose body arrives in a later read', async () => {
		const answers = await pipelined(tcp(mirror.port), mirror.port, [
			{ lines: ['POST /ws HTTP/1.1', ...HANDSHAKE, 'Content-Length: 5'], body: 'hello' },
			{ lines: ['GET /healthz HTTP/1.1'] }
		], { splitAfter: '\r\n\r\nhe' });
		expect(answers).toHaveLength(3);
		expect(statuses(answers).slice(1)).toEqual(['200', '200']);
	});

	it('hands a handshake behind two declined upgrades exactly its own bytes', async () => {
		const raw = await pingBehind(tcp(mirror.port), mirror.port, [
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] },
			{ lines: ['GET /healthz HTTP/1.1', ...H2C] }
		]);
		expect(raw.split('HTTP/1.1 101 ').length - 1).toBe(1);
		expect(raw).toContain(PONG);
	});
});

describe('resumeAfterDeclinedUpgrade on a plain node server', () => {
	const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');

	/**
	 * @param {{
	 *   secure?: boolean,
	 *   onConnection?: (socket: import('node:net').Socket) => void,
	 *   onRequest?: (req: import('node:http').IncomingMessage, socket: import('node:net').Socket) => void,
	 *   onUpgrade?: (req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void
	 * }} [opts]
	 */
	async function serve(opts = {}) {
		/** @param {import('node:http').IncomingMessage} req */
		const shouldUpgradeCallback = (req) => {
			if (opts.onUpgrade && req.url === '/ws') return true;
			resumeAfterDeclinedUpgrade(req);
			return false;
		};
		/** @type {import('node:http').RequestListener} */
		const answer = (req, res) => {
			opts.onRequest?.(req, req.socket);
			req.resume();
			req.on('end', () => {
				if (req.url === '/slow') setTimeout(() => res.end('answered /slow'), 200);
				else if (req.url === '/wide') res.end('w'.repeat(64 * 1024));
				else res.end(`answered ${req.url}`);
			});
		};
		const server = opts.secure
			? https.createServer({
				key: fs.readFileSync(path.join(certs, 'localhost.key')),
				cert: fs.readFileSync(path.join(certs, 'localhost.crt')),
				shouldUpgradeCallback
			}, answer)
			: http.createServer({ shouldUpgradeCallback }, answer);
		if (opts.onConnection) server.on(opts.secure ? 'secureConnection' : 'connection', opts.onConnection);
		if (opts.onUpgrade) server.on('upgrade', opts.onUpgrade);
		await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
		return server;
	}

	/** @param {import('node:net').Socket} socket @param {boolean[]} into */
	function recordPauseAtHandBack(socket, into) {
		const unshift = socket.unshift;
		socket.unshift = function (chunk) {
			into.push(/** @type {any} */ (socket)._paused === true);
			return unshift.call(this, chunk);
		};
	}

	/** @param {string} line @param {string[]} [extra] */
	const wire = (line, extra = []) => [`${line} HTTP/1.1`, 'Host: x', ...extra].join('\r\n') + '\r\n\r\n';

	/**
	 * Writes in order, each after its delay, then the answers once `count`
	 * have arrived or at the wait.
	 *
	 * @param {() => import('node:net').Socket} connect
	 * @param {[number, string][]} writes
	 * @param {number} count
	 */
	function exchangeTimed(connect, writes, count) {
		const methods = new Array(count).fill('GET');
		return new Promise((resolve) => {
			const socket = connect();
			let got = '';
			const finish = () => { clearTimeout(timer); socket.destroy(); resolve(parseAnswers(got, methods)); };
			const timer = setTimeout(finish, 3000);
			socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => {
				for (const [at, text] of writes) setTimeout(() => socket.write(Buffer.from(text, 'latin1')), at);
			});
			socket.on('data', (chunk) => {
				got += chunk.toString('latin1');
				if (parseAnswers(got, methods).length === count) finish();
			});
			socket.on('error', finish);
			socket.on('close', finish);
		});
	}

	/** @param {Answer[]} answers */
	const shown = (answers) => answers.map((a) => (a.body.startsWith('w') ? `wide ${a.body.length}` : a.body));

	it('keeps the order on a connection node pauses behind queued answers', async () => {
		// A wide answer queued behind a slow one makes node pause the connection
		// when the declined request is parsed, so the rest of that read waits on
		// a paused socket, and a request sent during the pause comes after it.
		/** @type {boolean[]} */
		const paused = [];
		const server = await serve({ onConnection: (socket) => recordPauseAtHandBack(socket, paused) });
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			const answers = await exchangeTimed(tcp(port), [
				[0, wire('GET /slow') + wire('GET /wide')],
				[50, wire('GET /a', H2C) + wire('GET /b')],
				[120, wire('GET /c')]
			], 5);
			expect(paused, 'the rest of the read was handed back while node had paused the connection').toEqual([true]);
			expect(shown(answers)).toEqual(['answered /slow', `wide ${64 * 1024}`, 'answered /a', 'answered /b', 'answered /c']);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it('keeps the order over TLS when one read carries the next record too', async () => {
		// One write that TLS cuts into a 16384-byte record ending right after
		// the pipelined request, and a second record. node feeds both records of
		// the read to the parser; the second must wait behind the handed-back one.
		/** @type {boolean[]} */
		const paused = [];
		const server = await serve({ secure: true, onConnection: (socket) => recordPauseAtHandBack(socket, paused) });
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			const declined = wire('GET /a', [...H2C, `X-Pad: ${'p'.repeat(8000)}`]);
			const behind = (/** @type {number} */ pad) => wire('GET /b', [`X-Pad: ${'q'.repeat(pad)}`]);
			const record = declined + behind(16384 - declined.length - behind(0).length);
			expect(record.length).toBe(16384);
			const answers = await exchangeTimed(
				() => tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }),
				[[0, wire('GET /slow') + wire('GET /wide')], [50, record + wire('GET /c')]],
				5
			);
			expect(paused, 'the rest of the read was handed back while node had paused the connection').toEqual([true]);
			expect(shown(answers)).toEqual(['answered /slow', `wide ${64 * 1024}`, 'answered /a', 'answered /b', 'answered /c']);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it('returns its parser to the pool as node made it, with one close listener', async () => {
		/** @type {any} */ let parser;
		/** @type {Promise<unknown>} */ let closed = Promise.resolve();
		let baseline = 0;
		let added = -1;
		const server = await serve({
			onConnection: (socket) => {
				parser = /** @type {any} */ (socket).parser;
				closed = new Promise((resolve) => socket.once('close', resolve));
				baseline = socket.listenerCount('close');
			},
			// node adds one of its own for each in-flight response.
			onRequest: (req, socket) => {
				if (req.url === '/b') added = socket.listeners('close').filter((f) => f.name !== 'onServerResponseClose').length - baseline;
			}
		});
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			const answers = await pipelined(tcp(port), port, [
				{ lines: ['GET /a HTTP/1.1', ...H2C] },
				{ lines: ['GET /a2 HTTP/1.1', ...H2C] },
				{ lines: ['GET /a3 HTTP/1.1', ...H2C] },
				{ lines: ['GET /b HTTP/1.1'] }
			]);
			expect(bodies(answers)).toEqual(['answered /a', 'answered /a2', 'answered /a3', 'answered /b', 'answered /healthz']);
			expect(added, 'three declines on one connection add one close listener').toBe(1);
			await closed;
			expect(Object.hasOwn(parser, 'execute'), 'node pools the parser; it must go back as node made it').toBe(false);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it('returns the parser clean when a paused connection is destroyed before node resumes it', async () => {
		/** @type {any} */ let parser;
		/** @type {Promise<unknown>} */ let closed = Promise.resolve();
		/** @type {boolean[]} */
		const paused = [];
		const server = await serve({
			onConnection: (socket) => {
				parser = /** @type {any} */ (socket).parser;
				closed = new Promise((resolve) => socket.once('close', resolve));
				recordPauseAtHandBack(socket, paused);
			}
		});
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			const socket = net.connect(port, '127.0.0.1');
			socket.on('error', () => {});
			await new Promise((resolve) => socket.once('connect', resolve));
			socket.write(wire('GET /slow') + wire('GET /wide'));
			await new Promise((resolve) => setTimeout(resolve, 50));
			socket.write(wire('GET /a', H2C) + wire('GET /b'));
			await new Promise((resolve) => setTimeout(resolve, 80));
			// Well before the slow answer, so node never resumes the connection.
			server.closeAllConnections();
			await closed;
			socket.destroy();
			expect(paused).toEqual([true]);
			expect(Object.hasOwn(parser, 'execute')).toBe(false);
		} finally {
			server.close();
		}
	});

	it('resumes on a connection something else moved to the JS read path', async () => {
		const server = await serve({ onConnection: (socket) => { socket.on('data', () => {}); } });
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			const answers = await pipelined(tcp(port), port, [
				{ lines: ['POST /p HTTP/1.1', ...H2C, 'Content-Length: 5'], body: 'hello' },
				{ lines: ['GET /b HTTP/1.1'] }
			], { splitAfter: '\r\n\r\nhe' });
			expect(bodies(answers)).toEqual(['answered /p', 'answered /b', 'answered /healthz']);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it('hands a later handshake on such a connection its own bytes, its parser unwrapped', async () => {
		// The declined request ends in node's own execute there, so it stays on
		// record; the handshake in the next read must still stop the parse. The
		// bytes after the handshake read as the start of a request, which a
		// parse carried on past the handshake would take from its head.
		const after = 'GET /x HTTP/1.1\r\n';
		/** @type {any} */ let parser;
		/** @type {string[]} */
		const heads = [];
		/** @type {boolean[]} */
		const wrappedAtUpgrade = [];
		const server = await serve({
			onConnection: (socket) => {
				socket.on('data', () => {});
				parser = /** @type {any} */ (socket).parser;
			},
			onUpgrade: (req, socket, head) => {
				heads.push(head.toString('latin1'));
				wrappedAtUpgrade.push(Object.hasOwn(parser, 'execute'));
				socket.destroy();
			}
		});
		try {
			const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
			// The upgrade listener ends the socket without an answer, so the
			// exchange ends on that close with one answer.
			const answers = await exchangeTimed(tcp(port), [
				[0, wire('GET /a', H2C)],
				[100, wire('GET /ws', HANDSHAKE) + after]
			], 2);
			expect(bodies(answers)).toEqual(['answered /a']);
			expect(heads).toEqual([after]);
			expect(wrappedAtUpgrade, 'node frees the parser into its pool for the upgrade').toEqual([false]);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});

describe('resumeAfterDeclinedUpgrade', () => {
	const kOnExecute = createRequire(import.meta.url)('_http_common').HTTPParser.kOnExecute;

	/** @param {{ upgrade: boolean }} incoming */
	function consumed(incoming) {
		const onExecute = vi.fn();
		const parser = { _consumed: true, [kOnExecute]: onExecute, incoming, getCurrentBuffer: () => Buffer.from('abcd') };
		const socket = { parser, unshift: vi.fn(), on: vi.fn(), removeListener: vi.fn(), once: vi.fn() };
		const req = { socket, complete: true };
		return { req, socket, parser, onExecute };
	}

	it('does nothing for a request whose socket has no parser', () => {
		expect(() => resumeAfterDeclinedUpgrade(/** @type {any} */ ({ socket: { parser: null } }))).not.toThrow();
	});

	it('hands the rest of the read back after the declined request, once', () => {
		const { req, socket, parser, onExecute } = consumed({ upgrade: false });
		resumeAfterDeclinedUpgrade(/** @type {any} */ (req));
		/** @type {any} */ (parser)[kOnExecute](1);
		expect(socket.unshift).toHaveBeenCalledTimes(1);
		expect(socket.unshift.mock.calls[0][0].toString()).toBe('bcd');
		expect(onExecute).toHaveBeenCalledWith(1);
		expect(/** @type {any} */ (parser)[kOnExecute]).toBe(onExecute);
	});

	it('waits for the read in which the declined request ends', () => {
		const { req, socket, parser, onExecute } = consumed({ upgrade: false });
		req.complete = false;
		resumeAfterDeclinedUpgrade(/** @type {any} */ (req));
		const hook = /** @type {any} */ (parser)[kOnExecute];
		hook(4);
		expect(socket.unshift).not.toHaveBeenCalled();
		expect(onExecute).toHaveBeenCalledWith(4);
		expect(/** @type {any} */ (parser)[kOnExecute]).toBe(hook);
		req.complete = true;
		hook(2);
		expect(socket.unshift.mock.calls[0][0].toString()).toBe('cd');
		expect(/** @type {any} */ (parser)[kOnExecute]).toBe(onExecute);
	});

	it('leaves a read that ended on an upgrade node took to node', () => {
		const { req, socket, parser, onExecute } = consumed({ upgrade: true });
		resumeAfterDeclinedUpgrade(/** @type {any} */ (req));
		/** @type {any} */ (parser)[kOnExecute](1);
		expect(socket.unshift).not.toHaveBeenCalled();
		expect(onExecute).toHaveBeenCalledWith(1);
	});

	it('hands nothing back when the declined request ended the read', () => {
		const { req, socket, parser } = consumed({ upgrade: false });
		resumeAfterDeclinedUpgrade(/** @type {any} */ (req));
		/** @type {any} */ (parser)[kOnExecute](4);
		expect(socket.unshift).not.toHaveBeenCalled();
	});
});
