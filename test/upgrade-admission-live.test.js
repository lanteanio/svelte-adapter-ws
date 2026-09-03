// The upgrade gate as production runs it: a real built payload, booted on a
// real port, driven over real sockets. The harness suites
// (upgrade-admission-wiring, upgrade-waiting-room) prove the same composition
// on createTestServer; this one proves the production upgrade listener and the
// HTTP routing spine carry it too, because those are separate code.
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

const BARE_503_BODY = 'Server is at upgrade capacity, please retry';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LIB_ACCEPT = 'application/json';

/**
 * Boot a payload whose WS_OPTIONS carry the given admission section.
 *
 * @param {Record<string, unknown>} upgradeAdmission
 * @param {{ wsHandlerSource?: string }} [options]
 */
async function bootWithAdmission(upgradeAdmission, options = {}) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...BASE_WS_OPTS, upgradeAdmission })
		},
		wsHandlerSource: options.wsHandlerSource ?? '// no handler\n'
	});
	const rt = await bootRuntime(payload);
	return {
		...rt,
		cleanup: async () => {
			await rt.close();
			payload.cleanup();
		}
	};
}

/**
 * One upgrade attempt. Resolves `opened` on a handshake, or the refusal's
 * status / headers / body when the server answered with plain HTTP instead.
 *
 * @param {number} port
 * @param {{ subprotocol?: string, headers?: Record<string, string> }} [options]
 */
function attemptUpgrade(port, options = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(
			`ws://127.0.0.1:${port}/ws`,
			options.subprotocol,
			options.headers ? { headers: options.headers } : undefined
		);
		const result = { opened: false, status: null, headers: null, body: '', ws };
		let settled = false;
		const done = () => { if (!settled) { settled = true; resolve(result); } };
		ws.on('open', () => { result.opened = true; done(); });
		ws.on('unexpected-response', (_req, res) => {
			result.status = res.statusCode;
			result.headers = res.headers;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => { result.body = Buffer.concat(chunks).toString('utf8'); done(); });
			res.on('error', () => { result.body = Buffer.concat(chunks).toString('utf8'); done(); });
		});
		ws.on('error', () => { if (!result.opened && result.status === null) done(); });
	});
}

/** @param {WebSocket} ws */
function closed(ws) {
	return new Promise((resolve) => { ws.once('close', resolve); ws.close(); });
}

