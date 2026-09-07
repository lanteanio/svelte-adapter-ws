// The realtime engine: WebSocket upgrade admission, connection lifecycle,
// the JSON control-frame demux, and the authenticate preflight endpoint.
// Semantics mirror the family's native tier; the transport is the `ws`
// library over the node HTTP server.

// Substituted by the adapter's build step; free identifiers until then.
/* global WS_OPTIONS */
/* global WS_PATH */
/* global WS_AUTH_PATH */
import { WebSocketServer } from 'ws';
import {
	WS_ATTRIBUTION, WS_CAPS, WS_CONNECTION_PERMIT, WS_LEASE, WS_PENDING_REQUESTS, WS_PLATFORM,
	WS_PUBLISH_GRANT, WS_SESSION_ID, WS_STATS, WS_SUBSCRIPTIONS,
	beginPendingSubscribe, pendingSubscribeTotal, settlePendingSubscribe,
	settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership,
	tombstonePendingSubscribe, isPendingSubscribeCancelled,
	releaseDerivedSubscriptions, declareConnectionSlots
} from '../utils/ws-symbols.js';
import { MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../utils/caps.js';
import {
	deniesWireSystemTopicSubscribe, deniesWireSubscribePreHook,
	deniesWireSubscribeLanding, wantsRecover, recoverIsRevoked,
	deniesRefLessRecover, deniesRefLessRecoverBatch, recoverRequiresRefFrame,
	exceedsSubscriptionCap, exceedsPendingSubscribeCap, deniesUngrantedObserve
} from '../utils/subscribe-policy.js';
import { isValidWireTopic } from '../utils/topic.js';
import { assert, fatal, wireAssertionMetrics } from '../utils/assertions.js';
import { containMetricInstrument, mirrorRegistry } from '../utils/metrics.js';
import { metricsRegistry } from '../metrics-bridge.js';
import {
	createTransportMetricHooks, HTTP_DURATION_BUCKETS, UPGRADE_DURATION_BUCKETS,
	WS_CONNECTION_DURATION_BUCKETS, WS_MESSAGE_DURATION_BUCKETS
} from '../transport-metrics.js';
import { emitPressureMetricTelemetry, probeOsPressureSources } from '../utils/os-pressure.js';
import { countOpenFds, readFdLimits } from '../utils/fd-limit.js';
import { PRESSURE_REASON_CODES } from '../observability-manifest.js';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { isOriginAllowed, isAuthOriginAccepted, describeUnsafeSameOriginConfig } from '../utils/origin.js';
import { installAttribution } from '../utils/attribution.js';
import { snapshotUpgradeHeaders } from '../utils/upgrade-headers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { createSlidingWindowLimiter } from '../utils/rate-limiter.js';
import { activeTraceContext, extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { resolveRequestId } from '../utils/request-id.js';
import {
	createMessageAdmission, runAdmittedMessageHook, runAdmittedMessageWork, messageOverloadedFrame
} from '../utils/message-admission.js';
import {
	createUpgradeAdmission, negotiateRejection, isCursorLaneUpgrade, resolveWaitingRoom,
	createWaitingRoomRequest, sendWaitingRoomPage, buildAccessibleCapacityRefusalPage,
	jitterRetryAfter, REFUSAL_RETRY_AFTER_SECONDS, createPollCounter
} from '../utils/upgrade-admission.js';
import { createConnectionPermitCarrier } from '../utils/connection-permit.js';
import { createPosture } from '../utils/pressure.js';
import { startPostureExport } from '../utils/posture-export.js';
import { hasMultipleWorkers } from './cluster-sequence-policy.js';
import { createConsistencyAuditor } from '../auditor.js';
import { buildConnectionAuditSnapshot } from '../audit-snapshot.js';
import { createResourceGrowthAuditor, structuralResourceProbes } from '../leak-probes.js';
import { waitingRoomRenderer } from '../waiting-room-renderer-bridge.js';
import { parseCookies, createCookies } from '../cookies.js';
import {
	createLeaseState, leaseGrantFrame, leaseReportedSaturation,
	controlFrameTooLargeFrame, DEFAULT_GRANT
} from '../wire.js';
import { now, monotonicNow, processMonotonicNow, randomFloat, randomUuid, wallEpoch, setTimer, setIntervalTimer, clearIntervalTimer, clearTimer } from '../runtime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorDefinition, adapterErrorMessage } from '../error-registry.js';
import { wsModule } from '../ws-handler-bridge.js';
import {
	capCounts, counters, decodeCache, divergenceDiagnostics, envelopePrefixCache, GAP_CONFIRM_MS,
	lastPublishWarnAt, maxSeenSeq, originStreams, pressureSnapshot, staticCache, streamTracking,
	subscribeAuth, takeConfirmedGaps, topicPublishStats, wsConnections, wsWrappers
} from './state.js';
import { signalRelayGaps } from './platform.js';
import { seqBound } from './seq-bound.js';
import { computeStateHash, partitionActiveTopics } from '../invariants.js';
import { DIVERGENCE_TOPIC_LIMIT, summarizeTopicSequences } from '../divergence-diagnostics.js';
import { detachWireStates } from './wire-state.js';
import { normalizePressureThresholds, startPressureSampler } from './pressure.js';
import { configureEgress } from './egress-budget.js';
import { leaseGrantSize } from '../wire.js';
import { recordBackpressureDrop } from '../utils/backpressure.js';
import { accountClosedLogicalSubscriptions, addLogicalSubscription, isSettledSubscriptionRegistry, removeLogicalSubscription, setSubscriptionAccountingHook } from '../utils/ws-symbols.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './ingress.js';
import { registerGameIngress, gameLaneClusterSafe } from './game-ingress.js';
import { registerSocket, unregisterSocket } from './topic-registry.js';
import { wrapWebSocket } from './ws-facade.js';
import { platform, flushCoalescedFor, hasUserSubscribeHook, runUserSubscribeGate, ALLOW_NON_ASCII_TOPICS } from './platform.js';
import { beginResumeCapture, discardResumeCapture, flushResumeTopic } from './resume-capture.js';
import { bumpIn, bumpOut, setStatsEnabled } from './conn-stats.js';
import { sendControl } from './control-egress.js';
import { origin as pinnedOrigin, host_header, protocol_header, port_header, is_tls, resolveClientIp, armCloseHookAccounting } from './config.js';
import { isDraining } from './lifecycle.js';

const OPEN = 1;

// A bare alias, deliberately. This module is imported only from inside the
// `if (WS_ENABLED)` branch, and the build sets WS_ENABLED from the same
// truthiness that decides whether WS_OPTIONS is an object, so the `|| {}` that
// used to sit here could never fire. It was not harmless: the option-contract
// scan follows aliases of WS_OPTIONS through bare identifiers only, so a
// logical expression here made every option this module reads invisible to the
// check that exists to catch an option declared and never read.
const wsOptions = WS_OPTIONS;
const MAX_PAYLOAD_LENGTH = wsOptions.maxPayloadLength ?? 1024 * 1024;
const MAX_BACKPRESSURE = wsOptions.maxBackpressure ?? 1024 * 1024;
const CLOSE_ON_BACKPRESSURE_LIMIT = wsOptions.closeOnBackpressureLimit === true;
const IDLE_TIMEOUT_S = wsOptions.idleTimeout ?? 120;
const SEND_PINGS = wsOptions.sendPingsAutomatically !== false;
const COMPRESSION = wsOptions.compression ?? false;
const ALLOWED_ORIGINS = wsOptions.allowedOrigins ?? 'same-origin';
const UPGRADE_TIMEOUT_S = wsOptions.upgradeTimeout ?? 10;
const AUTH_PATH_REQUIRE_ORIGIN = wsOptions.authPathRequireOrigin !== false;
const ALLOW_SYSTEM_TOPIC_SUBSCRIBE = wsOptions.allowSystemTopicSubscribe === true;

// Wire-subscribe authorization arming, seeded from the build. subscribeAuth
// lives in state.js so platform.authorizeWireSubscribe can arm it at runtime.
subscribeAuth.enabled = wsOptions.authorizeWireSubscribe === true || wsOptions.authorizeWireSubscribe === 'strict';
subscribeAuth.strict = wsOptions.authorizeWireSubscribe === 'strict';

// Refuse to start when the same-origin policy has no fronting trust to pin
// against: the check would compare two attacker-controlled headers and pass
// for any non-browser client.
const _unsafeOriginErr = describeUnsafeSameOriginConfig({
	allowedOrigins: ALLOWED_ORIGINS,
	hasOriginEnv: !!pinnedOrigin,
	hasHostHeader: !!host_header,
	isTls: is_tls,
	hasUpgradeHook: !!wsModule.upgrade,
	optOut: wsOptions.unsafeSameOriginWithoutHostPin === true
});
if (_unsafeOriginErr) throw new Error(_unsafeOriginErr);

// Warn about unrecognized handler exports - catches typos like "mesage".
const knownWsExports = new Set([
	'init', 'shutdown',
	'open', 'message', 'upgrade', 'close', 'drain',
	'subscribe', 'subscribeBatch', 'unsubscribe',
	'authenticate', 'resume', 'admin', 'attribution', 'egressTenantOf'
]);
for (const name of Object.keys(wsModule)) {
	if (!knownWsExports.has(name)) {
		console.warn(
			`[svelte-adapter-ws] Warning: WebSocket handler exports unknown "${name}". ` +
			`Did you mean one of: ${[...knownWsExports].join(', ')}?\n` +
			'  See: https://svti.me/ws-hooks'
		);
	}
}
armCloseHookAccounting(wsModule.close);
// The egress gate arms from the serialized option section; the tenant
// resolver comes from the handler module - the one carrier that reaches the
// runtime as a function. A defined non-function export refuses at startup
// rather than silently standing every tenant ceiling down.
configureEgress(wsOptions.egress, wsModule.egressTenantOf);

setStatsEnabled(!!wsModule.close);

// The client-relay binary twin: a `wire.ingress:1` connection can bind an id
// to kind `game:1` and publish game frames as `0x03`.
registerGameIngress();

// The 1 Hz pressure sampler and the live logical-subscription counter it
// reads. The hook fires from the shared add/remove primitives, so every
// lane - platform, wire, plugin trackedSubscribe - lands on one counter.
startPressureSampler(wsOptions.pressure);
// A second handler copy in one worker takes the shared sink from the first.
// Both keep their own counter and their own auditor, so the displaced one stops
// receiving deltas while the new one receives releases for memberships it never
// charged - the reported shapes being a total stuck under its summed
// bookkeeping, and a total driven negative by unmatched releases. Neither says
// why on its own, and the topology that causes it is invisible from either side.
//
// Reported, not asserted. A soft assertion throws under NODE_ENV=test, and
// loading two independently built runtimes into one test process is an ordinary
// thing for this suite to do - the condition is about a deployment carrying two
// copies, not about a harness that deliberately holds two.
if (setSubscriptionAccountingHook((delta) => { counters.totalSubscriptions += delta; })) {
	emitOperationalEvent({
		source: 'svelte-adapter-ws',
		component: 'runtime.subscription-accounting',
		event: 'runtime.subscription-accounting.sink-displaced',
		severity: 'warn',
		dataClass: 'operational',
		message: 'A second adapter runtime in this worker took over the subscription accounting sink. One subscription total is now frozen and the other is charged releases it never matched.',
		attributes: {}
	});
}

// - Per-worker consistency auditor -------------------------------------------
// A background check that runs the shared invariant predicates against a
// BOUNDED, structure-only snapshot of live connection state on a slow,
// seam-jittered, unref'd timer. It NEVER runs on the hot path: publish /
// send / subscribe / close pay nothing; the only cost is the bookkeeping they
// already do. Default on (5000ms); set `consistencyAuditIntervalMs: 0` to
// disable entirely (no timer scheduled, zero cost). A violation logs +
// increments the assertion counter (the soft tier); only a `subs.shape`
// corruption that PERSISTS across two consecutive audits of the same window
// escalates to the hard tier (a deferred worker restart), so a healthy or
// transient state is never killed.
const CONSISTENCY_AUDIT_INTERVAL_MS = wsOptions.consistencyAuditIntervalMs ?? 5000;
if (CONSISTENCY_AUDIT_INTERVAL_MS > 0) {
	// Build a bounded snapshot over the round-robin window the factory requests.
	// The builder iterates the connection Set ONCE with a skip-counter and only
	// allocates the window, so the cost is fixed per tick regardless of how many
	// connections the worker holds. `counters.totalSubscriptions` is read at call
	// time (not captured), so the cap accountant reflects the live value.
	const buildAuditSnapshot = ({ offset, limit }) => buildConnectionAuditSnapshot({
		connections: wsConnections,
		subscriptionsKey: WS_SUBSCRIPTIONS,
		sessionIdKey: WS_SESSION_ID,
		totalSubscriptions: counters.totalSubscriptions,
		offset,
		limit,
		isSettled: isSettledSubscriptionRegistry
	});
	// Soft by default; only `subs.shape` (a per-connection subscription slot
	// that is not a Set) escalates, and only when it persists across two audits.
	const auditor = createConsistencyAuditor({
		snapshot: buildAuditSnapshot,
		assert,
		fatal,
		hardCategories: ['subs.shape'],
		intervalMs: CONSISTENCY_AUDIT_INTERVAL_MS
	});
	counters.consistencyAuditor = auditor;
	auditor.start();
}

// - Cross-worker state-hash reporter (clustered mode only) ------------------
// On a slow, seam-jittered interval each worker folds its observed-seq map
// into one structure-only integer hash and reports it to the primary, which
// compares the live workers' hashes per primary-assigned epoch. Only the
// integer hashes and this thread id cross the boundary - no topic strings and
// no payloads. Gated on parentPort (there is nobody to disagree with in a
// single process) AND a positive interval (off by default), so an
// unconfigured deployment schedules no timer and pays nothing.
const STATE_HASH_INTERVAL_MS = wsOptions.stateHashIntervalMs ?? 0;
if (parentPort && STATE_HASH_INTERVAL_MS > 0) {
	// The same gate arms the relay-contiguity stamps, so the tracker only
	// runs where something will read what it tracks. Armed off, the relay
	// receive lanes pay one boolean test and allocate nothing.
	streamTracking.enabled = true;
	// Reporter-side activity tracking, diffed per tick against the previous
	// snapshot so the publish and relay hot paths pay nothing for the split.
	// The two mirrors hold the same topic strings by reference and are bounded
	// by maxSeenSeq's own cardinality: the partition prunes entries whose topic
	// has left the live map, so the registry cap is these mirrors' cap too.
	let reporterTick = 0;
	/** @type {Map<string, number>} */
	const reporterPrevSeqs = new Map();
	/** @type {Map<string, number>} */
	const reporterLastChanged = new Map();
	// The registry bound may forget a subscriber-free topic to stay inside its
	// ceiling, and a sibling that still holds it then reports a different hash.
	// That is only safe while the forgotten topic is QUIET - the quiet lane logs
	// a disagreement, the active lane can restart a worker over one - so the
	// reporter lends the bound its activity window and eviction never takes a
	// topic whose seq moved inside it. A single-process worker never installs
	// this: it has no sibling to disagree with.
	seqBound.useQuietProbe((topic) => {
		const changedAt = reporterLastChanged.get(topic);
		return changedAt !== undefined && reporterTick - changedAt > 1;
	});
	const reportStateHash = () => {
		reporterTick++;
		// The comparison is split: ACTIVE topics (seq moved within the last tick
		// window) carry the restart-authorized vote, because an active divergence
		// either self-heals on the next publish or is real; QUIET topics ride a
		// separate log-only hash, because a respawned worker legitimately holds
		// none of its siblings' quiet history and a maximum over a topic nobody
		// publishes can never re-converge.
		const { active, quiet } = partitionActiveTopics(maxSeenSeq, reporterPrevSeqs, reporterLastChanged, reporterTick);
		const hash = computeStateHash({ topicSeqs: active });
		const quietHash = computeStateHash({ topicSeqs: quiet });
		parentPort.postMessage({ type: 'state-hash', hash, quietHash, threadId, intervalMs: STATE_HASH_INTERVAL_MS });

		// A maximum only ever reveals a lost TAIL. A lost INTERIOR frame moves
		// no maximum - a worker that got [2,3] of a stream and one that got
		// [1,2,3] both report 3 - so it is caught by contiguity instead, and
		// REPORTED rather than voted on: this worker found the hole in a stream
		// that is dense by construction, so it already knows it lost the frames
		// and no comparison could tell it more. Each hole drains once, so this
		// is silent until something is actually lost.
		//
		// The event's identity comes from the registry entry rather than inline
		// literals, so the entry and the emission cannot drift apart.
		const RELAY_GAP = adapterErrorDefinition(ADAPTER_ERROR_IDS.RELAY_GAP);
		const confirmedGaps = takeConfirmedGaps(originStreams, processMonotonicNow(), GAP_CONFIRM_MS);
		// The operator hears below; this is the affected CLIENTS hearing.
		const gapSignals = signalRelayGaps(confirmedGaps);
		for (const gap of confirmedGaps) {
			const signal = gapSignals.get(gap.topic);
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: RELAY_GAP.component,
				event: RELAY_GAP.event,
				severity: RELAY_GAP.severity,
				dataClass: 'pseudonymous',
				message: RELAY_GAP.problemPrefix,
				attributes: {
					count: gap.count,
					topic: privateValueMetadata(gap.topic, 'topic'),
					originWorker: gap.origin,
					fromOrdinal: gap.from,
					toOrdinal: gap.to,
					signalledClients: signal === undefined ? 0 : signal.signalled,
					closedClients: signal === undefined ? 0 : signal.closed
				}
			});
			mRelayGap?.inc({}, gap.count);
			parentPort.postMessage({ type: 'relay-gap', threadId, count: gap.count });
		}
	};
	// Spread the FIRST report by a per-worker jitter, drawn from the injectable
	// RNG so a seeded harness reproduces the phase, then report on a FIXED
	// period. A fixed period keeps every worker on one cadence, so the primary -
	// which sizes its epoch bucket to comfortably exceed the period - reliably
	// collects one report from each. Jittering the PERIOD would let workers
	// drift out of any shared bucket, and a real divergence could then go
	// undetected: a silent false negative in the one mechanism that exists to
	// catch silent divergence.
	const firstReportDelay = randomFloat() * STATE_HASH_INTERVAL_MS;
	const stateHashKickoff = setTimer(() => {
		reportStateHash();
		const stateHashTimer = setIntervalTimer(reportStateHash, STATE_HASH_INTERVAL_MS);
		if (stateHashTimer.unref) stateHashTimer.unref();
	}, firstReportDelay);
	if (stateHashKickoff.unref) stateHashKickoff.unref();

	// The primary cannot touch a registry counter across the thread boundary, so
	// on a detected divergence it posts a notice back and the worker raises its
	// own. A separate listener from the relay one above: they never overlap on a
	// message type, and Node allows many.
	parentPort.on('message', (msg) => {
		if (msg && msg.type === 'state-divergence') {
			mStateDivergence?.inc({ role: msg.role === 'minority' ? 'minority' : 'majority' });
			// The aggregate detector deliberately carries no topic names. Only
			// after it fires does the primary request this bounded, keyed
			// high-water snapshot. The shared random key lives in workerData and
			// never appears in a message, log, metric or admin response.
			if (
				typeof msg.diagnosticId === 'string' && msg.diagnosticId.length <= 128 &&
				workerData?.divergenceDiagnosticKey
			) {
				parentPort.postMessage({
					type: 'state-divergence-detail',
					diagnosticId: msg.diagnosticId,
					threadId,
					summary: summarizeTopicSequences(
						maxSeenSeq,
						workerData.divergenceDiagnosticKey,
						// Honor the primary's requested bound, capped by this worker's
						// own limit so a compromised primary message cannot inflate
						// the snapshot.
						Number.isInteger(msg.topicLimit) && msg.topicLimit > 0
							? Math.min(msg.topicLimit, DIVERGENCE_TOPIC_LIMIT)
							: DIVERGENCE_TOPIC_LIMIT
					)
				});
			}
		} else if (msg && msg.type === 'state-divergence-diagnostic') {
			divergenceDiagnostics.set(msg.diagnostic);
		}
	});
}

