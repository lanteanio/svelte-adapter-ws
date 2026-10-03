// Which requests the WebSocket route takes, on the BUILT runtime and on
// createTestServer, over raw sockets. The family's native tier routes a
// handshake to it on a GET to the WebSocket path whose key is 24 bytes long,
// and nothing else: a complete handshake on any other path, with any other
// method, or with a key of another length is an ordinary request. It is
// answered exactly as the same request without the upgrade headers, and the
// connection serves a request sent once that answer has arrived.

import net from 'node:net';
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

/** A request the connection must still answer after the one under test. */
const FOLLOW_UP = { lines: ['GET /healthz HTTP/1.1'] };

/**
 * @typedef {{ status: string, lines: string[], body: string }} Answer
 * @typedef {{ lines: string[], body?: string }} Ask
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
 * Requests in order on one connection, each sent once the previous one is
 * answered, until every one is answered or the server hangs up.
 *
 * @param {number} port
 * @param {Ask[]} asks
 * @returns {Promise<Answer[]>}
 */
function exchange(port, asks) {
	const methods = asks.map((a) => a.lines[0].slice(0, a.lines[0].indexOf(' ')));
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		let raw = '';
		let sent = 0;
		let done = false;
		const send = () => {
			const ask = asks[sent++];
			socket.write([...ask.lines, `Host: 127.0.0.1:${port}`].join('\r\n') + '\r\n\r\n' + (ask.body ?? ''));
		};
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(parseAnswers(raw, methods));
		};
		const timer = setTimeout(finish, 3000);
		socket.on('connect', send);
		socket.on('data', (chunk) => {
			raw += chunk.toString('latin1');
			const answered = parseAnswers(raw, methods);
			if (answered.length === asks.length || answered.at(-1)?.status === '101') finish();
			else if (answered.length === sent) send();
		});
		socket.on('end', finish);
		socket.on('error', (err) => {
			if (/** @type {any} */ (err).code === 'ECONNRESET') { finish(); return; }
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * What a client can compare between two answers: everything but the clock.
 *
 * @param {Answer} answer
 */
const comparable = (answer) => ({
	status: answer.status,
	lines: answer.lines.filter((l) => !l.startsWith('date:')),
	body: answer.body
});

/**
 * The request, sent with a complete handshake and without, is answered the
 * same both ways, and its connection answers the next request.
 *
 * @param {number} port
 * @param {string[]} lines request line and any headers of its own
 * @param {string[]} [handshake] the upgrade headers added to the second send
 * @returns {Promise<Answer>} the answer to the handshake
 */
async function expectOrdinary(port, lines, handshake = HANDSHAKE) {
	const plain = await exchange(port, [{ lines }, FOLLOW_UP]);
	const asked = await exchange(port, [{ lines: [...lines, ...handshake] }, FOLLOW_UP]);
	expect(plain, 'the control is answered and keeps its connection').toHaveLength(2);
	expect(asked.length, 'the connection answers the request after the handshake').toBe(2);
	expect(comparable(asked[0])).toEqual(comparable(plain[0]));
	expect(asked[1].status).toBe('200');
	return asked[0];
}

/** @param {Record<string, unknown>} wsOptions */
async function boot(wsOptions) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: 'export function message() {}\n',
		files: { 'client/asset.txt': 'asset' }
	});
	return { payload, rt: await bootRuntime(payload) };
}

/** @type {any} */ let open;
/** @type {any} */ let ceiling;

beforeAll(async () => {
	open = await boot({});
	ceiling = await boot({ upgradeAdmission: { maxConcurrent: 10, waitingRoom: {} } });
}, 60000);

