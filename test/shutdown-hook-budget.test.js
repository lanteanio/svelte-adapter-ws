// The app's WebSocket `shutdown` hook runs under the shutdown budget, against
// the REAL runtime.
//
// This lane has two separate implementations - src/testing.js carries its own,
// and src/runtime/handler/app-shutdown-hook.js is what a deployed server runs -
// and the carried suite reaches only the harness one. Proved by mutation:
// neutralizing the production race left the carried suite green, and
// neutralizing the harness race took it red. So the production half needs its
// own pin or it has none.
//
// Driven through shutdown() rather than a helper export, because the close path
// is where the hook has to run: anything that shuts the server down without
// going through the entry must still get it.
//
// Driven through a `buildRuntime` payload rather than a fixture variant: the
// fixture's `variants.js` is vendored byte-identical, and adding an entry to it
// so our copy can carry one more case is the drift the manifest exists to
// prevent. The payload's ws handler is written here instead, which needs no
// vendored file at all.
//
// What is asserted, in order of what an operator loses without it: the hook is
// handed a `signal` and a `deadline` it can honour; a hook that never settles
// does NOT hold the close path open; and that case says so with the indexed
// line, while a hook that finishes inside the budget stays silent.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildRuntime } from './helpers/build-runtime.js';
import { ADAPTER_ERROR_IDS } from '../src/runtime/error-registry.js';

// A complete option set: the built handler reads these at module eval, so a
// partial object fails the import rather than the assertion.
const WS_OPTS = {
	adminPath: '/__realtime',
	adminAuthAcknowledged: true,
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

// Behaviour is read from the environment at CALL time, not at module eval: the
// payload is imported once and both halves have to be reachable from it.
const WS_HANDLER = `
globalThis.__wsShutdownSeen = { called: 0, hasSignal: null, deadline: undefined, aborted: null, reason: undefined, published: null, probeStatus: null };

// An upgrade hook that can be made slow, so a shutdown can begin while a
// handshake is still inside it.
export async function upgrade() {
	if (process.env.WS_UPGRADE_DELAY_MS) {
		await new Promise((r) => setTimeout(r, Number(process.env.WS_UPGRADE_DELAY_MS)));
	}
	return {};
}

export async function shutdown(ctx) {
	const seen = globalThis.__wsShutdownSeen;
	seen.called += 1;
	seen.hasSignal = Boolean(ctx && ctx.signal);
	seen.deadline = ctx ? ctx.deadline : undefined;
	seen.reason = ctx ? ctx.reason : undefined;
	// A last frame to whoever is still connected: the hook is documented to
	// run ahead of the socket close, and this is what that order is for.
	seen.published = ctx && ctx.platform ? ctx.platform.publish('bye', 'last', { n: 1 }) : null;
	// And the listen socket is documented to still be bound: a fresh request
	// made from inside the hook must be accepted, not refused by a closed
	// listener.
	if (process.env.WS_SHUTDOWN_PROBE_PORT) {
		try {
			const res = await fetch('http://127.0.0.1:' + process.env.WS_SHUTDOWN_PROBE_PORT + '/healthz');
			seen.probeStatus = res.status;
		} catch (err) {
			seen.probeStatus = 'refused:' + (err && err.cause && err.cause.code ? err.cause.code : String(err));
		}
	}
	if (process.env.WS_SHUTDOWN_DELAY_MS) {
		await new Promise((r) => setTimeout(r, Number(process.env.WS_SHUTDOWN_DELAY_MS)));
	}
	if (process.env.WS_SHUTDOWN_HANG !== '1') return;
	// Never settles on its own. The runtime must stop waiting on its own budget
	// and say so; if it does not, this hangs the caller, which is the defect.
	await new Promise(() => {
		if (ctx && ctx.signal) {
			ctx.signal.addEventListener('abort', () => { seen.aborted = true; }, { once: true });
		}
	});
}
`;

/** @type {any} */
let handler;
/** @type {{ cleanup: () => void } | null} */
let payload = null;

beforeAll(async () => {
	// WS_ENABLED defaults to false in a payload. A build with WebSockets off
	// writes a ws-handler stub carrying no exports at all, so the hook has
	// nothing to reach and would silently never run.
	payload = buildRuntime({
		wsHandlerSource: WS_HANDLER,
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) }
	});
	handler = await import(pathToFileURL(path.join(payload.dir, 'handler.js')).href);
}, 120000);

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.WS_SHUTDOWN_HANG;
	delete process.env.WS_SHUTDOWN_DELAY_MS;
	delete process.env.WS_SHUTDOWN_PROBE_PORT;
	delete process.env.WS_UPGRADE_DELAY_MS;
	globalThis.__wsShutdownSeen = { called: 0, hasSignal: null, deadline: undefined, aborted: null, reason: undefined, published: null, probeStatus: null };
});