const messageAdmission = createMessageAdmission(wsOptions.messageAdmission);

// Upgrade admission: the concurrent-handshake ceiling, the whole-lifetime
// connection bound, the reserved cursor sub-budget, and the bounded per-tick
// pacing queue. Every ceiling is off by default, so a zero-config build pays
// one comparison per upgrade and nothing else.
const admission = createUpgradeAdmission(wsOptions.upgradeAdmission);
const connectionPermitCarrier = createConnectionPermitCarrier();
const ADMISSION_PER_TICK_BUDGET = wsOptions.upgradeAdmission?.perTickBudget ?? 0;
// Whether any ceiling can reject. Read where the gate's bookkeeping would
// otherwise cost an unconfigured deployment something it can never use.
const ADMISSION_ARMED =
	admission.maxConcurrent > 0 || admission.maxConnections > 0 || ADMISSION_PER_TICK_BUDGET > 0;
// Content-negotiated rejection for over-capacity upgrades: resolved once (or
// null when off), and null keeps the bare 503. On by default whenever the gate
// can reject; the only escape is `waitingRoom: false`.
const WAITING_ROOM = resolveWaitingRoom(wsOptions.upgradeAdmission, waitingRoomRenderer);
// The rolling poll counter behind the queue-depth estimate. Created only with
// a room to report to, so nothing is allocated for a server without one.
const pollCounter = WAITING_ROOM !== null ? createPollCounter(WAITING_ROOM.pollIntervalMs) : null;

// Bounded label vocabularies for the transport RED families. Frozen label
// objects are built once per cell so an emit on a hot path allocates nothing,
// and an unrecognized method folds into `other` rather than seating a series
// per verb a scanner invents.
const HTTP_METRIC_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'other'];
/** @param {readonly string[]} left @param {string} leftKey @param {readonly string[]} outcomes */
function labelMatrix(left, leftKey, outcomes) {
	/** @type {Record<string, Record<string, Readonly<Record<string, string>>>>} */
	const matrix = {};
	for (const a of left) {
		/** @type {Record<string, Readonly<Record<string, string>>>} */
		const row = {};
		for (const b of outcomes) row[b] = Object.freeze({ [leftKey]: a, outcome: b });
		matrix[a] = Object.freeze(row);
	}
	return Object.freeze(matrix);
}
const HTTP_METRIC_LABELS = labelMatrix(HTTP_METRIC_METHODS, 'method',
	['ok', 'client_error', 'server_error', 'aborted']);
const WS_MESSAGE_METRIC_LABELS = labelMatrix(['text', 'binary'], 'kind', ['ok', 'error']);
const OUTCOME_ONLY_LABELS = Object.freeze(Object.fromEntries(
	['admitted', 'rejected', 'aborted', 'error', 'clean', 'abnormal']
		.map((outcome) => [outcome, Object.freeze({ outcome })])
));

/** @param {string} method @param {string} outcome */
function httpLabels(method, outcome) {
	const key = String(method || '').toLowerCase();
	return HTTP_METRIC_LABELS[HTTP_METRIC_METHODS.includes(key) ? key : 'other'][outcome];
}

/** @param {number} status */
function httpOutcome(status) {
	if (status >= 500) return 'server_error';
	if (status >= 400) return 'client_error';
	return 'ok';
}

// - Registry observability ---------------------------------------------------
// Opt-in via the `metrics` option - a module path (`websocket.metrics`) whose
// default export is a registry shaped like the extensions `createMetrics()`
// (positional counter/gauge factories). The build bundles it; the runtime
// imports it here through the bridge and also exposes it on `platform.metrics`
// for a scrape route. Instruments resolve once; every emit is optional-chained,
// so the disabled path (registry null) costs one undefined check per site and
// the accept path allocates nothing.
//
// Registrations go through a MIRRORING wrapper: every value the runtime writes
// is recorded under the adapter's own declared name, which is what
// `platform.metricsSnapshot()` merges across worker threads. Merging the
// registry's RENDERED text instead is wrong - a registry that namespaces its
// output (the documented way to use one) renders names the manifest cannot
// match, and the cluster merge would silently degrade to per-worker
// passthrough. `platform.metrics` still exposes the real registry, so an app's
// own scrape route is unaffected.
const METRICS = mirrorRegistry(metricsRegistry);
const mUpgradeAdmitted = containMetricInstrument(METRICS?.counter(
	'upgrade_admitted_total', 'WebSocket upgrades accepted'
));
const mUpgradeRejected = containMetricInstrument(METRICS?.counter(
	'upgrade_rejected_total', 'WebSocket upgrades rejected before open', ['reason']
));
const mUpgradeDeferredRejected = containMetricInstrument(METRICS?.counter(
	'upgrade_deferred_rejected_total',
	'Upgrade callbacks shed because the bounded deferral queue was full'
));
const mUpgradeRateEvicted = containMetricInstrument(METRICS?.counter(
	'upgrade_rate_map_evicted_total', 'Rate-limit entries evicted at the map cap', ['door']
));
const mPostureTransitions = containMetricInstrument(METRICS?.counter(
	'protection_posture_transitions_total', 'Protection posture level changes', ['from', 'to']
));
const gPostureState = containMetricInstrument(METRICS?.gauge(
	'protection_posture_state', 'Current protection posture (0 normal, 1 elevated, 2 siege)'
));
const gUpgradeInflight = containMetricInstrument(METRICS?.gauge(
	'upgrade_inflight', 'Upgrades currently between admission and open'
));
const gUpgradeDeferredDepth = containMetricInstrument(METRICS?.gauge(
	'upgrade_deferred_depth', 'Upgrade callbacks waiting in the bounded pacing queue'
));
const gUpgradeDeferredOldestAge = containMetricInstrument(METRICS?.gauge(
	'upgrade_deferred_oldest_age_seconds',
	'Age of the oldest callback in the bounded upgrade pacing queue'
));
if (gUpgradeDeferredDepth !== undefined || gUpgradeDeferredOldestAge !== undefined) {
	admission.setDeferredObserver((depth, oldestAgeMs) => {
		gUpgradeDeferredDepth?.set(depth);
		gUpgradeDeferredOldestAge?.set(oldestAgeMs / 1000);
	});
}
const gConnectionHeadroom = admission.maxConnections > 0
	? containMetricInstrument(METRICS?.gauge(
		'ws_connection_headroom',
		'Remaining reserved-or-live WebSocket connection permits'
	))
	: undefined;
gConnectionHeadroom?.set(admission.connectionHeadroom);
const gQueueDepth = containMetricInstrument(METRICS?.gauge(
	'waiting_room_queue_depth', 'Clients currently polling the waiting room'
));
// Outbound-backpressure telemetry, sampled from the 1 Hz pressure snapshot.
// Worst per-connection buffered bytes seen over the sampled connection set,
// and the count of sampled connections holding a notable outbound queue.
const gBackpressureMaxBytes = containMetricInstrument(METRICS?.gauge(
	'ws_backpressure_max_bytes', 'Worst per-connection outbound buffered bytes over the sampled set'
));
const gBackpressureConnections = containMetricInstrument(METRICS?.gauge(
	'ws_backpressure_connections', 'Sampled connections holding a backpressured outbound queue'
));
const mDroppedFrames = containMetricInstrument(METRICS?.counter(
	'ws_dropped_frames_total', 'Outbound WebSocket frames dropped under backpressure', []
));
const mDroppedBytes = containMetricInstrument(METRICS?.counter(
	'ws_dropped_bytes_total', 'Outbound WebSocket payload bytes dropped under backpressure', []
));
// The rest of what the 1 Hz sampler already computes. These are scalars the
// fold produces and then discards - exporting them adds gauge writes to a
// callback that already runs, and no new work to any per-request or
// per-message path.
const gConnections = containMetricInstrument(METRICS?.gauge(
	'ws_connections', 'Live WebSocket connections'
));
const gSubscriptions = containMetricInstrument(METRICS?.gauge(
	'ws_subscriptions', 'Live topic subscriptions; divide by ws_connections for the subscriber ratio'
));
// A counter, not the sampler's precomputed rate: a rate baked at our cadence
// cannot be re-windowed by the query, and reads wrong whenever the scrape
// interval differs from the sample interval.
const mPublishes = containMetricInstrument(METRICS?.counter(
	'ws_publishes_total', 'Publish calls made, never per-recipient deliveries', []
));
const mHttpRequests = containMetricInstrument(METRICS?.counter(
	'http_requests_total', 'Completed HTTP requests by bounded method and outcome', ['method', 'outcome']
));
const hHttpDuration = containMetricInstrument(METRICS?.histogram?.(
	'http_request_duration_seconds', 'HTTP request completion duration in seconds', {
		labelNames: ['method', 'outcome'],
		buckets: [...HTTP_DURATION_BUCKETS]
	}
));
const hUpgradeDuration = containMetricInstrument(METRICS?.histogram?.(
	'upgrade_duration_seconds', 'WebSocket upgrade decision duration in seconds', {
		labelNames: ['outcome'],
		buckets: [...UPGRADE_DURATION_BUCKETS]
	}
));
const mWsMessages = containMetricInstrument(METRICS?.counter(
	'ws_messages_total', 'Completed inbound WebSocket messages by kind and outcome', ['kind', 'outcome']
));
const mMessageAdmissionRejected = containMetricInstrument(METRICS?.counter(
	'ws_message_admission_rejected_total', 'Application WebSocket messages shed by established-message admission', ['reason', 'scope']
));
const hWsMessageDuration = containMetricInstrument(METRICS?.histogram?.(
	'ws_message_duration_seconds', 'Inbound WebSocket message handling duration in seconds', {
		labelNames: ['kind', 'outcome'],
		buckets: [...WS_MESSAGE_DURATION_BUCKETS]
	}
));
const hWsConnectionDuration = containMetricInstrument(METRICS?.histogram?.(
	'ws_connection_duration_seconds', 'WebSocket connection lifetime in seconds', {
		labelNames: ['outcome'],
		buckets: [...WS_CONNECTION_DURATION_BUCKETS]
	}
));
// Scope note, because it differs from the family's other backend and the
// difference is not a choice: there, the counter covers native fan-out calls
// only, and a publish that excludes a socket falls through to a per-socket
// walk that the breakdown never sees. Every publish here IS that walk, so the
// same scope would count nothing at all. It therefore covers every logical
// publish, classified by whether the publish reached anyone with the excluded
// socket deducted - which is also why this family sums to ws_publishes_total
// here. The help string is the manifest's, and the manifest is vendored.
const mPublishOutcomes = containMetricInstrument(METRICS?.counter(
	'ws_publish_outcomes_total', 'Publish calls by aggregate delivery outcome', ['outcome']
));
// Only the publish-outcome hook is taken from the shared transport helper. Its
// HTTP and WebSocket wrappers patch a uWS response object and wrap ONE
// behavior object - neither shape exists on this transport, and both would
// apply silently and measure nothing - so those emit sites are wired directly
// against the node request and per-socket listeners instead.
const transportMetricHooks = createTransportMetricHooks({ publishOutcomes: mPublishOutcomes }, monotonicNow);
counters.publishOutcomeHook = transportMetricHooks?.publishOutcome ?? null;
const gPressureSaturation = containMetricInstrument(METRICS?.gauge(
	'pressure_saturation', 'Worker saturation, 0 healthy to 1 at the configured thresholds'
));
const gPressureReason = containMetricInstrument(METRICS?.gauge(
	'pressure_reason', 'Pressure reason as a severity-ordered code (0 none to 6 memory)'
));
const mPressureReasonTransitions = containMetricInstrument(METRICS?.counter(
	'pressure_reason_transitions_total', 'Pressure reason changes, including incidents and recoveries', ['from', 'to']
));
const gResidentBytes = containMetricInstrument(METRICS?.gauge(
	'resident_memory_bytes', 'Resident set size of the process'
));
const gHeapUsedRatio = containMetricInstrument(METRICS?.gauge(
	'heap_used_ratio', 'Used fraction of the nearest memory wall (heap vs the V8 limit, resident set vs the cgroup memory limit, worst-of)'
));
// Freshness of the sample the gauges above were written from. The pressure
// timer is unref'd and driven from one interval; if it ever stops, every gauge
// here keeps serving its last value against a target that still reads up.
// Alerting on the age of this timestamp is what separates "healthy and steady"
// from "frozen".
const gSampleTimestamp = containMetricInstrument(METRICS?.gauge(
	'pressure_sample_timestamp_seconds', 'Unix time of the most recent pressure sample; alert on its age'
));
// Kernel pressure readings. Availability is probed ONCE here rather than
// discovered on the first sample, so these register at startup like every other
// instrument: creating an instrument inside the 1 Hz tick would put a
// configuration fault (a registry that throws on registration, which is meant
// to fail loudly at boot) into a timer callback that repeats forever. A host
// without the source registers nothing, so the gauges are absent rather than
// serving a zero that reads as "no pressure".
const OS_PRESSURE_SOURCES = METRICS == null ? null : probeOsPressureSources();
const gPsiCpuSome = OS_PRESSURE_SOURCES?.psi !== false
	? containMetricInstrument(METRICS?.gauge(
		'psi_cpu_some_avg10', 'Kernel pressure-stall CPU some avg10'
	))
	: undefined;
