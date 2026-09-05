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
globalThis.__wsShutdownSeen = { called: 0, hasSignal: null, deadline: undefined, aborted: null, reason: undefined };

export async function shutdown(ctx) {
	const seen = globalThis.__wsShutdownSeen;
	seen.called += 1;
	seen.hasSignal = Boolean(ctx && ctx.signal);
	seen.deadline = ctx ? ctx.deadline : undefined;
	seen.reason = ctx ? ctx.reason : undefined;
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
	globalThis.__wsShutdownSeen = { called: 0, hasSignal: null, deadline: undefined, aborted: null, reason: undefined };
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
