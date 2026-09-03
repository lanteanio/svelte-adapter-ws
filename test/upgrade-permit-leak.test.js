// A connection permit is a whole-lifetime reservation: taken at the handshake,
// held on the connection, handed back at close. The dangerous shape is a
// handshake that takes one and then never becomes a connection, because
// nothing is left to hand it back and the ceiling shrinks for the life of the
// process.
//
// The lead cannot reach this. Its accept primitive either opens the connection
// or throws, so marking the transfer around the call is sound there. The `ws`
// library has a THIRD outcome: for a non-GET, a missing or malformed
// Sec-WebSocket-Key, a version other than 8 or 13, a rejected shouldHandle, an
// unparseable subprotocol or a bad permessage-deflate offer, it answers the
// peer itself and returns, calling nothing and throwing nothing.
//
// Every case below is reachable by an unauthenticated peer with no hook
// configured, which is what makes an unreturned permit a denial of service
// rather than an accounting slip.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawUpgrade } from './helpers/raw-upgrade.js';

const BASE_WS_OPTS = {
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
	unsafeSameOriginWithoutHostPin: false
};

async function bootWithAdmission(upgradeAdmission, extraWsOpts = {}) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, ...extraWsOpts, upgradeAdmission })
		},
		wsHandlerSource: '// no handler\n'
	});
	const rt = await bootRuntime(payload);
	return { ...rt, cleanup: async () => { await rt.close(); payload.cleanup(); } };
}


/** Does a legitimate client still get in? */
function healthyHandshake(port, headers) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, headers ? { headers } : undefined);
		let settled = false;
		const done = (v) => { if (!settled) { settled = true; resolve(v); } };
		ws.on('open', () => { ws.close(); done({ opened: true, status: null }); });
		ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }));
		ws.on('error', () => done({ opened: false, status: null }));
	});
}

describe('a handshake that never becomes a connection returns its permit', () => {
	it('survives handshakes the ws library answers itself, which call nothing and throw nothing', async () => {
		const rt = await bootWithAdmission({ maxConnections: 2 });
		try {
			// Two permits' worth of malformed handshakes. Each is answered 400
			// by ws before our accept callback would have run.
			for (let i = 0; i < 2; i++) {
				const status = await rawUpgrade(rt.port, [
					'GET /ws HTTP/1.1',
					`Host: 127.0.0.1:${rt.port}`,
					'Upgrade: websocket',
					'Connection: Upgrade',
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version: 7'
				]);
				expect(status).toContain('400');
			}
			// If those took permits, the ceiling is now exhausted for good.
			const healthy = await healthyHandshake(rt.port);
			expect(healthy.status).not.toBe(503);
			expect(healthy.opened).toBe(true);
		} finally {
			await rt.cleanup();
		}
	}, 60000);

	it('survives a non-GET on the websocket path, refused the same silent way', async () => {
		const rt = await bootWithAdmission({ maxConnections: 1 });
		try {
			await rawUpgrade(rt.port, [
				'POST /ws HTTP/1.1',
				`Host: 127.0.0.1:${rt.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'Content-Length: 0'
			]);
			const healthy = await healthyHandshake(rt.port);
			expect(healthy.status).not.toBe(503);
			expect(healthy.opened).toBe(true);
		} finally {
			await rt.cleanup();
		}
	}, 60000);

	it('still hands the permit back on an ordinary close, so the fix did not just stop counting', async () => {
		const rt = await bootWithAdmission({ maxConnections: 1 });
		try {
			// One at a time, three times over: if close stopped returning the
			// permit, the second attempt would be refused.
			for (let i = 0; i < 3; i++) {
				const healthy = await healthyHandshake(rt.port);
				expect(healthy.opened, `attempt ${i}`).toBe(true);
				await new Promise((r) => setTimeout(r, 60));
			}
		} finally {
			await rt.cleanup();
		}
	}, 60000);
});

// The in-flight slot is the other half of the same accounting. Every refusal
// between taking the slot and accepting has to give it back, and each of those
// returns sits on its own branch - so one deleted release is invisible until a
// ceiling stops recovering under exactly that kind of traffic.
//
// The end-to-end case here proves the branch answers 400 and that the gate
// recovers; the branch-local release is pinned in the stub-socket block below,
// because over a real socket the abandoned-handshake listener would return the
// slot on its own.
describe('a refused upgrade returns the in-flight slot', () => {
	it('recovers after a handshake refused on the duplicate-header branch', async () => {
		const rt = await bootWithAdmission({ maxConcurrent: 1 });
		try {
			// A repeated singleton header is refused before the accept, on a
			// different branch from the malformed handshakes above. Content-Type
			// rather than Content-Length: node's own parser answers a repeated
			// Content-Length itself, so a handshake carrying one never reaches
			// the adapter and proves nothing about this branch.
			const dup = await rawUpgrade(rt.port, [
				'GET /ws HTTP/1.1',
				`Host: 127.0.0.1:${rt.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'Content-Type: text/plain',
				'Content-Type: text/plain'
			]);
			expect(dup).toContain('400');

			// The slot came back, so the single concurrent handshake is free.
			const healthy = await healthyHandshake(rt.port);
			expect(healthy.status).not.toBe(503);
			expect(healthy.opened).toBe(true);
		} finally {
			await rt.cleanup();
		}
	}, 60000);
});

// Over a real socket every refusal ends in socket.destroy(), node emits
// 'close' on the next tick, and the abandoned-handshake listener an armed gate
// installs hands the slot back regardless of what the branch itself did. So an
// end-to-end refusal cannot tell a working branch from a deleted one. These
// drive the upgrade listener directly over a socket stub that destroys without
// emitting anything: with no 'close' there is no backstop, and the branch's own
// release is the only thing that can free the slot.
//
// The follow-up probe on every case is a duplicate-header handshake rather than
// a healthy one, because that branch is checked before both the rate limiter
// and the origin policy and consumes no rate-limit token - so the probe reads
// the same under every configuration below. Its answer is the assertion: 400
// means the slot came back, 503 means the previous refusal kept it.

/** A socket that records what was written and dies quietly. */
function stubSocket({ destroyed = false } = {}) {
	const socket = new EventEmitter();
	socket.destroyed = destroyed;
	socket.written = '';
	socket.write = (chunk) => { socket.written += String(chunk); return true; };
	socket.destroy = () => { socket.destroyed = true; };
	return socket;
}

function statusLine(socket) {
	return socket.written.split('\r\n')[0];
}

const HANDSHAKE_HEADERS = [
	['Host', '127.0.0.1'],
	['Upgrade', 'websocket'],
	['Connection', 'Upgrade'],
	['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
	['Sec-WebSocket-Version', '13']
];

const DUPLICATE_HEADERS = [...HANDSHAKE_HEADERS, ['Content-Length', '0'], ['Content-Length', '0']];

/** The upgrade listener's view of a request: raw pairs plus the joined bag. */
function upgradeRequest(headerPairs) {
	/** @type {string[]} */
	const rawHeaders = [];
	/** @type {Record<string, string>} */
	const headers = {};
	for (const [name, value] of headerPairs) {
		rawHeaders.push(name, value);
		headers[name.toLowerCase()] = value;
	}
	return {
		method: 'GET',
		url: '/ws',
		rawHeaders,
		headers,
		socket: { remoteAddress: '127.0.0.1' }
	};
}

/**
 * Boot a payload and hand back its upgrade listener. The port is never dialed -
 * every drive below hands the listener a socket stub directly - but the server
 * still has to reach `ready`, because an upgrade arriving before that is
 * refused as draining, ahead of every branch under test.
 */
async function bootRealtime(wsOptions, wsHandlerSource) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: wsHandlerSource ?? '// no handler\n'
	});
	const rt = await bootRuntime(payload);
	return {
		realtime: rt.handler.realtime,
		cleanup: async () => { await rt.close(); payload.cleanup(); }
	};
}

