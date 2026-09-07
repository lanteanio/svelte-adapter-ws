// The app's `shutdown` export, run once per process and bounded by the
// shutdown budget.
//
// It lives in its own module rather than in realtime.js because the close path
// is what has to reach it: lifecycle.js drives the shutdown, and realtime.js
// already imports lifecycle.js, so calling it from there would close a cycle.
// The app's handler arrives through the root-level bridge, which needs no
// substitution of its own, and `platform` is the same object realtime.js hands
// the init hook - so a shutdown hook sees exactly what an init hook saw.

import { wsModule } from '../ws-handler-bridge.js';
import { platform } from './platform.js';
import { monotonicNow } from '../runtime.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

/**
 * Run the app's `shutdown` export, bounded by the shutdown budget.
 *
 * The hook is RACED against the budget rather than awaited outright. A bare
 * await hands an application the ability to hold the close path open for as
 * long as the process lives, and says nothing while it does.
 *
 * Not latched here: `lifecycle.shutdown()` is the only caller and is already
 * latched on its own promise, which a restart clears along with the lifecycle
 * state - so once-per-lifecycle falls out, and a second lifecycle gets its hook
 * back instead of inheriting a latch from the one before it.
 *
 * @param {{ reason?: string | null, signal?: AbortSignal | null, deadline?: number | null }} [ctx]
 * @returns {Promise<void>}
 */
export async function runAppShutdownHook(ctx) {
	if (typeof wsModule.shutdown !== 'function') return;
	const signal = ctx?.signal ?? null;
	const started = monotonicNow();
	try {
		// The rejection handler is attached BEFORE the race, not after it: once
		// the race is lost nothing awaits the hook any more, so a late rejection
		// would surface as an unhandled rejection in the middle of the exit.
		const hook = Promise.resolve(
			wsModule.shutdown({
				platform,
				// Without the reason a hook cannot tell a rolling restart from a
				// crash-loop kill, and cannot decide how much of its flush it
				// still has time for.
				reason: ctx?.reason ?? null,
				signal,
				deadline: ctx?.deadline ?? null
			})
		).then(
			() => true,
			(err) => { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_THREW), err); return true; }
		);
		// The hook keeps running after the budget expires - user code cannot be
		// interrupted - but it no longer holds the close path. Its `signal` is how
		// a hook that wants to give up cleanly can.
		const settled = await Promise.race([hook, whenAborted(signal).then(() => false)]);
		if (!settled) {
			console.error(adapterConsoleLine(
				ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED,
				`${(monotonicNow() - started).toFixed(0)}ms and the shutdown budget is spent; ` +
				'closing the listen socket anyway - whatever the hook was flushing did NOT finish.'
			));
		}
	} catch (err) {
		// A hook that threw synchronously, before it ever returned a promise.
		// Log-and-continue: shutdown is best-effort and cannot be refused.
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_THREW), err);
	}
}

/**
 * Resolve when `signal` aborts, and never otherwise.
 *
 * The never-settling half is deliberate: this is one side of a `Promise.race`,
 * so "no budget" has to mean "this side never wins" rather than "this side wins
 * immediately".
 *
 * @param {AbortSignal | null} signal
 * @returns {Promise<void>}
 */
function whenAborted(signal) {
	if (!signal) return new Promise(() => {});
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}
