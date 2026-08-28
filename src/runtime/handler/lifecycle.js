// Boot and shutdown lifecycle: the state machine the readiness probe reports
// and graceful drain walks.
//
// States: 'starting' -> 'ready' -> 'draining' -> 'closed'. The listen socket
// is bound while still 'starting' so the kernel queues connections during a
// rolling restart (lossless handover); readiness flips to 'ready' only after
// the warmup pass, so a balancer never routes a cold instance.

import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';
import { monotonicNow, setTimer, clearTimer } from '../runtime.js';
import { counters } from './state.js';
import { is_tls } from './config.js';
import { runWarmup } from './warmup.js';
import { platform } from './platform.js';

/** @type {'starting' | 'ready' | 'draining' | 'closed'} */
let lifecycle_state = 'starting';

/** @type {import('node:http').Server | import('node:https').Server | null} */
let httpServer = null;

/** @returns {'starting' | 'ready' | 'draining' | 'closed'} */
export function lifecycleState() {
	return lifecycle_state;
}

/** @returns {boolean} */
export function isDraining() {
	return lifecycle_state !== 'ready';
}

/**
 * Single writer for the lifecycle state so the counters mirror can never
 * disagree with the probe's answer.
 * @param {'starting' | 'ready' | 'draining' | 'closed'} next
 */
function setLifecycleState(next) {
	lifecycle_state = next;
	counters.draining = next !== 'ready';
}

/**
 * Flip readiness to 503 while the listener still accepts. A balancer routes
 * away on the readiness probe; the traffic already in flight keeps being
 * served until `shutdown` closes the door.
 */
export function beginDrain() {
	if (lifecycle_state === 'closed') return;
	setLifecycleState('draining');
}

/** @type {Array<() => void>} */
const drainResolvers = [];

/**
 * Called by the request handler on every completed exchange. Resolves every
 * pending in-flight drain once the last accepted request finishes.
 */
export function requestDone() {
	if (drainResolvers.length > 0 && counters.inFlightCount === 0) {
		for (const resolve of drainResolvers.splice(0)) resolve();
	}
}

/**
 * Bind the listen socket, run the boot warmup, and commit readiness.
 *
 * @param {import('node:http').Server | import('node:https').Server} server
 * @param {string} host
 * @param {number} port
 * @param {{ warmupPaths?: string[], beforeReady?: () => Promise<void> }} [opts]
 * @returns {Promise<void>}
 */
export async function start(server, host, port, opts = {}) {
	httpServer = server;
	const t0 = monotonicNow();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.removeListener('error', reject);
			resolve(undefined);
		});
	}).catch((err) => {
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.lifecycle',
			event: 'runtime.listen.failed',
			severity: 'error',
			dataClass: 'none',
			message: `Failed to bind ${host}:${port}.`,
			attributes: { error: diagnosticError(err) }
		});
		process.exit(1);
	});
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	console.log(
		`[svelte-adapter-ws] Listening on http${is_tls ? 's' : ''}://${host}:${address?.port ?? port} ` +
		`(bound in ${(monotonicNow() - t0).toFixed(0)}ms)`
	);

	// The app's init hook runs with the socket already bound (the kernel
	// queues connections during a rolling restart) but before warmup and
	// readiness, so top-level state it installs exists before any request.
	if (opts.beforeReady) await opts.beforeReady();

	const warmupPaths = opts.warmupPaths ?? [];
	if (warmupPaths.length > 0) {
		await runWarmup({ paths: warmupPaths, platform });
	}

	// A shutdown signal that arrived during boot has already moved the state
	// past 'starting'; it wins.
	if (lifecycle_state === 'starting') setLifecycleState('ready');
}

/** @type {Promise<void> | null} */
let shutdownPromise = null;

/**
 * Graceful shutdown: stop accepting, drain in-flight exchanges within the
 * budget, then close whatever remains. Live WebSocket drain layers on top of
 * this in the realtime lane. Idempotent: concurrent and repeated calls share
 * one teardown, and the first caller's budget governs it.
 *
 * @param {{ timeoutMs?: number }} [opts] - 0 or undefined = no budget
 * @returns {Promise<void>}
 */
export function shutdown(opts = {}) {
	if (shutdownPromise === null) shutdownPromise = performShutdown(opts);
	return shutdownPromise;
}

/** @param {{ timeoutMs?: number }} opts */
async function performShutdown(opts) {
	beginDrain();
	const server = httpServer;
	if (!server) {
		setLifecycleState('closed');
		return;
	}

	// Close the listener; already-accepted sockets keep being served. Idle
	// keep-alive connections hold no exchange and are closed at once so the
	// drain waits only on real work.
	const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
	server.closeIdleConnections?.();

	if (counters.inFlightCount > 0) {
		/** @type {Promise<void>} */
		const drained = new Promise((resolve) => { drainResolvers.push(resolve); });
		const timeoutMs = opts.timeoutMs ?? 0;
		if (timeoutMs > 0) {
			let timer;
			const budget = new Promise((resolve) => {
				timer = setTimer(resolve, timeoutMs);
				if (typeof timer?.unref === 'function') timer.unref();
			});
			await Promise.race([drained, budget]);
			clearTimer(timer);
		} else {
			await drained;
		}
	}

	// Whatever is still open after the budget is cut off; a truncated exchange
	// is the documented cost of the deadline expiring.
	if (counters.inFlightCount > 0) {
		console.error(adapterConsoleLine(
			ADAPTER_ERROR_IDS.SHUTDOWN_REQUESTS_DROPPED,
			`${counters.inFlightCount} still open`
		));
	}
	server.closeAllConnections?.();
	await closed;
	setLifecycleState('closed');
}