const gPsiMemoryFull = OS_PRESSURE_SOURCES?.psi !== false
	? containMetricInstrument(METRICS?.gauge(
		'psi_memory_full_avg10', 'Kernel pressure-stall memory full avg10'
	))
	: undefined;
const gPsiIoFull = OS_PRESSURE_SOURCES?.psi !== false
	? containMetricInstrument(METRICS?.gauge(
		'psi_io_full_avg10', 'Kernel pressure-stall IO full avg10'
	))
	: undefined;
const gCpuThrottled = OS_PRESSURE_SOURCES?.cpuThrottle !== false
	? containMetricInstrument(METRICS?.gauge(
		'cpu_throttled_ratio', 'Fraction of the window the cgroup CPU quota held the process suspended'
	))
	: undefined;
// Descriptor observability. Worker threads share one process-wide fd table, so
// any worker's registry reports the whole-process truth. Each gauge registers
// only where its source exists (Linux/macOS; null on Windows). The soft limit
// is captured once - an external prlimit change mid-flight is rare enough to
// ignore.
const FD_SOFT_LIMIT = METRICS == null ? null : (readFdLimits()?.soft ?? null);
const gOpenFds = METRICS != null && countOpenFds() !== null
	? containMetricInstrument(METRICS?.gauge(
		'open_fds', 'File descriptors currently open by the process'
	))
	: undefined;
const gFdSoftLimit = FD_SOFT_LIMIT !== null && Number.isFinite(FD_SOFT_LIMIT)
	? containMetricInstrument(METRICS?.gauge(
		'fd_soft_limit', 'Soft file-descriptor limit; new sockets fail with EMFILE at this count'
	))
	: undefined;
gFdSoftLimit?.set(FD_SOFT_LIMIT);
// Cross-worker state-hash divergence detections. The primary owns no registry
// across the thread boundary, so it posts a notice back and the worker raises
// its own counter - once per divergent epoch per role, since the primary
// judges each bucket once.
const mStateDivergence = containMetricInstrument(METRICS?.counter(
	'state_divergence_total', 'Cross-worker state hash divergence detections', ['role']
));
// Relayed frames this worker was sent and never received. The contiguity
// check that finds a gap reads the per-topic stream stamps, which the
// state-hash reporter arms - so a deployment without that reporter never
// tracks, never drains, and this family stays at its honest zero.
const mRelayGap = containMetricInstrument(METRICS?.counter(
	'relay_gap_frames_total', 'Relayed frames proven lost to this worker', []
));
// Primary-owned spill incidents, attributed exactly once to a healthy worker
// registry. Counts stay cluster-summable without pretending the primary has a
// metrics registry of its own.
const mRelaySpillQuarantines = containMetricInstrument(METRICS?.counter(
	'relay_spill_quarantines_total', 'Workers quarantined after a relay spill ceiling', ['reason']
));
const mRelaySpillDroppedBytes = containMetricInstrument(METRICS?.counter(
	'relay_spill_dropped_bytes_total', 'Pending relay bytes discarded when a lagging worker was quarantined', []
));
const gRelaySpillPendingAge = containMetricInstrument(METRICS?.gauge(
	'relay_spill_pending_age_seconds', 'Worst oldest-pending age observed at relay spill quarantine', []
));
// A refusal is decided on THIS worker (the sender), so the count lands here
// directly; handler/relay.js reaches it through the hook below.
const mRelayFrameRefused = containMetricInstrument(METRICS?.counter(
	'relay_frame_refused_total', 'Publishes refused by the sender-side relay frame ceiling; local subscribers still received them', ['lane']
));
counters.relayFrameRefusedHook = mRelayFrameRefused === undefined
	? null
	: (lane) => mRelayFrameRefused?.inc({ lane: lane === 'batched' ? 'batched' : 'publish' });
// A publish refused by an egress ceiling is decided on THIS worker, so the
// cumulative count lands here directly; the per-window figures ride the
// pressure snapshot. Always assigned (hook or null) so a module re-run replaces
// any previous hook.
const mEgressRefused = containMetricInstrument(METRICS?.counter(
	'egress_refused_total', 'Publishes refused by a configured egress ceiling; nothing was delivered or relayed for them', ['scope']
));
counters.egressRefusedHook = mEgressRefused === undefined
	? null
	: (scope) => mEgressRefused?.inc({ scope: scope === 'tenant' ? 'tenant' : 'topic' });
const mEgressEvicted = containMetricInstrument(METRICS?.counter(
	'egress_window_evicted_total', 'Live usage windows evicted at the ledger cap; each one stops enforcing its ceiling for the rest of its window', ['scope']
));
counters.egressEvictedHook = mEgressEvicted === undefined
	? null
	: (scope) => mEgressEvicted?.inc({ scope: scope === 'tenant' ? 'tenant' : 'topic' });
// An oversized-frame stop is a primary-side incident with no registry of its
// own; like the spill quarantines it is attributed exactly once to a surviving
// worker registry via a posted notice.
const mRelayFrameOversized = containMetricInstrument(METRICS?.counter(
	'relay_frame_oversized_total', 'Relay frames refused at the reassembly ceiling; the sending worker relay stream was stopped', []
));
let relaySpillPendingAgePeak = 0;
if (parentPort) {
	parentPort.on('message', (msg) => {
		if (!msg) return;
		if (msg.type === 'relay-frame-oversized') {
			mRelayFrameOversized?.inc();
			return;
		}
		if (msg.type !== 'relay-spill-overflow') return;
		const reason = msg.reason === 'age' ? 'age' : 'bytes';
		const droppedBytes = Number.isFinite(msg.droppedBytes) ? Math.max(0, msg.droppedBytes) : 0;
		const pendingAgeMs = Number.isFinite(msg.pendingAgeMs) ? Math.max(0, msg.pendingAgeMs) : 0;
		mRelaySpillQuarantines?.inc({ reason });
		mRelaySpillDroppedBytes?.inc({}, droppedBytes);
		relaySpillPendingAgePeak = Math.max(relaySpillPendingAgePeak, pendingAgeMs / 1000);
		gRelaySpillPendingAge?.set(relaySpillPendingAgePeak);
	});
}
// Route the framework's own invariant violations (assert/fatal) into the same
// registry, labelled by category and severity, so the `metrics` option lights
// up `framework_assertion_violations_total` without the app touching the
// internal assert seam. The emit itself is best-effort inside the assert path,
// so a throwing registry can never turn an invariant check into a crash.
if (METRICS) wireAssertionMetrics(METRICS);

// The waiting room's live depth, read by the sampling hook below. Null when no
// room is configured, which is also when the estimate has no meaning.
const queueDepthProbe = pollCounter === null ? null : () => pollCounter.depth(now());

// - Optional resource-growth trend auditor -----------------------------------
// Distinct from the consistency auditor above (which checks point-in-time
// invariants): this one trends the SIZE of the live bookkeeping collections
// across samples and flags a series that grows monotonically - the signature
// of a close / unsubscribe / eviction path that stopped shedding. It reads
// ONLY Map/Set `.size` (never a monotonic-by-design counter), rides its own
// slow, seam-jittered, unref'd timer, and is OBSERVE-ONLY: a suspected trend
// increments a metric and logs at most one throttled warning, and NEVER asserts
// or terminates. Off by default (interval 0), because a trend signal is
// inherently probabilistic and the always-on structural guard is the
// deterministic simulator, not production.
const RESOURCE_GROWTH_AUDIT_INTERVAL_MS = wsOptions.resourceGrowthAuditIntervalMs ?? 0;
if (RESOURCE_GROWTH_AUDIT_INTERVAL_MS > 0) {
	const mResourceGrowth = containMetricInstrument(METRICS?.counter(
		'framework_resource_growth_suspected_total',
		'Sustained resource-growth suspicions raised by the optional auditor',
		['resource']
	));
	let growthWarned = false;
	const growthAuditor = createResourceGrowthAuditor({
		// Self-healing / bounded collections only, so a rising trend really is a
		// leak: wsConnections shrinks as clients disconnect, topicPublishStats is
		// cleared every pressure tick, and lastPublishWarnAt / decodeCache /
		// envelopePrefixCache are LRU-evicted while staticCache plateaus at the
		// finite asset set. The per-topic registries topicSeqs and sharedTopics
		// grow with topic cardinality BY DESIGN, so probing them here would
		// self-fire a false leak: topicSeqs is held to its configured ceiling by
		// the seq bound (handler/seq-bound.js), which can only evict a topic no
		// client is on, and sharedTopics has no such bound at all.
		probes: structuralResourceProbes({
			wsConnections,
			topicPublishStats,
			lastPublishWarnAt,
			decodeCache,
			envelopePrefixCache,
			staticCache
		}),
		intervalMs: RESOURCE_GROWTH_AUDIT_INTERVAL_MS,
		metrics: mResourceGrowth,
		onGrowth(report) {
			// One throttled warning for the whole worker lifetime; the auditor
			// observes a direction, and repeating the same line every tick would
			// bury the rest of the log without adding a fact.
			if (growthWarned) return;
			growthWarned = true;
			console.warn(adapterConsoleLine(ADAPTER_ERROR_IDS.RESOURCE_GROWTH,
				`'${report.name}' size trending upward (delta ${report.delta} over ${report.n} samples); investigate a close/unsubscribe/eviction path that stopped shedding.`));
		}
	});
	counters.resourceGrowthAuditor = growthAuditor;
	growthAuditor.start();
}

// Gauge sampling rides the existing 1 Hz pressure timer - no new timer. Always
// assigned (hook or null) so a module re-run replaces any previous hook and a
// stale closure can never outlive its server. Counting open fds is a directory
// read whose cost scales with the count itself, so it rides every 5th sample
// (~5s) instead of every tick; seeded one below the modulus so the very first
// sample publishes a value.
let fdSampleTick = 4;
counters.metricsSampleHook = METRICS == null ? null : (telemetry) => {
	const lvl = postureLevel();
	gPostureState?.set(lvl === 'siege' ? 2 : lvl === 'elevated' ? 1 : 0);
	gUpgradeInflight?.set(admission.inFlight);
	gUpgradeDeferredDepth?.set(admission.deferredDepth);
	gUpgradeDeferredOldestAge?.set(admission.deferredOldestAgeMs / 1000);
	gQueueDepth?.set(queueDepthProbe !== null ? queueDepthProbe() : 0);
	// Read the snapshot the sampler just folded (this hook runs later in the
	// same tick), so these track the current window's backpressure figures.
	gBackpressureMaxBytes?.set(pressureSnapshot.maxBufferedBytes);
	gBackpressureConnections?.set(pressureSnapshot.backpressuredConnections);
	// Healthy workers publish an explicit zero, so absent-vs-zero stays
	// queryable and the completeness gate can be satisfied by a worker that has
	// never seen a quarantine. The IPC handler raises the peak the moment a
	// spill happens; this rewrite never lowers it.
	gRelaySpillPendingAge?.set(relaySpillPendingAgePeak);
	if (counters.lastDroppedFrames > 0) mDroppedFrames?.inc({}, counters.lastDroppedFrames);
	if (counters.lastDroppedBytes > 0) mDroppedBytes?.inc({}, counters.lastDroppedBytes);
	gConnections?.set(counters.lastConnections);
	gSubscriptions?.set(counters.totalSubscriptions);
	gPressureSaturation?.set(pressureSnapshot.value);
	// Unknown reasons floor to 0 rather than throwing: the vocabulary is
	// source-declared, so an unmapped value means the two lists drifted, and
	// silently reading "no pressure" is the safer of two wrong answers here only
	// because the reason string also reaches the log and the export.
	gPressureReason?.set(PRESSURE_REASON_CODES[pressureSnapshot.reason] ?? 0);
	gResidentBytes?.set(counters.lastResidentBytes);
	gHeapUsedRatio?.set(counters.lastHeapUsedRatio);
	if (counters.lastSampleWallMs > 0) gSampleTimestamp?.set(counters.lastSampleWallMs / 1000);
	if (counters.lastPublishCount > 0) mPublishes?.inc({}, counters.lastPublishCount);
	emitPressureMetricTelemetry(telemetry, {
		reasonTransitions: mPressureReasonTransitions,
		psiCpuSome: gPsiCpuSome,
		psiMemoryFull: gPsiMemoryFull,
		psiIoFull: gPsiIoFull,
		cpuThrottled: gCpuThrottled
	});
	if (gOpenFds !== undefined && ++fdSampleTick >= 5) {
		fdSampleTick = 0;
		const openFds = countOpenFds();
		if (openFds !== null) gOpenFds.set(openFds);
	}
};

