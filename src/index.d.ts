import type { Adapter } from '@sveltejs/kit';
import type { TraceContext } from './observability.js';
import type { upgradeResponse } from './upgrade-response.js';

/**
 * A live server-side WebSocket handle: the first argument every hook in
 * {@link WebSocketHandler} receives, and the `ws` argument the {@link Platform}
 * per-socket methods take.
 *
 * The transport here is the `ws` library over `node:http`, so this is the
 * adapter's own facade over a `ws` socket rather than a native handle. It
 * honors the family socket contract: `send` answers the tri-state result
 * (`0` enqueued behind backpressure, `1` sent clean, `2` dropped past
 * `maxBackpressure`), and the accessors throw once the socket has closed, so
 * code that reaps dead sockets by catching that throw behaves identically.
 */
export interface WebSocket<UserData = unknown> {
	/** Send one frame. Returns `0` enqueued, `1` sent clean, `2` shed past the ceiling. */
	send(message: string | ArrayBuffer | Uint8Array, isBinary?: boolean, compress?: boolean): number;
	/** Drop the connection abruptly, without a close handshake. */
	close(): void;
	/** Close with a code and reason. */
	end(code?: number, message?: string | ArrayBuffer): void;
	subscribe(topic: string): boolean;
	unsubscribe(topic: string): boolean;
	/** Fan a frame out to the topic's subscribers, this socket excluded. */
	publish(topic: string, message: string | ArrayBuffer | Uint8Array, isBinary?: boolean, compress?: boolean): boolean;
	isSubscribed(topic: string): boolean;
	getTopics(): string[];
	/** The object the `upgrade` hook returned; the same identity for the connection's life. */
	getUserData(): UserData;
	getBufferedAmount(): number;
	/** Raw address bytes: 4 for IPv4, 16 for IPv6. */
	getRemoteAddress(): ArrayBuffer;
	getRemoteAddressAsText(): ArrayBuffer;
	/** Batch writes. Node's socket layer batches on its own, so this runs `fn` directly. */
	cork(fn: () => void): void;
}

/** Path-scoped Cache-Control rule for static assets. */
export interface StaticCacheControlRule {
	/** Absolute asset path; a trailing slash selects the directory tree. */
	pattern: string;
	cacheControl: string;
}

// Not exported: the lead declares no `PressureThresholds` name, it inlines this
// shape on `WebSocketOptions.pressure`. A name only this package exposes is one
// an app cannot carry back, so it stays local and the option keeps its shape.
interface PressureThresholds {
	memoryHeapUsedRatio?: number | false;
	publishRatePerSec?: number | false;
	subscriberRatio?: number | false;
	sampleIntervalMs?: number;
	topicPublishRatePerSec?: number | false;
	topicPublishBytesPerSec?: number | false;
	psiCpuSome?: number | false;
	psiMemoryFull?: number | false;
	psiIoFull?: number | false;
	cpuThrottledRatio?: number | false;
}

export interface MessageAdmissionOptions {
	perConnectionRate?: number;
	globalRate?: number;
	perConnectionBytesRate?: number;
	globalBytesRate?: number;
	rateWindowMs?: number;
	perConnectionConcurrent?: number;
	globalConcurrent?: number;
	maxQueue?: number;
}

/**
 * One scope's publish-egress ceilings, each per rotation window
 * (`EgressOptions.windowMs`). Every ceiling must be a non-negative safe
 * integer; `0` (or omitted) disables that ceiling deliberately, and a value
 * of any other shape refuses the build on every intake surface.
 *
 * Size a ceiling above the largest single publish it must admit. A batch frame
 * is admitted whole or refused whole (`platform.batch()` is a loop over
 * independent publishes, not one frame), and a publish heavier than the entire
 * window allowance (a 10-entry batch under `messages: 5`, or a topic whose
 * subscriber count exceeds `deliveries`) can never fit a window: it is
 * refused on every attempt, reported through the refusal counter and the
 * throttled operational event rather than silently.
 *
 * Ceilings are held per key in a ledger bounded per scope - 4096 keys unless
 * `EgressOptions.maxKeys` sizes it. Keys approaching the bound reclaim windows that have
 * already lapsed, a little at a time, so that the lapsed ones are gone before
 * the ledger is full; a ceiling is given up only when it is full anyway and
 * nothing in it has lapsed. So the bound is on the keys LIVE at once rather
 * than on every key the worker has published to, and a population that fits
 * inside the bound keeps every ceiling however close to the bound it sits.
 * Below it the ceilings apply to every key.
 *
 * Above it - more distinct topics (or tenants) live inside one window than the
 * bound - the ledger evicts, and an evicted key stops being held to its ceiling
 * for the rest of its window. The victim is the key that has spent least of its
 * allowance among a bounded sample (`EgressOptions.evictionSample`) rather than
 * the least-spent key overall, so a group of keys that became busy together can
 * lose some of its members even while quieter keys survive elsewhere. Every
 * eviction that costs enforcement increments
 * `egress_window_evicted_total{scope}`; sustained churn there means live key
 * cardinality has outgrown the ledger, and `maxKeys` is the lever sized for it.
 * A `tenant` ceiling stays the durable one for a high-cardinality topic space:
 * tenant ids have to outnumber the ledger before the tenant scope can be
 * affected at all.
 */
export interface EgressCeilings {
	/** Maximum logical publishes per window. `0` disables. */
	messages?: number;
	/**
	 * Maximum charged wire bytes per window (serialized frame bytes summed
	 * over recipients, pre-compression). `0` disables. This ceiling refuses
	 * once the window's charge has REACHED it - the publish that crosses it
	 * is delivered and the next is refused - because a publish's byte weight
	 * exists only after serialization, which must not precede admission.
	 */
	bytes?: number;
	/**
	 * Maximum deliveries per window (local recipients times messages, an
	 * excluded socket deducted). `0` disables. Refuses the publish that
	 * would cross it.
	 */
	deliveries?: number;
}

/**
 * The `websocket.egress` section: publish-egress accounting ceilings per
 * worker. See the `egress` option on {@link WebSocketOptions} for the charge
 * law, the refusal shape, and the tenant attribution contract.
 */
export interface EgressOptions {
	/**
	 * Accounting window in milliseconds. Rotated lazily per scope key - no
	 * timer. Must be a number `>= 100` (and below the 32-bit timer ceiling,
	 * the shared bound every interval option takes).
	 * @default 1000
	 */
	windowMs?: number;
	/**
	 * Keys each scope's usage ledger may hold at once (one ledger per scope
	 * per worker, plus the tenant-resolution memo). Must be a safe integer
	 * between `1024` and `2^24` (the largest bound a V8 Map can actually
	 * hold); the ledger rounds it UP to the next power of two, because V8
	 * sizes a Map's backing table to a power of two anyway - the rounded
	 * bound holds no fewer keys in the same memory the requested value would
	 * have taken. Memory is paid only for keys actually seated (~56 bytes per
	 * entry at steady churn), so an oversized cap on a small population costs
	 * nothing; size it to the keys LIVE inside one window when
	 * `egress_window_evicted_total{scope}` shows sustained churn. There is no
	 * disable value: an unbounded ledger would turn topic cardinality into
	 * unbounded memory.
	 * @default 4096
	 */
	maxKeys?: number;
	/**
	 * Entries an at-cap eviction inspects before taking the least-active one
	 * it saw (an expired window wins outright and ends the sample). Must be a
	 * safe integer `>= 1`. A deployment that raises `maxKeys` by an order of
	 * magnitude may widen it to match; the walk stays bounded at any width,
	 * because a pass wraps the ledger at most once per eviction.
	 * @default 8
	 */
	evictionSample?: number;
	/** Ceilings applied per topic, to attributed and unattributed publishes alike. */
	topic?: EgressCeilings;
	/**
	 * Ceilings applied per tenant, keyed by the tenant a publish is charged
	 * to (the game lane sender's `attribution` tenant id, or the handler
	 * module's `egressTenantOf(topic)` result). Unattributed publishes are
	 * not bounded here - they fall under `topic` only.
	 */
	tenant?: EgressCeilings;
}

export type MessageOverloadReason = 'rate_limit' | 'concurrency_limit' | 'queue_full';

/** Server response for an application message shed by `messageAdmission`. */
export interface MessageOverloadedFrame {
	type: 'message-overloaded';
	reason: MessageOverloadReason;
	scope: 'connection' | 'global';
	/** Present only for a rate-limit response. */
	retryAfterMs?: number;
}