afterAll(async () => {
	for (const built of [open, ceiling]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

describe('the built runtime takes a handshake on a GET to the WebSocket path only', () => {
	it('opens one there, query and all', async () => {
		const [answer] = await exchange(open.rt.port, [{ lines: ['GET /ws?x=1 HTTP/1.1', ...HANDSHAKE] }]);
		expect(answer?.status).toBe('101');
	});

	it('serves the liveness probe', async () => {
		const answer = await expectOrdinary(open.rt.port, ['GET /healthz HTTP/1.1']);
		expect(answer.status).toBe('200');
		expect(answer.body).toBe('OK');
	});

	it('serves a built asset', async () => {
		const answer = await expectOrdinary(open.rt.port, ['GET /asset.txt HTTP/1.1']);
		expect(answer.status).toBe('200');
		expect(answer.body).toBe('asset');
	});

	it('refuses a data request onto the probe as the request edge does', async () => {
		expect((await expectOrdinary(open.rt.port, ['GET /healthz/__data.json HTTP/1.1'])).status).toBe('400');
	});

	it('hands an application route to the application', async () => {
		expect((await expectOrdinary(open.rt.port, ['GET /api/tiny HTTP/1.1'])).body).toBe('ok');
	});

	it('hands a POST on the WebSocket path to the application', async () => {
		const answer = await expectOrdinary(open.rt.port, ['POST /ws HTTP/1.1', 'Content-Length: 0']);
		expect(answer.status).toBe('200');
		expect(answer.body).toBe('SSR:/ws');
	});

	it('hands a HEAD on the WebSocket path to the application', async () => {
		expect((await expectOrdinary(open.rt.port, ['HEAD /ws HTTP/1.1'])).status).toBe('200');
	});

	it('matches the path as spelled', async () => {
		expect((await expectOrdinary(open.rt.port, ['GET /ws/ HTTP/1.1'])).body).toBe('SSR:/ws/');
		expect((await expectOrdinary(open.rt.port, ['GET /WS HTTP/1.1'])).body).toBe('SSR:/WS');
	});

	it('refuses a dot segment onto the path while a ceiling answers its GETs', async () => {
		expect((await expectOrdinary(ceiling.rt.port, ['GET /x/../ws HTTP/1.1'])).status).toBe('400');
	});

	it('refuses a key of another length on the GET answer, keeping the connection', async () => {
		// The control is the key alone, which node never offers the upgrade
		// listener at all.
		for (const port of [open.rt.port, ceiling.rt.port]) {
			const answer = await expectOrdinary(port, ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: abc'],
				['Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13']);
			expect(answer.status).toBe('400');
			expect(answer.body).toBe('Bad Request');
		}
	});
});

describe('the built runtime mounts the WebSocket path and the waiting room for GET only', () => {
	it('answers a GET on each', async () => {
		const [upgrade, poll, room] = await exchange(ceiling.rt.port, [
			{ lines: ['GET /ws HTTP/1.1'] },
			{ lines: ['GET /__admit-check HTTP/1.1'] },
			{ lines: ['GET /__waiting-room HTTP/1.1'] }
		]);
		expect(upgrade?.status).toBe('426');
		expect(upgrade?.body).toBe('WebSocket upgrade required');
		expect(upgrade?.lines.filter((l) => !l.startsWith('date:'))).toEqual([
			'content-type: text/plain', 'content-length: 26', 'connection: keep-alive', 'keep-alive: timeout=5'
		]);
		expect(poll?.status).toBe('200');
		expect(room?.status).toBe('200');
		expect(room?.body).toContain('<html');
	});

	it('hands a HEAD on each to the application', async () => {
		for (const path of ['/ws', '/__admit-check', '/__waiting-room']) {
			const [head, get] = await exchange(open.rt.port, [{ lines: [`HEAD ${path} HTTP/1.1`] }, { lines: [`GET ${path} HTTP/1.1`] }]);
			const [ceilingHead] = await exchange(ceiling.rt.port, [{ lines: [`HEAD ${path} HTTP/1.1`] }]);
			expect(get?.body, 'the application answers the path without a ceiling').toBe('SSR:' + path);
			expect(comparable(/** @type {Answer} */ (ceilingHead)), path).toEqual(comparable(/** @type {Answer} */ (head)));
		}
	});
});

describe('createTestServer takes a handshake on a GET to the WebSocket path only', () => {
	/** @type {any} */ let mirror;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({ handler: { upgrade: () => ({}) } });
	});

	afterAll(async () => {
		await mirror?.close();
	});

	it('opens one there', async () => {
		const [answer] = await exchange(mirror.port, [{ lines: ['GET /ws?x=1 HTTP/1.1', ...HANDSHAKE] }]);
		expect(answer?.status).toBe('101');
	});

	it('answers everything else as the plain request', async () => {
		expect((await expectOrdinary(mirror.port, ['GET /healthz HTTP/1.1'])).body).toBe('OK');
		await expectOrdinary(mirror.port, ['GET /elsewhere HTTP/1.1']);
		await expectOrdinary(mirror.port, ['POST /ws HTTP/1.1', 'Content-Length: 0']);
		await expectOrdinary(mirror.port, ['HEAD /ws HTTP/1.1']);
		await expectOrdinary(mirror.port, ['GET /ws/ HTTP/1.1']);
	});

	it('refuses a key of another length on the GET answer, keeping the connection', async () => {
		const answer = await expectOrdinary(mirror.port, ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: abc'],
			['Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13']);
		expect(answer.status).toBe('400');
	});
});
