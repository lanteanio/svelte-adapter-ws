// Shared per-worker runtime state. One module so the request handler, the
// static index, and the lifecycle machine read and write the same objects
// without circular imports.

/**
 * @typedef {{
 *   buffer: Buffer,
 *   contentType: string,
 *   etag: string,
 *   lastModifiedMs?: number,
 *   headers: [string, string][],
 *   headersFlat: (string | number)[],
 *   brBuffer?: Buffer,
 *   gzBuffer?: Buffer,
 *   brEtag?: string,
 *   gzEtag?: string,
 *   brHeaders?: [string, string][],
 *   gzHeaders?: [string, string][],
 *   brHeadersFlat?: (string | number)[],
 *   gzHeadersFlat?: (string | number)[]
 * }} StaticEntry
 */

/** In-memory static file cache, keyed by exact URL pathname. @type {Map<string, StaticEntry>} */
export const staticCache = new Map();

/**
 * Prerendered pages whose canonical form carries a trailing slash
 * (directory-style output, `trailingSlash: 'always'`), keyed by the bare path.
 * @type {Set<string>}
 */
export const prerenderedDirStyle = new Set();

/** Bounded LRU for decoded URI pathnames. @type {Map<string, string | null>} */
export const decodeCache = new Map();

export const counters = {
	/** HTTP exchanges currently in flight (accepted, response not finished). */
	inFlightCount: 0,
	/** Operations attempted on an already-closed socket, absorbed. */
	closedWsAborts: 0,
	/** Mirrors the lifecycle state for cheap hot-path reads. */
	draining: false,
	/** Monotonic ref allocator for platform.request frames. */
	nextRequestRef: 1,
	/** Frames shed past maxBackpressure since boot. */
	droppedFrames: 0,
	/** Payload bytes shed past maxBackpressure since boot. */
	droppedBytes: 0,
	/** Exact shed window for the pressure sampler (recordBackpressureDrop). */
	droppedFramesWindow: 0,
	droppedBytesWindow: 0,
	/** platform.publish calls in the current sample window. */
	publishCountWindow: 0,
	/**
	 * Publish-egress accounting for the current pressure window (reset each
	 * sample): local deliveries (recipients times messages) and serialized
	 * wire bytes charged by the shared egress charge point, plus ceiling
	 * refusals per scope. Written by handler/egress-budget.js, drained into
	 * pressureSnapshot.egress by the sampler.
	 */
	egressDeliveriesWindow: 0,
	egressBytesWindow: 0,
	egressRefusedTopicWindow: 0,
	egressRefusedTenantWindow: 0,
	/**
	 * Cumulative egress-refusal metrics hook (null when metrics are disabled);
	 * called with the refused scope so the registry counter carries it.
	 * @type {((scope: string) => void) | null}
	 */
	egressRefusedHook: null,
	/**
	 * Cumulative hook for LIVE usage windows dropped at the ledger cap (null
	 * when metrics are disabled), called with the evicted scope. An expired
	 * window is reclaimed for free and is deliberately not reported here.
	 * @type {((scope: string) => void) | null}
	 */
	egressEvictedHook: null,
	/**
	 * Cumulative hook for one relayed publish refused by the sender-side frame
	 * ceiling (null when metrics are disabled), called with the lane.
	 * @type {((lane: string) => void) | null}
	 */
	relayFrameRefusedHook: null,
	/**
	 * Aggregate delivery outcome for one counted publish call (null when
	 * metrics are disabled). `true` means at least one local subscriber held
	 * the topic.
	 * @type {((delivered: boolean) => void) | null}
	 */
	publishOutcomeHook: null,
	/**
	 * One completed HTTP exchange, from the terminal hook in handler/request.js
	 * (null when metrics are disabled). The status is the response's own; the
	 * aborted flag is what separates a client hang-up from a real status, and it
	 * cannot be derived from the code.
	 * @type {((method: string, status: number, aborted: boolean, seconds: number) => void) | null}
	 */
	httpRequestHook: null,
	/**
	 * Gauge-sampling hook, called once per pressure fold with the reason
	 * transition (or null) and the kernel readings that fold already paid for.
	 * Null when no metrics registry is configured, so the zero-config sampler
	 * is unchanged.
	 * @type {((telemetry: { transition: { from: string, to: string } | null, os: any }) => void) | null}
	 */
	metricsSampleHook: null,
	/**
	 * Readings the pressure fold produced and the metrics hook cannot
	 * recompute: `publishCountWindow` is zeroed as it is read, and the memory
	 * figures come from the one `process.memoryUsage()` the fold already paid
	 * for. `lastSampleWallMs` is the wall time the fold completed - 0 until
	 * the first sample, which is what keeps the freshness gauge from dating a
	 * document that has never been measured.
	 */
	lastPublishCount: 0,
	lastConnections: 0,
	lastDroppedFrames: 0,
	lastDroppedBytes: 0,
	lastResidentBytes: 0,
	lastSampleWallMs: 0,
	/** Live logical subscription count across every connection. */
	totalSubscriptions: 0,
	/** Worst client-reported send-gate backlog since the last sample. */
	leaseSaturationPeak: 0,
	/** The wall ratio the last sample measured (sizes lease grants). */
	lastHeapUsedRatio: 0,
	/**
	 * Live protection posture, null until the realtime module builds one and
	 * null for the whole life of a `'normal'` deployment. Every read in the
	 * family tests `!== null` first, so the field must EXIST here even when it
	 * holds null - an absent property reads `undefined`, which passes that
	 * test and throws on the `.level` behind it.
	 * @type {{ level: 'normal' | 'elevated' | 'siege', rejectedPerSecond: number, recordCapacityReject(): void, recordRateLimitReject(): void, tick(snapshot: { active: boolean }): void } | null}
	 */
	activePosture: null,
	/** Base (un-layered) pressure reason from the most recent sample, for the posture transition line. */
	lastBasePressureReason: 'NONE',
	/**
	 * Posture-export push hook, called by the 1 Hz sampler and by a posture
	 * transition. Null when no export is configured.
	 * @type {(() => void) | null}
	 */
	postureExportHook: null,
	/**
	 * The live posture exporter; shutdown closes it. Null when no export is
	 * configured.
	 * @type {{ broadcast: () => void, close: () => void, clientCount: () => number } | null}
	 */
	postureExporter: null,
	/**
	 * The per-worker consistency auditor (null when disabled by interval 0).
	 * Lives on the holder so the install site (handler/realtime.js) and the
	 * shutdown site (handler/lifecycle.js) share ONE reference.
	 * @type {{ start(): void, stop(): void, runOnce(): unknown } | null}
	 */
	consistencyAuditor: null,
	/**
	 * The optional resource-growth trend auditor (null when disabled by
	 * interval 0, the default). Same holder rationale as consistencyAuditor.
	 * @type {{ start(): void, stop(): void, runOnce(): void } | null}
	 */
	resourceGrowthAuditor: null
};

