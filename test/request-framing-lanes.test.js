// Which lane refuses an ambiguously framed request, on the BUILT runtime and on
// createTestServer, over raw sockets. node's own parser refuses most framing
// shapes before any lane runs - an unknown or doubled coding, an empty or
// repeated Content-Length - so a probe built on one of those passes whether a
// lane is wired or not. Two shapes reach the runtime and are what this file
// drives: a coding list that ENDS in chunked, which node decodes as chunked
// and the one lookup in front of every lane refuses, and an EMPTY
// Transfer-Encoding, which that lookup reads as absent and every lane that
// builds a header set refuses. Both refusals end the connection; a repeated
// non-framing header is refused too and keeps it.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	metrics: './metrics.js',
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
	adminAuthAcknowledged: true,
	upgradeAdmission: { maxConcurrent: 10, waitingRoom: { admitCheckPath: '/__admit-check' } }
};

// Counts every counter series in a table the test reads back: the registry
// module is evaluated in this process, so the table is shared.
const REGISTRY_SRC = `
const table = globalThis.__framingCounts ??= new Map();
const noop = { inc() {}, set() {}, observe() {} };
export default {
	counter(name) {
		return {
			inc(labels) {
				const key = name + ' ' + JSON.stringify(labels ?? {});
				table.set(key, (table.get(key) || 0) + 1);
			}
		};
	},
	gauge() { return noop; },
	histogram() { return noop; },
	serialize() { return ''; }
};
`;

const WS_HANDLER = `
export function message() {}
export function authenticate() { return {}; }
export function admin() { return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); }
`;

/** @param {string} reason */
const rejected = (reason) => /** @type {Map<string, number>} */ (globalThis.__framingCounts)
	?.get('upgrade_rejected_total ' + JSON.stringify({ reason })) || 0;

/**
 * One request, the connection left open from this side: what came back and
 * whether the SERVER hung up within the grace window.
 *
 * @param {number} port
 * @param {string[]} lines request line and headers
 * @param {string} [body]
 */
function probe(port, lines, body = '') {
	const wire = [...lines, `Host: 127.0.0.1:${port}`].join('\r\n') + '\r\n\r\n' + body;
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(wire));
		let raw = '';
		let closedByServer = false;
		const timer = setTimeout(() => socket.destroy(), 1000);
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('end', () => { closedByServer = true; });
		socket.on('error', (err) => {
			if (/** @type {any} */ (err).code === 'ECONNRESET') { closedByServer = true; return; }
			clearTimeout(timer);
			reject(err);
		});
		socket.on('close', () => {
			clearTimeout(timer);
			const at = raw.indexOf('\r\n\r\n');
			const head = at < 0 ? raw : raw.slice(0, at);
			resolve({
				status: (head.match(/^HTTP\/1\.1 (\d{3})/) || [])[1],
				lines: head.split('\r\n').slice(1).map((l) => l.toLowerCase()),
				body: at < 0 ? '' : raw.slice(at + 4),
				closedByServer
			});
		});
	});
}

/**
 * Refused with 400, the connection ended by the server, and exactly one
 * `connection: close` line.
 *
 * @param {Awaited<ReturnType<typeof probe>>} answer
 */
function expectRefusedAndClosed(answer) {
	expect(answer.status).toBe('400');
	expect(answer.closedByServer, 'the server ends a connection it can no longer read').toBe(true);
	expect(answer.lines.filter((l) => l.replace(/ /g, '') === 'connection:close')).toHaveLength(1);
}

const LIST = 'Transfer-Encoding: gzip, chunked';
const CHUNKED_AA = '2\r\nAA\r\n0\r\n\r\n';
const HANDSHAKE = [
	'GET /ws HTTP/1.1',
	'Upgrade: websocket',
	'Connection: Upgrade',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
	'Sec-WebSocket-Version: 13'
];

/** @param {Record<string, unknown>} wsOptions */
async function boot(wsOptions) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: WS_HANDLER,
		metricsRegistrySource: REGISTRY_SRC,
		files: { 'client/asset.txt': 'asset' }
	});
	return { payload, rt: await bootRuntime(payload) };
}

