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

import net from 'node:net';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

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

/** A raw handshake ws will refuse itself, answered without our callback running. */
function rawUpgrade(port, lines) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(lines.join('\r\n') + '\r\n\r\n');
		});
		let data = '';
		socket.on('data', (chunk) => { data += chunk.toString(); });
		const done = () => resolve(data.split('\r\n')[0] || '');
		socket.on('close', done);
		socket.on('error', () => resolve(''));
		setTimeout(() => { socket.destroy(); done(); }, 1500);
	});
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
describe('a refused upgrade returns the in-flight slot', () => {
	it('recovers after a handshake refused on the duplicate-header branch', async () => {
		const rt = await bootWithAdmission({ maxConcurrent: 1 });
		try {
			// A repeated singleton header is refused before the accept, on a
			// different branch from the malformed handshakes above.
			const dup = await rawUpgrade(rt.port, [
				'GET /ws HTTP/1.1',
				`Host: 127.0.0.1:${rt.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'Content-Length: 0',
				'Content-Length: 0'
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