interface WaitingRoomOptions {
	/** Holding-page route the adapter serves (default '/__waiting-room'). */
	path?: string;
	/** Poll endpoint the page hits (default '/__admit-check'). */
	admitCheckPath?: string;
	/** Base seconds for the jittered Retry-After (default derived from pollIntervalMs). */
	retryAfterSeconds?: number;
	/** Page poll cadence in ms (default 2000). */
	pollIntervalMs?: number;
	/** Application name shown above the capacity message and in the title. */
	appName?: string;
	/** Service-status link: relative, or http, https, mailto, tel. */
	statusUrl?: string;
	/** Help link: relative, or http, https, mailto, tel. */
	supportUrl?: string;
	/** Incident reference shown as escaped text. */
	incidentId?: string;
	/**
	 * Module path whose default (or named `renderWaitingRoom`) export renders
	 * the page per request from a safe request facade, returning a full HTML
	 * document plus BCP 47 `lang` and `dir`. A build-serializable module path,
	 * not a live function; mutually exclusive with `template`.
	 */
	renderer?: string;
	/**
	 * Full HTML document replacing the built-in page, validated at
	 * construction against the accessible-document contract. `{{queueDepth}}`,
	 * `{{estimatedSeconds}}`, `{{pollIntervalMs}}`, `{{retryAfterSeconds}}`,
	 * `{{admitCheckPath}}`, `{{appName}}`, `{{statusUrl}}`, `{{supportUrl}}`
	 * and `{{incidentId}}` substitute the live escaped values.
	 */
	template?: string;
}

interface UpgradeAdmissionOptions {
	/** Ceiling on upgrades in flight at once; crossed requests get 503. 0 or omitted disables. */
	maxConcurrent?: number;
	/** Ceiling on reserved upgrades plus live connections, held until close. 0 or omitted disables. */
	maxConnections?: number;
	/** Ceiling on handshakes completed per event-loop tick; the overflow defers. 0 or omitted disables. */
	perTickBudget?: number;
	/** Ceiling on callbacks waiting behind perTickBudget (default 1024 while pacing is on). */
	maxDeferred?: number;
	/** Reserve a fraction of maxConcurrent for the deprioritised cursor-only upgrade lane. */
	cursorLane?: { fraction?: number };
	/**
	 * Content-negotiated refusal at capacity, on by default whenever a ceiling
	 * is set: a browser navigation gets a self-polling holding page, every
	 * other client keeps the 503 with a jittered Retry-After. `false` drops the
	 * polling page; an HTML navigation then gets a minimal accessible 503.
	 */
	waitingRoom?: false | WaitingRoomOptions;
}