// One RED observation per completed HTTP exchange, emitted from the single
// terminal hook handler/request.js already runs. Null when no registry is
// configured, so the request path reads one property and allocates nothing.
counters.httpRequestHook = mHttpRequests === undefined && hHttpDuration === undefined
	? null
	: (method, status, aborted, seconds) => {
		const labels = httpLabels(method, aborted ? 'aborted' : httpOutcome(status));
		mHttpRequests?.inc(labels);
		hHttpDuration?.observe(labels, seconds);
	};

// Graduated protection posture over the 1 Hz pressure signal. Opt-in via the
// `protection` option; absent or `'normal'` leaves `counters.activePosture`
// null, so the reject path, the pressure snapshot and the poll response stay
// byte-identical to a deployment that never sets it. `'auto'` resolves the
// level from pressure; `'elevated'`/`'siege'` pin it for incident response.
// The posture is ticked from the pressure sampler (no new timer) but built
// here because it reads the module's admission gate.
const PROTECTION_MODE = wsOptions.protection || 'normal';

/** @returns {'normal' | 'elevated' | 'siege'} */
function postureLevel() {
	return counters.activePosture !== null ? counters.activePosture.level : 'normal';
}

counters.activePosture = (PROTECTION_MODE === 'normal')
	? null
	: createPosture({
		admission,
		// The LIVE thresholds this transport's sampler reads. Resolving them
		// any other way would let the posture judge a different set of numbers
		// than the sampler that drives it.
		getThresholds: () => normalizePressureThresholds(wsOptions.pressure),
		pin: PROTECTION_MODE === 'auto' ? undefined : PROTECTION_MODE,
		// One log line per level change - the operator's incident timeline.
		// Dwell-gated by the machine, so it can never flood. No client identity
		// on the line: rate and reason only.
		onTransition: (from, to) => {
			mPostureTransitions?.inc({ from, to });
			console.warn(adapterConsoleLine(
				ADAPTER_ERROR_IDS.POSTURE_TRANSITION,
				`${from} -> ${to} rejected/s=${counters.activePosture !== null ? counters.activePosture.rejectedPerSecond : 0} ` +
				`pressure=${counters.lastBasePressureReason}`
			));
			// Push the transition to export subscribers immediately - a defense
			// daemon reacting to a posture change must not wait out the rest of
			// the sample window.
			if (counters.postureExportHook !== null) counters.postureExportHook();
		}
	});

// Posture push-export (opt-in): a local stream socket where an external
// process (an edge-defense daemon, a watchdog) follows the live posture as
// newline-delimited JSON - pushed on connect, on every transition, and on
// every 1 Hz sample (the cadence doubles as a liveness signal). Local-only and
// payload-free: posture, reason, and kernel pressure numbers.
const POSTURE_EXPORT = wsOptions.postureExport;
if (POSTURE_EXPORT !== undefined && POSTURE_EXPORT !== false) {
	const exportPath = typeof POSTURE_EXPORT === 'string' ? POSTURE_EXPORT : POSTURE_EXPORT?.path;
	if (typeof exportPath !== 'string' || exportPath.length === 0) {
		throw new Error("websocket.postureExport must be a socket path string or { path } (or omitted)");
	}
	const postureLine = () => ({
		v: 1,
		posture: postureLevel(),
		reason: pressureSnapshot.reason,
		value: pressureSnapshot.value,
		psi: pressureSnapshot.psi ?? null,
		cpuThrottle: pressureSnapshot.cpuThrottle ?? null
	});
	if (parentPort && hasMultipleWorkers()) {
		// One path, N workers: whoever binds last owns it and everyone else
		// is listening on an orphaned inode, so a consumer would read one
		// bind-order-chosen thread's posture and believe it was the server's.
		// The primary binds instead (see runtime/posture-collector.js) and
		// this worker reports inward on the same two occasions it would have
		// pushed locally - every transition and every sample. The path travels
		// with the first report rather than through the environment, so the
		// option stays the one place it is configured.
		counters.postureExporter = null;
		counters.postureExportHook = () => {
			try {
				parentPort.postMessage({ type: 'posture', threadId, path: exportPath, line: postureLine() });
			} catch { /* the primary is gone; the cadence stopping IS the signal */ }
		};
		// One report before the first sample, so a consumer that connects
		// during boot is not answered with silence for up to a second.
		counters.postureExportHook();
	} else {
		const exporter = startPostureExport(exportPath, postureLine);
		counters.postureExporter = exporter;
		counters.postureExportHook = () => exporter.broadcast();
	}
} else {
	// Assigned on BOTH branches, so a re-run of this module replaces a stale
	// hook rather than leaving one pointed at a closed exporter.
	counters.postureExporter = null;
	counters.postureExportHook = null;
}

/**
 * Hand back the whole-lifetime connection permit a connection holds, once.
 * Every path that ends an accepted connection goes through here - a normal
 * close, an attribution refusal at open, a failure between the handshake and
 * full registration - or the live ceiling shrinks by one until restart.
 *
 * @param {any} userData
 */
function releaseConnectionPermitFor(userData) {
	if (!userData[WS_CONNECTION_PERMIT]) return;
	userData[WS_CONNECTION_PERMIT] = undefined;
	admission.releaseConnection();
	gConnectionHeadroom?.set(admission.connectionHeadroom);
}

// Rate limiters for the two doors, sharing one implementation so a
// correction can never land on only one of them. Bounds match the family:
// 10k tracked identities, 16-entry eviction sample, 128-char keys.
const MAX_RATE_ENTRIES = 10000;
const RATE_MAP_EVICTION_SAMPLE = 16;
const MAX_RATE_KEY_LEN = 128;
const upgradeRateLimiter = createSlidingWindowLimiter({
	maxPerWindow: wsOptions.upgradeRateLimit ?? 10,
	windowMs: (wsOptions.upgradeRateLimitWindow ?? 10) * 1000,
	maxEntries: MAX_RATE_ENTRIES,
	evictionSample: RATE_MAP_EVICTION_SAMPLE,
	maxKeyLen: MAX_RATE_KEY_LEN,
	// An eviction at the map cap stops rate-limiting whatever identity it
	// dropped, so it is reported per door rather than folded into one number.
	onEvict: mUpgradeRateEvicted === undefined ? undefined : () => mUpgradeRateEvicted.inc({ door: 'upgrade' })
});
const authPathRateLimiter = createSlidingWindowLimiter({
	maxPerWindow: wsOptions.authPathRateLimit ?? 30,
	windowMs: (wsOptions.authPathRateLimitWindow ?? 10) * 1000,
	maxEntries: MAX_RATE_ENTRIES,
	evictionSample: RATE_MAP_EVICTION_SAMPLE,
	maxKeyLen: MAX_RATE_KEY_LEN,
	onEvict: mUpgradeRateEvicted === undefined ? undefined : () => mUpgradeRateEvicted.inc({ door: 'auth' })
});
// The periodic sweep keeps stale identities from pinning the maps.
const _rateSweepTimer = setIntervalTimer(() => {
	const t = now();
	upgradeRateLimiter.sweep(t);
	authPathRateLimiter.sweep(t);
}, 60_000);
if (typeof _rateSweepTimer?.unref === 'function') _rateSweepTimer.unref();

export const wss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_PAYLOAD_LENGTH,
	perMessageDeflate: COMPRESSION ? true : false,
	// Echo the client's offered subprotocol: the native tier passes
	// Sec-WebSocket-Protocol through, and a client that offered one
	// hard-fails its handshake when the echo is missing.
	handleProtocols: (protocols) => {
		const first = protocols.values().next().value;
		return first === undefined ? false : first;
	}
});

// Custom 101 headers (the upgradeResponse contract): ws emits a 'headers'
// event before writing the handshake; a per-request map carries the app's
// validated headers into it.
/** @type {WeakMap<import('node:http').IncomingMessage, Record<string, string>>} */
const upgradeExtraHeaders = new WeakMap();
wss.on('headers', (headers, req) => {
	const extra = upgradeExtraHeaders.get(req);
	if (!extra) return;
	for (const [name, value] of Object.entries(extra)) {
		// An array value (several Set-Cookie lines) writes one header LINE per
		// element - joining them would corrupt every cookie after the first.
		if (Array.isArray(value)) {
			for (const item of value) headers.push(`${name}: ${item}`);
		} else {
			headers.push(`${name}: ${value}`);
		}
	}
});

/**
 * Record one REJECTED admission: the counter always, and a span when a tracing
 * provider is armed, so a trace shows why a socket never opened. Accepted
 * upgrades get their span around the upgrade itself.
 *
 * The counter lives here rather than beside each branch so the reason
 * vocabulary has exactly one emit point: a branch that reports a reason to a
 * trace and not to the registry is the shape that leaves an operator's
 * dashboard short of a rejection the trace can see.
 *
 * @param {Record<string, string> | null} headers
 * @param {string} reason
 */
function noteUpgradeRejection(headers, reason) {
	mUpgradeRejected?.inc({ reason });
	if (!tracingEnabled) return;
	traceOperation('adapter.websocket.admission', {
		kind: 'server',
		parent: headers === null ? null : extractTraceContext(headers),
		attributes: {
			'network.protocol.name': 'websocket',
			'admission.outcome': 'rejected',
			'admission.reason': reason
		}
	}, () => undefined);
}

const STATUS_TEXT = {
	200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
	426: 'Upgrade Required', 429: 'Too Many Requests', 500: 'Internal Server Error',
	503: 'Service Unavailable', 504: 'Gateway Timeout'
};

// Upgrade-decision timing, keyed by the socket the decision is about. There is
// no response object to instrument on this transport: the upgrade either hands
// the socket to `ws` or writes a refusal onto the raw socket, so the clock is
// started when the path is known to be the WebSocket path and stamped at
// whichever of those two ends the attempt. Absent when no histogram is armed,
// which is what keeps an unconfigured deployment allocation-free here.
/** @type {WeakMap<import('node:stream').Duplex, { started: number }>} */
const upgradeTimings = new WeakMap();

/**
 * Stamp one upgrade decision, once. A socket with no entry either never
 * started a decision (a non-WebSocket path) or already settled.
 *
 * @param {import('node:stream').Duplex} socket
 * @param {'admitted' | 'rejected' | 'aborted' | 'error'} outcome
 */
function observeUpgradeOutcome(socket, outcome) {
	const timing = upgradeTimings.get(socket);
	if (timing === undefined) return;
	upgradeTimings.delete(socket);
	hUpgradeDuration?.observe(
		OUTCOME_ONLY_LABELS[outcome],
		Math.max(0, monotonicNow() - timing.started) / 1000
	);
}

/**
 * Answer an upgrade attempt with a plain HTTP response on the raw socket. The
 * upgrade listener owns the socket outright - there is no ServerResponse to
 * write through - so the status line and headers are composed here.
 *
 * `extraHeaders` is either one pre-rendered header line or a list of name /
 * value pairs; a pair list supplying its own content-type wins, which is what
 * lets the capacity refusals answer with a document instead of plain text.
 *
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} text
 * @param {string | Array<[string, string]>} [extraHeaders]
 */
function refuseUpgrade(socket, status, text, extraHeaders) {
	// Every refusal on the WebSocket path writes through here (the waiting-room
	// and capacity documents reach it via upgradeRefusalResponse), so this is
	// the one place the rejected leg of the upgrade timing has to be stamped.
	observeUpgradeOutcome(socket, 'rejected');
	const line = STATUS_TEXT[status] || 'Error';
	let head = `HTTP/1.1 ${status} ${line}\r\nConnection: close\r\n`;
	let hasType = false;
	if (typeof extraHeaders === 'string') {
		head += extraHeaders + '\r\n';
	} else if (extraHeaders) {
		for (const [name, value] of extraHeaders) {
			if (name.toLowerCase() === 'content-type') hasType = true;
			head += `${name}: ${value}\r\n`;
		}
	}
	if (!hasType) head += 'Content-Type: text/plain\r\n';
	try {
		socket.write(head + `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` + text);
	} catch { /* peer already gone */ }
	socket.destroy();
}

/**
 * The response shape the shared refusal writers speak, over a raw upgrade
 * socket. sendWaitingRoomPage() and the capacity refusals are written once for
 * the whole family against a cork/writeStatus/writeHeader/end response; this
 * adapts that to the socket the upgrade listener holds, so the status line,
 * the headers and the body bytes stay identical to what the family answers.
 *
 * @param {import('node:stream').Duplex} socket
 */
function upgradeRefusalResponse(socket) {
	let status = 503;
	/** @type {Array<[string, string]>} */
	const headers = [];
	const res = {
		cork(fn) { fn(); return res; },
		writeStatus(statusLine) {
			status = Number.parseInt(String(statusLine), 10) || 503;
			return res;
		},
		writeHeader(name, value) { headers.push([String(name), String(value)]); return res; },
		end(body) {
			refuseUpgrade(socket, status, body == null ? '' : String(body), headers);
			return res;
		}
	};
	return res;
}

/**
 * The request shape the shared waiting-room helpers read, over a node request.
 * A localization renderer inspects method, url and headers through this; the
 * facade is what keeps that contract identical across the family's transports.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} pathname
 * @param {string} query - the query string without its leading '?'
 */
function waitingRoomRequestFacade(req, pathname, query) {
	return {
		getMethod: () => String(req.method || 'GET').toLowerCase(),
		getUrl: () => pathname,
		getQuery: () => query,
		/** @param {(name: string, value: string) => void} visitor */
		forEach: (visitor) => {
			const raw = req.rawHeaders;
			for (let i = 0; i < raw.length; i += 2) visitor(raw[i].toLowerCase(), raw[i + 1]);
		}
	};
}

/**
 * The `Retry-After` a refusal answers. The room's configured base where a room
 * exists, the shared default where none does - one number per condition, so a
 * client honouring the header never reads one lane as "retry immediately"
 * while the same full gate tells another lane to wait. The jitter band widens
 * as the posture rises, so a packed server thins its own retry rate; 0.5 is
 * the jitter helper's own default, which keeps `normal` exactly where it was.
 *
 * @returns {number}
 */
function refusalRetryAfter() {
	const lvl = postureLevel();
	const spread = lvl === 'siege' ? 1.5 : lvl === 'elevated' ? 1.0 : 0.5;
	return WAITING_ROOM !== null
		? WAITING_ROOM.jitteredRetryAfter(spread)
		: jitterRetryAfter(REFUSAL_RETRY_AFTER_SECONDS, spread);
}

/**
 * Read one header off a node request without the duplicate-policy walk. The
 * refusal paths read at most two headers and must not pay for a full
 * collection; node has already merged repeated lines here.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string}
 */