/**
 * Run a shutdown under a budget that expires after `ms`, collecting stderr.
 *
 * Driven through `shutdown()` - the close path every caller reaches - rather
 * than through a helper export, because that is where the hook actually has to
 * run. Each case begins its own lifecycle first: shutdown() latches on its own
 * promise for the life of ONE lifecycle, which is right in production, and
 * start() is what clears that latch once the previous lifecycle closed. Without
 * the restart the second and third cases here would assert against a no-op.
 *
 * `listen: false` because none of this needs a socket - the hook runs before
 * the close path ever looks for a server.
 */
async function runUnderBudget(ms) {
	const errors = [];
	vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
	const expiry = new AbortController();
	const timer = setTimeout(() => expiry.abort(), ms);
	await handler.start('127.0.0.1', 0, { listen: false });
	try {
		await handler.shutdown({ reason: 'SIGTERM', signal: expiry.signal, deadline: ms, timeoutMs: ms });
	} finally {
		clearTimeout(timer);
	}
	return errors;
}

describe('the app shutdown hook runs under the budget', () => {
	it('hands the hook a signal and a deadline it can honour', async () => {
		await runUnderBudget(50);
		const seen = globalThis.__wsShutdownSeen;
		expect(seen.called).toBe(1);
		expect(seen.hasSignal, 'the hook must receive an AbortSignal').toBe(true);
		expect(seen.deadline, 'the hook must receive the budget deadline').toBe(50);
		// Without the reason a hook cannot tell a rolling restart from a
		// crash-loop kill, and cannot decide how much of its flush it has time
		// for. It was dropped on the way through for as long as the hook was
		// driven from the entry.
		expect(seen.reason, 'the hook must receive the shutdown reason').toBe('SIGTERM');
	});

	it('stops waiting on a hook that never settles, and says the flush did not finish', async () => {
		process.env.WS_SHUTDOWN_HANG = '1';
		// The load-bearing assertion is that this AWAIT RETURNS AT ALL. Before the
		// budget existed, a hook like this held the close path for the life of the
		// process, so the failure mode is a hang rather than a wrong value.
		const errors = await runUnderBudget(50);
		const line = errors.find((e) => e.includes(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED));
		expect(line, `no unsettled line; stderr was ${JSON.stringify(errors)}`).toBeTruthy();
		expect(line).toMatch(/has not settled after \d+ms/);
		expect(globalThis.__wsShutdownSeen.aborted, 'the signal handed to the hook must abort').toBe(true);
	}, 20000);

	it('says nothing for a hook that finishes inside the budget', async () => {
		const errors = await runUnderBudget(5000);
		expect(globalThis.__wsShutdownSeen.called).toBe(1);
		expect(
			errors.filter((e) => e.includes(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED)),
			'a hook that settled must not be reported as unsettled'
		).toEqual([]);
	});
});

describe('the app shutdown hook runs ahead of the close, and the drains get what it leaves', () => {
	/**
	 * A listening lifecycle with one live WebSocket client, so the order of
	 * the close path is observable: the hook either finds the socket still
	 * open or it does not.
	 */
	async function withOneClient(fn) {
		await handler.start('127.0.0.1', 0);
		const port = handler.server.address().port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
		try {
			return await fn(ws, port);
		} finally {
			try { ws.terminate(); } catch { /* already gone */ }
		}
	}

	it('runs the hook while every WebSocket is still open, so a last frame still reaches the client', async () => {
		// The documented order: the hook runs BEFORE the listen socket closes
		// and BEFORE existing connections are kicked, so a hook flushing a last
		// frame has somewhere to flush it. Run after the WebSocket drain, the
		// hook publishes to nobody and nothing else in the suite notices - so
		// the client's inbox is the oracle, not the hook's call count.
		await withOneClient(async (ws, port) => {
			process.env.WS_SHUTDOWN_PROBE_PORT = String(port);
			const frames = [];
			const closedCodes = [];
			ws.on('message', (data) => { try { frames.push(JSON.parse(String(data))); } catch { /* binary */ } });
			ws.on('close', (code) => closedCodes.push(code));
			ws.send(JSON.stringify({ type: 'subscribe', topic: 'bye', ref: 1 }));
			await new Promise((resolve) => {
				const tick = () => (frames.some((f) => f.type === 'subscribed') ? resolve(undefined) : setTimeout(tick, 10));
				tick();
			});
			await handler.shutdown({ reason: 'SIGTERM', timeoutMs: 2000 });
			await new Promise((r) => setTimeout(r, 100));
			const seen = globalThis.__wsShutdownSeen;
			expect(seen.called).toBe(1);
			expect(seen.published, 'the hook found no subscriber to publish to').toBe(true);
			// The listener was still bound while the hook ran: its own request
			// was answered rather than refused.
			expect(seen.probeStatus, 'the listen socket was already closed under the hook').toBe(200);
			expect(frames.some((f) => f.topic === 'bye' && f.event === 'last'), 'the last frame never reached the client').toBe(true);
			// And the client is still told to go, after the hook: the order is a
			// reordering, not a skipped step.
			expect(closedCodes).toEqual([1001]);
		});
	}, 20000);

	it('hands the drains only what the hook left of the budget, not the budget again', async () => {
		// A hook that spends most of a budget must not be followed by a drain
		// that waits a whole budget of its own: the number the operator set is a
		// bound on the sequence. With a client that never acknowledges the close
		// frame the WebSocket drain runs to its bound, so the elapsed time says
		// whether that bound was the remainder or a fresh allowance.
		process.env.WS_SHUTDOWN_DELAY_MS = '600';
		await withOneClient(async (ws) => {
			// Stop reading: the server's close frame is never acked, so the drain
			// holds until the budget cuts it.
			ws._socket.pause();
			const t0 = Date.now();
			await handler.shutdown({ reason: 'SIGTERM', timeoutMs: 1000 });
			const elapsed = Date.now() - t0;
			expect(globalThis.__wsShutdownSeen.called).toBe(1);
			// The hook took ~600 of the 1000; the drain got the ~400 left. A drain
			// handed 1000 again lands near 1600.
			expect(elapsed).toBeGreaterThanOrEqual(900);
			expect(elapsed).toBeLessThan(1400);
		});
	}, 20000);
});