export interface WebSocketOptions {
	/** Module path of the WebSocket handler (default: auto-discovered src/hooks.ws.{js,ts,mjs}). */
	handler?: string;
	/** WebSocket route (default '/ws'). */
	path?: string;
	/** Authenticate preflight route (default '/__ws/auth'). */
	authPath?: string;
	/**
	 * Prefix for the reserved admin / observability route. When your WebSocket
	 * handler exports an `admin(request)` function (svelte-realtime's auth-gated
	 * introspection handler is the canonical one), the adapter auto-mounts it at
	 * `<adminPath>/*`, matched before the SSR catch-all so it never hits page
	 * routing. The handler is mount-prefix agnostic, so relocating it is a
	 * one-place change here.
	 *
	 * Set `false` to disable the auto-mount entirely - for apps that mount the
	 * `admin` handler themselves (e.g. a SvelteKit `+server.js` route with their
	 * own middleware) and do not want a second, adapter-owned mount point. No
	 * effect unless the handler exports `admin`.
	 *
	 * Must be an absolute path (starting with `/`) that differs from `path` and
	 * `authPath`.
	 * @default '/__realtime'
	 */
	adminPath?: string | false;
	/**
	 * Silence the boot warning that the auto-mounted admin route carries no
	 * adapter-level authentication.
	 *
	 * The adapter mounts `admin` without gating it - whether requests are
	 * authenticated is entirely up to the handler, and the adapter cannot
	 * inspect that - so it warns once at startup. Set this to `true` after
	 * confirming the handler validates a session cookie, bearer token or
	 * equivalent, so the line stops appearing in logs an operator has already
	 * acted on. It changes nothing about routing or authorization.
	 *
	 * @default false
	 */
	adminAuthAcknowledged?: boolean;
	/**
	 * Prometheus-style registry for transport, admission and posture
	 * observability. Off by default; when set, the adapter registers the
	 * manifest's worker signals and emits them from the request, upgrade,
	 * message and publish paths, with gauges riding the existing 1 Hz pressure
	 * sampler. No client identity - address or session - ever reaches a label.
	 *
	 * This is a **module path**, like `handler`, not a live object: adapter
	 * options are serialized into the build, so a registry constructed in
	 * `svelte.config.js` could never reach the production runtime. Point it at
	 * a module whose default export (or a named `metrics` / `registry` export)
	 * is the registry; the adapter populates it and exposes it as
	 * `platform.metrics`.
	 *
	 * The adapter serves no scrape route of its own - the app writes an
	 * ordinary `+server.js` reading `platform.metrics.serialize()`, or awaits
	 * `platform.metricsSnapshot()` for the cluster-wide merge.
	 *
	 * **One instance, with the Vite plugin.** With
	 * `import ws from 'svelte-adapter-ws/vite'` in `vite.config.js` - the
	 * standard setup, which also provides dev WebSockets - the registry is
	 * bundled into the app's own server graph and deduplicated with every
	 * route that imports it, so `platform.metrics` and a direct
	 * `import { metrics } from '$lib/server/metrics.js'` read the SAME object.
	 * Without the plugin the adapter falls back to a standalone bundle, which
	 * instantiates the module a second time: adapter counters land on a copy
	 * only `platform.metrics` reaches, an app-graph import reads the other,
	 * empty one, and any module-level side effect runs twice per process. The
	 * build warns when it takes that fallback.
	 */
	metrics?: string;
	/** Max inbound frame bytes (default 1 MiB). */
	maxPayloadLength?: number;
	/** Idle reap timeout in seconds; 0 disables (default 120). */
	idleTimeout?: number;
	/** Outbound queue ceiling in bytes past which frames shed (default 1 MiB). */
	maxBackpressure?: number;
	/** Terminate a consumer pinned over the ceiling instead of shedding (default false). */
	closeOnBackpressureLimit?: boolean;
	/** Keep idle peers alive with pings (default true). */
	sendPingsAutomatically?: boolean;
	/**
	 * Enable per-message deflate compression. Pass `true` to compress, or a uWS
	 * compression constant so a config written for the family carries over
	 * unchanged: a non-zero constant reads as on, `uWS.DISABLED` (`0`) as off.
	 * The `ws` permessage-deflate extension has one compressor, so the choice
	 * between a shared and a dedicated one does not reach the wire here.
	 *
	 * Compression is applied per frame, not blanket: text frames (`publish` /
	 * `send`) compress by default, binary codec frames (`publishWire` /
	 * `sendWire`) are opt-in, the cursor plugin stays uncompressed (its 60 Hz
	 * hot path), and the presence plugin opts in (low-frequency). Pass
	 * `{ compress: false }` to `publish` / `send` for a high-frequency,
	 * high-fan-out text topic: permessage-deflate CPU scales per subscriber, so
	 * compressing a hot broadcast to many subscribers is expensive.
	 *
	 * @default false
	 */
	compression?: boolean | number;
	/** Origin policy: 'same-origin' (default), '*', or an explicit list. */
	allowedOrigins?: '*' | 'same-origin' | string[];
	/** Seconds the upgrade admission hook may run before 504 (default 10). */
	upgradeTimeout?: number;
	/** Upgrades admitted per IP per window; 0 disables (default 10). */
	upgradeRateLimit?: number;
	/** Upgrade limiter window in seconds (default 10). */
	upgradeRateLimitWindow?: number;
	/** Authenticate-door requests per IP per window; 0 disables (default 30). */
	authPathRateLimit?: number;
	authPathRateLimitWindow?: number;
	upgradeAdmission?: UpgradeAdmissionOptions;
	messageAdmission?: MessageAdmissionOptions;
	/**
	 * Keys the per-topic seq registry may hold at once. Past the cap an insert
	 * evicts the least recently published unprotected topic and carries its
	 * high-water number forward, so a re-published topic always resumes above
	 * what any forgotten topic reached: a counter may skip numbers, it never
	 * repeats one. No epoch changes and no client is asked to rehydrate. When
	 * every candidate is protected the insert is admitted over the cap and the
	 * cardinality warning fires instead.
	 *
	 * A registry that rises above the cap holds that level rather than draining
	 * back to it: eviction stops further growth, it does not compact. Set `0`
	 * to disable the bound entirely. Topics published with `seq: false` never
	 * enter these registries, and a topic whose sequence comes from an external
	 * authority (a numeric `seq`) is that authority's to keep continuous.
	 *
	 * Applies to the production runtime and `createTestServer`. `vite dev`
	 * stamps per-topic sequences only on the `game` lane, so its registry is
	 * bounded by the rooms in one dev session and needs no ceiling.
	 * @default 1000000 (the cardinality warning threshold)
	 */
	maxTopicSeqEntries?: number;
	/**
	 * Publish-egress accounting ceilings - the outbound half of a tenant
	 * budget, enforced per worker at every publish-family fan-out (`publish`,
	 * `publishWire`, `publishWireBatch`, `publishBatched`, `publishGame`,
	 * `sendTo`). Every logical publish is charged as serialized wire bytes
	 * times local recipients; the optional ceilings refuse a publish BEFORE
	 * anything happens - no sequence is stamped, no frame is built, nothing
	 * reaches the transport or the cross-worker relay - so subscribers never
	 * see a sequence gap from a refusal. The caller receives the refusal shape
	 * (`false`, a zero count, or `{ seq: null, delivered: 0 }` on the game
	 * lane).
	 *
	 * Frames received over the cross-worker relay are never charged and never
	 * refused: the origin worker charged its own local recipients, and each
	 * instance owns only its own egress.
	 *
	 * The `tenant` ceilings key on the tenant a publish is charged to: the
	 * SENDER's frozen attribution (`attribution` export) on the client-relay
	 * game lane, and the handler module's `egressTenantOf(topic)` export for
	 * server-side publishes. An unattributed publish is bounded by the `topic`
	 * ceilings only. `tenantOf` cannot be configured here - a function does not
	 * survive the build's option serialization, so a `tenantOf` key in this
	 * section refuses the build and points to the handler export.
	 *
	 * Enforcement semantics, identical on production, `createTestServer`, and
	 * the dev plugin: the `messages` and `deliveries` ceilings refuse the
	 * publish that would cross them; the `bytes` ceiling refuses once the
	 * window's charged bytes have reached it, so the crossing publish is
	 * delivered and the next is refused. A batching primitive that builds one
	 * wire frame - `publishBatched`, `publishWireBatch` - is atomic: it is
	 * admitted against the pooled weight of every topic it spans and every
	 * tenant that owns them, then delivered whole or refused whole.
	 * `platform.batch()` is not one of them; it loops independent publishes, so
	 * a ceiling can admit part of a `batch()` call. Refusals are visible as
	 * `egress_refused_total{scope}` on a configured metrics registry, in
	 * `platform.pressure.egress`, and as a throttled
	 * `ADAPTER-ERR-EGRESS-REFUSED` operational event - `publishBatched` returns
	 * nothing, so those signals are its only refusal report.
	 *
	 * The charged `bytes` are the encoded UTF-8 length while a `bytes` ceiling
	 * is armed, and the character length otherwise: measuring the encoding
	 * walks the envelope, so a server that configured no budget - or one that
	 * counts messages rather than bytes - does not pay for a number nothing
	 * decides on. The two agree for ASCII.
	 */
	egress?: EgressOptions;
	pressure?: PressureThresholds;
	/**
	 * Graduated protection posture over the live `platform.pressure` signal,
	 * governing only the admission of NEW upgrades - existing connections are
	 * never affected at any level.
	 *
	 * - `'normal'` (default): today's behaviour. The posture machine is inert
	 *   and adds no work to the hot path.
	 * - `'auto'`: the adapter escalates under sustained pressure and relaxes on
	 *   recovery (escalate fast, relax slow). `normal -> elevated` on sustained
	 *   `pressure.active`; `elevated -> siege` when over-capacity upgrade
	 *   rejects run at twice the gate's admit rate; downward needs a longer
	 *   quiet dwell.
	 * - `'elevated'` / `'siege'`: pin a level for incident response or testing.
	 *
	 * At `'elevated'` every refusal widens its `Retry-After` jitter. At
	 * `'siege'` new upgrades are refused at static-serve cost and
	 * `/__admit-check` always reports busy. Only the `siege` step needs a
	 * ceiling: escalating to it compares the over-capacity reject rate against
	 * the gate's admit rate, so without `upgradeAdmission.maxConcurrent` or
	 * `upgradeAdmission.maxConnections` there is no rate to compare and
	 * `'auto'` stops at `elevated` - which it still reaches on sustained
	 * pressure alone.
	 */
	protection?: 'normal' | 'elevated' | 'siege' | 'auto';
	/**
	 * Posture push-export (opt-in): listen on a local stream socket (a unix
	 * domain socket path, or a `\\.\pipe\...` named pipe on Windows) and push
	 * the live protection posture as newline-delimited JSON -
	 * `{"v":1,"posture":"elevated","reason":"PSI","value":0.83,"psi":{...},"cpuThrottle":{...}}` -
	 * to every connected consumer: once on connect, once on every posture or
	 * reason transition, and once per 1 Hz pressure sample (the steady cadence
	 * doubles as a liveness signal - silence means the adapter is gone). Built
	 * for an external edge-defense daemon or watchdog that wants the app's
	 * load state without speaking its protocol. Local-only and payload-free.
	 *
	 * With CLUSTER_WORKERS set the line describes the DEPLOYMENT: one socket
	 * cannot have several owners, so each worker reports inward and the primary
	 * serves the highest posture any worker is in, carrying that worker's own
	 * `reason` and pressure numbers, plus a `workers` count of the threads it
	 * summarizes. A worker that exits is dropped rather than remembered. A
	 * single-process deployment is unchanged and carries no `workers` field.
	 *
	 * @example
	 * ```js
	 * adapter({ websocket: { postureExport: '/run/app/posture.sock' } });
	 * ```
	 */
	postureExport?: string | { path: string } | false;
	/**
	 * Interval in milliseconds for the per-worker consistency auditor - a
	 * background check that runs the shared invariant predicates against a
	 * bounded, structure-only snapshot of the worker's live connections on a
	 * slow, jittered, unref'd timer.
	 *
	 * It runs OFF the hot path: publish, send, subscribe, and close pay nothing;
	 * the only cost is reading state the worker already maintains, on a timer
	 * that never holds the event loop open. The snapshot is bounded - a fixed
	 * slice of connections per tick, walked round-robin - so a worker with a
	 * million connections audits a constant amount of work each tick regardless
	 * of population, and the snapshot carries no payloads, no topic strings, and
	 * no client identity beyond the per-connection session id used as a log
	 * label.
	 *
	 * A detected violation logs a package-attributed `[lantean/diagnostic ...]` line and
	 * increments the queryable `platform.assertions` counter (the soft tier) - it
	 * never terminates the worker. The single exception is a subscription slot
	 * that has become a non-`Set` (heap or dispatch corruption that cannot heal):
	 * if it persists across two consecutive audits, it escalates to a deferred
	 * worker restart (exit code 78). A healthy or transient state is never killed.
	 *
	 * On by default at `5000` (5s). Set to `0` to disable entirely - no timer is
	 * scheduled and the path costs nothing. It runs in single-process AND
	 * clustered deployments alike (it is a per-worker net, not a cross-worker
	 * comparison).
	 *
	 * @default 5000
	 */
	consistencyAuditIntervalMs?: number;
	/**
	 * Interval in milliseconds for the optional per-worker resource-growth
	 * auditor - a background trend detector that samples the SIZE of the live
	 * bookkeeping collections (connections, topic index, caches) on a slow,
	 * jittered, unref'd timer and flags a series that climbs monotonically, the
	 * signature of a close / unsubscribe / eviction path that stopped shedding.
	 * It reads only Map/Set sizes, never a monotonic-by-design counter.
	 *
	 * OBSERVE-ONLY: a suspected trend logs at most one throttled warning per
	 * worker; it NEVER asserts, throws, or terminates. Distinct from
	 * `consistencyAuditIntervalMs`, which checks point-in-time invariants rather
	 * than a time-series trend.
	 *
	 * Off by default (`0` - no timer is scheduled and the path costs nothing),
	 * because a trend signal is probabilistic; the always-on structural guard is
	 * the deterministic simulator (`svelte-adapter-ws/sim`), not production.
	 * `30000` (30s) is a sensible enabled value.
	 *
	 * @default 0 (disabled)
	 */
	resourceGrowthAuditIntervalMs?: number;
	/** Allow wire-level subscribes to '__'-prefixed system topics (default false). */
	allowSystemTopicSubscribe?: boolean;
	/** Honor client subscribes only for server-granted topics; 'strict' ignores app hooks. */
	authorizeWireSubscribe?: boolean | 'strict';
	/** Allow non-ASCII wire topic names (default false). */
	allowNonAsciiTopics?: boolean;
	/** Require CSRF signals on the authenticate door (default true). */
	authPathRequireOrigin?: boolean;
	/** Compress credentialed SSR responses despite BREACH exposure (default false). */
	compressCredentialedResponses?: boolean;
	/** Run 'same-origin' without a host pin (audited apps only; default false). */
	unsafeSameOriginWithoutHostPin?: boolean;
	/**
	 * Module path whose default (or named `primaryInit`) export runs ONCE in
	 * the cluster primary before any worker spawns; its return value is
	 * replayed as `workerData.app` to every worker and respawn
	 * (SharedArrayBuffers ride by reference). Only consulted when
	 * CLUSTER_WORKERS is set at runtime.
	 */
	primaryInit?: string;
	/** Cluster worker roles: how many of the CLUSTER_WORKERS total are compute workers (no listen socket). */
	workers?: { compute?: number };

	/**
	 * Interval in milliseconds for the cross-worker state-hash reporter
	 * (clustered mode only). When greater than `0`, each worker periodically
	 * folds a structure-only projection of its per-topic delivered-sequence
	 * map into a single 32-bit hash and reports it to the primary, which
	 * compares the live workers' hashes per primary-assigned epoch and logs a
	 * `divergence.detected` event (and increments the `state_divergence_total`
	 * metric when a `metrics` registry is configured) if they disagree at rest.
	 *
	 * Divergence means a publish that reached some workers did not reach
	 * another - a relay drop, partial fan-out, or a frame one worker failed to
	 * apply - which a single-worker deployment can never have. Only the integer
	 * hash and the worker's thread id cross the thread boundary: no topic
	 * strings, no payloads, no client identity.
	 *
	 * Off by default (`0`): no reporter timer is scheduled and the path costs
	 * nothing. In single-process mode the reporter never runs regardless of
	 * this value (there are no other workers to compare against). The detection
	 * is observe-only; the optional auto-restart of a diverged worker is a
	 * separate primary-level switch (`RESTART_ON_STATE_DIVERGENCE=1`) that
	 * defaults off. `30000` (30s) is a sensible enabled value.
	 *
	 * @default 0 (disabled)
	 */
	stateHashIntervalMs?: number;
}

