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
	/** Live logical subscription count across every connection. */
	totalSubscriptions: 0,
	/** Worst client-reported send-gate backlog since the last sample. */
	leaseSaturationPeak: 0,
	/** The wall ratio the last sample measured (sizes lease grants). */
	lastHeapUsedRatio: 0
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

/** Per-topic publish counters for the current window. @type {Map<string, { m: number, b: number }>} */
export const topicPublishStats = new Map();
