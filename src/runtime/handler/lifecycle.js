// Boot and shutdown lifecycle: the state machine the readiness probe reports
// and graceful drain walks.
//
// States: 'starting' -> 'ready' -> 'draining' -> 'closed'. The listen socket
// is bound while still 'starting' so the kernel queues connections during a
// rolling restart (lossless handover); readiness flips to 'ready' only after
// the warmup pass, so a balancer never routes a cold instance.

import { emitOperationalDiagnostic, listenFailureDiagnostic } from '../utils/operational-diagnostic.js';
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
 * @param {{ warmupPaths?: string[], beforeReady?: () => Promise<void>, listen?: boolean, reusePort?: boolean }} [opts]
 *   `listen: false` runs the boot sequence (init hook, readiness commit)
 *   without binding a socket, for a cluster compute worker that boots the
 *   full app but never accepts connections. `reusePort: true` binds with
 *   SO_REUSEPORT so every cluster io worker owns its own listen socket on the
 *   shared port and the kernel distributes accepts.
 * @returns {Promise<void>}
 */
export async function start(server, host, port, opts = {}) {
	// A lifecycle that ran to completion leaves the state 'closed' and the drain
	// latched, and neither ever cleared - so a second start served a runtime that
	// was permanently draining, refusing every upgrade with 503, and a third
	// called listen() on a still-listening server.
	//
	// Re-armed HERE, at the top, and never by forcing 'ready' at the end. The
	// ready flip below is guarded on 'starting' precisely so that a stop signal
	// arriving DURING a boot wins over it; beginning the new lifecycle from
	// 'starting' keeps that race decided the same way, where relaxing the flip
	// itself would re-open it.
	if (lifecycle_state === 'closed') {
		setLifecycleState('starting');
		shutdownPromise = null;
	}
	const doListen = opts.listen !== false;
	const t0 = monotonicNow();
	if (doListen) {
		httpServer = server;
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			if (opts.reusePort === true) {
				server.listen({ port, host, reusePort: true }, () => {
					server.removeListener('error', reject);
					resolve(undefined);
				});
			} else {
				server.listen(port, host, () => {
					server.removeListener('error', reject);
					resolve(undefined);
				});
			}
		}).catch((err) => {
			// Through the registry, so the printed line and the catalog entry an
			// operator looks the ID up in are the same bytes. The previous emit
			// built its own record with a dataClass the schema does not declare,
			// which made every bind failure print an invalid-record-shape line
			// instead of the address that could not be bound.
			// The registry builds the record so the printed line and the catalog
			// entry an operator looks the ID up in stay the same bytes. Its own
			// `error` slot carries a placeholder, because the lead's transport
			// reports a bind failure as a falsy token with no error to pass;
			// node rejects with the real one, so it goes in the same declared
			// field rather than a new one - EADDRINUSE is the whole answer on
			// the failure an operator hits most.
			emitOperationalDiagnostic({ ...listenFailureDiagnostic(host, port), error: err });
			process.exit(1);
		});
		const address = /** @type {import('node:net').AddressInfo} */ (server.address());
		console.log(
			`[svelte-adapter-ws] Listening on http${is_tls ? 's' : ''}://${host}:${address?.port ?? port} ` +
			`(bound in ${(monotonicNow() - t0).toFixed(0)}ms)`
		);
	}

	// The app's init hook runs with the socket already bound (the kernel
	// queues connections during a rolling restart) but before warmup and
	// readiness, so top-level state it installs exists before any request.
	if (opts.beforeReady) await opts.beforeReady();

	// Only a worker that actually serves traffic warms - a listen:false
	// compute worker owns no socket and never renders, so warming it would
	// burn boot time on a path it will not use.
	const warmupPaths = doListen ? (opts.warmupPaths ?? []) : [];
	if (warmupPaths.length > 0) {
		await runWarmup({ paths: warmupPaths, platform });
	}

	// A shutdown signal that arrived during boot has already moved the state
	// past 'starting'; it wins.
	if (lifecycle_state === 'starting') {
		setLifecycleState('ready');
		// Announced, and only by a worker that serves traffic. "Listening" is
		// not the same claim: the socket is bound before the init hook and
		// before warmup, so an operator reading only that line cannot tell a
		// server that is taking requests from one still rendering its warmup
		// paths. The elapsed figure is measured from the same t0 the bind line
		// reports against.
		if (doListen) console.log(`[svelte-adapter-ws] Ready for traffic (${(monotonicNow() - t0).toFixed(0)}ms since boot)`);
	}
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
	// Stop the audit timers (both no-ops when never installed). An auditor
	// left running keeps reading state its server no longer serves, and unlike
	// the export it reports to nobody outside the process, so nothing is owed
	// it during the drain.
	counters.consistencyAuditor?.stop();
	counters.consistencyAuditor = null;
	counters.resourceGrowthAuditor?.stop();
	counters.resourceGrowthAuditor = null;
	const server = httpServer;
	if (!server) {
		closePostureExport();
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
	closePostureExport();
	setLifecycleState('closed');
}

/**
 * Drop the posture export socket (a no-op when none was configured) so the
 * socket file does not outlive the process and its consumers read a clean EOF
 * rather than a path that answers nothing.
 *
 * Deliberately the LAST thing the shutdown does. The export's steady cadence is
 * documented as a liveness signal - silence means the adapter is gone - so
 * cutting it at the start of the drain would report gone while this worker is
 * still serving every connection it has left.
 */
function closePostureExport() {
	counters.postureExporter?.close();
	counters.postureExporter = null;
	counters.postureExportHook = null;
}