function headerValue(req, name) {
	const value = req.headers[name];
	if (value === undefined) return '';
	return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * The node 'upgrade' listener. Wire this on the HTTP server.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 */
export async function handleUpgrade(req, socket, head) {
	// Own the socket's 'error' event for the whole admission window. Until
	// wss.handleUpgrade hands the socket to ws, nothing is listening: a client
	// that resets the TCP connection while the admission hook is parked makes
	// node emit 'error' on an ownerless emitter, and one unauthenticated RST
	// becomes an uncaught exception that takes the worker down. The listener
	// is detached the moment ws takes ownership and installs its own.
	const onSocketError = () => socket.destroy();
	socket.on('error', onSocketError);

	const url = req.url || '/';
	const q = url.indexOf('?');
	const pathname = q === -1 ? url : url.slice(0, q);
	if (pathname !== WS_PATH) {
		refuseUpgrade(socket, 404, 'Not Found');
		return;
	}
	// The decision clock starts once the path is known to be the WebSocket path,
	// so a 404 on some other path never seats a series here.
	if (hUpgradeDuration !== undefined) upgradeTimings.set(socket, { started: monotonicNow() });
	if (isDraining()) {
		refuseUpgrade(socket, 503, 'Service Unavailable');
		return;
	}

	// Cursor-only upgrade lane (the worker's second WebSocket). The requested
	// subprotocol routes the upgrade through the reserved cursor sub-budget
	// only when a lane is configured; an unconfigured deployment never reads
	// the header for lane purposes and never branches on the lane.
	const cursorLaneEnabled = admission.cursorMaxConcurrent > 0;
	const isCursor = cursorLaneEnabled && isCursorLaneUpgrade(headerValue(req, 'sec-websocket-protocol'));

	// Serve an at-capacity refusal without ever consuming a gate slot. A
	// browser navigation gets the self-polling holding page (it holds no
	// socket); everything else keeps the 503 plus a jittered Retry-After. A
	// cursor-lane upgrade is never a browser navigation, so it always gets the
	// bare 503 and skips the Accept negotiation - but it backs off like every
	// other refusal, because the condition is the same full gate.
	const serveUpgradeRefusal = () => {
		if (WAITING_ROOM === null || isCursor) {
			// An HTML navigation keeps a minimal document baseline even when
			// the interactive room is disabled.
			if (!isCursor && negotiateRejection(
				headerValue(req, 'accept'), headerValue(req, 'upgrade')
			) === 'html') {
				sendWaitingRoomPage(upgradeRefusalResponse(socket), {
					body: buildAccessibleCapacityRefusalPage(),
					lang: 'en',
					dir: 'ltr',
					headers: [['retry-after', String(refusalRetryAfter())]],
					varyAcceptLanguage: false
				}, '503 Service Unavailable');
				return;
			}
			refuseUpgrade(socket, 503, 'Server is at upgrade capacity, please retry', [
				['retry-after', String(refusalRetryAfter())]
			]);
			return;
		}
		// One header read, no full walk on the reject path.
		if (negotiateRejection(headerValue(req, 'accept'), headerValue(req, 'upgrade')) === 'html') {
			// Browser navigation: serve the self-polling holding page.
			sendWaitingRoomPage(upgradeRefusalResponse(socket), WAITING_ROOM.renderResponse(
				undefined,
				createWaitingRoomRequest(waitingRoomRequestFacade(req, pathname, q === -1 ? '' : url.slice(q + 1)))
			));
			return;
		}
		// WebSocket handshake / library client: the 503, refined with the
		// jittered Retry-After.
		refuseUpgrade(socket, 503, 'Server is at upgrade capacity, please retry', [
			['retry-after', String(refusalRetryAfter())]
		]);
	};

	// Siege refuses every NEW upgrade at static-serve cost, even while the gate
	// has free slots - no slot is acquired, so an existing connection is never
	// touched. Counted as an over-capacity reject so an auto posture stays
	// escalated.
	if (postureLevel() === 'siege') {
		if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
		noteUpgradeRejection(null, 'siege');
		serveUpgradeRefusal();
		return;
	}

	// Pre-upgrade soft filter: the cap on concurrent upgrades being processed.
	// The cheapest possible rejection - no header walk, no address decode, no
	// origin check - so a connection storm is shed before it consumes
	// per-request CPU. A cursor-lane upgrade is admitted through its reserved
	// sub-budget so it can never starve main-WS admission; a saturated cursor
	// lane is real capacity pressure, so it counts as an over-capacity reject
	// too.
	const handshakeAcquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
	if (!handshakeAcquired) {
		// Count the over-capacity reject (and only this one) so the posture's
		// rolling reject rate reflects true gate pressure.
		if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
		noteUpgradeRejection(null, isCursor ? 'cursor_lane' : 'over_capacity');
		serveUpgradeRefusal();
		return;
	}
	let inFlightReleased = false;
	let connectionPermitHeld = false;
	let connectionPermitTransferred = false;
	function releaseConnectionPermit() {
		if (!connectionPermitHeld || connectionPermitTransferred) return;
		connectionPermitHeld = false;
		admission.releaseConnection();
		gConnectionHeadroom?.set(admission.connectionHeadroom);
	}
	function releaseInFlight() {
		if (!inFlightReleased) {
			inFlightReleased = true;
			if (isCursor) admission.releaseCursorInFlight();
			else admission.release();
		}
		releaseConnectionPermit();
		// Nothing is left for the abandoned-handshake listener to hand back;
		// drop it so an accepted connection does not retain the whole upgrade
		// closure - request, header bag and handshake head - for its lifetime.
		if (ADMISSION_ARMED) socket.removeListener('close', releaseInFlight);
	}
	function rejectDeferredOverflow() {
		if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
		noteUpgradeRejection(null, 'deferred_overflow');
		mUpgradeDeferredRejected?.inc();
		releaseInFlight();
		serveUpgradeRefusal();
	}

	// The whole-lifetime connection permit is reserved across the handshake
	// too, so concurrent upgrades cannot overshoot the live-connection ceiling.
	if (!admission.tryAcquireConnection()) {
		if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
		noteUpgradeRejection(null, 'connection_capacity');
		releaseInFlight();
		serveUpgradeRefusal();
		return;
	}
	connectionPermitHeld = admission.maxConnections > 0;
	gConnectionHeadroom?.set(admission.connectionHeadroom);

	// Returns the reservations early when the socket is DESTROYED while the
	// admission hook is parked - the error path above does that, and so does a
	// peer RST. It does not catch an ordinary hang-up: node hands over an
	// upgrade socket with its parser detached and nothing reading it, so a FIN
	// produces no 'end' and therefore no 'close', and that slot is instead
	// returned by the release below once the hook settles. Bounded either way
	// by the upgrade deadline, never held past it. Only a gate with a ceiling
	// has anything to return, so an unconfigured deployment installs nothing.
	if (ADMISSION_ARMED) socket.on('close', releaseInFlight);

	// Full header policy: repeated singletons refuse the handshake the same
	// way they refuse a request.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		noteUpgradeRejection(null, 'duplicate_header');
		refuseUpgrade(socket, 400, 'Bad Request');
		releaseInFlight();
		return;
	}
	const wsTraceParent = extractTraceContext(headers);

	const direct = req.socket?.remoteAddress || '';
	const clientIp = resolveClientIp(direct, headers, direct);

	if (upgradeRateLimiter.exceeded(clientIp, now())) {
		// Per-IP rate-limit reject. Reported on its own counter, never the
		// over-capacity one, so an attack-driven 429 storm can never escalate
		// the protection posture toward siege.
		if (counters.activePosture !== null) counters.activePosture.recordRateLimitReject();
		noteUpgradeRejection(headers, 'ip_rate_limit');
		refuseUpgrade(socket, 429, 'Too Many Requests');
		releaseInFlight();
		return;
	}

	if (!isOriginAllowed(headers['origin'], headers, {
		allowedOrigins: ALLOWED_ORIGINS,
		pinnedOrigin,
		// The proxy headers the deployment trusts: without them the check
		// falls back to the client-controlled Host and the direct scheme,
		// which behind a TLS-terminating proxy 403s every real browser and
		// behind no proxy compares two attacker-controlled headers.
		hostHeader: host_header,
		protocolHeader: protocol_header,
		portHeader: port_header,
		isTls: is_tls,
		hasUpgradeHook: !!wsModule.upgrade
	})) {
		noteUpgradeRejection(headers, 'bad_origin');
		refuseUpgrade(socket, 403, 'Origin not allowed');
		releaseInFlight();
		return;
	}

	const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();

	// The connection inherits the upgrade request's trace context; a span
	// started around the upgrade hook below refines it to the hook's own.
	let connectionTraceContext = wsTraceParent;

	let userData = {};
	if (wsModule.upgrade) {
		// The admission hook is awaited under the upgrade deadline: an
		// admission source that hangs must answer 504, not park the socket.
		let timedOut = false;
		let timer = null;
		try {
			const callUpgradeHook = () => {
				connectionTraceContext = activeTraceContext() ?? wsTraceParent;
				return wsModule.upgrade({
					headers,
					cookies: parseCookies(headers['cookie']),
					url,
					remoteAddress: clientIp,
					requestId: wsRequestId,
					traceContext: connectionTraceContext
				});
			};
			const hookRun = Promise.resolve(tracingEnabled
				? traceOperation('adapter.websocket.upgrade', {
					kind: 'server',
					parent: wsTraceParent,
					attributes: { 'network.protocol.name': 'websocket' }
				}, callUpgradeHook)
				: callUpgradeHook());
			const TIMEOUT = Symbol('timeout');
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => { timedOut = true; resolve(TIMEOUT); }, UPGRADE_TIMEOUT_S * 1000); // determinism-allow: admission deadline over a real socket, outside the replayable engine
				if (typeof timer?.unref === 'function') timer.unref();
			});
			const result = await Promise.race([hookRun, deadline]);
			if (timer) clearTimeout(timer); // determinism-allow: pairs with the admission deadline above
			if (result === TIMEOUT) {
				noteUpgradeRejection(headers, 'auth_timeout');
				refuseUpgrade(socket, 504, 'Upgrade timed out');
				releaseInFlight();
				return;
			}
			if (result === false) {
				noteUpgradeRejection(headers, 'auth_rejected');
				refuseUpgrade(socket, 401, 'Unauthorized');
				releaseInFlight();
				return;
			}
			if (result && /** @type {any} */ (result).__upgradeResponse === true) {
				userData = /** @type {any} */ (result).userData || {};
				const responseHeaders = snapshotUpgradeHeaders(/** @type {any} */ (result).headers);
				if (responseHeaders && Object.keys(responseHeaders).length > 0) {
					upgradeExtraHeaders.set(req, responseHeaders);
				}
			} else {
				userData = result || {};
			}
		} catch (err) {
			if (timer) clearTimeout(timer); // determinism-allow: pairs with the admission deadline above
			if (!timedOut) {
				emitOperationalEvent({
					source: 'svelte-adapter-ws',
					component: 'runtime.websocket-upgrade',
					event: 'runtime.websocket-upgrade.failed',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'The WebSocket upgrade hook failed.',
					attributes: { requestId: wsRequestId, error: diagnosticError(err) }
				});
				noteUpgradeRejection(headers, 'hook_error');
				refuseUpgrade(socket, 500, 'Internal Server Error', 'X-Request-ID: ' + wsRequestId);
			}
			releaseInFlight();
			return;
		}
	}

	// A peer that vanished during admission has nothing left to accept or
	// refuse; ws would notice on its own, but skipping the accept avoids
	// tearing down a connection that never opened.
	if (socket.destroyed) {
		observeUpgradeOutcome(socket, 'aborted');
		releaseInFlight();
		return;
	}

	const acceptUpgrade = () => {
		// Between admission and a paced execution the client may have hung up.
		if (socket.destroyed) { observeUpgradeOutcome(socket, 'aborted'); releaseInFlight(); return; }
		// The drain check above ran before the app's upgrade hook. A shutdown
		// that began while the hook was pending has since told every live
		// socket to go; a connection opened now would be one the sweep never
		// saw, holding the listener's close for as long as the client stays.
		// Refused the way an upgrade during the drain is refused.
		if (isDraining()) {
			refuseUpgrade(socket, 503, 'Service Unavailable');
			releaseInFlight();
			return;
		}
		try {
			const remoteAddress = /** @type {any} */ (userData).remoteAddress || clientIp;
			const merged = { remoteAddress, .../** @type {any} */ (userData) };
			// The whole-lifetime permit rides the handshake on userData and is
			// promoted to its symbol slot at open, so close - and only close -
			// hands it back. Rolled back here if the handshake itself throws,
			// or the ceiling would shrink by one for the process's lifetime.
			let carrier = null;
			// Decorating `merged` is safe to do up front - it is unreachable
			// unless the accept lands - but the TRANSFER is only real once ws
			// has actually handed us a socket. `handleUpgrade` has a third
			// outcome besides accept and throw: it answers the peer itself and
			// returns, calling nothing, for a non-GET, a missing or malformed
			// Sec-WebSocket-Key, a version that is not 8 or 13, a rejected
			// shouldHandle, an unparseable subprotocol, a bad
			// permessage-deflate offer, or a socket that stopped being
			// readable. Marking the transfer before the call meant every one
			// of those took a permit that nothing could ever hand back - two
			// unauthenticated packets each, until the ceiling was gone and the
			// process needed a restart. The lead cannot reach this: its accept
			// primitive either opens or throws.
			if (connectionPermitHeld) carrier = connectionPermitCarrier.install(merged);
			try {
				wss.handleUpgrade(req, socket, head, (ws) => {
					// ws owns the socket's error handling from here on.
					socket.removeListener('error', onSocketError);
					// The accept landed, so the permit now belongs to the
					// connection and close is what returns it.
					if (connectionPermitHeld) connectionPermitTransferred = true;
					mUpgradeAdmitted?.inc();
					observeUpgradeOutcome(socket, 'admitted');
					try {
						openConnection(ws, merged, wsRequestId, connectionTraceContext);
					} catch (err) {
						// A failure between accept and full registration must tear
						// the socket down completely - a half-registered connection
						// would sit in the walks forever with no close listener to
						// reap it.
						emitOperationalEvent({
							source: 'svelte-adapter-ws',
							component: 'runtime.websocket-open',
							event: 'runtime.websocket-open.failed',
							severity: 'error',
							dataClass: 'pseudonymous',
							message: 'Connection setup failed after the upgrade completed.',
							attributes: { requestId: wsRequestId, error: diagnosticError(err) }
						});
						const facade = wsWrappers.get(ws);
						unregisterSocket(ws);
						wsWrappers.delete(ws);
						if (facade) wsConnections.delete(facade);
						releaseConnectionPermitFor(merged);
						try { ws.terminate(); } catch { /* already gone */ }
					}
				});
			} catch (error) {
				if (connectionPermitTransferred) {
					connectionPermitTransferred = false;
					connectionPermitCarrier.rollback(merged, carrier);
				}
				releaseConnectionPermit();
				observeUpgradeOutcome(socket, 'error');
				throw error;
			}
			// handleUpgrade has a third outcome: it answers the peer itself and
			// calls nothing back (a non-GET, a bad key, an unsupported version).
			// That is a refusal, and a no-op once the accept above stamped.
			observeUpgradeOutcome(socket, 'rejected');
		} finally {
			releaseInFlight();
		}
	};

	// Bounded deferral: the per-tick budget paces how many handshakes complete
	// in one turn, and the queue behind it is finite. A full queue sheds rather
	// than growing without bound.
	if (admission.admit(acceptUpgrade) === null) rejectDeferredOverflow();
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} userData
 * @param {string} requestId
 */
