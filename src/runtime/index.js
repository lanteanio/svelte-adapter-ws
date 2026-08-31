// Process entry of the built server: reads the process-level environment,
// arms signal handling BEFORE the runtime boots (a SIGTERM during boot is
// latched and dispatched once the listen socket is up), then hands off to the
// handler module - or, with CLUSTER_WORKERS set, becomes the cluster primary
// that spawns one worker thread per slot and coordinates their supervision,
// cross-worker relay, TLS reloads and shutdown. Everything request-shaped
// lives in handler.js and below; this file owns only process concerns.

// Substituted by the adapter's build step; a free identifier until then.
/* global WORKERS_CONFIG */
import process from 'node:process';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { env } from './env.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from './error-registry.js';
import { monotonicNow, wallEpoch, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from './runtime.js';
import { createRelayRingBuffer, RingWriter, RingReader, decodeRelayFrame } from './relay-ring.js';
import { createRelaySpillQuarantine, attributeRelayIncident, relayEligible } from './relay-spill-policy.js';
import { createRestartSupervisor } from './restart-supervisor.js';
import { classifyWorkerHealth, resolveBootTimeout, routeWorkerMessage } from './worker-watchdog.js';
import { certExpiryAlert, createCertWatcher, readCertIdentity, reloadClusterTls } from './utils/tls-reload.js';
import { readFdLimits, fdPreflightWarning } from './utils/fd-limit.js';
import { createSdNotify } from './utils/sd-notify.js';
import { emitOperationalEvent, diagnosticError } from './diagnostic.js';

// systemd readiness + watchdog (auto-detected from NOTIFY_SOCKET; a no-op
// everywhere else). Only the main thread talks to systemd - it owns the
// service's MainPID - so every call site below is main-thread-gated.
const sdNotify = createSdNotify();
let sd_ready_sent = false;
// Set the moment this process is condemned. Readiness is reported by whichever
// worker comes up first, on its own schedule, so a report can land after the
// decision to go down has already been taken - telling the supervisor the
// instance arrived one tick before it leaves, which is how a rolling deploy
// convinces itself a dying instance is healthy.
let sd_ready_withheld = false;
function sdReadyOnce() {
	if (sd_ready_sent || sd_ready_withheld || !isMainThread) return;
	sd_ready_sent = true;
	sdNotify.ready();
	sdNotify.armWatchdog();
}

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

// In-process cluster: CLUSTER_WORKERS worker threads behind one primary. The
// primary owns supervision and the cross-worker relay; each io worker binds
// the shared port itself with SO_REUSEPORT and the kernel distributes accepts.
const cluster_workers = env('CLUSTER_WORKERS', '');

// Shared-memory relay ring size per direction per worker, in KB. The cluster
// relay's hot path (publish fan-out across workers) rides two
// SharedArrayBuffer rings per worker (worker->primary, primary->worker)
// instead of structured-clone postMessage: the publisher encodes each message
// to bytes once, the primary forwards the framed bytes verbatim, and only the
// receiving workers decode. A ring that fills spills into the producer's
// pending queue and flushes as the consumer drains - order always preserved.
// 0 disables the rings (every relay rides postMessage exactly as before).
const relay_ring_kb = parseIntEnv('CLUSTER_RELAY_RING_KB', env('CLUSTER_RELAY_RING_KB', '256'), 0);
// A receiving worker that stops draining its ring must not turn the primary
// into an unbounded spill buffer. These finite per-peer ceilings quarantine
// that worker through the normal clean-exit/restart supervisor. The byte
// ceiling counts the spilled frames' own bytes (a spilled view can pin its
// drain-batch buffer until the tail flushes, so momentary residency can
// exceed the count - bounded by one ring-sized batch per peer); age catches
// a small spill that otherwise sits forever.
const relay_pending_max_bytes = parseIntEnv(
	'CLUSTER_RELAY_MAX_PENDING_KB', env('CLUSTER_RELAY_MAX_PENDING_KB', '4096'), 1
) * 1024;
const relay_pending_max_ms = parseIntEnv(
	'CLUSTER_RELAY_MAX_PENDING_MS', env('CLUSTER_RELAY_MAX_PENDING_MS', '5000'), 1
);
// Largest serialized envelope a worker will hand to the cluster relay. This is
// the SENDER's ceiling and it is a different question from the two above: those
// describe a receiving peer's failure to drain, this describes the size of one
// frame, which is nobody's fault and identical for every peer. Keeping them
// apart is the point - conflating them is what would let one large publish
// quarantine every healthy sibling at once.
//
// It defaults to the per-peer byte ceiling, so one admitted frame can never be
// larger than the backlog budget it will occupy, and the pathological publish
// is refused at its source instead of being reassembled whole in the primary's
// heap on its way to bouncing the cluster. `0` disables it, for a deployment
// that genuinely relays frames larger than its spill budget and accepts the
// memory.
const relay_frame_max_bytes = parseIntEnv(
	'CLUSTER_RELAY_MAX_FRAME_KB',
	env('CLUSTER_RELAY_MAX_FRAME_KB', String(Math.floor(relay_pending_max_bytes / 1024))),
	0
) * 1024;

const is_primary = cluster_workers && isMainThread;

// Descriptor-budget preflight: fires once per process (main thread only -
// worker threads share the single process fd table, so per-worker repeats
// would be noise) when the soft limit is EMFILE-low for a socket server.
// The probes return null on platforms without a limit source, so this is a
// silent no-op there.
if (isMainThread) {
	const fdWarning = fdPreflightWarning(readFdLimits());
	// The subject is spelled at the call site, ahead of the advisory's own
	// numbers: a line whose first words are the package tag and then an
	// interpolated value gives an operator nothing to search for.
	if (fdWarning !== null) console.warn('[svelte-adapter-ws] file-descriptor preflight: ' + fdWarning);
}

if (is_primary) {
	// ── Primary thread: spawn workers, coordinate shutdown ──

	// Signal handlers are armed FIRST, ahead of this branch's own awaits, for
	// the reason the single-process branch arms ahead of `start()`: until the
	// first `process.on('SIGTERM')` call Node installs no handler at all, so
	// everything before it sits on the OS default disposition, where a signal
	// terminates the process outright. The blast radius is larger here than in
	// single-process mode, because the workers are THREADS in this process:
	// the default disposition takes every worker's live connections with it,
	// and no `await` may ever be added between the spawn loop and the end of
	// this branch without the fleet inheriting that.
	//
	// A signal that arrives mid-boot is LATCHED rather than dispatched, and
	// the latch has two states because the primary's mid-boot situation is
	// genuinely different from a single-process server's. Before the spawn
	// loop there is no listen socket, no worker and nothing in flight - no
	// drain to run, and `graceful_shutdown` cannot even end the process from
	// there, because it leaves the exit to the last worker's `exit` handler
	// (`workers.size === 0`) and an empty fleet fires no such handler.
	// Deferring would hang until the orchestrator's SIGKILL, so that state
	// exits directly. Once the fleet exists, the latch is spent at the end of
	// this branch and the ordinary shutdown runs against a complete fleet.
	/** @type {'SIGINT' | 'SIGTERM' | null} */
	let boot_signal = null;
	let primary_booted = false;
	let fleet_spawned = false;
	// Declared here, ahead of the signal arming, because the handler below
	// reads it and a signal can land during any await between the arming and
	// the fleet spawn (primaryInit is unbounded app code).
	let shutting_down = false;
	/** @param {'SIGINT' | 'SIGTERM'} reason */
	const onPrimarySignal = (reason) => {
		// A second signal while already draining is the operator saying
		// "now": exit immediately instead of waiting out the workers' hooks
		// or the drain window - the same escape hatch single-process mode
		// gives, and the README promise it carries.
		if (shutting_down) {
			console.error(`[svelte-adapter-ws] second ${reason} during shutdown; exiting immediately.`);
			process.exit(1);
		}
		if (primary_booted) { graceful_shutdown(reason); return; }
		if (boot_signal) return;
		boot_signal = reason;
		// Whatever happens next, this instance is going down: the workers
		// spawned after this point must not announce it ready on the way out.
		sd_ready_withheld = true;
		if (!fleet_spawned) {
			// No STOPPING notification from here: the helper that carries it is
			// a short-lived child process, and this exits in the same tick, so
			// the spawn would never complete. It is also the wrong message -
			// STOPPING announces the orderly shutdown of a RUNNING service, and
			// this one never reached READY.
			console.log(`[svelte-adapter-ws] Primary received ${reason} before any worker was spawned; exiting.`);
			process.exit(0);
		} else {
			console.log(`[svelte-adapter-ws] Primary received ${reason} during boot; shutting down once the fleet is up.`);
		}
	};
	process.on('SIGTERM', () => onPrimarySignal('SIGTERM'));
	process.on('SIGINT', () => onPrimarySignal('SIGINT'));

	const { availableParallelism } = await import('node:os');

	// The token must denote a whole number, judged by the rule PORT, the
	// shutdown budgets, and the relay ceilings answer to: parseInt would
	// absorb '2.5' as 2, '3workers' as 3, and '1e2' as 1, silently booting
	// a fleet the operator did not ask for where the documented behavior is
	// a fatal exit before any worker spawns. The helper's throw becomes
	// this path's refusal: the indexed console line and a pre-spawn exit.
	let num;
	if (cluster_workers === 'auto') {
		num = availableParallelism();
	} else {
		try { num = parseIntEnv('CLUSTER_WORKERS', cluster_workers, 1); } catch { num = NaN; }
	}

	if (isNaN(num) || num < 1) {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_WORKERS,
			`${cluster_workers}'. Use a positive integer or 'auto'.`));
		process.exit(1);
	}

	// Worker roles: split the pool into I/O workers (listen + serve) and
	// compute workers (never listen; driven entirely by the app via shared
	// memory seeded in primaryInit, so a latency-critical tick pays no I/O
	// jitter). WORKERS_CONFIG is the serialized `websocket.workers` option;
	// `compute` is how many of the `num` total workers are compute workers
	// (io = num - compute).
	const workers_config = WORKERS_CONFIG;
	const compute_count = Math.max(0, Math.floor(workers_config?.compute ?? 0));
	if (compute_count >= num) {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_COMPUTE,
			`${compute_count}) must be less than the total worker count (${num}).`));
		process.exit(1);
	}
	const io_count = num - compute_count;

	// The only cluster mode this runtime has is reuseport: every io worker
	// binds `listen({ reusePort: true })` itself and the kernel distributes
	// accepted connections across the listeners. That distribution is a Linux
	// kernel behavior (SO_REUSEPORT with load balancing), so any other
	// platform refuses before spawning - a fleet whose workers cannot bind, or
	// whose kernel routes every accept to one listener, is a capacity
	// misconfiguration nobody notices until saturation. An acceptor mode (one
	// thread accepting and handing sockets to the others) requires moving live
	// socket ownership across threads, which Node core cannot do; deployments
	// that need multi-core off Linux run one process per core under the
	// platform process manager instead.
	const cluster_mode = env('CLUSTER_MODE', 'reuseport');

	if (cluster_mode === 'acceptor') {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_ACCEPTOR,
			'Remove CLUSTER_MODE to use reuseport, the only mode this runtime has.'));
		process.exit(1);
	}
	if (cluster_mode !== 'reuseport') {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_MODE,
			`${cluster_mode}'. Use 'reuseport' (Linux), or unset CLUSTER_MODE.`));
		process.exit(1);
	}
	// An ephemeral port and a shared listening port are mutually exclusive by
	// construction. Every io worker calls listen() itself with reusePort, so
	// PORT=0 gets each of them its OWN kernel-assigned port: the fleet boots
	// green, reports success, and serves on as many ports as there are workers,
	// none of which anything upstream knows to reach. Refused here with the
	// rest of the capacity misconfigurations rather than discovered in
	// production, because nothing downstream can notice it.
	if (port === 0) {
		console.error(
			'[svelte-adapter-ws] PORT=0 cannot be combined with CLUSTER_WORKERS: every io worker ' +
			'binds the shared port itself, so an ephemeral port would give each worker a different ' +
			'one and no worker would be reachable at a known address. Set PORT to a fixed port, or ' +
			'unset CLUSTER_WORKERS to run a single process on an ephemeral port.'
		);
		process.exit(1);
	}
	if (process.platform !== 'linux') {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_REUSEPORT,
			`${process.platform}). Deploy on Linux, or run one process per core under your process manager.`));
		process.exit(1);
	}
	// `listen({ reusePort: true })` exists from Node 22.12 (and 23.1); an
	// older Node silently DROPS the unknown option, so the first worker would
	// bind normally and every sibling would crash-loop on EADDRINUSE until the
	// restart budget took the whole process down - minutes of partial service
	// ending in total outage where every other bad configuration refuses
	// up front. So this refuses up front too.
	const [node_major, node_minor] = process.versions.node.split('.').map(Number);
	const reuse_port_supported = node_major >= 24 ||
		(node_major === 23 && node_minor >= 1) ||
		(node_major === 22 && node_minor >= 12);
	if (!reuse_port_supported) {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_NODE,
			`${process.versions.node}, which ignores the listen reusePort option). Upgrade Node, or unset CLUSTER_WORKERS.`));
		process.exit(1);
	}

	// primaryInit: run the app's optional primary-thread hook ONCE, before any
	// worker spawns. Its return value is retained and replayed as the
	// IDENTICAL `workerData.app` to every worker AND every respawn (a
	// SharedArrayBuffer is shared by reference through workerData, so all
	// workers - and a crashed worker's replacement - see the same backing
	// memory). Bundled as its own isolated entry, so importing it never pulls
	// the app graph into the primary.
	const { default: primaryInit } = await import('PRIMARY_INIT');
	let app_worker_data = null;
	if (typeof primaryInit === 'function') {
		app_worker_data = (await primaryInit({ env: process.env })) ?? null;
	}

	// TLS cert hot-reload knobs, mirrored from the worker config
	// (handler/config.js) so the primary reads the same env. Default-ON when
	// SSL is configured (opt out with SSL_WATCH=0). The primary owns the
	// cert-directory watch in cluster mode; a single-process server watches
	// worker-side (handler/tls.js).
	const ssl_cert = env('SSL_CERT', '');
	const ssl_key = env('SSL_KEY', '');
	const ssl_pfx = env('SSL_PFX', '');
	const is_tls = !!(ssl_cert && ssl_key) || !!ssl_pfx;
	const ssl_watch = is_tls && env('SSL_WATCH', '1') !== '0';
	const _ssl_debounce_raw = parseInt(env('SSL_RELOAD_DEBOUNCE_MS', '500'), 10);
	const ssl_reload_debounce_ms = Number.isFinite(_ssl_debounce_raw) && _ssl_debounce_raw >= 0 ? _ssl_debounce_raw : 500;
	// SSL_SNI_HOSTS is deliberately NOT read here: its semicolon groups
	// override the EXTRA certificates' SAN discovery (handler/tls.js), never
	// the first certificate this identity record describes. The workers parse
	// it themselves when they build their SNI contexts.
	// Watch every certificate-bearing DIRECTORY, deduped, exactly as the
	// single-process watch does (handler/tls.js): certbot renews each domain
	// on its own schedule and a key can live apart from its cert, so keying
	// the broadcast on the first pair's directory alone would let every other
	// pair's renewal land unseen - no broadcast, a fleet serving stale SNI
	// certs until they expire. Identity/expiry observability still reads the
	// FIRST PEM cert (the default context); a PKCS#12 bundle is not PEM, so a
	// PFX deployment watches and broadcasts without the identity record
	// rather than logging a spurious read failure on every renewal.
	const watched_files = ssl_pfx
		? [ssl_pfx]
		: [...ssl_cert.split(','), ...ssl_key.split(',')].map((s) => s.trim()).filter(Boolean);
	const watched_dirs = [...new Set(watched_files.map((f) => dirname(f)))];
	const identity_cert_path = ssl_pfx ? '' : ssl_cert.split(',').map((s) => s.trim()).filter(Boolean)[0] || '';

	console.log(
		`[svelte-adapter-ws] Primary thread starting ${num} workers ` +
		`(${io_count} io${compute_count ? `, ${compute_count} compute` : ''}, ${cluster_mode} mode)...`
	);

	/**
	 * Per-worker metadata. `role` is the worker's assigned role
	 * ('io' | 'compute') and `slot` is its stable `{ role, index }` identity,
	 * both retained so a respawn re-creates the SAME role in the SAME slot
	 * after a crash. `threadId` is captured at spawn because Node nulls the
	 * worker handle before emitting 'exit'.
	 * @typedef {{ threadId: number, lastHeartbeat: number, spawnedAt: number, ready: boolean, role: 'io' | 'compute', slot: { role: 'io' | 'compute', index: number }, ringWriter: RingWriter | null, ringReader: RingReader | null, relayQuarantined: boolean }} WorkerMeta
	 */

	/** @type {Map<import('node:worker_threads').Worker, WorkerMeta>} */
	const workers = new Map();

	// Per-slot crash-restart budgets. A cluster has a fixed set of worker
	// slots (io_count io + compute_count compute); the supervisor keeps each
	// slot's restart attempts, exponential backoff, and pending respawn timer
	// separate, so one slot becoming ready never resets or cancels another
	// slot's restart. A slot's budget resets only after a worker has been
	// ready for RESTART_STABLE_MS, so a slot that flaps a brief ready between
	// crashes exhausts instead of resetting forever (restart-supervisor.js).
	const RESTART_DELAY_MAX = 5000;
	const RESTART_MAX_ATTEMPTS = 50;
	const RESTART_STABLE_MS = 30000;
	const restartSupervisor = createRestartSupervisor({
		setTimer,
		clearTimer,
		now: monotonicNow,
		spawn: (slot) => spawn_worker(slot),
		onExhausted: (slot) => {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT,
				`${slot.role}#${slot.index} (${RESTART_MAX_ATTEMPTS}). Exiting.`));
			process.exit(1);
		},
		shuttingDown: () => shutting_down,
		delayBase: 100,
		delayMax: RESTART_DELAY_MAX,
		maxAttempts: RESTART_MAX_ATTEMPTS,
		stableMs: RESTART_STABLE_MS
	});

	// Worker health monitoring: send a heartbeat every 10 s. A worker that has
	// not responded within 30 s is assumed stuck (deadlock / infinite loop)
	// and asked to exit so the exit handler can restart it. lastHeartbeat 0
	// means the worker has not confirmed it is alive yet (still starting up) -
	// that regime is judged by the separate boot deadline below.
	const HEARTBEAT_INTERVAL_MS = 10000;
	const HEARTBEAT_TIMEOUT_MS = 30000;

	// Boot-deadline watchdog. A worker whose `init` hook wedges (a sync
	// infinite loop or a native hang) never confirms ready, so the
	// steady-state timeout above - which only judges a worker that HAS
	// confirmed ready - never escalates it and its cluster slot is stranded
	// (permanent capacity loss). The boot deadline closes that window: a
	// still-booting worker whose liveness clock goes stale past it is
	// escalated and respawned via the normal exit path. A slow-but-healthy
	// init keeps acking the heartbeats (its pre-start liveness responder
	// answers while the event loop is free), so its clock never goes stale -
	// only a genuine no-ack wedge reaches the deadline. Generously defaulted
	// so a long-but-legitimate warmup (cron registration, dataset load,
	// external connections) is never false-killed into a restart loop. 0
	// disables it (a wedged boot then stays stranded). Clamped to at least two
	// heartbeat intervals: a worker cannot ack before its first ping (one
	// interval after spawn) and its liveness clock then trails by up to one
	// interval between pings, so a shorter deadline could false-kill a healthy
	// slow boot at a sweep boundary.
	const WORKER_BOOT_TIMEOUT_FLOOR_MS = 2 * HEARTBEAT_INTERVAL_MS;
	const _boot_timeout_raw = parseIntEnv('WORKER_BOOT_TIMEOUT_MS', env('WORKER_BOOT_TIMEOUT_MS', '60000'), 0);
	const { bootTimeoutMs: WORKER_BOOT_TIMEOUT_MS, clamped: _boot_timeout_clamped } = resolveBootTimeout(_boot_timeout_raw, WORKER_BOOT_TIMEOUT_FLOOR_MS);
	if (_boot_timeout_clamped) {
		console.warn(
			`[primary] WORKER_BOOT_TIMEOUT_MS=${_boot_timeout_raw}ms is below the ${WORKER_BOOT_TIMEOUT_FLOOR_MS}ms floor ` +
			`(two heartbeat intervals) and would risk false-killing a healthy slow boot; using ${WORKER_BOOT_TIMEOUT_FLOOR_MS}ms.`
		);
	}

	// Ask a worker to exit cleanly; force it after the grace. The clean-exit
	// message protocol is the family shape: the worker flushes and closes on
	// its own event loop, so a busy-but-alive worker leaves cleanly well
	// inside the grace. Only a genuine wedge (a loop that cannot process the
	// message) reaches the fallback, and there this runtime terminates just
	// that worker thread in place - a plain Node worker holds no native
	// socket handles, so terminate() is safe and the slot respawns under the
	// restart budget instead of the whole process going down.
	const WORKER_EXIT_GRACE_MS = 5000;
	/** @type {Set<import('node:worker_threads').Worker>} */
	const exit_requested = new Set();
	/** @param {import('node:worker_threads').Worker} worker @param {number} code */
	function requestWorkerExit(worker, code) {
		if (exit_requested.has(worker)) return;
		exit_requested.add(worker);
		try { worker.postMessage({ type: 'terminate', code }); } catch {}
		const t = setTimer(() => {
			if (workers.has(worker)) {
				const meta = workers.get(worker);
				console.error(adapterConsoleLine(
					ADAPTER_ERROR_IDS.WORKER_EXIT_FORCED,
					`${meta?.threadId ?? -1} did not exit within ${WORKER_EXIT_GRACE_MS}ms; ` +
					'terminating the worker thread (a wedged worker cannot self-close) - its slot respawns under the restart budget.'
				));
				void worker.terminate();
			}
		}, WORKER_EXIT_GRACE_MS);
		if (t && t.unref) t.unref();
	}

	const heartbeatSweep = setIntervalTimer(() => {
		if (shutting_down) return;
		const t = monotonicNow();
		for (const [worker, meta] of workers) {
			// A ready worker is judged by the tight steady-state timeout; a
			// still-booting one by the generous, separate boot deadline. A
			// slow-but-healthy init acks throughout boot via its pre-start
			// liveness responder, so its clock stays fresh under either
			// timeout - only a genuine wedge goes stale.
			const verdict = classifyWorkerHealth(meta, t, { steadyTimeoutMs: HEARTBEAT_TIMEOUT_MS, bootTimeoutMs: WORKER_BOOT_TIMEOUT_MS });
			if (verdict.escalate) {
				console.error(
					`[primary] Worker ${meta.threadId} (${meta.slot.role}#${meta.slot.index}) ${verdict.reason}, asking it to exit...`
				);
				requestWorkerExit(worker, 1);
			} else {
				worker.postMessage({ type: 'heartbeat' });
			}
		}
		// Self-heal the live-plus-spawning-plus-pending invariant: if any slot
		// has somehow ended up with no live worker, no booting worker, and no
		// pending respawn, schedule its restart. A correct event path never
		// leaves a slot stranded; this only fires against a future regression,
		// and it skips still-booting slots so it never double-spawns.
		const backfilled = restartSupervisor.reconcile();
		if (backfilled > 0) console.error(`[primary] reconciled ${backfilled} stranded worker slot(s)`);
	}, HEARTBEAT_INTERVAL_MS);
	if (heartbeatSweep && heartbeatSweep.unref) heartbeatSweep.unref();

	/** @param {{ role: 'io' | 'compute', index: number }} slot */
	function spawn_worker(slot) {
		// This worker is (re)occupying its slot: reset the slot's not-yet-live
		// flag and drop any pending respawn timer before the new thread starts.
		restartSupervisor.noteSpawn(slot);
		const role = slot.role;
		// Shared-memory relay rings for this worker (fresh per spawn AND per
		// respawn - a replacement never inherits a dead worker's stream
		// state). The ceilings travel with the buffers so BOTH directions are
		// bounded by the same numbers.
		const relay_ring = relay_ring_kb > 0
			? {
				up: createRelayRingBuffer(relay_ring_kb * 1024),
				down: createRelayRingBuffer(relay_ring_kb * 1024),
				maxPendingBytes: relay_pending_max_bytes,
				maxPendingAgeMs: relay_pending_max_ms
			}
			: null;
		const worker = new Worker(fileURLToPath(import.meta.url), {
			// `app` is the retained primaryInit output, replayed identically on
			// every spawn and respawn so a compute worker's replacement rejoins
			// the same shared-memory world.
			// `ioWorkers` is a correctness input, not diagnostics: worker-local
			// features that promise one authoritative in-memory home (notably
			// the game lane) must reject a topology in which sockets can land
			// on more than one I/O worker. Passing the resolved count also
			// handles `auto` without asking a worker to guess from the
			// original env spelling.
			workerData: {
				mode: cluster_mode,
				role,
				totalWorkers: num,
				ioWorkers: io_count,
				app: app_worker_data,
				relayRing: relay_ring,
				// Threaded rather than re-read from env in the worker: the
				// sender-side ceiling is derived from the primary's spill
				// budget, and every worker must apply the SAME one or a large
				// publish is refused by some siblings and relayed by others.
				relayMaxFrameBytes: relay_frame_max_bytes
			}
		});
		// lastHeartbeat starts at 0 - the worker is confirmed alive only after
		// its first 'ready' / 'heartbeat-ack' message arrives. spawnedAt
		// anchors the boot deadline before the first ack; ready flips the
		// watchdog from the boot regime to the steady-state regime.
		/** @type {WorkerMeta} */
		const meta = {
			threadId: worker.threadId,
			lastHeartbeat: 0,
			spawnedAt: monotonicNow(),
			ready: false,
			role,
			slot,
			ringWriter: null,
			ringReader: null,
			relayQuarantined: false
		};
		if (relay_ring !== null) {
			const quarantineRelaySpill = createRelaySpillQuarantine({
				worker,
				meta,
				workers,
				requestWorkerExit
			});
			meta.ringWriter = new RingWriter(relay_ring.down, {
				maxPendingBytes: relay_pending_max_bytes,
				maxPendingAgeMs: relay_pending_max_ms,
				onOverflow: quarantineRelaySpill
			});
			// Forward each inbound frame VERBATIM to every other worker's ring -
			// the primary never parses relay traffic, it moves bytes. Ring
			// activity also proves the worker alive (the same reasoning as the
			// any-postMessage-advances-the-heartbeat rule: a worker saturating
			// the relay is busy, not dead).
			meta.ringReader = new RingReader(relay_ring.up, (frame) => {
				meta.lastHeartbeat = monotonicNow();
				for (const [w, m] of workers) {
					if (w !== worker && m.ringWriter !== null && relayEligible(m)) {
						const accepted = m.ringWriter.write(frame);
						if (accepted) {
							m.ringWriter.notify();
						}
					}
				}
			}, {
				// Generous headroom over the sender's ENVELOPE ceiling: a frame
				// also carries the topic, the event, the raw payload and the
				// stream stamps, so it is legitimately a multiple of the
				// envelope it was measured from. This bounds unbounded growth
				// rather than fitting tightly - a frame this far past it means
				// a peer not applying the ceiling, or a corrupt stream.
				maxFrameBytes: relay_frame_max_bytes > 0 ? relay_frame_max_bytes * 4 : Infinity,
				onOversized: (event) => {
					emitOperationalEvent({
						source: 'svelte-adapter-ws',
						component: 'runtime.cluster-relay',
						event: 'cluster-relay.frame-oversized',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'A worker sent a relay frame larger than this process will reassemble; its relay stream was stopped.',
						attributes: { declaredBytes: event.declaredBytes, maxFrameBytes: event.maxFrameBytes }
					});
					// The incident is attributed once, onto a surviving sibling
					// worker, never onto the sender whose stream this stop just
					// cut off (its up spill is about to retire it). A worker
					// with no metrics registry ignores the notice; the
					// operational event above is the log record either way.
					attributeRelayIncident(workers, worker, {
						type: 'relay-frame-oversized',
						declaredBytes: event.declaredBytes,
						maxFrameBytes: event.maxFrameBytes
					});
				}
			});
			meta.ringReader.start();
		}
		workers.set(worker, meta);

		worker.on('message', (msg) => {
			const meta = workers.get(worker);
			// Any inbound message proves the worker is alive: advance the
			// heartbeat clock so a worker saturated with publish/relay traffic
			// (whose heartbeat-ack queues behind the publishes) is never
			// false-flagged as unresponsive under sustained fan-out.
			if (meta) meta.lastHeartbeat = monotonicNow();
			if (msg.type === 'ready') {
				// An io worker reports 'ready' once it is listening; a compute
				// worker once its init hook has resolved. Both mark the worker
				// confirmed-alive and stamp its uptime clock; the crash-restart
				// budget resets on a later exit only if it stayed up.
				if (meta) meta.ready = true;
				if (msg.role === 'compute') console.log(`[svelte-adapter-ws] Compute worker ${worker.threadId} ready`);
				else {
					console.log(`[svelte-adapter-ws] Worker thread ${worker.threadId} listening on :${port}`);
					// First listening worker = the service accepts traffic.
					sdReadyOnce();
				}
				if (meta?.slot) restartSupervisor.noteReady(meta.slot);
			} else if (msg.type === 'heartbeat-ack') {
				// Liveness only; the clock already advanced above.
			} else if (msg.type === 'publish') {
				// Single relay (postMessage fallback lane). Like every relay
				// forward below, a quarantined peer is skipped: these
				// postMessage lanes stay live as the encode-failure fallback
				// while the rings run, and without the check they would keep
				// feeding relay traffic to a worker already being torn down.
				for (const [w, m] of workers) {
					if (w !== worker && relayEligible(m)) w.postMessage(msg);
				}
			} else if (msg.type === 'publish-batch') {
				// Batched relay: one postMessage per microtask from the
				// publishing worker. Forward each message individually so
				// receiving workers use the same single-message 'publish' path
				// in their relayPublish handler. The stamped seq and the
				// sender's origin/ordinal/birth ride along as frame metadata
				// for the receive side.
				for (const { topic, envelope, compress, seq, capability, event, data, origin, ord, birth } of msg.messages) {
					const relay = { type: 'publish', topic, envelope, compress, seq, capability, event, data, origin, ord, birth };
					for (const [w, m] of workers) {
						if (w !== worker && relayEligible(m)) w.postMessage(relay);
					}
				}
			} else if (msg.type === 'publish-batched') {
				// Wire-level batched relay (platform.publishBatched). Forward
				// the whole event list as one IPC frame so receiving workers
				// can re-detect the fast path locally and dispatch a single
				// batch envelope, instead of degrading to N individual relays.
				for (const [w, m] of workers) {
					if (w !== worker && relayEligible(m)) w.postMessage(msg);
				}
			}
		});

		worker.on('exit', (code) => {
			const meta = workers.get(worker);
			// The dead worker's slot ({ role, index }) drives the respawn so
			// its replacement re-occupies the SAME slot in the SAME role with
			// the same replayed workerData.app.
			const role = meta?.role ?? 'io';
			// The id stamped at spawn, NOT worker.threadId: Node nulls the
			// handle before emitting 'exit', so reading it here yields -1.
			const deadThreadId = meta?.threadId ?? -1;
			// Release the relay rings: close() unblocks each side's pending
			// Atomics wait so no promise (or the SharedArrayBuffer it retains)
			// outlives the worker.
			if (meta?.ringReader) meta.ringReader.close();
			if (meta?.ringWriter) meta.ringWriter.close();
			workers.delete(worker);
			exit_requested.delete(worker);
			if (!shutting_down) {
				// Each worker owns its listen socket in reuseport mode - when
				// it dies, the kernel stops routing to it automatically, so
				// there is no acceptor to pause. Charge the attempt against
				// THIS slot only and schedule ITS own respawn after ITS own
				// backoff. onExhausted (exit) fires from inside the supervisor
				// when the slot passes its attempt cap.
				const slot = meta?.slot ?? { role, index: 0 };
				const outcome = restartSupervisor.noteExit(slot);
				if (outcome && !('exhausted' in outcome)) {
					console.log(
						`[svelte-adapter-ws] Worker thread ${deadThreadId} (${slot.role}#${slot.index}) exited with code ${code}, ` +
						`restarting in ${outcome.delay}ms... (attempt ${outcome.attempts}/${RESTART_MAX_ATTEMPTS})`
					);
				}
			}
			// If shutting down and all workers have exited, exit immediately.
			if (shutting_down && workers.size === 0) {
				process.exit(0);
			}
		});

		worker.on('error', (err) => {
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.cluster',
				event: 'cluster.worker-error',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'A worker thread reported an error.',
				attributes: { error: diagnosticError(err) }
			});
		});
	}

	// One stable slot per desired worker. Registering every slot up front lets
	// the supervisor account for it (desired() / reconcile()) before its first
	// worker reports, and a respawn always targets the same { role, index }.
	for (let i = 0; i < io_count; i++) restartSupervisor.register({ role: 'io', index: i });
	for (let i = 0; i < compute_count; i++) restartSupervisor.register({ role: 'compute', index: i });
	for (let i = 0; i < io_count; i++) spawn_worker({ role: 'io', index: i });
	for (let i = 0; i < compute_count; i++) spawn_worker({ role: 'compute', index: i });
	// From here a latched signal has a fleet to shut down, so it waits for the
	// end of this branch instead of exiting directly.
	fleet_spawned = true;

	// --- TLS certificate hot-reload (cluster primary half) ---
	// The primary watches the cert directory and, on a renewed cert (certbot /
	// cert-manager), broadcasts {type:'tls-reload'} so every worker swaps its
	// own secure context in place (each worker validates + fingerprint-gates
	// its own apply; a bad cert keeps the previous one). The primary itself
	// terminates no TLS - reuseport workers own their listen sockets - so it
	// only tracks the disk cert's identity for observability. Live
	// connections survive a swap; node applies the new context to new
	// handshakes without re-binding.
	/** @type {Array<{ stop: () => void }>} */
	let primaryCertWatchers = [];
	let primaryTlsState = { hosts: [], fingerprint: null, notAfter: null, notAfterText: null };

	// Reload-path health, mirroring the per-worker record. The primary is the
	// only thing watching the cert directory in cluster mode, so a primary
	// whose watcher never started broadcasts nothing and NO worker ever picks
	// up a renewal - while every probe in the fleet stays green until the
	// served leaf expires and every handshake fails at once. Hourly sentinel,
	// armed only while degraded, silent until the leaf is inside the alert
	// window.
	const TLS_DEGRADED_CHECK_MS = 3600000;
	const primaryTlsHealth = { degraded: null, notAfter: null, notAfterText: null };
	let primaryTlsSentinel = null;
	/** @param {string} reason */
	function primaryTlsDegraded(reason) {
		primaryTlsHealth.degraded = reason;
		const alert = certExpiryAlert(primaryTlsHealth, wallEpoch());
		if (alert !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, alert));
		if (primaryTlsSentinel !== null) return;
		primaryTlsSentinel = setIntervalTimer(() => {
			const line = certExpiryAlert(primaryTlsHealth, wallEpoch());
			if (line !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, line));
		}, TLS_DEGRADED_CHECK_MS);
		if (primaryTlsSentinel && primaryTlsSentinel.unref) primaryTlsSentinel.unref();
	}
	function primaryTlsRecovered() {
		if (primaryTlsHealth.degraded !== null) {
			console.log(`[tls] primary certificate read recovered (was: ${primaryTlsHealth.degraded})`);
			primaryTlsHealth.degraded = null;
		}
		if (primaryTlsSentinel !== null) {
			clearIntervalTimer(primaryTlsSentinel);
			primaryTlsSentinel = null;
		}
	}
	function onCertChange() {
		let failure = null;
		primaryTlsState = reloadClusterTls({
			workers: workers.keys(),
			// No identity source on a PFX deployment: the broadcast still goes
			// out, the workers still swap, and the primary simply keeps no
			// expiry record instead of reporting a spurious read failure on
			// every successful renewal.
			source: identity_cert_path ? { certPath: identity_cert_path } : undefined,
			state: primaryTlsState,
			onError: (err) => { failure = err && err.message ? err.message : String(err); }
		});
		primaryTlsHealth.notAfter = primaryTlsState.notAfter ?? null;
		primaryTlsHealth.notAfterText = primaryTlsState.notAfterText ?? null;
		if (failure !== null) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_RELOAD_READ), failure);
			primaryTlsDegraded('the renewed certificate is unreadable on the primary');
		} else {
			primaryTlsRecovered();
		}
	}
	if (is_tls && ssl_watch && watched_dirs.length > 0) {
		// Record the boot cert's identity so the reload broadcast has a
		// baseline to report against, and its expiry so a later failure can be
		// reported with the number that says how urgent it is. A parse failure
		// only degrades primary-side observability - the workers gate on their
		// own reads. Skipped for a PFX bundle, which has no PEM identity to read.
		if (identity_cert_path) {
			try {
				primaryTlsState = readCertIdentity(identity_cert_path);
				primaryTlsHealth.notAfter = primaryTlsState.notAfter;
				primaryTlsHealth.notAfterText = primaryTlsState.notAfterText;
			} catch (err) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_BOOT_READ), err && err.message ? err.message : err);
			}
		}
		// Guard each watcher start: fs.watch throws ENOENT synchronously when
		// a parent directory does not exist (a not-yet-mounted secret volume,
		// a mistyped path). Single-process degrades gracefully here (its
		// cert-read gates the watcher), so the cluster primary must too - log
		// and degrade rather than crash-loop the whole process at boot. One
		// unarmed directory means renewals landing THERE are never seen, so
		// any failure enters the degraded state even when other directories
		// armed.
		let watchFailed = false;
		for (const dir of watched_dirs) {
			try {
				const watcher = createCertWatcher({
					certPath: identity_cert_path || watched_files[0],
					dir,
					debounceMs: ssl_reload_debounce_ms,
					onChange: onCertChange,
					// Post-arm watcher death (directory removed, EPERM): the
					// watcher closes itself; renewals landing in this directory
					// are no longer seen, which is the same degraded state as a
					// watcher that never armed.
					onError: (err) => {
						console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_WATCH), /** @type {any} */ (err)?.message || err);
						primaryTlsDegraded(`the certificate watch on ${dir} stopped`);
					}
				});
				watcher.start();
				primaryCertWatchers.push(watcher);
				console.log(`[tls] primary watching ${dir} for certificate renewals (cluster broadcast reload)`);
			} catch (err) {
				watchFailed = true;
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_WATCH), err && err.message ? err.message : err);
			}
		}
		if (watchFailed) {
			// Nothing retries this: a renewal in an unwatched directory never
			// broadcasts, so those workers serve their current certificate
			// until it expires.
			primaryTlsDegraded('a primary certificate directory watch failed to start, so renewals there will not be broadcast');
		}
	}

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		// A worker still finishing its own boot can report `ready` after this
		// point; the announcement is withheld from here on for the same reason
		// a mid-boot signal withholds it.
		sd_ready_withheld = true;
		sdNotify.stopping();
		sdNotify.disarmWatchdog();
		console.log(`[svelte-adapter-ws] Primary received ${reason}, shutting down ${workers.size} workers...`);

		// Cancel all pending worker restarts so we don't spawn during
		// shutdown. (The supervisor also re-checks shutting_down when a timer
		// fires, so a respawn already in flight is a no-op even if it races
		// this.)
		restartSupervisor.stopAll();

		// Stop the cert-directory watchers so they never hold the loop or fire
		// a broadcast at exiting workers.
		for (const watcher of primaryCertWatchers) watcher.stop();
		primaryCertWatchers = [];

		// Step 1: readiness OFF on every worker, BEFORE the delay below. The
		// workers own the readiness route, so this is what makes the delay do
		// its job: a load balancer polls readiness, and it can only deregister
		// this instance during the propagation window if the answer flips at
		// the START of that window. Draining is not closing - every worker
		// keeps its listen socket open and keeps serving, so the requests the
		// balancer has not stopped sending yet are still answered.
		for (const [worker] of workers) {
			try { worker.postMessage({ type: 'drain' }); } catch { /* worker already exiting */ }
		}
		console.log(`[primary] Readiness now reports NOT ready on ${workers.size} worker(s); still accepting.`);

		// Step 2: keep accepting connections until the load balancer has had
		// time to remove this pod from rotation (Kubernetes rolling updates).
		// SHUTDOWN_DELAY_MS=0 (default) skips this and is correct for non-k8s
		// deploys.
		if (shutdown_delay > 0) {
			console.log(`[primary] Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimer(resolve, shutdown_delay));
		}

		// Step 3: tell workers to drain and exit. Each worker bounds its OWN
		// whole teardown (hooks plus both drains) by SHUTDOWN_TIMEOUT.
		for (const [worker] of workers) {
			try { worker.postMessage({ type: 'shutdown' }); } catch { /* worker already exiting */ }
		}

		// Backstop, not the budget: the workers self-bound at SHUTDOWN_TIMEOUT,
		// so this fires one exit grace LATER and only reaches a worker whose
		// teardown machinery is itself wedged - a worker inside its budget must
		// never lose the race to its own supervisor. Each request carries its
		// own terminate fallback. The last worker's exit handler
		// (workers.size === 0) performs the clean primary process.exit(0).
		//
		// SHUTDOWN_TIMEOUT=0 is the no-budget spelling, so there is no
		// force-exit to arm: each worker awaits its own hook, drain and
		// cleanup listeners for as long as they take, and cutting them off
		// from here would be the same deadline by another name.
		if (shutdown_timeout > 0) {
			const t = setTimer(() => {
				for (const [worker] of workers) requestWorkerExit(worker, 0);
			}, shutdown_timeout * 1000 + WORKER_EXIT_GRACE_MS);
			if (t && t.unref) t.unref();
		} else {
			console.log('[primary] SHUTDOWN_TIMEOUT=0: no shutdown budget - workers exit when their own teardown finishes, however long that takes.');
		}
	}

	// The fleet is up and every handler above is installed, so the latch is
	// spent: a signal from here on dispatches straight into the shutdown, and
	// one taken during boot runs now, against the complete fleet.
	primary_booted = true;
	if (boot_signal) graceful_shutdown(boot_signal);
} else {
	// ── Worker thread or single-process mode ─────────────────────────────

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
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_LISTENER_THREW), err);
			}
		}
	}

	/**
	 * @param {string} signal - an OS signal name, or 'shutdown' when the
	 *   cluster primary asked this worker to go down (the primary already
	 *   spent the load-balancer delay, so it is not spent again here)
	 * @param {typeof import('./handler.js')} handler
	 */
	async function performShutdown(signal, handler) {
		if (phase === 'shutting-down') return;
		phase = 'shutting-down';
		if (isMainThread) {
			sdNotify.stopping();
			sdNotify.disarmWatchdog();
		}

		// Readiness flips first so the balancer routes away while the listener
		// still accepts - a poll-interval race never sees a closed socket.
		handler.beginDrain();
		if (shutdown_delay > 0 && signal !== 'shutdown') {
			await new Promise((resolve) => setTimeout(resolve, shutdown_delay)); // determinism-allow: process-level shutdown pacing, outside the replayable runtime
		}

		// ONE budget for everything that follows: SHUTDOWN_TIMEOUT bounds the
		// whole teardown sequence (app cleanup hooks, then the WS and HTTP
		// drains), not each phase separately - a hook that eats the budget
		// leaves the drains only what remains, so the process is down when the
		// operator's number says it is. The readiness delay above is outside
		// the budget: it is a wait the operator asked for, not work that can
		// overrun. Under SHUTDOWN_TIMEOUT=0 every phase runs unbounded; the
		// second-signal force-exit is the escape hatch.
		// Monotonic anchor: a wall-clock step during the hooks phase must not
		// stretch or collapse what the drains have left.
		const budgetMs = shutdown_timeout * 1000;
		const deadlineAt = budgetMs > 0 ? monotonicNow() + budgetMs : null;
		const hooks = (async () => {
			await runShutdownCleanup(signal);
			await handler.runAppShutdownHook?.();
		})().catch((err) => {
			console.error('[svelte-adapter-ws] app shutdown hook failed:', err);
		});
		if (deadlineAt !== null) {
			const EXPIRED = Symbol('expired');
			/** @type {any} */
			let timer = null;
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => resolve(EXPIRED), budgetMs); // determinism-allow: process-level shutdown budget, outside the replayable runtime
				if (typeof timer?.unref === 'function') timer.unref();
			});
			const outcome = await Promise.race([hooks, deadline]);
			if (timer) clearTimeout(timer); // determinism-allow: pairs with the shutdown budget above
			if (outcome === EXPIRED) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_LISTENERS_UNSETTLED));
			}
		} else {
			await hooks;
		}
		// The drains get the REMAINDER of the sequence budget, floored at 1ms
		// because timeoutMs 0 is the no-budget spelling: an exhausted budget
		// must cut the drains immediately, not unbound them.
		await handler.shutdown({
			timeoutMs: deadlineAt !== null ? Math.max(1, deadlineAt - monotonicNow()) : 0
		});
		process.exit(0);
	}

	/**
	 * @param {string} signal
	 * @param {typeof import('./handler.js')} handler
	 */
	function dispatchShutdown(signal, handler) {
		// A throw out of the sequence's own machinery must still end the
		// process: an unhandled rejection here would leave a half-drained
		// server running with readiness already flipped.
		performShutdown(signal, handler).catch((err) => {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_FAILED), err);
			process.exit(1);
		});
	}

	if (isMainThread) {
		// Single-process mode. Signals are armed before the handler module
		// ever evaluates, so a signal arriving mid-boot is latched rather than
		// lost; it dispatches the moment start() resolves.
		const handlerPromise = (async () => {
			const handler = await import('./handler.js');
			await handler.start(host, port);
			phase = 'running';
			if (latchedSignal !== null) {
				dispatchShutdown(latchedSignal, handler);
			} else {
				// An instance that took a signal mid-boot is already draining
				// and about to exit, so it never announces itself READY -
				// telling the supervisor it came up, one tick before it goes
				// down, is how a rolling deploy convinces itself the new
				// instance is healthy.
				sdReadyOnce();
			}
			return handler;
		})();

		for (const signal of ['SIGINT', 'SIGTERM']) {
			process.on(signal, () => {
				if (phase === 'boot') {
					latchedSignal = signal;
					sd_ready_withheld = true;
					return;
				}
				// A second signal while already draining is the operator
				// saying "now": exit immediately instead of waiting out hooks
				// or the drain window.
				if (phase === 'shutting-down') {
					console.error(`[svelte-adapter-ws] second ${signal} during shutdown; exiting immediately.`);
					process.exit(1);
				}
				void handlerPromise.then((handler) => dispatchShutdown(signal, handler));
			});
		}

		await handlerPromise;
	} else {
		// Worker thread startup: role decides whether this worker listens.
		// The handler graph is evaluated first (the boot-deadline watchdog on
		// the primary covers a wedge inside module evaluation), then the
		// message router registers BEFORE `await start()` so a worker still
		// running - or wedged in - its `init` hook still answers the
		// primary's liveness heartbeats. A healthy async init keeps its event
		// loop free and keeps acking, so the primary tells it apart from a
		// wedge and never boot-kills it. Until the graph is committed
		// (`booted`), only liveness, drain and terminate are actioned - relay
		// and other control traffic is buffered and replayed in arrival order
		// once boot completes, never dispatched into a half-built graph.
		const handler = await import('./handler.js');
		const role = workerData?.role ?? 'io';
		let booted = false;
		/** @type {any[]} */
		const boot_backlog = [];

		/**
		 * Leave the ready rotation. Safe from the FIRST tick of this worker:
		 * it touches only the lifecycle state, which the handler graph
		 * imported above has already built - never a route, a socket or the
		 * relay.
		 */
		function applyDrain() {
			handler.beginDrain();
			console.log(`[worker ${threadId}] Readiness now reports NOT ready (draining); still accepting.`);
		}

		// Control messages that need the live handler graph. `drain` is
		// deliberately NOT one of them - it is handled ahead of this gate in
		// the message router.
		function dispatchControl(msg) {
			if (msg.type === 'shutdown') {
				console.log(`[svelte-adapter-ws] [worker ${threadId}] Received shutdown, shutting down gracefully...`);
				dispatchShutdown('shutdown', handler);
			} else if (msg.type === 'publish') {
				handler.relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data, msg.origin, msg.ord, msg.birth);
			} else if (msg.type === 'publish-batched') {
				handler.relayPublishBatched(msg.events, msg.compress);
			} else if (msg.type === 'tls-reload') {
				// Primary detected a renewed cert on disk and broadcast a
				// reload. Swap this worker's secure context in place
				// (fingerprint-gated; a torn read keeps the previous one).
				// No-op unless TLS + SSL_WATCH, so an opted-out worker
				// ignores it.
				handler.reloadTls();
			}
		}
		parentPort.on('message', (msg) => {
			if (msg.type === 'drain') {
				// Applied NOW, never buffered, even mid-boot. Buffering it
				// would replay it after `start()` has already committed this
				// worker to `ready` - for an instance the primary put into
				// shutdown before it finished booting. Leaving the rotation is
				// exactly the kind of decision that must not wait for the boot
				// it is overtaking: a worker drained mid-boot never announces
				// itself ready at all (start() commits readiness only from the
				// starting state).
				applyDrain();
				return;
			}
			const action = routeWorkerMessage(msg.type, booted);
			if (action === 'ack') {
				// Liveness ack - answered even mid-init (this handler is live
				// before `await start()`) so a slow-but-healthy boot is never
				// mistaken for a wedge. The primary advances its heartbeat
				// clock on any inbound message, so this doubles as the
				// boot-liveness signal.
				parentPort.postMessage({ type: 'heartbeat-ack' });
			} else if (action === 'terminate') {
				// Primary asked us to exit (steady-state or boot-deadline
				// timeout, spill quarantine, or shutdown timeout). Honored
				// during init too so a boot-deadline escalation lands cleanly;
				// a genuinely wedged loop cannot process it and the primary
				// terminates the thread as the fallback. A plain Node worker
				// holds no native socket handles, so a direct exit is clean.
				process.exit(typeof msg.code === 'number' ? msg.code : 0);
			} else if (action === 'dispatch') {
				dispatchControl(msg);
			} else {
				// buffer: handler graph not committed yet - hold relay /
				// shutdown / tls-reload until boot completes, then replay in
				// arrival order.
				boot_backlog.push(msg);
			}
		});

		if (role === 'compute') {
			// Compute worker: fire the app's `init` hook (which receives
			// `workerData.app` - the shared memory seeded in primaryInit) but
			// never bind a listen socket, so a latency-critical tick pays no
			// connection-I/O jitter. `ready` is posted once init resolves.
			await handler.start(host, port, { listen: false });
		} else {
			// Reuseport io worker: bind the shared port directly; the kernel
			// distributes incoming connections via SO_REUSEPORT. `init` fires
			// once per worker; `ready` is posted only after the hook resolves
			// so the primary's worker-ready bookkeeping matches actual
			// readiness.
			await handler.start(host, port, { reusePort: true });
		}
		parentPort.postMessage({ type: 'ready', role });

		// Handler graph is live: drain any relay / control traffic that
		// arrived during init, in arrival order, then switch to live dispatch.
		booted = true;
		for (const msg of boot_backlog) dispatchControl(msg);
		boot_backlog.length = 0;

		// The sender-side frame ceiling is applied whether or not the rings
		// are enabled: `CLUSTER_RELAY_RING_KB=0` is a documented configuration
		// and its postMessage fan-out is no more able to absorb an arbitrarily
		// large frame than the ring is. Set BEFORE the ring block for that
		// reason. The refusal event carries sizes only - no topic names cross
		// into the log.
		if (typeof workerData?.relayMaxFrameBytes === 'number' && workerData.relayMaxFrameBytes > 0) {
			handler.setRelayFrameCeiling(workerData.relayMaxFrameBytes, (lane, _topic, bytes, limit) => {
				emitOperationalEvent({
					source: 'svelte-adapter-ws',
					component: 'runtime.cluster-relay',
					event: 'cluster-relay.frame-refused',
					severity: 'warn',
					dataClass: 'pseudonymous',
					message: 'A publish was too large for the cluster relay and was not sent to other workers. Local subscribers received it.',
					attributes: { lane, bytes, limitBytes: limit }
				});
			});
		}
		// Shared-memory relay rings (when the primary enabled them): outbound
		// relays ride the up ring (handler/relay.js), and inbound frames -
		// forwarded verbatim by the primary from a sibling worker - decode
		// here into the exact dispatch the postMessage path performs. Started
		// after the graph is live; the postMessage path above stays as the
		// fallback / control lane.
		if (workerData?.relayRing) {
			// The up writer carries the SAME ceilings as the primary's down
			// writers: a stalled primary must not let every publishing worker
			// spill without bound in its own heap. The action differs from the
			// down direction - a worker cannot quarantine the primary, so it
			// reports and exits through the supervised path that already
			// replaces it.
			handler.setRelayRingWriter(new RingWriter(workerData.relayRing.up, {
				maxPendingBytes: workerData.relayRing.maxPendingBytes,
				maxPendingAgeMs: workerData.relayRing.maxPendingAgeMs,
				onOverflow: (event) => {
					emitOperationalEvent({
						source: 'svelte-adapter-ws',
						component: 'runtime.cluster-relay',
						event: 'cluster-relay.up-spill-overflow',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'This worker could not hand its relay backlog to the primary within its spill ceiling and is exiting to be replaced.',
						attributes: { reason: event.reason, droppedBytes: event.droppedBytes, pendingAgeMs: event.pendingAgeMs }
					});
					process.exit(1);
				}
			}));
			const relayReader = new RingReader(workerData.relayRing.down, (frame) => {
				const msg = decodeRelayFrame(frame);
				if (msg === null) return;
				if (msg.type === 'publish') {
					handler.relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data, msg.origin, msg.ord, msg.birth);
				} else if (msg.type === 'publish-batched') {
					handler.relayPublishBatched(msg.events, msg.compress);
				}
			});
			relayReader.start();
		}
	}
}
