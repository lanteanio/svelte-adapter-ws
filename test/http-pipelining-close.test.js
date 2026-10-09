// A request parsed while an earlier one on the same connection is still
// waiting for its answer closes the connection, as the family's native tier
// does: neither gets a byte that was not already on the wire, the waiting one
// sees its client go, and the one behind it never reaches a route. On the
// BUILT runtime and on createTestServer, over raw sockets. Requests that are
// each answered before the next is parsed are all served, and a request whose
// head has not ended yet changes nothing.

import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

const HANDSHAKE = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';

/** Counts the application's upgrade hook. */
const WS_HANDLER = 'export function message() {}\n' +
	'export function upgrade() { globalThis.__pipelineUpgrades = (globalThis.__pipelineUpgrades ?? 0) + 1; return {}; }\n';

/** @param {string} target @param {string} [extra] */
const get = (target, extra = '') => `GET ${target} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;

/**
 * Writes in order, each after its delay; resolves with everything that came
 * back, whether the server ended the connection, and when.
 *
 * @param {number} port
 * @param {Array<[number, string]>} writes
 * @param {number} [wait]
 * @returns {Promise<{ raw: string, closed: boolean, ms: number }>}
 */
function converse(port, writes, wait = 1500) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		const started = Date.now();
		let raw = '';
		let done = false;
		const finish = (/** @type {boolean} */ closed) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ raw, closed, ms: Date.now() - started });
		};
		const timer = setTimeout(() => finish(false), wait);
		socket.on('connect', () => {
			for (const [at, text] of writes) {
				setTimeout(() => { if (!socket.destroyed && socket.writable) socket.write(text); }, at);
			}
		});
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('end', () => finish(true));
		socket.on('error', () => finish(true));
	});
}

/** @param {string} raw */
const statusLines = (raw) => raw.match(/HTTP\/1\.1 \d{3}[^\r]*/g) ?? [];

describe('the built runtime', () => {
	/** @type {any} */ let open;
	/** @type {{ inFlightCount: number }} */ let counters;

	beforeAll(async () => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: WS_HANDLER
		});
		open = { payload, rt: await bootRuntime(payload) };
		({ counters } = await import(pathToFileURL(path.join(payload.dir, 'handler', 'state.js')).href));
	}, 60000);

	afterAll(async () => {
		await open?.rt.close();
		open?.payload.cleanup();
	});

	/** Every exchange the runtime counted has been settled. */
	async function expectNothingInFlight() {
		for (let i = 0; i < 50 && counters.inFlightCount !== 0; i++) await new Promise((r) => setTimeout(r, 20));
		expect(counters.inFlightCount, 'no exchange is left counted').toBe(0);
	}

	it('closes without an answer when a request is parsed behind one still waiting, in one write or a later one', async () => {
		for (const [label, writes] of /** @type {Array<[string, Array<[number, string]>]>} */ ([
			['one write', [[0, get('/api/slow') + get('/api/tiny')]]],
			['a later write', [[0, get('/api/slow')], [50, get('/api/tiny')]]],
			['behind a POST with its body', [[0, 'POST /api/slow HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello' + get('/api/tiny')]]],
			['behind a request that closes the connection', [[0, get('/api/slow', 'Connection: close\r\n') + get('/api/tiny')]]]
		])) {
			const { raw, closed, ms } = await converse(open.rt.port, writes);
			expect(raw, label + ': neither is answered').toBe('');
			expect(closed, label + ': the server closed the connection').toBe(true);
			expect(ms, label + ': before the waiting answer was due').toBeLessThan(250);
		}
		await expectNothingInFlight();
	});

	it('answers requests that are each answered before the next is parsed', async () => {
		const sync = await converse(open.rt.port, [[0, get('/healthz') + get('/healthz', 'Connection: close\r\n')]]);
		expect(statusLines(sync.raw)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		// The native tier reads the next request once the turn the one ahead
		// was handed over in has run its ticks and microtasks; a render that
		// needs no more than that has answered by then.
		const turn = await converse(open.rt.port, [[0, get('/api/tiny') + get('/api/tiny') + get('/healthz', 'Connection: close\r\n')]]);
		expect(statusLines(turn.raw)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		// The next request goes out once the waiting answer has arrived.
		const after = await new Promise((resolve) => {
			const socket = net.connect(open.rt.port, '127.0.0.1');
			let raw = '';
			let followed = false;
			socket.on('connect', () => socket.write(get('/api/slow')));
			socket.on('data', (chunk) => {
				raw += chunk.toString('latin1');
				if (!followed && raw.includes('slow-done')) {
					followed = true;
					socket.write(get('/api/tiny', 'Connection: close\r\n'));
				}
			});
			socket.on('end', () => resolve(raw));
			socket.on('error', () => resolve(raw));
			setTimeout(() => { socket.destroy(); resolve(raw); }, 3000);
		});
		expect(statusLines(/** @type {string} */ (after))).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
		expect(after).toContain('ok');
	});

	it('never runs a request behind an answer that ends the connection', async () => {
		// A 505 on an HTTP/1.0 keep-alive request, and the 400 for a framing
		// header that ends the connection: node parses on past each, the native
		// tier does not.
		for (const [label, ahead, status] of /** @type {Array<[string, string, string]>} */ ([
			['behind a 505', 'GET /api/counted HTTP/1.0\r\nConnection: keep-alive\r\n\r\n', 'HTTP/1.1 505 HTTP Version Not Supported'],
			['behind a framing 400', 'POST /api/counted HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n', 'HTTP/1.1 400 Bad Request']
		])) {
			const before = /** @type {any} */ (globalThis).__renders ?? 0;
			const { raw, closed } = await converse(open.rt.port, [[0, ahead + get('/api/counted')]]);
			expect(statusLines(raw), label).toEqual([status]);
			expect(closed, label).toBe(true);
			await new Promise((r) => setTimeout(r, 200));
			expect(/** @type {any} */ (globalThis).__renders ?? 0, label + ': the request behind it never ran').toBe(before);
		}
		const upgrades = /** @type {any} */ (globalThis).__pipelineUpgrades ?? 0;
		const handshake = await converse(open.rt.port, [[0, 'GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n' + get('/ws', HANDSHAKE)]]);
		expect(statusLines(handshake.raw), 'a handshake behind the 505').toEqual(['HTTP/1.1 505 HTTP Version Not Supported']);
		expect(/** @type {any} */ (globalThis).__pipelineUpgrades ?? 0).toBe(upgrades);
		await expectNothingInFlight();
	});

	it('waits for the head of the request behind before closing', async () => {
		// Its head never ends, so it is never parsed: the waiting answer goes out.
		const { raw } = await converse(open.rt.port, [[0, get('/api/slow') + 'GET /api/tiny HTTP/1.1\r\nHost: x\r\n']], 800);
		expect(statusLines(raw)).toEqual(['HTTP/1.1 200 OK']);
		expect(raw).toContain('slow-done');
	});

	it('keeps what a streaming answer already sent, then closes', async () => {
		// The event stream sends two events and stays open.
		const { raw, closed } = await converse(open.rt.port, [[0, get('/api/sse')], [150, get('/api/tiny')]]);
		expect(statusLines(raw)).toEqual(['HTTP/1.1 200 OK']);
		expect(raw).toContain('data: 1');
		expect(raw).toContain('data: 2');
		expect(raw.endsWith('0\r\n\r\n'), 'no terminal chunk').toBe(false);
		expect(closed).toBe(true);
		await expectNothingInFlight();
	});

	it('closes behind a waiting request on a WebSocket handshake too, without running the upgrade hook', async () => {
		const before = /** @type {any} */ (globalThis).__pipelineUpgrades ?? 0;
		const { raw, closed } = await converse(open.rt.port, [[0, get('/api/slow') + get('/ws', HANDSHAKE)]]);
		expect(raw).toBe('');
		expect(closed).toBe(true);
		expect(/** @type {any} */ (globalThis).__pipelineUpgrades ?? 0).toBe(before);
	});

	it('leaves nothing counted in flight after such a close', async () => {
		// A queued exchange that was counted and never ended would hold a
		// shutdown's drain to its budget.
		await converse(open.rt.port, [[0, get('/api/slow') + get('/api/tiny')]]);
		await expectNothingInFlight();
		const started = Date.now();
		expect(await open.rt.handler.shutdown({ timeoutMs: 2000 }), 'nothing was left in flight').toBe(true);
		expect(Date.now() - started, 'the drain did not wait out its budget').toBeLessThan(1500);
	});
});

describe('createTestServer', () => {
	/** @type {any} */ let mirror;
	let adminRuns = 0;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({
			handler: {
				admin: async () => {
					adminRuns++;
					await new Promise((r) => setTimeout(r, 300));
					return new Response('slow-done');
				}
			}
		});
	});

	afterAll(async () => {
		await mirror?.close();
	});

	it('closes without an answer when a request is parsed behind one still waiting', async () => {
		const { raw, closed, ms } = await converse(mirror.port, [[0, get('/__realtime/status') + get('/healthz')]]);
		expect(raw).toBe('');
		expect(closed).toBe(true);
		expect(ms).toBeLessThan(250);
		expect(adminRuns, 'the waiting request did run').toBe(1);
	});

	it('answers requests that are each answered before the next is parsed', async () => {
		const { raw } = await converse(mirror.port, [[0, get('/healthz') + get('/healthz', 'Connection: close\r\n')]]);
		expect(statusLines(raw)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
	});

	it('closes behind a waiting request on a WebSocket handshake too, and upgrades behind an answered one', async () => {
		const behindWaiting = await converse(mirror.port, [[0, get('/__realtime/status') + get('/ws', HANDSHAKE)]]);
		expect(behindWaiting.raw).toBe('');
		expect(behindWaiting.closed).toBe(true);
		const behindAnswered = await converse(mirror.port, [[0, get('/healthz') + get('/ws', HANDSHAKE)]], 600);
		expect(statusLines(behindAnswered.raw)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 101 Switching Protocols']);
	});
});