describe('the close path is bounded by the budget whatever a handshake is doing', () => {
	it('does not let an upgrade caught inside its hook hold the exit past the budget', async () => {
		// The upgrade hook is checked for draining BEFORE it runs. A shutdown
		// that begins while the hook is pending has swept the live sockets by
		// the time the hook resolves, so a connection opened then would be one
		// nothing sweeps again - and the listener's close never fires while it
		// is open. The accept re-checks and refuses, and the wait on the close
		// is bounded by the same budget either way.
		process.env.WS_UPGRADE_DELAY_MS = '800';
		await handler.start('127.0.0.1', 0);
		const port = handler.server.address().port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		/** @type {string[]} */
		const outcome = [];
		ws.on('open', () => outcome.push('open'));
		ws.on('unexpected-response', (_req, res) => outcome.push('refused:' + res.statusCode));
		ws.on('error', (err) => outcome.push('error:' + err.message));
		ws.on('close', (code) => outcome.push('close:' + code));
		await new Promise((r) => setTimeout(r, 100));

		const t0 = Date.now();
		await handler.shutdown({ reason: 'SIGTERM', timeoutMs: 1500 });
		const elapsed = Date.now() - t0;
		await new Promise((r) => setTimeout(r, 100));
		try { ws.terminate(); } catch { /* already gone */ }

		// Down once the pending handshake settled (~700ms), well inside the
		// budget - not at the budget, and not never.
		expect(elapsed).toBeLessThan(1300);
		expect(outcome.some((o) => o === 'open'), `the handshake was accepted under a closing server: ${outcome.join(', ')}`).toBe(false);
		expect(outcome.some((o) => o.startsWith('refused:503') || o.startsWith('error:')), outcome.join(', ')).toBe(true);
	}, 20000);

	it('bounds the wait on the listener close when a handshake outlives the whole budget', async () => {
		// The listener's close does not fire while the pending upgrade holds its
		// socket, and nothing sweeps a socket that never opened. With the hook
		// outliving the budget, only the bound on that wait ends the shutdown;
		// an unbounded await returns when the hook does, at 3000ms. The overrun
		// is reported as dropped, and the shutdown is not clean.
		process.env.WS_UPGRADE_DELAY_MS = '3000';
		await handler.start('127.0.0.1', 0);
		const port = handler.server.address().port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		/** @type {string[]} */
		const outcome = [];
		ws.on('open', () => outcome.push('open'));
		ws.on('unexpected-response', (_req, res) => outcome.push('refused:' + res.statusCode));
		ws.on('error', (err) => outcome.push('error:' + err.message));
		await new Promise((r) => setTimeout(r, 100));
		const errors = [];
		vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });

		const t0 = Date.now();
		const drained = await handler.shutdown({ reason: 'SIGTERM', timeoutMs: 1000 });
		const elapsed = Date.now() - t0;
		try { ws.terminate(); } catch { /* already gone */ }
		await new Promise((r) => setTimeout(r, 3100));

		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(elapsed, 'the listener close held the exit until the hook resolved').toBeLessThan(1600);
		expect(drained, 'a connection held past the budget must not read as a clean drain').toBe(false);
		expect(errors.some((e) => e.includes(ADAPTER_ERROR_IDS.SHUTDOWN_REQUESTS_DROPPED)), 'the overrun must be reported').toBe(true);
		expect(outcome.some((o) => o === 'open'), outcome.join(', ')).toBe(false);
	}, 20000);
});