// - Realtime state -----------------------------------------------------------

/** Live connection facades. @type {Set<object>} */
export const wsConnections = new Set();

/** Facade lookup by raw socket. @type {Map<import('ws').WebSocket, object>} */
export const wsWrappers = new Map();

/** Per-topic publish seq counters (one seq space per topic, every lane). @type {Map<string, number>} */
export const topicSeqs = new Map();

/**
 * Whether outbound cluster relay frames are stamped with this worker's
 * per-topic stream identity (origin thread id, dense ordinal, stream birth).
 * Nothing in this runtime arms it: the stamps feed a receiver-side
 * contiguity check that lives with the state-hash divergence machinery, and
 * they are worth paying for only where that consumer exists - armed off, the
 * relay send path (handler/relay.js) pays one boolean test per relayed
 * publish and allocates nothing, while the ring format keeps the stamp
 * fields so an armed sender and an unarmed receiver stay wire-compatible. A
 * holder, not `export let`, so an arming write is visible to the read site
 * in relay.js.
 * @type {{ enabled: boolean }}
 */
export const streamTracking = { enabled: false };

/**
 * Wire-subscribe authorization arming. Seeded from build options; the
 * platform can arm it at runtime.
 */
export const subscribeAuth = {
	enabled: false,
	strict: false
};

/** Cache of `{"topic":...,"event":...` envelope prefixes. @type {Map<string, string>} */
export const envelopePrefixCache = new Map();

import { createCapCounts } from '../wire.js';

/**
 * Live per-capability connection counts, adjusted on hello and close, so the
 * binary publish path can skip the whole subscriber walk when nobody
 * advertises a capability.
 */
export const capCounts = createCapCounts();

/**
 * The live pressure snapshot: ONE stable object mutated in place by the 1 Hz
 * sampler and returned by reference from `platform.pressure`. `sampledAt`
 * null is the only discriminator between a real reading and this placeholder.
 */
export const pressureSnapshot = {
	sampledAt: /** @type {number | null} */ (null),
	active: false,
	value: 0,
	subscriberRatio: 0,
	publishRate: 0,
	memoryMB: 0,
	reason: 'NONE',
	psi: /** @type {object | null} */ (null),
	cpuThrottle: /** @type {object | null} */ (null),
	maxBufferedBytes: 0,
	backpressuredConnections: 0,
	droppedFrames: 0,
	droppedBytes: 0,
	egress: { deliveries: 0, bytes: 0, refusedTopic: 0, refusedTenant: 0 },
	topPublishers: /** @type {Array<object>} */ ([])
};

/** onPressure transition listeners. @type {Set<(snapshot: object) => void>} */
export const pressureListeners = new Set();

/** onPublishRate window listeners. @type {Set<(top: Array<object>) => void>} */
export const publishRateListeners = new Set();

/**
 * Per-topic publish counters for runaway-publisher detection (sampled + reset
 * each pressure tick). `m`/`b` keep their original meanings (publish calls and
 * envelope UTF-16 length); `d` is the additive egress deliveries dimension
 * (recipients times messages, exclusions deducted), charged by the egress
 * charge point where that lane is armed.
 * @type {Map<string, { m: number, b: number, d: number }>}
 */
export const topicPublishStats = new Map();

/** Throttle map for the default runaway-publisher console.warn (one per topic per minute). @type {Map<string, number>} */
export const lastPublishWarnAt = new Map();
