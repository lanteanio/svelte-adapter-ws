// Process entry of the built server: reads the process-level environment,
// arms signal handling BEFORE the runtime boots (a SIGTERM during boot is
// latched and dispatched once the listen socket is up), then hands off to the
// handler module. Everything request-shaped lives in handler.js and below;
// this file owns only process concerns.

import process from 'node:process';
import { env } from './env.js';

/**
 * Parse an integer env var strictly: '2.5', '3workers' and '1e2' are fatal
 * misconfigurations, not values to silently coerce.
 *
 * @param {string} name
 * @param {string} raw
 * @param {number} floor
 * @returns {number}
 */
function parseIntEnv(name, raw, floor) {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < floor) {
		throw new Error(
			`Invalid ${name}: '${raw}'. Must be an integer >= ${floor}.`
		);
	}
	return value;
}

export const host = env('HOST', '0.0.0.0');
export const port = parseIntEnv('PORT', env('PORT', '3000'), 0);

// Grace budget for in-flight work at shutdown, in seconds; 0 = no budget.
const shutdown_timeout = parseIntEnv('SHUTDOWN_TIMEOUT', env('SHUTDOWN_TIMEOUT', '30'), 0);

// Delay between readiness flipping to 503 and the drain actually starting,
// for balancers that poll readiness on an interval. Only applied to OS
// signals, and spent OUTSIDE the shutdown budget.
const shutdown_delay = parseIntEnv('SHUTDOWN_DELAY_MS', env('SHUTDOWN_DELAY_MS', '0'), 0);

// Multi-core deployments run through the platform's own process manager until
// the adapter's node:cluster lane lands. The env var must not silently no-op:
// a deployment that sets it expects N workers, and getting one worker with no
// message is a capacity misconfiguration nobody notices until saturation.
if (env('CLUSTER_WORKERS', '')) {
	throw new Error(
		'[svelte-adapter-ws] CLUSTER_WORKERS is not supported by this adapter. ' +
		'Run one process per core under your process manager (systemd template ' +
		'units, PM2, container replicas) behind a load balancer, or unset the variable.'
	);
}

/** @type {'boot' | 'running' | 'shutting-down'} */
let phase = 'boot';
/** @type {string | null} */
let latchedSignal = null;

/**
 * Await every 'sveltekit:shutdown' listener. `process.emit` would discard
 * returned thenables; invoking the listeners directly lets async cleanup
 * (draining queues, closing database pools) actually finish inside the
 * shutdown budget.
 *
 * @param {string} reason
 */
async function runShutdownCleanup(reason) {
	const listeners = process.listeners('sveltekit:shutdown');
	for (const listener of listeners) {
		try {
			await listener(reason);
		} catch (err) {
			console.error('[svelte-adapter-ws] sveltekit:shutdown listener failed:', err);
		}
	}
}

/**
 * @param {string} signal
 * @param {typeof import('./handler.js')} handler
 */
async function performShutdown(signal, handler) {
	if (phase === 'shutting-down') return;
	phase = 'shutting-down';

	// Readiness flips first so the balancer routes away while the listener
	// still accepts - a poll-interval race never sees a closed socket.
	handler.beginDrain();
	if (shutdown_delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, shutdown_delay)); // determinism-allow: process-level shutdown pacing, outside the replayable runtime
	}

	await runShutdownCleanup(signal);
	// The app's own shutdown hook runs inside the same budget as the drain -
	// cleanup the app owns (queues, pools) settles before the process exits.
	await handler.runAppShutdownHook?.();
	await handler.shutdown({ timeoutMs: shutdown_timeout * 1000 });
	process.exit(0);
}

const handlerPromise = (async () => {
	// Signals are armed before the handler module ever evaluates, so a signal
	// arriving mid-boot is latched rather than lost; it dispatches the moment
	// start() resolves.
	const handler = await import('./handler.js');
	await handler.start(host, port);
	phase = 'running';
	if (latchedSignal !== null) {
		void performShutdown(latchedSignal, handler);
	}
	return handler;
})();

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		if (phase === 'boot') {
			latchedSignal = signal;
			return;
		}
		void handlerPromise.then((handler) => performShutdown(signal, handler));
	});
}

await handlerPromise;
