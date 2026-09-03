// The protection posture on the BUILT runtime: the production module graph,
// booted over a real socket.
//
// The harness carries its own posture machine, so a test that drives
// createTestServer proves the shared policy module and nothing about the
// wiring in src/runtime/handler/realtime.js. These cases go through the real
// request edge instead, which is the only thing that fails when a posture
// branch is dropped from the production upgrade path.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const WS_HANDLER = 'export function message() {}\n';

/** @param {Record<string, unknown>} wsOptions */
async function bootWith(wsOptions) {
	const payload = await buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: WS_HANDLER
	});
	const rt = await bootRuntime(payload);
	return { payload, rt };
}

/** A handshake the built runtime either upgrades or refuses. */
function upgradeStatus(port) {
	return rawUpgrade(port, [
		'GET /ws HTTP/1.1',
		'Host: 127.0.0.1',
		'Upgrade: websocket',
		'Connection: Upgrade',
		'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
		'Sec-WebSocket-Version: 13'
	]);
}

/** @type {any} */
let siege;
/** @type {any} */
let siegeGated;
/** @type {any} */
let normal;

beforeAll(async () => {
	// No upgradeAdmission at all: the posture must still refuse, because the
	// siege short-circuit runs before the gate is consulted.
	siege = await bootWith({ protection: 'siege' });
	// With a ceiling the waiting-room routes exist, which is where the
	// always-busy admit-check and the doubled poll interval are observable.
	siegeGated = await bootWith({
		protection: 'siege',
		upgradeAdmission: { maxConcurrent: 8, waitingRoom: { pollIntervalMs: 3000 } }
	});
	normal = await bootWith({});
}, 60000);

afterAll(async () => {
	for (const built of [siege, siegeGated, normal]) {
		if (!built) continue;
		await built.rt.close();
		built.payload.cleanup();
	}
});

describe('the protection posture on the built runtime', () => {
	it('refuses a handshake under siege with no ceiling configured', async () => {
		// The short-circuit takes no admission slot and does not need one to
		// exist: pinning siege is a deployment answer on its own.
		const line = await upgradeStatus(siege.rt.port);
		expect(line).toContain('503');
	});

	it('answers a navigation to the WebSocket path the same way it answers the handshake', async () => {
		// Without the posture test outside the armed guard this returns 426
		// 'upgrade required' and then refuses the upgrade it just asked for.
		const res = await fetch(`${siege.rt.origin}/ws`, { headers: { accept: 'text/html' } });
		expect(res.status).toBe(503);
		expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	it('opens the same handshake at the default posture', async () => {
		const line = await upgradeStatus(normal.rt.port);
		expect(line).toContain('101');
	});

	it('serves the upgrade hint at the default posture', async () => {
		const res = await fetch(`${normal.rt.origin}/ws`);
		expect(res.status).toBe(426);
		expect(res.headers.get('upgrade')).toBe('websocket');
	});

	it('keeps the admit-check busy under siege and thins its own poll rate', async () => {
		// hasCapacity() is true here - the gate has 8 free slots - so a poll
		// answering 202 can only be the posture, and the doubled interval is
		// the only lever the served page has on how often it comes back.
		const res = await fetch(`${siegeGated.rt.origin}/__admit-check`);
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.admit).toBe(false);
		expect(body.pollAfterMs).toBe(6000);
	});

	it('admits through the same poll endpoint at the default posture', async () => {
		const res = await fetch(`${normal.rt.origin}/__admit-check`);
		// An unconfigured gate mounts no room at all, so this belongs to the app.
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
	});
});