/** @type {any} */ let open;
/** @type {any} */ let sieged;

beforeAll(async () => {
	open = await boot({});
	sieged = await boot({ protection: 'siege' });
}, 60000);

afterAll(async () => {
	for (const built of [open, sieged]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

describe('the built runtime refuses a coding list ending in chunked ahead of every lane', () => {
	const LANES = [
		['a built asset', ['GET /asset.txt HTTP/1.1']],
		['the liveness probe', ['GET /healthz HTTP/1.1']],
		['the readiness probe', ['GET /readyz HTTP/1.1']],
		['the non-upgrade answer on the WebSocket path', ['GET /ws HTTP/1.1']],
		['the waiting-room poll', ['GET /__admit-check HTTP/1.1']],
		['the authenticate endpoint', ['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest']],
		['the admin lane', ['GET /__realtime/introspect HTTP/1.1']],
		['an SSR route', ['POST /api/echo HTTP/1.1']]
	];
	for (const [name, lines] of LANES) {
		it(`on ${name}`, async () => {
			// The control: the same request framed plainly chunked is answered.
			const served = await probe(open.rt.port, [...lines, 'Transfer-Encoding: chunked'], CHUNKED_AA);
			expect(served.status, 'plain chunked is answered').not.toBe('400');
			expectRefusedAndClosed(await probe(open.rt.port, [...lines, LIST], CHUNKED_AA));
		});
	}
});

describe('every lane that builds a header set refuses an empty Transfer-Encoding', () => {
	it('on an SSR route', async () => {
		expectRefusedAndClosed(await probe(open.rt.port, ['GET /api/echo HTTP/1.1', 'Transfer-Encoding:']));
	});

	it('on the authenticate endpoint', async () => {
		expectRefusedAndClosed(await probe(open.rt.port, [
			'POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest', 'Transfer-Encoding:'
		]));
	});

	it('on the admin lane, through its own JSON writer', async () => {
		const answer = await probe(open.rt.port, ['GET /__realtime/introspect HTTP/1.1', 'Transfer-Encoding:']);
		expectRefusedAndClosed(answer);
		expect(answer.body).toBe('{"error":"bad request"}');
	});

	it('and the one lookup in front of them lets a built asset through', async () => {
		// The line the family draws: the lookup cannot tell an empty value from
		// an absent one, so a lane that builds no header set serves it.
		const answer = await probe(open.rt.port, ['GET /asset.txt HTTP/1.1', 'Transfer-Encoding:']);
		expect(answer.status).toBe('200');
	});
});

describe('a repeated non-framing header is refused and keeps its connection', () => {
	const TWO = ['Authorization: Bearer one', 'Authorization: Bearer two'];
	for (const [name, lines] of [
		['an SSR route', ['GET /api/echo HTTP/1.1']],
		['the authenticate endpoint', ['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest', 'Content-Length: 0']],
		['the admin lane', ['GET /__realtime/introspect HTTP/1.1']]
	]) {
		it(`on ${name}`, async () => {
			const answer = await probe(open.rt.port, [...lines, ...TWO]);
			expect(answer.status).toBe('400');
			expect(answer.closedByServer, 'nothing about it makes the connection unreadable').toBe(false);
			expect(answer.lines.some((l) => l.startsWith('connection: close'))).toBe(false);
		});
	}
});

describe('the handshake answers the framing question first, under its own reason', () => {
	it('ahead of the siege short-circuit', async () => {
		const before = { framing: rejected('ambiguous_framing'), siege: rejected('siege') };
		const plain = await probe(sieged.rt.port, HANDSHAKE);
		expect(plain.status, 'siege refuses every new upgrade').toBe('503');
		const framed = await probe(sieged.rt.port, [...HANDSHAKE, LIST], CHUNKED_AA);
		expect(framed.status, 'framing is answered before the posture').toBe('400');
		expect(framed.closedByServer).toBe(true);
		expect(rejected('ambiguous_framing') - before.framing).toBe(1);
		expect(rejected('siege') - before.siege).toBe(1);
	});

	it('names an empty Transfer-Encoding as framing, not as a duplicate', async () => {
		const before = { framing: rejected('ambiguous_framing'), duplicate: rejected('duplicate_header') };
		const answer = await probe(open.rt.port, [...HANDSHAKE, 'Transfer-Encoding:']);
		expect(answer.status).toBe('400');
		expect(rejected('ambiguous_framing') - before.framing).toBe(1);
		expect(rejected('duplicate_header') - before.duplicate).toBe(0);
	});

	it('names a repeated identity header as a duplicate', async () => {
		const before = { framing: rejected('ambiguous_framing'), duplicate: rejected('duplicate_header') };
		const answer = await probe(open.rt.port, [...HANDSHAKE, 'Authorization: Bearer one', 'Authorization: Bearer two']);
		expect(answer.status).toBe('400');
		expect(rejected('duplicate_header') - before.duplicate).toBe(1);
		expect(rejected('ambiguous_framing') - before.framing).toBe(0);
	});
});

describe('createTestServer mirrors the refusals', () => {
	/** @type {any} */ let mirror;
	/** @type {any} */ let siegedMirror;
	const counts = new Map();
	const metrics = {
		/** @param {string} name */
		counter(name) {
			return { inc(labels) { const k = name + ' ' + JSON.stringify(labels ?? {}); counts.set(k, (counts.get(k) || 0) + 1); } };
		},
		gauge() { return { set() {} }; },
		histogram() { return { observe() {} }; }
	};
	/** @param {string} reason */
	const mirrored = (reason) => counts.get('upgrade_rejected_total ' + JSON.stringify({ reason })) || 0;

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		const handler = {
			upgrade: () => ({}),
			admin: () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
		};
		mirror = await createTestServer({ metrics, handler });
		siegedMirror = await createTestServer({ metrics, handler, protection: 'siege', upgradeAdmission: { maxConcurrent: 50 } });
	});

	afterAll(async () => {
		await mirror?.close();
		await siegedMirror?.close();
	});

	it('refuses a coding list ending in chunked on a route answered from the method alone', async () => {
		const served = await probe(mirror.port, ['GET /healthz HTTP/1.1', 'Transfer-Encoding: chunked'], CHUNKED_AA);
		expect(served.status).toBe('200');
		expectRefusedAndClosed(await probe(mirror.port, ['GET /healthz HTTP/1.1', LIST], CHUNKED_AA));
	});

	it('refuses an empty Transfer-Encoding through the admin mirror and hangs up', async () => {
		const answer = await probe(mirror.port, ['GET /__realtime/introspect HTTP/1.1', 'Transfer-Encoding:']);
		expectRefusedAndClosed(answer);
		expect(answer.body).toBe('{"error":"bad request"}');
	});

	it('keeps the admin mirror connection for a repeated identity header', async () => {
		const answer = await probe(mirror.port, ['GET /__realtime/introspect HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two']);
		expect(answer.status).toBe('400');
		expect(answer.closedByServer).toBe(false);
	});

	it('answers the handshake framing question ahead of siege, under its own reason', async () => {
		const before = { framing: mirrored('ambiguous_framing'), siege: mirrored('siege') };
		expect((await probe(siegedMirror.port, HANDSHAKE)).status).toBe('503');
		const framed = await probe(siegedMirror.port, [...HANDSHAKE, LIST], CHUNKED_AA);
		expect(framed.status).toBe('400');
		expect(mirrored('ambiguous_framing') - before.framing).toBe(1);
		expect(mirrored('siege') - before.siege).toBe(1);
	});

	it('names an empty Transfer-Encoding on the handshake as framing', async () => {
		const before = { framing: mirrored('ambiguous_framing'), duplicate: mirrored('duplicate_header') };
		expect((await probe(mirror.port, [...HANDSHAKE, 'Transfer-Encoding:'])).status).toBe('400');
		expect(mirrored('ambiguous_framing') - before.framing).toBe(1);
		expect(mirrored('duplicate_header') - before.duplicate).toBe(0);
	});
});