describe('production upgrade admission', () => {
	it('holds a connection permit for the socket lifetime and hands it back on close', async () => {
		const rt = await bootWithAdmission({ maxConnections: 2 });
		try {
			const first = await attemptUpgrade(rt.port);
			const second = await attemptUpgrade(rt.port);
			expect(first.opened).toBe(true);
			expect(second.opened).toBe(true);

			// Both handshakes are over but their sockets are held: a
			// handshake-only counter would be zero here and admit a third.
			const crossed = await attemptUpgrade(rt.port);
			expect(crossed.opened).toBe(false);
			expect(crossed.status).toBe(503);
			expect(crossed.body).toBe(BARE_503_BODY);
			const retryAfter = Number(crossed.headers['retry-after']);
			expect(Number.isInteger(retryAfter)).toBe(true);
			expect(retryAfter).toBeGreaterThanOrEqual(2);

			// Closing frees exactly one permit; without the release on close
			// the ceiling would shrink until the process restarted.
			await closed(first.ws);
			const replacement = await attemptUpgrade(rt.port);
			expect(replacement.opened).toBe(true);

			second.ws.close();
			replacement.ws.close();
		} finally {
			await rt.cleanup();
		}
	});

	it('sheds a concurrent-handshake surplus while a slow upgrade hook holds the gate', async () => {
		const rt = await bootWithAdmission({ maxConcurrent: 2 }, {
			wsHandlerSource:
				'export async function upgrade() {\n' +
				'\tawait new Promise((r) => setTimeout(r, 120));\n' +
				'\treturn {};\n' +
				'}\n'
		});
		try {
			const results = await Promise.all(
				Array.from({ length: 12 }, () => attemptUpgrade(rt.port))
			);
			const shed = results.filter((r) => r.status === 503);
			const opened = results.filter((r) => r.opened);
			expect(shed.length).toBeGreaterThan(0);
			expect(opened.length).toBeGreaterThan(0);
			expect(opened.length + shed.length).toBe(results.length);
			for (const r of shed) expect(r.body).toBe(BARE_503_BODY);

			for (const r of results) { try { r.ws.close(); } catch { /* already gone */ } }
			// The gate is released once the burst settles: a quiet attempt
			// afterwards must open.
			await new Promise((r) => setTimeout(r, 200));
			const fresh = await attemptUpgrade(rt.port);
			expect(fresh.opened).toBe(true);
			fresh.ws.close();
		} finally {
			await rt.cleanup();
		}
	});

	it('sheds the cursor lane on its own sub-budget without starving the main lane', async () => {
		const rt = await bootWithAdmission(
			{ maxConcurrent: 8, cursorLane: { fraction: 0.25 } },
			{
				wsHandlerSource:
					'export async function upgrade() {\n' +
					'\tawait new Promise((r) => setTimeout(r, 120));\n' +
					'\treturn {};\n' +
					'}\n'
			}
		);
		try {
			const cursor = await Promise.all(Array.from({ length: 8 }, () =>
				attemptUpgrade(rt.port, { subprotocol: 'svelte-realtime-cursor' })
			));
			const shed = cursor.filter((r) => r.status === 503);
			expect(shed.length).toBeGreaterThan(0);
			// A cursor client is never a browser, so it never gets the page.
			for (const r of shed) {
				expect(r.body).toBe(BARE_503_BODY);
				expect(String(r.headers['content-type'])).toContain('text/plain');
			}
			for (const r of cursor) { try { r.ws.close(); } catch { /* already gone */ } }
		} finally {
			await rt.cleanup();
		}
	});

	it('serves the holding page, the poll endpoint and the WS-path navigation from the gate state', async () => {
		const rt = await bootWithAdmission({ maxConnections: 1 });
		try {
			// Below capacity: the poll admits and the WS path is the ordinary
			// upgrade-required hint.
			const idlePoll = await fetch(rt.origin + '/__admit-check');
			expect(idlePoll.status).toBe(200);
			expect(await idlePoll.json()).toEqual({ admit: true });
			const idleNav = await fetch(rt.origin + '/ws', { headers: { accept: HTML_ACCEPT } });
			expect(idleNav.status).toBe(426);
			await idleNav.text();

			// One held socket fills the single-permit gate.
			const held = await attemptUpgrade(rt.port);
			expect(held.opened).toBe(true);

			const fullPoll = await fetch(rt.origin + '/__admit-check');
			expect(fullPoll.status).toBe(202);
			expect(fullPoll.headers.get('cache-control')).toBe('no-store');
			const body = await fullPoll.json();
			expect(body.admit).toBe(false);
			expect(typeof body.queueDepth).toBe('number');
			expect(typeof body.estimatedSeconds).toBe('number');
			expect(typeof body.pollAfterMs).toBe('number');

			// Direct navigation to the room, and to the WS path itself, both
			// render the self-polling page wired to the poll endpoint.
			const page = await fetch(rt.origin + '/__waiting-room', { headers: { accept: HTML_ACCEPT } });
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			expect(await page.text()).toContain('/__admit-check');

			const navigation = await fetch(rt.origin + '/ws', { headers: { accept: HTML_ACCEPT } });
			expect(navigation.status).toBe(200);
			expect(navigation.headers.get('content-type')).toContain('text/html');
			expect(await navigation.text()).toContain('/__admit-check');

			// A library client on the same URL keeps the bare refusal.
			const plain = await fetch(rt.origin + '/ws', { headers: { accept: LIB_ACCEPT } });
			expect(plain.status).toBe(503);
			expect(Number.isInteger(Number(plain.headers.get('retry-after')))).toBe(true);
			expect(await plain.text()).toBe(BARE_503_BODY);

			// Polling never consumes a slot: after the held socket closes the
			// gate is fully back.
			await closed(held.ws);
			const replacement = await attemptUpgrade(rt.port);
			expect(replacement.opened).toBe(true);
			replacement.ws.close();
		} finally {
			await rt.cleanup();
		}
	});

	it('keeps one accessible document baseline when the waiting room is opted out', async () => {
		const rt = await bootWithAdmission({ maxConnections: 1, waitingRoom: false });
		try {
			const held = await attemptUpgrade(rt.port);
			expect(held.opened).toBe(true);

			// No room to poll: the route does not exist and the app answers.
			const poll = await fetch(rt.origin + '/__admit-check');
			expect(poll.status).not.toBe(202);
			await poll.text();

			const navigation = await fetch(rt.origin + '/ws', { headers: { accept: HTML_ACCEPT } });
			const document = await navigation.text();
			expect(navigation.status).toBe(503);
			expect(navigation.headers.get('content-type')).toContain('text/html');
			expect(navigation.headers.get('content-language')).toBe('en');
			expect(document).toMatch(/^<!doctype html><html lang="en" dir="ltr"/);
			expect(document).toContain('<title>Service unavailable</title>');
			expect(document).toContain('role="status"');
			expect(Number.isInteger(Number(navigation.headers.get('retry-after')))).toBe(true);

			// A real handshake with an HTML Accept still gets the bare 503.
			const handshake = await attemptUpgrade(rt.port, { headers: { accept: HTML_ACCEPT } });
			expect(handshake.status).toBe(503);
			expect(handshake.body).toBe(BARE_503_BODY);
			expect(String(handshake.headers['content-type'])).toContain('text/plain');

			held.ws.close();
		} finally {
			await rt.cleanup();
		}
	});

	it('leaves an unconfigured gate wide open and the WS path on its upgrade hint', async () => {
		const rt = await bootWithAdmission(undefined);
		try {
			const results = await Promise.all(Array.from({ length: 8 }, () => attemptUpgrade(rt.port)));
			expect(results.every((r) => r.opened)).toBe(true);
			for (const r of results) r.ws.close();

			const hint = await fetch(rt.origin + '/ws');
			expect(hint.status).toBe(426);
			await hint.text();

			// No ceiling means no room to resolve, so neither room route is
			// mounted and both paths belong to the app. The 426 above cannot
			// see this: the WS path answers it before it ever reads the room.
			const admit = await fetch(rt.origin + '/__admit-check');
			expect(admit.status).toBe(200);
			expect(String(admit.headers.get('content-type'))).toContain('text/html');
			expect(await admit.text()).toBe('SSR:/__admit-check');

			const room = await fetch(rt.origin + '/__waiting-room');
			expect(room.status).toBe(200);
			expect(String(room.headers.get('content-type'))).toContain('text/html');
			expect(await room.text()).toBe('SSR:/__waiting-room');
		} finally {
			await rt.cleanup();
		}
	});
});