/** One drive of the upgrade listener over a fresh stub. */
async function drive(realtime, headerPairs, socketOptions) {
	const socket = stubSocket(socketOptions);
	await realtime.handleUpgrade(upgradeRequest(headerPairs), socket, Buffer.alloc(0));
	return socket;
}

describe('every refusal branch returns the in-flight slot on its own', () => {
	it('returns it after the duplicate-header 400', async () => {
		const rt = await bootRealtime({ upgradeAdmission: { maxConcurrent: 1 } });
		try {
			const refused = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(refused)).toContain('400');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	});

	it('returns it after the per-IP rate-limit 429', async () => {
		// A positive ceiling is what arms the limiter at all: `upgradeRateLimit: 0`
		// disables it, so the branch is unreachable at the suite's usual value.
		// The limiter refuses only once a window's worth of upgrades has been
		// counted, and only a request that reaches it is counted - so the first
		// drive spends the single token. It arrives on an already-dead socket,
		// which is answered and released without writing anything.
		const rt = await bootRealtime({
			upgradeRateLimit: 1,
			upgradeAdmission: { maxConcurrent: 1 }
		});
		try {
			const spent = await drive(rt.realtime, HANDSHAKE_HEADERS, { destroyed: true });
			expect(spent.written).toBe('');

			const refused = await drive(rt.realtime, HANDSHAKE_HEADERS);
			expect(statusLine(refused)).toContain('429');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	});

	it('returns it after the origin 403', async () => {
		const rt = await bootRealtime({
			allowedOrigins: ['http://allowed.example'],
			upgradeAdmission: { maxConcurrent: 1 }
		});
		try {
			const refused = await drive(rt.realtime, [
				...HANDSHAKE_HEADERS,
				['Origin', 'http://evil.example']
			]);
			expect(statusLine(refused)).toContain('403');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	});

	it('returns it after the upgrade-hook deadline 504', async () => {
		const rt = await bootRealtime(
			{ upgradeTimeout: 1, upgradeAdmission: { maxConcurrent: 1 } },
			'export function upgrade() { return new Promise(() => {}); }\n'
		);
		try {
			const refused = await drive(rt.realtime, HANDSHAKE_HEADERS);
			expect(statusLine(refused)).toContain('504');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	}, 30000);

	it('returns it after the upgrade-hook 401', async () => {
		const rt = await bootRealtime(
			{ upgradeAdmission: { maxConcurrent: 1 } },
			'export function upgrade() { return false; }\n'
		);
		try {
			const refused = await drive(rt.realtime, HANDSHAKE_HEADERS);
			expect(statusLine(refused)).toContain('401');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	});

	it('returns it after the upgrade-hook 500', async () => {
		const rt = await bootRealtime(
			{ upgradeAdmission: { maxConcurrent: 1 } },
			"export function upgrade() { throw new Error('hook boom'); }\n"
		);
		try {
			const refused = await drive(rt.realtime, HANDSHAKE_HEADERS);
			expect(statusLine(refused)).toContain('500');

			const probe = await drive(rt.realtime, DUPLICATE_HEADERS);
			expect(statusLine(probe)).toContain('400');
			expect(statusLine(probe)).not.toContain('503');
		} finally {
			await rt.cleanup();
		}
	});
});