function openConnection(rawWs, userData, requestId, connectionTraceContext = null) {
	// The error listener attaches before anything can close the socket - a
	// peer RST during setup must never become an uncaught emitter throw.
	rawWs.on('error', (err) => {
		if (/** @type {any} */ (err)?.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
			console.error('[svelte-adapter-ws] connection error:', err);
		}
	});
	// Promote the handshake carrier to the symbol slot close reads. A carrier
	// that cannot be found is unrecoverable: the permit would be held with
	// nothing left to hand it back, so the connection is refused instead.
	if (admission.maxConnections > 0) {
		const permitRestored = connectionPermitCarrier.restore(userData);
		fatal(permitRestored, 'ws.connection-permit-carrier', null);
		if (!permitRestored) {
			try { rawWs.terminate(); } catch { /* already gone */ }
			return;
		}
	}
	registerSocket(rawWs);
	// Claim the adapter's slots as own properties before anything writes
	// one. userData is whatever the app's upgrade hook returned, and a plain
	// assignment onto it is a [[Set]] that an accessor on the key can swallow
	// whole - leaving the slot unwritten while every falsy guard downstream
	// keeps re-running its initialization. Declared once here, the later
	// assignments find an own property and never look at the chain again.
	declareConnectionSlots(userData);
	userData[WS_SUBSCRIPTIONS] = new Set();

	const wsPlatform = Object.create(platform);
	wsPlatform.requestId = requestId;
	// The platform's traceContext getter falls back to this when no operation
	// span is active, so message hooks parent onto the connection's context.
	Object.defineProperty(wsPlatform, 'connectionTraceContext', { value: connectionTraceContext });
	userData[WS_PLATFORM] = wsPlatform;

	const facade = wrapWebSocket(rawWs, userData, {
		maxBackpressure: MAX_BACKPRESSURE,
		closeOnBackpressureLimit: CLOSE_ON_BACKPRESSURE_LIMIT,
		compressionEnabled: !!COMPRESSION,
		onDrop: (byteLength) => {
			counters.droppedFrames++;
			counters.droppedBytes += byteLength;
			recordBackpressureDrop(counters, { byteLength });
		},
		onDrain: (f) => {
			flushCoalescedFor(f);
			// The drain callback rides a node write callback, not a native
			// boundary - an app throw here would otherwise be uncaught.
			try {
				wsModule.drain?.(f, { platform: userData[WS_PLATFORM] });
			} catch (err) {
				console.error('[adapter-ws] drain hook threw:', err);
			}
		},
		peerFacadeOf: (peer) => wsWrappers.get(peer)
	});

	// Attribution: resolved once, before the app open hook, fail-closed.
	try {
		installAttribution(wsModule.attribution, userData);
	} catch (err) {
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.websocket-attribution',
			event: 'runtime.websocket-attribution.failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The WebSocket attribution hook failed; the connection was refused at open.',
			attributes: { requestId, error: diagnosticError(err) }
		});
		unregisterSocket(rawWs);
		releaseConnectionPermitFor(userData);
		try { rawWs.close(1008, 'Attribution failed'); } catch { /* already gone */ }
		return;
	}

	const sessionId = randomUuid();
	userData[WS_SESSION_ID] = sessionId;
	userData[WS_STATS] = {
		openedAt: monotonicNow(),
		messagesIn: 0,
		messagesOut: 0,
		bytesIn: 0,
		bytesOut: 0
	};

	wsWrappers.set(rawWs, facade);
	wsConnections.add(facade);

	// Idle reaping: ws has no built-in idle timeout, so a JS timer plus
	// ping/pong stands in. A live peer answers the half-interval ping and the
	// deadline never fires; a vanished peer is terminated at the timeout.
	let lastActivity = monotonicNow();
	/** @type {any} */
	let idleTimer = null;
	if (IDLE_TIMEOUT_S > 0) {
		const halfMs = (IDLE_TIMEOUT_S * 1000) / 2;
		idleTimer = setIntervalTimer(() => {
			const idleFor = monotonicNow() - lastActivity;
			// The idle tick doubles as the drain-edge backstop: a pressure
			// episode whose last flush callback rode a callback-less write
			// (ping, pong, close frame) is caught here within a half-interval.
			/** @type {any} */ (facade)._checkDrain?.();
			if (idleFor >= IDLE_TIMEOUT_S * 1000) {
				rawWs.terminate();
			} else if (SEND_PINGS && idleFor >= halfMs && rawWs.readyState === OPEN) {
				try { rawWs.ping(); } catch { /* closing */ }
			}
		}, halfMs);
		if (typeof idleTimer?.unref === 'function') idleTimer.unref();
	}
	rawWs.on('pong', () => { lastActivity = monotonicNow(); });

	sendControl(facade, '{"type":"welcome","sessionId":"' + sessionId + '"}');

	rawWs.on('message', (raw, isBinary) => {
		lastActivity = monotonicNow();
		// One RED observation per inbound message. `ws` dispatches per socket, so
		// the timing wraps this dispatch rather than a shared behavior object.
		const kind = isBinary ? 'binary' : 'text';
		const startedAt = hWsMessageDuration === undefined ? 0 : monotonicNow();
		void handleMessage(rawWs, facade, userData, /** @type {Buffer} */ (raw), !!isBinary).then(
			() => observeWsMessage(kind, 'ok', startedAt),
			(err) => {
				observeWsMessage(kind, 'error', startedAt);
				console.error('[svelte-adapter-ws] message handling failed:', err);
			}
		);
	});

	rawWs.on('close', (code, reason) => {
		if (idleTimer !== null) clearIntervalTimer(idleTimer);
		// 1000 (normal) and 1001 (going away) are the two codes a peer sends
		// deliberately; everything else - including the 1006 a dropped TCP
		// connection synthesizes - is an abnormal end.
		hWsConnectionDuration?.observe(
			OUTCOME_ONLY_LABELS[code === 1000 || code === 1001 ? 'clean' : 'abnormal'],
			Math.max(0, monotonicNow() - userData[WS_STATS].openedAt) / 1000
		);
		closeConnection(rawWs, facade, userData, code, reason);
	});

	// The app open hook runs LAST, with every listener armed: a throw here is
	// contained and the connection keeps its close path.
	try {
		wsModule.open?.(facade, { platform: userData[WS_PLATFORM] });
	} catch (err) {
		console.error('[adapter-ws] open hook threw:', err);
	}
}

/**
 * One completed inbound message, by kind and outcome.
 * @param {'text' | 'binary'} kind
 * @param {'ok' | 'error'} outcome
 * @param {number} startedAt
 */
function observeWsMessage(kind, outcome, startedAt) {
	if (mWsMessages === undefined && hWsMessageDuration === undefined) return;
	const labels = WS_MESSAGE_METRIC_LABELS[kind][outcome];
	mWsMessages?.inc(labels);
	hWsMessageDuration?.observe(labels, Math.max(0, monotonicNow() - startedAt) / 1000);
}

/** @param {object} facade @param {any} rejection */
function rejectApplicationMessage(facade, rejection) {
	mMessageAdmissionRejected?.inc({ reason: rejection.reason, scope: rejection.scope });
	sendControl(facade, messageOverloadedFrame(rejection));
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {Buffer} raw
 * @param {boolean} isBinary
 */
async function handleMessage(rawWs, facade, userData, raw, isBinary) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
	bumpIn(userData, buf);

	// Binary ingress (client-to-server 0x03): an ingress-capable connection's
	// id-addressed binary frames decode and route ahead of the JSON control
	// block and the app hook. Only an actual 0x03 frame pays the cap lookup.
	if (isBinary && buf[0] === 0x03) {
		const icaps = userData[WS_CAPS];
		if (icaps !== undefined && icaps.has(WIRE_INGRESS_CAP)) {
			await runAdmittedMessageWork(messageAdmission, facade, { data: buf, platform: userData[WS_PLATFORM] }, runIngressWork, rejectApplicationMessage);
			return;
		}
	}

	// Oversized control-shaped frame: reject explicitly instead of a silent
	// fall-through.
	if (!isBinary && buf.byteLength >= 8192 && buf[3] === 0x79 /* 'y' in {"type" */) {
		// Charged and counted like every other control-demux send
		// (welcome, lease-ok, resumed, ingress-ok, subscribe-denied). An
		// error frame is outbound traffic like any other: a close hook's
		// byte accounting must not silently drop it, and a client that
		// provokes refusals is spending the same channel as one that
		// provokes acks.
		sendControl(facade, controlFrameTooLargeFrame(buf.byteLength));
		return;
	}

	/** @type {any} */
	let msg;
	if (!isBinary && buf.byteLength < 8192 && buf[3] === 0x79) {
		try {
			msg = JSON.parse(buf.toString());
			if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) msg = undefined;
		} catch {
			msg = undefined;
		}
	}

	// Control dispatch runs OUTSIDE the parse guard: a throw inside a control
	// handler surfaces to the message-loop catch instead of being swallowed
	// and the frame re-delivered to the app hook as raw bytes.
	if (msg !== undefined) {

			if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
				await handleSubscribe(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
				tombstonePendingSubscribe(userData, msg.topic);
				{ const subsSet = userData[WS_SUBSCRIPTIONS]; if (subsSet instanceof Set) removeLogicalSubscription(subsSet, msg.topic); }
				try { facade.unsubscribe(msg.topic); } catch { /* closed */ }
				if (userData[WS_PUBLISH_GRANT] === msg.topic) userData[WS_PUBLISH_GRANT] = undefined;
				releaseDerivedSubscriptions(facade, msg.topic);
				wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
				return;
			}
			if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
				await handleSubscribeBatch(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'hello' && Array.isArray(msg.caps)) {
				const caps = new Set();
				for (let i = 0; i < msg.caps.length; i++) {
					if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
				}
				// A re-sent hello REPLACES the cap set; the live per-capability
				// counts follow the diff.
				capCounts.adjust(userData[WS_CAPS], caps);
				userData[WS_CAPS] = caps;
				// Opt-in confirm for binary ingress (mirror of lease-ok).
				if (caps.has(WIRE_INGRESS_CAP)) {
					sendControl(facade, ingressOkFrame());
				}
				// Only the first hello allocates the lease slot and emits the
				// first window, so a re-sent hello does not reset the gate.
				if (caps.has('lease') && !userData[WS_LEASE]) {
					const grantCount = leaseGrantSize({
						heapRatio: counters.lastHeapUsedRatio,
						subscriberRatio: wsConnections.size > 0 ? counters.totalSubscriptions / wsConnections.size : 0
					});
					const gate = createLeaseState({ requestCount: grantCount, ttlMs: DEFAULT_GRANT.ttlMs });
					gate.grant();
					userData[WS_LEASE] = { gate, saturation: 0 };
					sendControl(facade, '{"type":"lease-ok"}');
					sendControl(facade, leaseGrantFrame(grantCount, DEFAULT_GRANT.ttlMs));
				}
				return;
			}
			if (msg.type === 'reply' && (typeof msg.ref === 'number' || typeof msg.ref === 'string')) {
				const pending = userData[WS_PENDING_REQUESTS];
				const entry = pending?.get(msg.ref);
				if (entry) {
					pending.delete(msg.ref);
					clearTimer(entry.timer);
					if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
					else entry.resolve(msg.data);
				}
				return;
			}
			if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
				msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
				await handleWholeSessionResume(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
				// Client binds a client-allocated ingress id to a decode+route
				// destination. Unknown kind: no bind, no ack, JSON fallback.
				if (bindIngress(userData, facade, msg.id, msg.kind, msg.target)) {
					sendControl(facade, ingressBoundFrame(msg.id));
				}
				return;
			}
			if (msg.type === 'request-n') {
				const slot = userData[WS_LEASE];
				if (slot) {
					slot.saturation = leaseReportedSaturation(msg.queued);
					if (slot.saturation > counters.leaseSaturationPeak) counters.leaseSaturationPeak = slot.saturation;
					const regrant = leaseGrantSize({
						heapRatio: counters.lastHeapUsedRatio,
						subscriberRatio: wsConnections.size > 0 ? counters.totalSubscriptions / wsConnections.size : 0
					});
					slot.gate.requestN(regrant, DEFAULT_GRANT.ttlMs);
					sendControl(facade, leaseGrantFrame(regrant, DEFAULT_GRANT.ttlMs));
				}
				return;
			}
			if (msg.type === 'game') {
				await runAdmittedMessageWork(messageAdmission, facade, { msg, platform: userData[WS_PLATFORM], data: raw }, runGameWork, rejectApplicationMessage);
				return;
			}
	}

	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	await runAdmittedMessageHook(messageAdmission, wsModule.message, facade, { data: arrayBuffer, isBinary, msg, platform: userData[WS_PLATFORM] }, rejectApplicationMessage);
}

/** @param {any} facade @param {any} context */
function runIngressWork(facade, context) {
	return dispatchIngressFrame(facade, facade.getUserData(), context.data, context.platform);
}

/** @param {any} facade @param {any} context */
function runGameWork(facade, context) {
	const msg = context.msg;
	const gud = facade.getUserData();
	const grantTopic = gud?.[WS_PUBLISH_GRANT];
	// The game lane's room sequencer is worker-local, so a topology where
	// sockets can land on more than one I/O worker denies the frame rather
	// than forking a room's sequence across workers - the same rule
	// grantPublish enforces at authorization time.
	const clusterSafe = gameLaneClusterSafe(workerData);
	if (!clusterSafe || !grantTopic || typeof msg.event !== 'string') {
		const reason = clusterSafe && grantTopic ? 'INVALID' : 'FORBIDDEN';
		const denied = msg.id === undefined
			? JSON.stringify({ type: 'game-denied', reason })
			: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
		sendControl(facade, denied);
		return;
	}
	context.platform.publishGame(facade, grantTopic, msg.event, msg.data, msg.id);
}

/** @param {any} facade @param {string} topic @param {number | string | null} ref */
function sendSubscribed(facade, topic, ref) {
	if (ref === null) return;
	// Carry the topic's current generation on the ack so a later resume can
	// detect a reset seq space.
	sendControl(facade, JSON.stringify({ type: 'subscribed', topic, ref, epoch: platform.topicEpoch(topic) }));
}

/** @param {any} facade @param {string} topic @param {number | string | null} ref @param {string} reason */
function sendDenied(facade, topic, ref, reason) {
	if (ref === null) return;
	sendControl(facade, JSON.stringify({ type: 'subscribe-denied', topic, ref, reason }));
}