export interface AdapterOptions {
	/** Output directory (default 'build'). */
	out?: string;
	/** Emit .br/.gz siblings for static assets (default true). */
	precompress?: boolean;
	/** Environment variable prefix (default ''). */
	envPrefix?: string;
	/** Liveness probe path or false (default '/healthz'). */
	healthCheckPath?: string | false;
	/** Readiness probe path or false (default '/readyz'). */
	readinessCheckPath?: string | false;
	/** Readiness-gated SSR warmup: true (default, warms '/'), false, or { paths }. */
	warmup?: boolean | { paths: string[] };
	/** Extra response headers for static/prerendered assets (reserved keys stripped). */
	staticHeaders?: Record<string, string>;
	/** Path-scoped Cache-Control rules for static assets. */
	staticCacheControl?: StaticCacheControlRule[];
	/** Serve dot-segment static paths (default false; .well-known stays served). */
	staticDotfiles?: boolean;
	/**
	 * Module path to an optional vendor-neutral tracing provider. The module's
	 * default or named tracing export implements startSpan(name, options)
	 * using the types from svelte-adapter-ws/observability. The adapter
	 * extracts validated W3C traceparent / tracestate headers, keeps the
	 * resulting context active across async native work, and exposes it through
	 * platform.trace and platform.traceContext.
	 *
	 * The provider may return an OpenTelemetry Span directly: its
	 * spanContext(), recordException(), and end() methods are recognized. When
	 * omitted, tracing is a no-op and the native hot path does not allocate
	 * spans.
	 *
	 * @example './src/lib/server/tracing.js'
	 */
	tracing?: string;
	/** Realtime lane: true, options object, or false/omitted for HTTP-only. */
	websocket?: boolean | WebSocketOptions;
}

export interface PressureSnapshot {
	/** Wall-clock ms of the last completed sample; null before the first tick. */
	sampledAt: number | null;
	active: boolean;
	/** 0..1 worker saturation (worst-of threshold distances plus lease backlog). */
	value: number;
	subscriberRatio: number;
	publishRate: number;
	memoryMB: number;
	reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
	psi: { cpuSome10: number; memoryFull10: number; ioFull10: number } | null;
	cpuThrottle: { throttledRatio: number; nrThrottledDelta: number } | null;
	maxBufferedBytes: number;
	backpressuredConnections: number;
	droppedFrames: number;
	droppedBytes: number;
	egress: { deliveries: number; bytes: number; refusedTopic: number; refusedTenant: number };
	topPublishers: Array<{ topic: string; messagesPerSec: number; bytesPerSec: number; deliveriesPerSec: number }>;
}

/**
 * Per-topic publish-rate sample, surfaced via `platform.pressure.topPublishers`
 * and the `platform.onPublishRate(cb)` callback.
 */
export interface TopicPublishRate {
	topic: string;
	messagesPerSec: number;
	/**
	 * Envelope size per second in UTF-16 code units (equal to bytes for
	 * ASCII envelopes) - the unit `topicPublishBytesPerSec` is compared
	 * against.
	 */
	bytesPerSec: number;
	/**
	 * Egress deliveries per second for the topic (local recipients times
	 * messages). Additive: `messagesPerSec` and `bytesPerSec` keep their
	 * meanings, and no over-threshold decision reads this dimension.
	 */
	deliveriesPerSec: number;
}