/** @param {unknown} ref @returns {ref is number | string} */
function hasRefValue(ref) {
	return typeof ref === 'number' || typeof ref === 'string';
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleSubscribe(rawWs, facade, userData, msg) {
	const ref = hasRefValue(msg.ref) ? msg.ref : null;
	// A ref-less frame gets deliberate silence from every refusal below - the
	// client said it would not listen. The recover lane is the exception: a
	// caller replaying an offset and hearing nothing cannot tell "it took" from
	// "something refused it", and resumes into a gap. Refused first, before any
	// check or hook can swallow it, with the uncorrelatable-error shape.
	if (deniesRefLessRecover({ hasResumeHook: wsModule.resume, recover: msg.recover, ref })) {
		sendControl(facade, recoverRequiresRefFrame(msg.topic));
		return;
	}
	if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS)) {
		sendDenied(facade, msg.topic, ref, 'INVALID_TOPIC');
		return;
	}
	if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic: msg.topic })) {
		sendDenied(facade, msg.topic, ref, 'INVALID_TOPIC');
		return;
	}
	const subs = userData[WS_SUBSCRIPTIONS];
	assert(subs instanceof Set, 'subs.shape', null);
	const isNew = !subs.has(msg.topic);
	if (exceedsSubscriptionCap({ held: !isNew, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
		sendDenied(facade, msg.topic, ref, 'RATE_LIMITED');
		return;
	}
	if (deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: !isNew, topic: msg.topic })) {
		sendDenied(facade, msg.topic, ref, 'FORBIDDEN');
		return;
	}
	if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(userData), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) {
		sendDenied(facade, msg.topic, ref, 'RATE_LIMITED');
		return;
	}
	// Enrol before the await so a revocation landing while the hook is parked
	// can see this subscribe and cancel it.
	const pendingToken = beginPendingSubscribe(userData, msg.topic, subs.has(msg.topic));
	const denial = await runUserSubscribeGate(facade, msg.topic);
	if (denial !== null) {
		if (settleDeniedSubscribe(userData, msg.topic, pendingToken, subs.has(msg.topic)) === 'deny-unwind') {
			unwindRevokedMembership(facade, msg.topic);
			wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
		}
		sendDenied(facade, msg.topic, ref, denial);
		return;
	}
	// Post-await held re-check - except when a gap-fill was requested: live
	// membership arriving during the await carries no history.
	const _wantsRecover = wantsRecover({ hasResumeHook: wsModule.resume, recover: msg.recover });
	if (subs.has(msg.topic) && !_wantsRecover) {
		const heldVerdict = settleHeldSubscribe(userData, msg.topic, pendingToken);
		if (heldVerdict === 'ack') {
			sendSubscribed(facade, msg.topic, ref);
			return;
		}
		if (heldVerdict === 'deny-unwind') {
			unwindRevokedMembership(facade, msg.topic);
			wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
		}
		sendDenied(facade, msg.topic, ref, 'FORBIDDEN');
		return;
	}
	// Landing re-check: the pre-gate stands aside for a plugin-owned topic so
	// the plugin's hook can run; the landing confirms the hook actually
	// admitted this socket.
	if (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: subs.has(msg.topic), topic: msg.topic })) {
		settlePendingSubscribe(userData, msg.topic, pendingToken);
		sendDenied(facade, msg.topic, ref, 'FORBIDDEN');
		return;
	}
	if (exceedsSubscriptionCap({ held: subs.has(msg.topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
		settlePendingSubscribe(userData, msg.topic, pendingToken);
		sendDenied(facade, msg.topic, ref, 'RATE_LIMITED');
		return;
	}
	// Resume-on-subscribe: gap-fill via the resume hook before subscribing to
	// live, so __replay frames precede the first live frame.
	let capture = null;
	const _recoverRevoked = recoverIsRevoked({
		held: subs instanceof Set && subs.has(msg.topic),
		wireAuthz: subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()),
		cancelled: isPendingSubscribeCancelled(userData, msg.topic, pendingToken),
		topic: msg.topic
	});
	if (!_recoverRevoked && _wantsRecover) {
		const epochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
		capture = beginResumeCapture([msg.topic], facade);
		try {
			await wsModule.resume(facade, {
				sessionId: userData[WS_SESSION_ID],
				lastSeenSeqs: { [msg.topic]: msg.recover.offset },
				lastSeenEpochs: epochs,
				platform: userData[WS_PLATFORM]
			});
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err);
		}
		if (subs.has(msg.topic)) {
			const heldVerdictR = settleHeldSubscribe(userData, msg.topic, pendingToken);
			if (heldVerdictR === 'ack') {
				discardResumeCapture(capture);
				sendSubscribed(facade, msg.topic, ref);
				return;
			}
			if (heldVerdictR === 'deny-unwind') {
				unwindRevokedMembership(facade, msg.topic);
				wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
			}
			discardResumeCapture(capture);
			sendDenied(facade, msg.topic, ref, 'FORBIDDEN');
			return;
		}
	}
	// Landing settle: a revocation that bumped this subscribe's epoch while
	// the hook was parked means the grant is discarded, not installed.
	if (!settlePendingSubscribe(userData, msg.topic, pendingToken, true)) {
		if (capture) discardResumeCapture(capture);
		sendDenied(facade, msg.topic, ref, 'FORBIDDEN');
		return;
	}
	try {
		facade.subscribe(msg.topic);
	} catch {
		if (capture) discardResumeCapture(capture);
		counters.closedWsAborts++;
		return;
	}
	addLogicalSubscription(subs, msg.topic);
	if (capture) {
		flushResumeTopic(capture, msg.topic, (payload) => {
			try {
				const result = facade.send(payload, false, false);
				if (result !== 2) bumpOut(userData, payload);
				return result;
			} catch { return 2; }
		});
	}
	sendSubscribed(facade, msg.topic, ref);
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleSubscribeBatch(rawWs, facade, userData, msg) {
	const ref = hasRefValue(msg.ref) ? msg.ref : null;
	// One ref covers the whole batch, so a missing one orphans every history
	// request the frame's recover map names - refused whole, before any entry
	// is inspected, like the batch's other contract refusals.
	if (deniesRefLessRecoverBatch({ hasResumeHook: wsModule.resume, recover: msg.recover, ref })) {
		sendControl(facade, recoverRequiresRefFrame(null));
		return;
	}
	const topics = msg.topics.slice(0, 256);
	// Topics past the 256 cap are denied loudly, never silently dropped.
	for (let i = 256; i < msg.topics.length; i++) {
		if (typeof msg.topics[i] === 'string') {
			sendDenied(facade, msg.topics[i], ref, 'BATCH_OVERFLOW');
		}
	}
	const valid = [];
	for (const topic of topics) {
		if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS)) {
			sendDenied(facade, topic, ref, 'INVALID_TOPIC');
			continue;
		}
		if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic })) {
			sendDenied(facade, topic, ref, 'INVALID_TOPIC');
			continue;
		}
		valid.push(topic);
	}
	// One reading of the app's hooks per frame - the reload path reassigns
	// them, and a per-topic read could split one frame across two versions.
	const _hasUserHook = hasUserSubscribeHook();
	const _wireAuthz = subscribeAuth.enabled && (subscribeAuth.strict || !_hasUserHook);
	const _authzSubs = userData[WS_SUBSCRIPTIONS];
	const authzDenied = _wireAuthz
		? valid.map((t) => deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held: _authzSubs instanceof Set && _authzSubs.has(t), topic: t }))
		: null;
	// In-flight authorization capacity: topics beyond the pending budget take
	// no further part in the frame.
	const headroom = MAX_PENDING_SUBSCRIBES_PER_CONNECTION - pendingSubscribeTotal(userData);
	if (headroom < valid.length) {
		for (let i = Math.max(headroom, 0); i < valid.length; i++) {
			sendDenied(rawWs, valid[i], ref, authzDenied?.[i] ? 'FORBIDDEN' : 'RATE_LIMITED', userData);
		}
		valid.length = Math.max(headroom, 0);
	}
	// A topic the grant gate already denied must not reach the hook.
	const hookTopics = authzDenied === null
		? valid.slice()
		: valid.filter((_t, i) => !authzDenied[i]);
	// Enrol every topic in the batch before the hook awaits.
	const batchTokens = valid.map((t) => beginPendingSubscribe(userData, t, _authzSubs instanceof Set && _authzSubs.has(t)));

	/** @type {Record<string, string> | null} */
	let batchDenials = null;
	/** @type {Array<string | null> | null} */
	let perTopicDenials = null;
	if (wsModule.subscribeBatch && hookTopics.length > 0) {
		try {
			const result = await wsModule.subscribeBatch(facade, hookTopics, { platform: userData[WS_PLATFORM] });
			batchDenials = Object.create(null);
			if (result && typeof result === 'object') {
				try {
					for (const [topic, val] of Object.entries(result)) {
						if (val === false) batchDenials[topic] = 'FORBIDDEN';
						else if (typeof val === 'string') batchDenials[topic] = val;
					}
				} catch (err) {
					console.error('[adapter-ws] subscribeBatch result read threw:', err);
					batchDenials = Object.create(null);
					for (const t of hookTopics) batchDenials[t] = 'INTERNAL_ERROR';
				}
			}
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_HOOK), err);
			batchDenials = Object.create(null);
			for (const t of hookTopics) batchDenials[t] = 'INTERNAL_ERROR';
		}
	} else if (wsModule.subscribe) {
		perTopicDenials = await Promise.all(valid.map((t, i) =>
			(authzDenied !== null && authzDenied[i]) ? Promise.resolve(null) : runUserSubscribeGate(facade, t)));
	}

	const udSubs = userData[WS_SUBSCRIPTIONS];
	assert(udSubs instanceof Set, 'subs.shape-batch', null);

	// Resume-on-subscribe (batch): gap-fill every recover-tagged topic that
	// passed the gates in one resume-hook call, before the subscribe loop.
	/** @type {Record<string, number> | null} */
	let recoverSeqs = null;
	/** @type {Record<string, number> | null} */
	let recoverEpochs = null;
	let batchCapture = null;
	if (msg.recover && typeof msg.recover === 'object') {
		for (let i = 0; i < valid.length; i++) {
			const t = valid[i];
			const held = udSubs instanceof Set && udSubs.has(t);
			const denial = (authzDenied !== null && authzDenied[i] ? 'FORBIDDEN' : null)
				?? (recoverIsRevoked({ held, wireAuthz: _wireAuthz, cancelled: isPendingSubscribeCancelled(userData, t, batchTokens[i]), topic: t }) ? 'FORBIDDEN' : null)
				?? (batchDenials !== null ? (batchDenials[t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
			if (denial !== null) continue;
			const rec = msg.recover[t];
			if (wantsRecover({ hasResumeHook: wsModule.resume, recover: rec })) {
				if (recoverSeqs === null) recoverSeqs = {};
				recoverSeqs[t] = rec.offset;
				if (Number.isInteger(rec.epoch)) {
					if (recoverEpochs === null) recoverEpochs = {};
					recoverEpochs[t] = rec.epoch;
				}
			}
		}
		if (recoverSeqs !== null && wsModule.resume) {
			batchCapture = beginResumeCapture(Object.keys(recoverSeqs), facade);
			try {
				await wsModule.resume(facade, {
					sessionId: userData[WS_SESSION_ID],
					lastSeenSeqs: recoverSeqs,
					lastSeenEpochs: recoverEpochs || undefined,
					platform: userData[WS_PLATFORM]
				});
			} catch (err) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err);
			}
		}
	}

	for (let i = 0; i < valid.length; i++) {
		const topic = valid[i];
		const held = udSubs.has(topic);
		const denial = (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held, topic }) ? 'FORBIDDEN' : null)
			?? (batchDenials !== null
				? (batchDenials[topic] ?? null)
				: (perTopicDenials !== null ? perTopicDenials[i] : null));
		if (denial !== null) {
			if (settleDeniedSubscribe(userData, topic, batchTokens[i], held) === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: userData[WS_PLATFORM] });
			}
			sendDenied(facade, topic, ref, denial);
			continue;
		}
		if (held) {
			const heldVerdict = settleHeldSubscribe(userData, topic, batchTokens[i]);
			if (heldVerdict === 'ack') {
				sendSubscribed(facade, topic, ref);
				continue;
			}
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: userData[WS_PLATFORM] });
			}
			sendDenied(facade, topic, ref, 'FORBIDDEN');
			continue;
		}
		if (exceedsSubscriptionCap({ held, size: udSubs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
			settlePendingSubscribe(userData, topic, batchTokens[i]);
			sendDenied(facade, topic, ref, 'RATE_LIMITED');
			continue;
		}
		if (!settlePendingSubscribe(userData, topic, batchTokens[i], true)) {
			sendDenied(facade, topic, ref, 'FORBIDDEN');
			continue;
		}
		try {
			facade.subscribe(topic);
		} catch {
			counters.closedWsAborts++;
			continue;
		}
		addLogicalSubscription(udSubs, topic);
		if (batchCapture) {
			flushResumeTopic(batchCapture, topic, (payload) => {
				try {
					const result = facade.send(payload, false, false);
					if (result !== 2) bumpOut(userData, payload);
					return result;
				} catch { return 2; }
				});
		}
		sendSubscribed(facade, topic, ref);
	}
	if (batchCapture) discardResumeCapture(batchCapture);
}

/**
 * The whole-session `resume` frame (compat carrier; resume-on-subscribe is
 * the reference mechanism).
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleWholeSessionResume(rawWs, facade, userData, msg) {
	const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
		? msg.lastSeenEpochs
		: undefined;
	// Grant filter: under the pure-grant model, ungranted topics are dropped
	// before the hook sees them.
	let resumeSeqs = msg.lastSeenSeqs;
	let resumeEpochs = lastSeenEpochs;
	if (subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()) && resumeSeqs && typeof resumeSeqs === 'object') {
		const grants = userData[WS_SUBSCRIPTIONS];
		/**
		 * Both client-named maps on this frame take the same filter.
		 * They arrive keyed the same way, by the same client, in the
		 * same frame, and the hook reads them together - an app
		 * checking for an epoch mismatch iterates the epoch map, so a
		 * topic dropped from the seqs and left in the epochs is a
		 * topic the gate refused arriving by the other hand.
		 * @param {Record<string, unknown>} map
		 * @returns {Record<string, unknown>}
		 */
		const filterGranted = (map) => {
			/** @type {Record<string, unknown>} */
			const allowed = Object.create(null);
			let droppedCount = 0;
			for (const t of Object.keys(map)) {
				if (deniesUngrantedObserve(true, false, grants, t)) { droppedCount++; continue; }
				allowed[t] = map[t];
			}
			return droppedCount > 0 ? allowed : map;
		};
		resumeSeqs = filterGranted(resumeSeqs);
		if (resumeEpochs) resumeEpochs = filterGranted(resumeEpochs);
	}
	if (wsModule.resume) {
		try {
			// Awaited so per-topic replay completes before the `resumed` ack
			// tells the client to switch to live mode.
			await wsModule.resume(facade, {
				sessionId: msg.sessionId,
				lastSeenSeqs: resumeSeqs,
				lastSeenEpochs: resumeEpochs,
				platform: userData[WS_PLATFORM]
			});
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RESUME_HOOK), err);
		}
	}
	sendControl(facade, '{"type":"resumed"}');
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {number} code
 * @param {Buffer} reason
 */
function closeConnection(rawWs, facade, userData, code, reason) {
	const reasonBuf = reason || Buffer.alloc(0);
	const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
	messageAdmission.close(facade);
	const subs = userData[WS_SUBSCRIPTIONS] || new Set();
	// Reject pending requests, clearing timers first; delete-then-reject so a
	// reply racing the close cannot double-settle.
	const pending = userData[WS_PENDING_REQUESTS];
	if (pending && pending.size > 0) {
		for (const entry of pending.values()) {
			clearTimer(entry.timer);
			try {
				entry.reject(new Error(adapterErrorMessage(
					ADAPTER_ERROR_IDS.REQUEST_CLOSED,
					entry.sent
						? REQUEST_CLOSED_DETAIL.UNANSWERED
						: REQUEST_CLOSED_DETAIL.NEVER_SENT
				)));
			} catch { /* listener threw */ }
		}
		pending.clear();
	}
	const stats = userData[WS_STATS];
	const closePlatform = userData[WS_PLATFORM];
	// The app close hook fires only for a connection whose open completed
	// (an attribution refusal never opened).
	if (userData[WS_SESSION_ID] !== undefined && wsModule.close) {
		const ctx = stats
			? {
				code,
				message: reasonAB,
				platform: closePlatform,
				subscriptions: subs,
				id: userData[WS_SESSION_ID],
				duration: Math.round(monotonicNow() - stats.openedAt),
				messagesIn: stats.messagesIn,
				messagesOut: stats.messagesOut,
				bytesIn: stats.bytesIn,
				bytesOut: stats.bytesOut
			}
			: { code, message: reasonAB, platform: closePlatform, subscriptions: subs };
		try {
			wsModule.close(facade, ctx);
		} catch (err) {
			console.error('[adapter-ws] close hook threw:', err);
		}
	}
	// Leave the live set FIRST, before any other release. Everything below is
	// teardown that reads userData and touches no connection set, but it is
	// unguarded: one throw anywhere in it used to skip the removal and stand
	// the connection in `wsConnections` forever. A stranded entry is not a
	// leak that stays still - every publish walk keeps visiting a dead socket,
	// and its topics keep counting toward the auditor's summed bookkeeping
	// while the accountant has already released them, which reports as a
	// subscription-ledger mismatch that no membership explains. Removal owes
	// nothing to the steps below, so it goes where nothing can skip it.
	wsConnections.delete(facade);
	releaseConnectionPermitFor(userData);
	accountClosedLogicalSubscriptions(subs);
	if (userData[WS_LEASE]) userData[WS_LEASE] = undefined;
	capCounts.adjust(userData[WS_CAPS], null);
	userData[WS_CAPS] = undefined;
	detachWireStates(facade, userData);
	unregisterSocket(rawWs);
	wsWrappers.delete(rawWs);
}

// - Authenticate preflight endpoint ------------------------------------------

/**
 * Handle the authenticate POST at WS_AUTH_PATH as a normal HTTP exchange so
 * session cookies refresh via a standard Set-Cookie. Returns true when the
 * request was handled here.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean}
 */
export function tryAuthenticateRoute(req, res, pathname) {
	if (pathname !== WS_AUTH_PATH) return false;
	if (!wsModule.authenticate) return false;
	const authenticate = () => runAuthenticateRoute(req, res).catch(() => {
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain' });
			res.end('Internal Server Error');
		}
	});
	if (tracingEnabled) {
		void traceOperation('adapter.http.websocket-authenticate', {
			kind: 'server',
			parent: extractTraceContext({
				traceparent: /** @type {string} */ (req.headers['traceparent']),
				tracestate: /** @type {string} */ (req.headers['tracestate'])
			}),
			attributes: {
				'http.request.method': req.method || 'POST',
				'network.protocol.name': 'http'
			}
		}, authenticate);
	} else {
		void authenticate();
	}
	return true;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function runAuthenticateRoute(req, res) {
	if (req.method !== 'POST') {
		// Length-framed like the shared writers in http-helpers.js. This route
		// keeps its own copies because its Allow value is POST alone, but one
		// status with one body must not be framed two ways by one server.
		const body = 'Method Not Allowed';
		res.writeHead(405, {
			allow: 'POST',
			'content-type': 'text/plain',
			'content-length': String(Buffer.byteLength(body))
		});
		res.end(body);
		return;
	}

	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		const body = 'Bad Request';
		res.writeHead(400, {
			'content-type': 'text/plain',
			'content-length': String(Buffer.byteLength(body))
		});
		res.end(body);
		return;
	}

	// CSRF defense FIRST, the limiter after: metering rejected origins would
	// let hostile cross-site traffic behind a shared NAT consume the
	// legitimate clients' whole authentication budget.
	if (AUTH_PATH_REQUIRE_ORIGIN && !isAuthOriginAccepted(headers, {
		allowedOrigins: ALLOWED_ORIGINS,
		pinnedOrigin,
		hostHeader: host_header,
		protocolHeader: protocol_header,
		portHeader: port_header,
		isTls: is_tls,
		hasUpgradeHook: false
	})) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('Origin not allowed');
		return;
	}

	const direct = req.socket?.remoteAddress || '';
	const clientIp = resolveClientIp(direct, headers, direct);
	if (authPathRateLimiter.exceeded(clientIp, now())) {
		// The preflight door has its own reason: a 429 here never reached the
		// upgrade gate, and folding it into ip_rate_limit would hide which door
		// an attack is hitting.
		mUpgradeRejected?.inc({ reason: 'auth_rate_limit' });
		res.writeHead(429, { 'content-type': 'text/plain' });
		res.end('Too Many Requests');
		return;
	}

	// Read the body, capped at 64 KB - the hook rarely needs one.
	const AUTH_BODY_LIMIT = 64 * 1024;
	/** @type {Buffer[]} */
	const chunks = [];
	let total = 0;
	let oversized = false;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > AUTH_BODY_LIMIT) { oversized = true; break; }
		chunks.push(chunk);
	}
	if (oversized) {
		res.writeHead(413, { 'content-type': 'text/plain' });
		res.end('Content Too Large');
		return;
	}
	const bodyBuf = Buffer.concat(chunks);

	const requestOrigin = (is_tls ? 'https://' : 'http://') + (headers['host'] || 'localhost');
	const url = req.url || WS_AUTH_PATH;
	const request = new Request(requestOrigin + url, {
		method: 'POST',
		headers,
		body: bodyBuf.length > 0 ? bodyBuf : undefined,
		// @ts-expect-error node accepts half-duplex request bodies
		duplex: 'half'
	});

	const cookies = createCookies(headers['cookie'], request.url);
	const authRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();
	const authPlatform = Object.create(platform);
	authPlatform.requestId = authRequestId;
	const event = {
		request,
		headers,
		cookies,
		url,
		remoteAddress: clientIp,
		getClientAddress: () => clientIp,
		platform: authPlatform
	};

	try {
		const result = await Promise.resolve(wsModule.authenticate(event));

		if (result === false) {
			res.writeHead(401, { 'content-type': 'text/plain' });
			res.end('Unauthorized');
			return;
		}

		if (result instanceof Response) {
			/** @type {Record<string, string | string[]>} */
			const outHeaders = {};
			for (const [hk, hv] of result.headers) {
				if (hk === 'set-cookie' || hk === 'content-length') continue;
				outHeaders[hk] = hv;
			}
			const outCookies = [
				...result.headers.getSetCookie(),
				...cookies._serialize()
			];
			if (outCookies.length > 0) outHeaders['set-cookie'] = outCookies;
			res.writeHead(result.status, outHeaders);
			if (result.body) {
				res.end(Buffer.from(await result.arrayBuffer()));
			} else {
				res.end();
			}
			return;
		}

		const outCookies = cookies._serialize();
		if (outCookies.length > 0) res.writeHead(204, { 'set-cookie': outCookies });
		else res.writeHead(204);
		res.end();
	} catch (err) {
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.authenticate',
			event: 'runtime.authenticate.failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The WebSocket authentication endpoint failed.',
			attributes: { requestId: authRequestId, error: diagnosticError(err) }
		});
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain', 'x-request-id': authRequestId });
			res.end('Internal Server Error');
		}
	}
}

/**
 * Fire the app's init hook once, awaited, before readiness commits.
 * @param {any} workerData
 */
let initFired = false;
export async function fireInitOnce(workerData = null) {
	if (initFired) return;
	if (typeof wsModule.init === 'function') {
		await wsModule.init({ platform, workerData });
	}
	initFired = true;
}

/** @returns {string} the configured WebSocket path (for the 426 route) */
export function wsPath() {
	return WS_PATH;
}

/**
 * The response shape the shared refusal writers speak, over a node response.
 * The HTTP routes below answer through the same sendWaitingRoomPage() the
 * upgrade path uses, so a holding page is byte-identical whichever door it
 * came through.
 *
 * @param {import('node:http').ServerResponse} res
 */
function httpRefusalResponse(res) {
	let status = 200;
	let statusText = 'OK';
	// Null-prototype: header names arrive lowercased from a writer, and a name
	// like `__proto__` assigned into a plain object hits Object.prototype's
	// setter - the write lands nowhere, the key never appears among the own
	// properties, and nothing throws, so the header is dropped in silence.
	// `normalizeStaticHeaders` takes the same precaution for the same reason:
	// `__proto__` is a valid field-name token, so no name check refuses it and
	// only a null-prototype accumulator carries it.
	/** @type {Record<string, string>} */
	const headers = Object.create(null);
	const facade = {
		cork(fn) { fn(); return facade; },
		writeStatus(statusLine) {
			const line = String(statusLine);
			const space = line.indexOf(' ');
			status = Number.parseInt(line, 10) || 200;
			statusText = space === -1 ? '' : line.slice(space + 1);
			return facade;
		},
		writeHeader(name, value) { headers[String(name).toLowerCase()] = String(value); return facade; },
		end(body) {
			try {
				const text = body == null ? '' : String(body);
				// uWS derives a length from the body handed to end(), so this
				// facade fills one in too: without it node answers chunked
				// where the family answers with a length, and a HEAD carries
				// no size at all. Never on a status defined to carry no body,
				// and never over a length the writer set for itself.
				if (
					headers['content-length'] === undefined &&
					status >= 200 && status !== 204 && status !== 304
				) headers['content-length'] = String(Buffer.byteLength(text));
				res.writeHead(status, statusText || undefined, headers);
				res.end(text);
			} catch { /* exchange already gone */ }
			return facade;
		}
	};
	return facade;
}

/**
 * The GET answer on the WebSocket path. A browser NAVIGATION to the socket URL
 * lands here rather than on the upgrade listener, so the two doors have to
 * negotiate a full gate identically: below capacity it is the ordinary
 * upgrade-required hint, at capacity it is the holding page (or the accessible
 * 503 when the room is opted out) for an HTML navigation and the bare 503 for
 * everything else.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {string} search - the query string including its leading '?', or ''
 * @returns {void}
 */
export function serveWsPathGet(req, res, pathname, search) {
	// Siege answers this navigation the same way the upgrade door answers the
	// handshake behind it; without the posture test a sieged server would hand
	// a browser 'upgrade required' and then refuse the upgrade it just asked
	// for. At normal and elevated the live gate stays the source of truth.
	//
	// The siege test sits OUTSIDE the armed guard on purpose: the upgrade
	// short-circuit refuses on posture alone, with no ceiling configured, so
	// gating this one behind ADMISSION_ARMED would reinstate exactly the
	// mismatch above for a deployment that pins `protection: 'siege'` and
	// configures no `upgradeAdmission` at all.
	if (postureLevel() !== 'siege' && (!ADMISSION_ARMED || admission.hasCapacity())) {
		const body = 'WebSocket upgrade required';
		res.writeHead(426, {
			'content-type': 'text/plain',
			upgrade: 'websocket',
			'content-length': String(Buffer.byteLength(body))
		});
		res.end(body);
		return;
	}
	if (negotiateRejection(headerValue(req, 'accept'), headerValue(req, 'upgrade')) === 'html') {
		if (WAITING_ROOM !== null) {
			// The same page the refusal path serves: no seeded count, the first
			// poll fills it in.
			sendWaitingRoomPage(httpRefusalResponse(res), WAITING_ROOM.renderResponse(
				undefined,
				createWaitingRoomRequest(waitingRoomRequestFacade(req, pathname, search.slice(1)))
			));
			return;
		}
		sendWaitingRoomPage(httpRefusalResponse(res), {
			body: buildAccessibleCapacityRefusalPage(),
			lang: 'en',
			dir: 'ltr',
			headers: [['retry-after', String(refusalRetryAfter())]],
			varyAcceptLanguage: false
		}, '503 Service Unavailable');
		return;
	}
	res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': String(refusalRetryAfter()) });
	res.end('Server is at upgrade capacity, please retry');
}

/**
 * The waiting room's own two GET routes: the capacity poll the holding page
 * calls, and direct navigation to the page itself. Both are read-only - the
 * poll probes capacity via `hasCapacity()` and never acquires - so polling can
 * never consume a gate slot. Returns true when the request was answered here.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {string} search - the query string including its leading '?', or ''
 * @returns {boolean}
 */
export function tryWaitingRoomRoute(req, res, pathname, search) {
	if (WAITING_ROOM === null) return false;
	if (pathname === WAITING_ROOM.admitCheckPath) {
		pollCounter.record(now());
		// Siege never admits a reload into a full gate: it always reports busy,
		// even while the live gate has free slots. At normal and elevated
		// `hasCapacity()` stays the source of truth, so the poll only ever ADDS
		// the siege always-202 gate - it never admits a client the real gate
		// would reject.
		if (postureLevel() !== 'siege' && admission.hasCapacity()) {
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
			res.end('{"admit":true}');
			return true;
		}
		const queueDepth = pollCounter.depth(now());
		const estimatedSeconds = WAITING_ROOM.estimateSeconds(queueDepth);
		// Widen the poll cadence under siege so a packed room thins its own
		// retry rate; normal and elevated keep the configured interval. The
		// client honours what is served here, so this is the only lever on it.
		const pollAfterMs = postureLevel() === 'siege'
			? WAITING_ROOM.pollIntervalMs * 2
			: WAITING_ROOM.pollIntervalMs;
		// 202 rather than 503 so the poll itself is never read as a failed or
		// rate-limited upgrade: it holds no socket and stays distinguishable
		// in logs.
		res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(
			'{"admit":false,"queueDepth":' + queueDepth +
			',"estimatedSeconds":' + estimatedSeconds +
			',"pollAfterMs":' + pollAfterMs + '}'
		);
		return true;
	}
	if (pathname === WAITING_ROOM.path) {
		sendWaitingRoomPage(httpRefusalResponse(res), WAITING_ROOM.renderResponse(
			pollCounter.depth(now()),
			createWaitingRoomRequest(waitingRoomRequestFacade(req, pathname, search.slice(1)))
		));
		return true;
	}
	return false;
}

/**
 * Managed WebSocket drain: `http.close()` never completes while a socket is
 * open and live sockets keep working after it, so shutdown closes them
 * itself. With a dispersal window the reconnect advisory scatters the herd
 * and closes each socket with 1001; without one every socket is closed
 * directly. Sockets that ignore the close frame past the deadline are
 * terminated.
 *
 * @param {{ dispersalMs: number, deadlineMs: number, pollMs?: number, signal?: AbortSignal | null }} opts
 *   `signal` is the shutdown budget shared with every other phase: once it
 *   aborts the wait ends at once and the holdouts are terminated, so this drain
 *   spends what the budget has left rather than a window of its own.
 * @returns {Promise<void>}
 */
export async function drainSockets({ dispersalMs, deadlineMs, pollMs = 50, signal = null }) {
	if (wsConnections.size === 0) return;
	if (dispersalMs > 0) {
		platform.adviseReconnect({ windowMs: dispersalMs, close: true });
	} else {
		for (const facade of [...wsConnections]) {
			try { /** @type {any} */ (facade).end(1001, 'Server draining'); } catch { /* already gone */ }
		}
	}
	// Wait for the close handshakes to land, bounded by the deadline; then
	// terminate whatever is still holding a socket open.
	const start = monotonicNow();
	while (wsConnections.size > 0 && !(signal && signal.aborted) && monotonicNow() - start < deadlineMs) {
		await new Promise((resolve) => {
			const timer = setTimer(resolve, pollMs);
			if (typeof timer?.unref === 'function') timer.unref();
		});
	}
	for (const facade of [...wsConnections]) {
		try { /** @type {any} */ (facade).close(); } catch { /* already gone */ }
	}
}