/** The per-topic publish helper returned by `platform.topic(name)`. */
export interface TopicHelper {
	/** Publish a custom event to this topic. */
	publish(event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('created', data)`. Pairs with `crud()` / `lookup()`. */
	created(data?: unknown, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('updated', data)`. Pairs with `crud()` / `lookup()`. */
	updated(data?: unknown, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('deleted', data)`. Pairs with `crud()` / `lookup()`. */
	deleted(data?: unknown, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('set', value)`. Pairs with `count()`. */
	set(value: number, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('increment', amount)`. Pairs with `count()`. */
	increment(amount?: number, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('decrement', amount)`. Pairs with `count()`. */
	decrement(amount?: number, options?: { relay?: boolean; seq?: boolean | number | bigint | null; compress?: boolean; jitterMs?: number }): void;
}

/** The versions the running adapter resolved for itself and its companions. */
export interface RuntimeVersionInfo {
	/** Adapter version read from the package metadata that produced this runtime. */
	adapter: string | null;
	/** Frozen wire revision parsed from protocol.schema.json. */
	protocolRevision: number | null;
	/**
	 * Actually resolved svelte-realtime version. `null` when the resolver
	 * reports the package absent; the literal `'unresolvable'` when something
	 * is present that cannot be read (a broken exports map, an invalid
	 * package config) - a configuration to fix, not an absence.
	 */
	realtime: string | null;
	/**
	 * Actually resolved extensions version. `null` when the resolver reports
	 * the package absent; the literal `'unresolvable'` when something is
	 * present that cannot be read - a configuration to fix, not an absence.
	 */
	extensions: string | null;
}

/**
 * Minimal registry contract for the `metrics` option: the subset of a
 * Prometheus-style registry the adapter calls. The `createMetrics()` registry
 * from `svelte-adapter-uws-extensions/prometheus` satisfies it as-is (and
 * owns naming concerns like a global prefix); any object with the same shape
 * works. Registration must be idempotent per name if the registry is shared
 * across consumers.
 */
export interface MetricsRegistry {
	counter(
		name: string,
		help: string,
		labelNames?: string[]
	): {
		/**
		 * Increment the counter. `value` defaults to 1; a registry that ignores it
		 * will under-count any metric the runtime increments in bulk (the relay-gap
		 * counter reports FRAMES lost, not incidents), so implement it.
		 */
		inc(labels?: Record<string, string>, value?: number): void;
	};
	gauge(
		name: string,
		help: string
	): { set(value: number): void };
	/**
	 * Observe a distribution. Optional: the adapter registers no histogram
	 * today, so a registry without this method satisfies the contract and
	 * nothing breaks.
	 *
	 * It is declared because a registry that omits it cannot be TOLD what
	 * buckets to use, and a duration histogram is worthless with the wrong
	 * ones. Bucket bounds are the caller's to choose and are always in the
	 * metric's own unit.
	 *
	 * Unit convention: durations are `seconds`, named with a `_seconds`
	 * suffix, with bucket bounds written as fractions of a second
	 * (`0.001`, `0.005`, `0.01`, ...). Milliseconds are not used in a metric
	 * name or value even where the source clock reports them, so a bound
	 * always reads in the same unit as the sample. Sizes are `bytes` with a
	 * `_bytes` suffix. A histogram of sub-second work whose buckets start at
	 * `1` records every sample in the first bucket and measures nothing.
	 */
	histogram?(
		name: string,
		help: string,
		options?: { labelNames?: string[]; buckets?: number[] }
	): { observe(labels?: Record<string, string>, value?: number): void };
	/**
	 * Render all metrics in Prometheus text exposition format. Present on the
	 * `createMetrics()` registry from `svelte-adapter-uws-extensions/prometheus`;
	 * optional here because the adapter itself only ever calls `counter`/`gauge`.
	 * Read it from a scrape route via `platform.metrics`.
	 *
	 * NOT required for `platform.metricsSnapshot()`, which is built from the
	 * values the adapter wrote rather than from rendered text.
	 */
	serialize?(): string;
}

/**
 * The realtime platform surface exposed as `event.platform` and to every
 * WebSocket hook. The full per-method contracts follow the family
 * documentation in svelte-adapter-uws; the shapes here type the core surface.
 */
export interface Platform {
	publish(topic: string, event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number; excludeWs?: object }): boolean;
	publishBatched(messages: Array<{ topic: string; event: string; data?: unknown; options?: object }>, options?: { compress?: boolean }): void;
	batch(messages: Array<{ topic: string; event: string; data?: unknown; options?: object }>): boolean[];
	send(ws: object, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;
	sendTo(filter: (userData: any) => boolean, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;
	sendCoalesced(ws: object, message: { key?: string; topic: string; event: string; data?: unknown }): void;
	publishWire(topic: string, event: string, data: unknown, wire: object, options?: object): boolean;
	publishWireBatch(topic: string, event: string, entries: Array<{ data: unknown; excludeWs?: object; seq?: number }>, wire: object, options?: object): boolean;
	sendWire(ws: object, topic: string, event: string, data: unknown, wire: object, options?: object): number;
	sendWireBatch(ws: object, topic: string, event: string, entries: Array<{ data: unknown; seq?: number }>, wire: object): number;
	registerWireCodec(wire: object): void;
	request(ws: object, event: string, data?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
	requestTopic(topic: string, event: string, data?: unknown, options?: { timeoutMs?: number }): Promise<Array<{ ok: boolean; reply?: unknown; error?: string }>>;
	subscribe(ws: object, topic: string): Promise<string | null>;
	checkSubscribe(ws: object, topic: string, options?: { requireGrant?: boolean }): Promise<string | null>;
	unsubscribe(ws: object, topic: string): boolean;
	authorizeWireSubscribe(mode?: 'legacy' | 'strict'): 'legacy' | 'strict';
	grantPublish(ws: object, topic: string): boolean;
	revokePublish(ws: object): boolean;
	publishGrant(ws: object): string | null;
	publishGame(senderWs: object, topic: string, event: string, data: unknown, id?: number | string): { seq: number | null; delivered: number };
	adviseReconnect(options?: { windowMs?: number; afterMs?: number; close?: boolean; compress?: boolean; filter?: (userData: any) => boolean }): number;
	subscribers(topic: string): number;
	forEachSubscriber(topic: string, fn: (ws: object, userData: object) => void): void;
	bufferedAmount(ws: object): number;
	isWarmupRequest(request: Request): boolean;
	introspect(): object;
	diagnostic(diagnosticId: string): unknown;
	topic(name: string): object;
	topicEpoch(name: string): number;
	onPressure(cb: (snapshot: PressureSnapshot) => void): () => void;
	onPublishRate(cb: (top: PressureSnapshot['topPublishers']) => void): () => void;
	now(): number;
	monotonic(): number;
	random: { float(): number; u32(): number; uuid(): string; bytes(n: number): Uint8Array };
	hlc(): { wall: number; logical: number; nodeId: string };
	readonly connections: number;
	readonly pressure: PressureSnapshot;
	readonly protection: 'normal' | 'elevated' | 'siege';
	/**
	 * The registry `WebSocketOptions.metrics` names, or `null` when unset. The
	 * SAME instance the adapter populates, so a scrape route can render it
	 * directly - and with the Vite plugin the module is bundled into the app's
	 * own server graph, so a direct import reads this instance too.
	 */
	readonly metrics: MetricsRegistry | null;
	/**
	 * Cluster-wide metrics in Prometheus text, or `null` when no registry is
	 * configured. Built from the values the adapter wrote rather than from
	 * rendered text, so it needs no `serialize()` and stays on canonical
	 * unprefixed manifest names however the registry renders its own output.
	 * Under `CLUSTER_WORKERS` the primary collects every worker and merges,
	 * and the two ways that can fall short are reported apart. A worker that
	 * misses the primary's deadline is absent from the merge: the document
	 * renders what arrived and `metrics_snapshot_workers_reporting` falls
	 * below `..._expected`, with `metrics_snapshot_degraded` still `0`. A
	 * scrape that never hears back from the primary answers with the
	 * requesting worker ALONE and sets `metrics_snapshot_degraded` - the
	 * expected/reporting pair cannot say so, because a worker that got no
	 * answer does not know how many siblings it has.
	 */
	metricsSnapshot(options?: { timeoutMs?: number }): Promise<string | null>;
	readonly assertions: Map<string, number>;
	readonly closedWsAborts: number;
	readonly maxPayloadLength: number;
	readonly traceContext: unknown;
	requestId?: string;
}

/**
 * Server-resolved connection attribution, returned by the handler module's
 * `attribution(user)` export and read back through the `./connection`
 * subpath's {@link import('./connection.js').attribution} helper.
 */
export interface Attribution {
	/** The tenant (organization, workspace) this connection belongs to. */
	readonly tenantId?: string;
	/** The principal (user, service identity) inside that tenant. */
	readonly principalId?: string;
	/** An application-defined entitlement label (a billing or quota class). */
	readonly entitlement?: string;
}

/**
 * Options accepted by `authenticateCookies.set()` and `.delete()`. Matches the
 * shape SvelteKit uses for `cookies.set()`.
 */
export interface CookieSerializeOptions {
	/** Required by `authenticateCookies.set()` and `.delete()`. */
	path: string;
	domain?: string;
	expires?: Date;
	/** In seconds. */
	maxAge?: number;
	/** Defaults to `true`. */
	httpOnly?: boolean;
	/** Defaults to `true`, except on plain HTTP at `localhost`. */
	secure?: boolean;
	partitioned?: boolean;
	/** Defaults to `'lax'`. Set to `false` to omit the attribute. */
	sameSite?: 'strict' | 'lax' | 'none' | boolean;
	/** Defaults to `true`. Set to `false` to skip URI-encoding the value. */
	encode?: boolean;
}

/**
 * SvelteKit-like cookies API available inside the `authenticate` hook.
 * Mutations via `.set()` and `.delete()` become `Set-Cookie` headers on the
 * HTTP response returned from the endpoint.
 */
export interface AuthenticateCookies {
	get(name: string): string | undefined;
	getAll(): Record<string, string>;
	set(name: string, value: string, options: CookieSerializeOptions): void;
	delete(name: string, options: CookieSerializeOptions): void;
}

/**
 * Context passed to the `upgrade` handler.
 */
export interface UpgradeContext {
	/** Request headers (all lowercase keys). */
	headers: Record<string, string>;
	/** Parsed cookies from the Cookie header. */
	cookies: Record<string, string>;
	/** The request URL path, including query string if present (e.g. '/ws?token=abc'). */
	url: string;
	/** Remote IP address. */
	remoteAddress: string;
	/**
	 * Per-connection correlation id. Reads `X-Request-ID` from the upgrade
	 * request when present (sanitized; printable ASCII, max 128 chars), else
	 * a fresh UUID. Stamped once at upgrade and reused for every WS hook on
	 * this connection (`platform.requestId` matches in `open`, `message`,
	 * `subscribe`, `drain`, `close`, etc.).
	 */
	requestId: string;
	/** Validated W3C context active for this upgrade, or null when tracing is disabled. */
	traceContext: TraceContext | null;
}

/**
 * Context passed to the optional `authenticate` handler.
 *
 * `authenticate` runs as a normal HTTP POST before the WebSocket upgrade, so
 * any `Set-Cookie` headers from `cookies.set()` ride on a standard response
 * and work behind every proxy (unlike `Set-Cookie` on the 101 upgrade, which
 * Cloudflare Tunnel and some other strict edge proxies silently drop).
 */
export interface AuthenticateContext {
	/** The incoming request (standard `Request` object, with body). */
	request: Request;
	/** Request headers (all lowercase keys). */
	headers: Record<string, string>;
	/** SvelteKit-like cookies API. Mutations become Set-Cookie on the response. */
	cookies: AuthenticateCookies;
	/** The request URL path, including query string if present. */
	url: string;
	/** Remote IP address (honoring `ADDRESS_HEADER` / `XFF_DEPTH`). */
	remoteAddress: string;
	/** Shorthand for returning `remoteAddress`. Matches the SvelteKit event shape. */
	getClientAddress: () => string;
	/** The platform API (publish, send, topic helpers, etc.). */
	platform: Platform;
}

/**
 * Context passed to `open` and `drain` handlers.
 */
export interface OpenContext {
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Context passed to the `message` handler.
 */
export interface MessageContext {
	/** The raw message data. */
	data: ArrayBuffer;
	/** Whether the message is binary. */
	isBinary: boolean;
	/**
	 * The JSON-parsed envelope, when the adapter parsed the frame for
	 * control-message routing (subscribe / unsubscribe / hello / resume /
	 * reply / subscribe-batch) but no control type matched.
	 *
	 * Plugin-layer JSON envelope dispatchers (e.g. svelte-realtime's
	 * `createMessage({ onJsonMessage })`) consume this directly instead of
	 * re-running `TextDecoder + JSON.parse` on every frame.
	 *
	 * `undefined` when:
	 * - the frame is binary (`isBinary === true`), or
	 * - the frame did not start with `{"ty` (byte[3] !== 0x79), or
	 * - the frame was larger than 8 KiB, or
	 * - `JSON.parse` threw, or
	 * - the parsed value was not a plain object (null / array / primitive).
	 *
	 * The adapter's `websocket.maxPayloadLength` (default 1 MB) is the
	 * structural ceiling for frame size; this field adds no separate cap.
	 */
	msg?: any;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Context passed to the `close` handler.
 *
 * The `id` / `duration` / `messagesIn` / `messagesOut` / `bytesIn` /
 * `bytesOut` fields are populated only when a `close` hook is exported
 * - the adapter skips the per-connection counter bookkeeping otherwise
 * to keep the hot path zero-cost for stats-uninterested apps.
 */
export interface CloseContext {
	/** The WebSocket close code. */
	code: number;
	/** The close reason (as ArrayBuffer). */
	message: ArrayBuffer;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
	/**
	 * Topics this connection was subscribed to via the client store's
	 * subscribe/unsubscribe protocol. Does not include topics subscribed
	 * via manual `ws.subscribe()` calls in server hooks.
	 */
	subscriptions: Set<string>;
	/**
	 * Per-connection session id, the same UUID announced to the client
	 * in the `welcome` envelope. Useful for correlating server logs with
	 * a specific socket lifecycle.
	 */
	id?: string;
	/** Connection lifetime in milliseconds (open -> close). */
	duration?: number;
	/** Count of incoming messages from the client over the connection. */
	messagesIn?: number;
	/**
	 * Count of direct outgoing messages to this specific connection
	 * (welcome, subscribe acks, replies, `platform.send`,
	 * `platform.sendCoalesced`, matched `platform.sendTo`).
	 *
	 * Topic-broadcast `platform.publish()` fan-out is **not** counted:
	 * one dispatch writes the same frame to the topic's subscriber set,
	 * and charging every recipient would put a per-subscriber accounting
	 * pass on the broadcast hot path. For aggregate publish-rate pressure
	 * use `platform.pressure.publishRate` instead.
	 */
	messagesOut?: number;
	/** Total bytes received over the connection. */
	bytesIn?: number;
	/** Total bytes sent directly to this connection (same caveat as `messagesOut`). */
	bytesOut?: number;
}

/**
 * Context passed to the `subscribe` handler.
 */
export interface SubscribeContext {
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Canonical reasons for a `subscribe-denied` ack. The `subscribe` hook
 * may return any of these strings, or any other string (forwarded
 * verbatim to the client). The framework also emits `'INVALID_TOPIC'`
 * automatically when a client sends a malformed topic.
 *
 * - `'UNAUTHENTICATED'` - no valid session / user identity.
 * - `'FORBIDDEN'` - user is identified but not authorised for the topic.
 * - `'INVALID_TOPIC'` - topic failed wire-protocol validation
 *   (length / control chars). Emitted by the framework, not the hook.
 * - `'RATE_LIMITED'` - a per-connection subscribe bound tripped. Emitted by
 *   the framework for the landed-subscription cap, and for the in-flight
 *   authorization cap - the count of attempts currently parked in their
 *   (possibly async) hook await; an attempt refused there never reaches the
 *   hook. Hooks may also return it for their own rate policies. Settled
 *   attempts free the in-flight budget, and the stock client re-sends a
 *   topic refused for this reason on a short jittered delay, so the
 *   condition resolves without application code.
 */
export type SubscribeDenialReason =
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'INVALID_TOPIC'
	| 'RATE_LIMITED';

/**
 * The client-driven relay lane (the `game` lane; see `platform.grantPublish`).
 *
 * Client -> server: `{ type: 'game', event, data, id? }`. There is NO
 * client-supplied topic - the server derives it from the connection's publish
 * grant, so a client can never publish to a room it was not granted. `event` is
 * a string; `data` is arbitrary JSON; `id` is an optional client-chosen input
 * id (number or string) echoed to the other receivers for input ordering /
 * prediction-reconcile.
 *
 * Server -> the room (fan-out): the standard `{ topic, event, data, seq }`
 * envelope with `id` echoed when the sender supplied one. The SENDER is excluded
 * (it already holds its own input and predicts locally). `seq` is a monotonic
 * per-room counter stamped by the home worker.
 *
 * Server -> the sender, on an ungranted or malformed frame:
 * `{ type: 'game-denied', reason, id? }` (`id` echoed when present).
 */
export interface GameFrame {
	type: 'game';
	event: string;
	data?: unknown;
	id?: number | string;
}

/**
 * The `game-denied` ack sent back to the SENDER of a rejected `game` frame.
 *
 * - `'FORBIDDEN'` - the connection holds no publish grant (never granted, or
 *   revoked). Grant one with `platform.grantPublish(ws, topic)`.
 * - `'INVALID'` - the connection is granted but the frame was malformed
 *   (a non-string `event`).
 */
export type GameDenialReason = 'FORBIDDEN' | 'INVALID';

export interface GameDeniedFrame {
	type: 'game-denied';
	reason: GameDenialReason;
	id?: number | string;
}

/**
 * Context passed to the `resume` handler.
 *
 * Fired when a reconnecting client presents the session id from its
 * previous connection plus the per-topic seq numbers it last saw. Use
 * this to fill the disconnect gap, typically by calling
 * `replay.replay(ws, topic, sinceSeq, platform)` per entry.
 */
export interface ResumeContext {
	/** Session id the client received in the welcome envelope of its previous connection. */
	sessionId: string;
	/**
	 * Highest seq the client saw per topic before disconnecting. Topics
	 * the client never received a message for are absent. Pass each
	 * `(topic, sinceSeq)` to your replay buffer.
	 */
	lastSeenSeqs: Record<string, number>;
	/**
	 * Generation the client last saw per topic, keyed the same as
	 * `lastSeenSeqs`. Compare each to `platform.topicEpoch(topic)`: on a
	 * match the client's offset is valid and you gap-fill as usual; on a
	 * mismatch the topic's seq space reset since the client last saw it
	 * (a restart, or a per-topic authority bump), so re-read it from the
	 * source of truth instead of replaying a reset space against a stale
	 * offset. Absent (the field omitted on the wire) for a client that
	 * never received an epoch; absence is treated as a match.
	 */
	lastSeenEpochs?: Record<string, number>;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Shape of the user's WebSocket handler module.
 *
 * Create a file (e.g. `src/lib/server/websocket.js`) and export any
 * of these functions. All are optional - the built-in handler already
 * handles subscribe/unsubscribe for the client store.
 *
 * Every hook receives `(ws, context)` where context always includes `platform`
 * plus any hook-specific fields. This gives you full access to publish, send,
 * and topic helpers directly in your WebSocket hooks.
 *
 * @example
 * ```js
 * // src/hooks.ws.js - auto-discovered, no config needed
 *
 * export function upgrade({ cookies }) {
 *   if (!cookies.session_id) return false; // reject with 401
 *   const user = await validateSession(cookies.session_id);
 *   if (!user) return false;
 *   return { userId: user.id }; // attach data to socket
 * }
 *
 * export function open(ws, { platform }) {
 *   ws.subscribe(`user:${ws.getUserData().userId}`);
 *   platform.topic('users').increment();
 * }
 *
 * export function close(ws, { platform }) {
 *   platform.topic('users').decrement();
 * }
 * ```
 */
export interface WebSocketHandler<UserData = unknown> {
	/**
	 * Optional HTTP preflight that runs before the WebSocket upgrade.
	 *
	 * Recommended for any flow that needs to refresh a session cookie on WS
	 * connect. Returning cookies from this hook goes out via a standard HTTP
	 * response, which works behind every proxy. Setting `Set-Cookie` on the
	 * 101 upgrade response (via `upgradeResponse()`) is silently dropped by
	 * Cloudflare Tunnel and some other strict edge proxies.
	 *
	 * Triggered by the client store via `connect({ auth: true })`, which
	 * POSTs to `/__ws/auth` (configurable via `websocket.authPath`) before
	 * opening every WebSocket - including after reconnects.
	 *
	 * Return values:
	 * - `undefined` / `void` - success, responds 204 with any cookies set via `cookies.set()`.
	 * - `false` - respond 401 Unauthorized.
	 * - `Response` - use the returned response directly; any `cookies.set()` calls are merged in.
	 *
	 * May be async.
	 *
	 * @example
	 * ```js
	 * export function authenticate({ cookies }) {
	 *   const session = validateSessionToken(cookies.get('session'));
	 *   if (!session) return false;
	 *   cookies.set('session', renewSession(session), {
	 *     httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7
	 *   });
	 * }
	 * ```
	 */
	authenticate?: (ctx: AuthenticateContext) =>
		| Response | false | void
		| Promise<Response | false | void>;

	/**
	 * Called once after the listen socket is bound and before any
	 * `upgrade` / `open` / `message` hooks fire. Use this to capture
	 * `platform` at boot time - the canonical entry point for cron
	 * registration, warmup tasks, scheduled metrics dumps, external
	 * pubsub bridge setup, or any "I need platform before the first
	 * connection" pattern.
	 *
	 * Async-allowed. The adapter awaits the returned promise before
	 * `start()` resolves (production) or `createTestServer()` resolves
	 * (test harness). Connections accepted at the kernel level during a
	 * slow async init queue until init resolves - but `open` / `message`
	 * hooks for those queued connections may run concurrently with the
	 * tail of init's execution. For most "capture platform" patterns the
	 * race is harmless (writes are idempotent); use synchronous init or
	 * an app-level ready-gate if strict ordering matters.
	 *
	 * **Per-worker firing in clustered mode.** Each worker process calls
	 * `start()` and fires `init` independently. An app running with N
	 * workers will see N `init` calls - one per worker. Do not assume
	 * singleton semantics; if you need a singleton (e.g. a single cron
	 * publisher across the cluster), layer leader election on top.
	 *
	 * Throws re-throw to the caller: boot failure should be loud. The
	 * `start()` promise rejects, the index.js entrypoint logs it, and the
	 * process crashes - which is the right behavior for a server that
	 * cannot complete its boot work.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * export function init({ platform }) {
	 *   // Capture platform so live.cron can publish without waiting
	 *   // for the first WebSocket connection.
	 *   live.setCronPlatform(platform);
	 * }
	 * ```
	 *
	 * **`workerData`** is whatever the `websocket.primaryInit` module returned,
	 * replayed identically to every worker (and every respawn) - the cross-worker
	 * shared memory (a `SharedArrayBuffer`, rings, a `MessagePort`) seeded once in
	 * the primary thread before any worker spawned. It is `null` in single-process
	 * mode and when no `primaryInit` is configured. A dedicated compute worker
	 * (`websocket.workers.compute`) also fires `init` with `workerData` but never
	 * binds a listen socket.
	 */
	init?: (ctx: { platform: Platform; workerData: any }) => void | Promise<void>;

	/**
	 * Called once during graceful shutdown, before the listen socket is
	 * closed and before existing WebSocket connections are kicked. Use
	 * this for app-level teardown that needs `platform` - cron drain,
	 * last metrics dump, external pubsub bridge teardown, queue flush.
	 *
	 * Async-allowed, and awaited before the listen socket closes - but only
	 * until the shutdown budget is spent. `SHUTDOWN_TIMEOUT` (seconds,
	 * default `30`) bounds the whole shutdown sequence, this hook included:
	 * when it expires the adapter logs that the hook did not settle and
	 * closes anyway. The hook itself is not interrupted (user code cannot
	 * be), it simply stops holding the close path, so work still running
	 * past that point may be lost. `SHUTDOWN_TIMEOUT=0` is the no-budget
	 * spelling: the await is unbounded and a wedged hook holds the process
	 * until something kills it.
	 *
	 * Throws are logged and ignored: shutdown is best-effort and the
	 * adapter cannot refuse to stop. If your teardown is strictly required,
	 * surface its failure via your own logging / alerting before the
	 * adapter logs it.
	 *
	 * The context carries the budget so a hook can honour it rather than be
	 * cut off by it:
	 *
	 * - `reason` - what started the shutdown (`'SIGTERM'`, `'SIGINT'`, or
	 *   `'shutdown'` for a programmatic close).
	 * - `signal` - aborts when the budget is spent, so a flush can stop
	 *   cleanly at a consistent point. `null` when no budget is configured.
	 * - `deadline` - wall-clock epoch ms the budget expires at, to compare
	 *   against your own `Date.now()`. `null` when no budget is configured.
	 *
	 * The three budget fields are OPTIONAL because one surface does not have
	 * them: the `vite dev` plugin fires this hook with `platform` alone. A
	 * dev server has no shutdown budget to report, so read them with a
	 * default (`signal ?? null`) if your hook must also run under dev. The
	 * built server and `createTestServer` both pass all four.
	 *
	 * Per-worker firing in clustered mode, same as `init`. Each worker
	 * fires `shutdown` independently when it receives the shutdown signal.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * export async function shutdown({ platform, signal }) {
	 *   await live.flushPendingCronTicks(platform, { signal });
	 * }
	 * ```
	 */
	shutdown?: (ctx: {
		platform: Platform;
		reason?: string | null;
		signal?: AbortSignal | null;
		deadline?: number | null;
	}) => void | Promise<void>;

	/**
	 * Called during the HTTP upgrade handshake.
	 *
	 * - Return an object to accept - it becomes `ws.getUserData()`.
	 * - Return `false` to reject with 401.
	 * - Omit this export to accept all connections with `{}` as user data.
	 *
	 * May be async.
	 */
	upgrade?: (ctx: UpgradeContext) =>
		| UserData | false
		| ReturnType<typeof upgradeResponse<UserData>>
		| Promise<UserData | false | ReturnType<typeof upgradeResponse<UserData>>>;

	/**
	 * Resolve who traffic on a connection is accounted to.
	 *
	 * Called exactly once per connection at open, BEFORE the `open` hook, with
	 * the connection's `ws.getUserData()` - the server-trusted identity the
	 * `upgrade` hook established. The result is validated, frozen, stored for
	 * the connection's life, and read back via `attribution(ws)` from
	 * `svelte-adapter-ws/connection`; the bundled ratelimit plugin reads its
	 * `tenantId` when no `tenant` resolver of its own is configured.
	 *
	 * MUST be synchronous - it runs inside the open callback, ahead of every
	 * hook that needs the answer. Resolve identity itself in the async-capable
	 * `upgrade` hook; derive the attribution from userData here.
	 *
	 * Fail-closed: a throwing resolver, a promise, a misshaped result, or an
	 * id outside `[a-zA-Z0-9_-]` / 64 chars refuses the connection at open
	 * (close code 1008) with one logged error line, rather than admitting it
	 * unattributed. Returning `null` / `undefined` (or omitting the export)
	 * means unattributed and is always accepted.
	 */
	attribution?: (user: UserData) => Attribution | null | undefined;

	/**
	 * Resolve the tenant a server-side publish on `topic` is charged to, for
	 * the `websocket.egress` tenant ceilings. This is how a framework's topic
	 * namespace convention (svelte-realtime's `@t/<id>/` prefix, for one)
	 * plugs into the egress budget without the adapter hardcoding any topic
	 * grammar.
	 *
	 * MUST be a pure synchronous function of the topic string - its answers
	 * are memoized. Return a tenant id under the shared attribution rule
	 * (`[a-zA-Z0-9_-]`, 1-64 chars) or `null` / `undefined` for an
	 * unattributed topic. Fail-closed on defects: an invalid id or a throwing
	 * resolver charges the publish UNATTRIBUTED (never a mangled key) and
	 * reports `ADAPTER-ERR-EGRESS-TENANT-RESOLVER` once per worker; a defined
	 * non-function export refuses startup outright.
	 *
	 * Not consulted on the client-relay game lane, where the SENDER's frozen
	 * `attribution` tenant id is the charged tenant. The ledger keys tenants
	 * only - `principalId` rides the attribution object for the inbound
	 * limiter surfaces, because per-principal budgets are the inbound rate
	 * limiter's job while egress budgets are tenant fair-share.
	 */
	egressTenantOf?: (topic: string) => string | null | undefined;

	/** Called when a WebSocket connection is established. */
	open?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;

	/**
	 * Called when a message is received.
	 *
	 * **Note:** subscribe/unsubscribe messages from the client store are
	 * handled automatically before this is called. You only need this for
	 * custom application-level messages.
	 */
	message?: (ws: WebSocket<UserData>, ctx: MessageContext) => void;

	/**
	 * Called when a client tries to subscribe to a topic.
	 *
	 * **Wire-level scope only.** This hook fires when a client sends a
	 * `{type:'subscribe'}` (or `{type:'subscribe-batch'}`) wire frame.
	 * Server-side code that calls `ws.subscribe(topic)` directly bypasses
	 * this hook - a subscribe on the socket handle is not intercepted.
	 * Frameworks
	 * and plugins that subscribe a connection on the user's behalf
	 * (RPC handlers, integration layers) must route through
	 * `platform.subscribe(ws, topic)` to inherit this gate. Otherwise the
	 * loader / RPC response runs and any data fans out before the
	 * client's eventual wire-level subscribe is denied.
	 *
	 * Return values:
	 * - `false` - deny with the default reason `'FORBIDDEN'`.
	 * - A string - deny with that string as the reason. The framework
	 *   recognises `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`,
	 *   and `'RATE_LIMITED'` as the canonical codes; any other string
	 *   is forwarded verbatim to the client.
	 * - Anything else (or omit this export) - allow.
	 *
	 * May be async: the returned promise is awaited before the value is
	 * inspected, so `async () => false` denies just like `() => false`,
	 * and a rejection denies with `'INTERNAL_ERROR'` exactly like a throw.
	 *
	 * When the client supplied a `ref` with its subscribe op, the
	 * server emits a `{type:'subscribed', topic, ref}` ack on accept or
	 * a `{type:'subscribe-denied', topic, ref, reason}` ack on deny.
	 * Old clients that send subscribe without a `ref` get no ack
	 * (silent allow / silent deny, as before).
	 *
	 * @example
	 * ```js
	 * export function subscribe(ws, topic, { platform }) {
	 *   const { role, userId } = ws.getUserData();
	 *   if (!userId) return 'UNAUTHENTICATED';
	 *   if (topic.startsWith('admin') && role !== 'admin') return 'FORBIDDEN';
	 * }
	 * ```
	 */
	subscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) =>
		| boolean | void | SubscribeDenialReason | string
		| Promise<boolean | void | SubscribeDenialReason | string>;

	/**
	 * Optional batch variant of `subscribe`. Called once when a client
	 * sends a `subscribe-batch` frame (typically on reconnect, where
	 * the client resubscribes to every topic it had before in a single
	 * message). Use this to authorise N topics with one DB query
	 * instead of N.
	 *
	 * **Wire-level scope only.** Same caveat as `subscribe`: server-side
	 * code that calls `ws.subscribe(topic)` directly does not pass through
	 * this hook. Frameworks subscribing on the user's behalf must route
	 * through `platform.subscribe(ws, topic)` - one call per topic, the
	 * per-topic `subscribe` hook fires for each. This hook is exclusively
	 * the optimization point for client-initiated bulk authorization.
	 *
	 * Receives the set of pre-validated topics (already filtered for
	 * `INVALID_TOPIC`) and returns a record mapping the topics you
	 * want to deny to a reason. Use:
	 *
	 * - `false` -> deny with the default reason `'FORBIDDEN'`.
	 * - A string -> deny with that string as the reason. Canonical
	 *   codes are `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`,
	 *   `'RATE_LIMITED'`; any other string is forwarded verbatim to
	 *   the client.
	 * - Omit a topic, return `true`, or return `undefined` for it -> allow.
	 *
	 * Returning `undefined` or `{}` from the hook means "allow
	 * everything". May be async: the returned promise is awaited before
	 * its entries are read, and a rejection denies the whole batch with
	 * `'INTERNAL_ERROR'` exactly like a throw.
	 *
	 * If you do not export this hook, the per-topic `subscribe` hook
	 * is called once per topic in the batch (unchanged behaviour).
	 *
	 * @example
	 * ```js
	 * export async function subscribeBatch(ws, topics, { platform }) {
	 *   const { userId } = ws.getUserData();
	 *   const allowed = await db.allowedTopics(userId, topics);
	 *   const allowedSet = new Set(allowed);
	 *   const denials = {};
	 *   for (const topic of topics) {
	 *     if (!allowedSet.has(topic)) denials[topic] = 'FORBIDDEN';
	 *   }
	 *   return denials;
	 * }
	 * ```
	 */
	subscribeBatch?: (
		ws: WebSocket<UserData>,
		topics: string[],
		ctx: SubscribeContext
	) =>
		| Record<string, boolean | SubscribeDenialReason | string> | void
		| Promise<Record<string, boolean | SubscribeDenialReason | string> | void>;

	/**
	 * Called when a client unsubscribes from a topic (ref count reached zero).
	 *
	 * Use this to clean up per-topic state like presence or group membership
	 * without waiting for the socket to close.
	 */
	unsubscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) => void;

	/**
	 * Called when backpressure has drained (buffered data was sent).
	 * Use this for flow control when sending large or frequent messages.
	 */
	drain?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;

	/**
	 * Called when a reconnecting client presents a previous session id and
	 * the per-topic sequence numbers it last saw. Use this to fill the gap
	 * caused by the disconnect window, typically by calling
	 * `replay.replay(ws, topic, sinceSeq, platform)` from the replay plugin
	 * for each topic the client cares about.
	 *
	 * If you do not export this hook, reconnects still work; the client
	 * just falls through to live mode without a gap fill (same as a cold
	 * connect). Wire it up only when your app needs in-flight events that
	 * landed during a brief network blip.
	 *
	 * The `lastSeenSeqs` object keys are topic names, values are the
	 * highest `seq` the client received before disconnect. Topics the
	 * client never received a message for are absent.
	 *
	 * The hook may be async. While it runs, the server buffers any live frame
	 * published to a recovering topic and flushes it once the connection goes
	 * live, so a message that lands mid-resume is never lost. Return the highest
	 * `seq` you delivered per topic - a `{ [topic]: seq }` map, or a bare number
	 * for a single-topic resume - and the server de-duplicates those buffered
	 * frames against it exactly. Return nothing and they are still delivered, but
	 * a frame from the narrow window between the buffer opening and your backend
	 * read may arrive twice (at-least-once) instead of exactly once.
	 *
	 * @example
	 * ```js
	 * import { createReplay } from 'svelte-adapter-ws/plugins/replay';
	 * const replay = createReplay({ size: 500 });
	 *
	 * export function resume(ws, { lastSeenSeqs, platform }) {
	 *   for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
	 *     replay.replay(ws, topic, sinceSeq, platform);
	 *   }
	 * }
	 * ```
	 *
	 * @example
	 * ```js
	 * // Exact de-dup: report the highest seq delivered per topic.
	 * export async function resume(ws, { lastSeenSeqs, platform }) {
	 *   const covered = {};
	 *   for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
	 *     covered[topic] = await myBackend.replay(ws, topic, sinceSeq, platform);
	 *   }
	 *   return covered;
	 * }
	 * ```
	 */
	resume?: (ws: WebSocket<UserData>, ctx: ResumeContext) =>
		void | Record<string, number> | number | Promise<void | Record<string, number> | number>;

	/** Called when the connection closes. */
	close?: (ws: WebSocket<UserData>, ctx: CloseContext) => void;
}

/**
 * Build-time option validation helpers. Exported so build tooling and tests
 * can validate an options object the way `adapter()` will; not part of the
 * documented app-facing API.
 * @internal
 */
export const KNOWN_ADAPTER_OPTION_KEYS: Set<string>;
/** @internal */
export const KNOWN_WEBSOCKET_OPTION_KEYS: Set<string>;
/** @internal */
export function unknownAdapterOptionKeys(opts: Record<string, unknown> | null | undefined): string[];
/** @internal */
export function serializeWsOptions(websocket: Record<string, unknown>, adminPath: string | false): Record<string, unknown>;
/** @internal */
export function renderRefusedDotfileWarning(refused: string[]): string;
/**
 * Keys present in a `websocket` object that the adapter does not recognize,
 * as dotted paths - the nested objects are walked too, because a typo one
 * level down is dropped just as silently as a top-level one.
 * @internal
 */
export function unknownWebsocketOptionKeys(
	websocket: Record<string, unknown> | null | undefined
): string[];
/**
 * Recognized keys inside the nested `websocket` option objects, keyed by the
 * dotted path of the object they belong to.
 * @internal
 */
export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS: Readonly<
	Record<string, ReadonlySet<string>>
>;
/**
 * Read the record the Vite plugin leaves of which module it built the
 * WebSocket handler from. `null` when the build carries no such record.
 * @internal
 */
export function readHandlerOrigin(
	tmp: string
): { source: string; absolute: string | null; from: string } | null;
/**
 * Refuse when the adapter's `websocket.handler` disagrees with the module the
 * Vite plugin actually bundled, which would otherwise ship a handler the app
 * did not ask for. Warns only when an older/unrelated plugin emitted no origin
 * record at all.
 * @internal
 */
export function assertBundledHandlerMatches(
	handler: string | null | undefined,
	origin: { source: string; absolute?: string | null; from: string } | null,
	log: { warn: (msg: string) => void }
): void;
/**
 * Read the record the Vite plugin leaves of which module it built the metrics
 * registry from. `null` when the build carries no such record.
 * @internal
 */
export function readMetricsOrigin(
	tmp: string
): { source: string; absolute: string | null; from: string } | null;
/**
 * Refuse when the adapter's `websocket.metrics` disagrees with the module the
 * Vite plugin actually bundled, which would otherwise ship adapter counters
 * incrementing on a registry no scrape route reads. Warns only when an
 * older/unrelated plugin emitted no origin record at all.
 * @internal
 */
export function assertBundledMetricsMatches(
	metrics: string | null | undefined,
	origin: { source: string; absolute?: string | null; from: string } | null,
	log: { warn: (msg: string) => void }
): void;

export default function adapter(options?: AdapterOptions): Adapter;

/**
 * Live context passed to a custom `waitingRoom.template`. All numeric fields
 * are UX estimates surfaced for the holding page, never an admission input.
 */
export interface WaitingRoomContext {
	/** Polls seen in the last poll interval (a UX estimate, not an admission input). */
	queueDepth: number;
	/** Rolling drain-rate estimate in seconds (a UX estimate). */
	estimatedSeconds: number;
	/** Configured page poll cadence in ms. */
	pollIntervalMs: number;
	/** Configured base for the jittered Retry-After in seconds. */
	retryAfterSeconds: number;
	/** The poll endpoint path the page should fetch. */
	admitCheckPath: string;
	/** Configured application name, or an empty string when omitted. */
	appName: string;
	/** Configured service-status URL, or an empty string when omitted. */
	statusUrl: string;
	/** Configured support URL, or an empty string when omitted. */
	supportUrl: string;
	/** Configured incident reference, or an empty string when omitted. */
	incidentId: string;
}

/** Synchronous request facade passed to a waiting-room renderer module. */
export interface WaitingRoomRequestContext {
	/** Uppercase request method. */
	readonly method: string;
	/** Path plus query string for the holding-page request. */
	readonly url: string;
	/** Case-insensitive request-header lookup; absent headers return `null`. */
	readonly headers: {
		get(name: string): string | null;
	};
}

/** Per-request context passed to a locale-aware waiting-room renderer. */
export interface WaitingRoomRendererContext extends WaitingRoomContext {
	readonly request: WaitingRoomRequestContext;
}

/**
 * One accessible document baseline for every custom waiting path.
 *
 * At runtime `body` is parsed and validated for a doctype; valid
 * `html[lang]` and `html[dir]`; non-empty title and body; exposed main
 * landmark and non-empty status live region; and an exposed enabled named recovery
 * control or non-empty safe link. Comments and hidden, inert, template, script,
 * and style subtrees cannot satisfy the contract. Renderer `lang` and
 * `dir` are authoritative and are applied before that validation.
 */
export interface AccessibleWaitingDocument {
	/**
	 * A full HTML document containing an `<html>` element. This is trusted
	 * application HTML; escape every request/configuration value you interpolate.
	 */
	body: string;
	/** Valid BCP 47 language tag; emitted as `Content-Language` and `html[lang]`. */
	lang: string;
	/** Document direction; emitted as `html[dir]`. */
	dir: 'ltr' | 'rtl' | 'auto';
	/**
	 * Optional extra response headers. Adapter-owned framing, cache, language,
	 * and variation headers cannot be overridden.
	 */
	headers?: Record<string, string>;
}

/** Compatibility name for the document returned by a waiting-room renderer. */
export interface WaitingRoomRendererResult extends AccessibleWaitingDocument {}

/** Synchronous build-bundled renderer for a localized waiting-room document. */
export type WaitingRoomRenderer = (
	context: WaitingRoomRendererContext
) => AccessibleWaitingDocument;
