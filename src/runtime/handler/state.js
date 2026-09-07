// Shared per-worker runtime state. One module so the request handler, the
// static index, and the lifecycle machine read and write the same objects
// without circular imports.

import { processMonotonicNow } from '../runtime.js';
import { createDivergenceDiagnosticStore } from '../divergence-diagnostics.js';

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
	/**
	 * Mirrors the lifecycle state for cheap hot-path reads. The lifecycle
	 * module is the single writer: it sets this the moment it loads, from its
	 * own 'starting' state, so the mirror and the readiness probe agree for
	 * the whole of boot as well as after it.
	 */
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
 * Per-topic highest delivered sequence number this worker has OBSERVED, whether
 * it stamped the publish locally or received the originator's pre-stamped frame
 * over the cross-worker relay. Unlike `topicSeqs` (which only the publishing
 * worker advances), every worker that receives a relayed frame advances this for
 * the topic, so under a reliable in-process relay every worker converges to the
 * same value per topic. A worker that fell behind (a relay frame delivered to
 * some workers but not this one) holds a lower value, which a structural hash
 * over this map surfaces as a cross-worker divergence. A topic only ever
 * published with seq stamping disabled never enters this map and is excluded
 * from the comparison.
 *
 * A maximum only ever reveals a lost TAIL. A lost INTERIOR frame moves no
 * maximum at all, and is caught by `originStreams` below instead.
 * @type {Map<string, number>}
 */
export const maxSeenSeq = new Map();

/**
 * Bounded replica of primary-completed state-divergence diagnostics. The
 * primary broadcasts a record only after the aggregate detector has fired and
 * the bounded keyed sequence snapshots have been collected. `platform` exposes
 * metadata by default and exact-id lookup separately for the authenticated
 * admin plane.
 */
export const divergenceDiagnostics = createDivergenceDiagnosticStore();

/**
 * Record an observed `seq` for `topic` into a max-seen map, keeping the highest.
 * Used on the relay RECEIVE path, where frames can arrive out of order across
 * the worker `postMessage` boundary, so the monotone-max guard is required (a
 * blind overwrite could move the value backward and fabricate a divergence). The
 * local publish path already holds the freshly stamped (monotonic) seq and takes
 * `recordStampedSeen` below instead, which skips the compare while the counter
 * is the only authority in the map and keeps the membership report either way.
 * A non-number `seq` (a frame relayed for a `{ seq: false }` topic) is ignored,
 * so such topics never enter the map on any worker.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `nextTopicSeq`), so a unit test can pass a fresh map per case.
 *
 * @param {Map<string, number>} seenMap
 * @param {string} topic
 * @param {number} seq
 * @param {{ onSeenInsert(topic: string): void } | undefined} [bound]
 * @returns {void}
 */
/**
 * Has this worker ever recorded a seq it did not itself stamp?
 *
 * Latches on the first such record and never clears (outside the reset below,
 * which exists for suites that drive these recorders with fresh maps). It is
 * the gate on the monotone compare in `recordStampedSeen`: until a foreign
 * number has entered the observed registry, the counter really is the only
 * authority numbering these topics, it really is monotone in itself, and the
 * compare really is redundant. Afterwards it is none of those things.
 *
 * A latch rather than a per-topic mark because per-topic granularity costs a
 * second lookup on the publish lane, which is the entire expense being avoided.
 * Erring toward comparing is the safe direction: the cost of a needless compare
 * is nanoseconds, the cost of a missed one is a max that moved backward.
 */
let foreignSeqRecorded = false;

/** Test seam: forget the latch so a suite can drive both sides in one process. */
export function resetForeignSeqLatch() { foreignSeqRecorded = false; }

/** Whether the monotone compare is currently armed. Exposed for assertions. */
export function foreignSeqLatched() { return foreignSeqRecorded; }

export function recordSeen(seenMap, topic, seq, bound) {
	if (typeof seq !== 'number') return;
	// Every caller of this recorder is handling a number some OTHER authority
	// issued - a sibling worker's relay frame, or an explicit `seq` option from a
	// replay backend - which is exactly the condition that makes a bare stamped
	// write able to regress the maximum.
	foreignSeqRecorded = true;
	const prev = seenMap.get(topic);
	if (prev === undefined) {
		seenMap.set(topic, seq);
		// A topic new to the map - the cold path; the bound caps the
		// observational registry the same way the counter map is capped.
		if (bound !== undefined) bound.onSeenInsert(topic);
		return;
	}
	if (seq > prev) seenMap.set(topic, seq);
}

/**
 * Record a freshly stamped counter `seq` for `topic` into a max-seen map.
 *
 * The local publish lanes hold a value they issued one line earlier, so the
 * write itself skips the compare: the monotone-max lookup `recordSeen` performs
 * exists for the reorder-prone relay RECEIVE path, and paying it on the hottest
 * lane in the runtime would buy nothing for a topic whose numbers this worker's
 * own counter issues in order.
 *
 * That reasoning holds only while the counter is the ONLY authority in the map.
 * It is not, on two ordinary shapes: a topic that also carries an explicit
 * numeric seq (the per-entry batch seq puts both on one topic by design, one
 * entry stamped and the next counted), and a clustered topic whose sibling's
 * relayed numbers land here through `recordSeen`. Against a foreign number the
 * counter is not monotone, so a topic recorded at 900000 and then published by
 * a counter sitting at 1 used to record 1 OVER 900000 - the observed maximum,
 * whose whole purpose is the highest seq seen for a topic, moving backward by
 * 899999. That value feeds the cross-worker convergence hash, where a backward
 * move is a fabricated divergence between workers that saw the publishes in a
 * different order, and the resume cutover floor, where it reads as `before` and
 * turns a clean handover into duplicate delivery.
 *
 * So the compare is paid, but only from the moment it can matter: `recordSeen`
 * latches on the first foreign number this worker records, and this recorder
 * takes the guarded path from then on. A worker that never meets one - a
 * single process publishing through its own counter - keeps the bare write and
 * measures at parity with it (bench/micro-seq-monotone-stamp-ab.mjs: +1.1% on
 * the hot-topic shape, with the arms crossing over between process runs, where
 * comparing unconditionally costs a consistent ~5.5%). Latch granularity rather
 * than per-topic because a per-topic mark costs the second lookup this shape
 * exists to avoid, and erring toward comparing is the safe direction.
 *
 * What it does share with `recordSeen` is the MEMBERSHIP report. A registry
 * bound caps a map by hearing about the entries that enter it, and a lane that
 * wrote the map directly was invisible to it: an application mixing an external
 * seq authority with ordinary adapter counters could hold a full ceiling of
 * observed topics from the relay and then add counter topics on top of it, one
 * per publish, with nothing left to notice. Coldness is read from the map's own
 * size across the write rather than from a preceding `has`, so a publish on a
 * topic the map already holds - every publish but the first - pays two field
 * reads and no second hash lookup.
 *
 * A non-number `seq` is ignored, exactly as in `recordSeen`: every call site
 * guards on the stamp being non-null, and the day one stops, a null recorded
 * here would become the `prev` that every later relay frame for that topic
 * compares against. Pure with respect to inputs other than the supplied map,
 * so a unit test can pass a fresh map per case.
 *
 * @param {Map<string, number>} seenMap
 * @param {string} topic
 * @param {number} seq
 * @param {{ onSeenInsert(topic: string): void } | undefined} [bound]
 * @returns {void}
 */
export function recordStampedSeen(seenMap, topic, seq, bound) {
	if (typeof seq !== 'number') return;
	// Once any foreign number has been recorded on this worker, the counter is no
	// longer the only authority in this map and its value is no longer the
	// maximum by construction, so the write has to compare. A publish on a topic
	// no foreign seq ever touched takes the bare write it always did; the branch
	// is one already-hot boolean, and the alternative - a per-topic mark - costs
	// the lookup this whole shape exists to avoid.
	if (foreignSeqRecorded) {
		const prev = seenMap.get(topic);
		if (prev === undefined) {
			seenMap.set(topic, seq);
			if (bound !== undefined) bound.onSeenInsert(topic);
			return;
		}
		if (seq > prev) seenMap.set(topic, seq);
		return;
	}
	const before = seenMap.size;
	seenMap.set(topic, seq);
	if (bound !== undefined && seenMap.size !== before) bound.onSeenInsert(topic);
}

/**
 * Per-(topic, origin) contiguity tracking for streams received over the
 * cross-worker relay - the state behind the interior-gap half of the
 * convergence hash.
 *
 * `maxSeenSeq` folds only each topic's HIGHEST seq, which catches a lost TAIL
 * (this worker's max lags its siblings') but is blind to a lost INTERIOR frame:
 * a worker that saw [2,3] and one that saw [1,2,3] both report max 3 and hash
 * identical. Contiguity is what distinguishes them.
 *
 * What is checked here is the relay ORDINAL each sending worker stamps on its
 * outbound frames (see handler/relay.js), NOT the publish seq. Only the ordinal
 * is dense on the path being audited: a publish seq skips numbers over the relay
 * whenever a topic is also published locally-only (`{ relay: false }` for an
 * external pub/sub source, or the game lane), and interleaves meaninglessly when
 * an explicit `{ seq: n }` authority stamps it from several workers at once.
 * The ordinal counts one thing - frames this origin handed to the relay for this
 * topic - so a hole in it is a dropped frame and nothing else. It also covers
 * `{ seq: false }` topics, which carry no seq to compare at all.
 *
 * Keyed by the origin's thread id, because each worker stamps its own 1-based
 * ordinal space.
 *
 * Unlike the maxima, a hole here is decidable by the worker that finds it: the
 * ordinal is dense at the origin by construction, so a worker holding 1 that
 * receives 3 KNOWS 2 was sent and never arrived. It needs no sibling to tell it
 * so, which is why a confirmed hole is REPORTED rather than folded into the
 * voted convergence hash. Voting on a self-evident fact would be worse than
 * useless: the publishing worker never receives its own frames, so it can hold
 * no view of the stream at all, and a loss that hit every receiver would make
 * the one worker that lost nothing the odd one out.
 *
 * `above` is allocated lazily (null while the stream is contiguous, the common
 * case) and `holeSince` is 0 when there is no open hole, so a healthy stream
 * costs one small object per (topic, origin).
 * @type {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, saturated: boolean, forgottenFloor: number, holeSince: number }>>}
 */
export const originStreams = new Map();

/**
 * Whether the relay-contiguity tracker is running. Off unless the cross-worker
 * reporter is configured (`stateHashIntervalMs`), since nothing would ever read
 * what it tracks - so a default deployment pays one boolean test on the relay
 * receive path and allocates nothing. A holder, not `export let`, so the write
 * (handler.js, at reporter install) reaches the read site in lifecycle.js.
 * @type {{ enabled: boolean }}
 */
export const streamTracking = { enabled: false };

/**
 * Process-monotonic instant at which this worker wired its relay listeners, i.e.
 * the point from which a sibling's publish was owed to it. `Infinity` until then,
 * so a stream can never be judged to have started after we attached before we
 * actually have - an unattached or single-process worker classifies every first
 * sighting as a legitimate mid-stream join and reports no gaps.
 *
 * A holder, not `export let`, so the write (runtime/index.js, via the handler's
 * `markRelayAttached`) is visible to the read site in this module.
 * @type {{ at: number }}
 */
export const relayAttach = { at: Infinity };

/**
 * Latch the relay-attach instant. Called once per worker, from the site that
 * wires the relay listeners. Idempotent: the FIRST attach wins, because a later
 * one would move the boundary forward and re-classify already-tracked streams.
 * @returns {void}
 */
export function markRelayAttached() {
	if (relayAttach.at === Infinity) relayAttach.at = processMonotonicNow();
}

/**
 * How many ordinals above an open hole the buffer retains. Bounds what one lost
 * frame behind a live publisher can hold. Not a tuning knob.
 *
 * At the cap the buffer keeps the `MAX_PENDING_ABOVE` SMALLEST ordinals seen: an
 * arrival below the current maximum evicts that maximum. The report boundary is
 * the LOWEST arrival above the hole, so keeping the smallest is what makes that
 * boundary exact - everything between the watermark and it genuinely never came.
 * Simply refusing arrivals once full leaves a larger ordinal defining the
 * boundary while smaller ones that DID arrive go unrecorded, and the report then
 * names delivered frames as lost.
 *
 * Eviction never forgets that a frame ARRIVED for re-baselining purposes - that
 * is what `hi` is for, and the drain resumes from `hi` rather than from the
 * buffer. What it does cost is auditing: ordinals evicted above the reported hole
 * are no longer individually checkable, so a second loss inside the same window
 * is folded into the first report rather than counted. The reported `count` is
 * therefore frames PROVEN lost - a lower bound, not a total.
 */
export const MAX_PENDING_ABOVE = 64;

/**
 * How long an open hole must persist before it counts as a real drop.
 *
 * A hole means a higher ordinal arrived while a lower one is still missing. Both
 * relay channels are FIFO per origin (the ring is a byte ring; postMessage is an
 * ordered port), so the only way a hole fills later is the rare mixed-channel
 * case - a frame whose ring encode threw falls back to postMessage while its
 * batch-mates ride the ring - and that resolves within the same process in
 * microseconds. Anything still missing an order of magnitude beyond any
 * plausible in-process reorder is gone, not late.
 *
 * Confirmation is by TIME rather than by pending count so a drop is reported on
 * a quiet topic just as it is on a busy one; the count only bounds memory.
 */
export const GAP_CONFIRM_MS = 1000;

/**
 * Retain a delivered ordinal that no longer fits in `above` as one of a bounded
 * set of sorted, merged ranges. A busy damaged stream is normally one ascending
 * range, however many frames it carries, so this preserves exact contiguity
 * without returning to an unbounded per-frame Set.
 *
 * At the range cap we keep the LOWEST ranges: only the first delivered ordinal
 * above the watermark defines the currently reportable hole. Losses beyond all
 * retained ranges remain part of the documented lower-bound trade once a stream
 * has exceeded both bounds.
 *
 * Returns the lowest DELIVERED ordinal the cap forgot (the popped furthest
 * range's start, or an arrival beyond every retained range that a full array
 * could not record), or 0 when nothing was forgotten. While this has only
 * ever returned 0, the exact buffer plus the ranges are a COMPLETE record of
 * every arrival above the watermark, and the drain may treat an uncovered
 * ordinal below the coverage frontier as certainly lost. Once an ordinal has
 * been forgotten, absence stops meaning loss AT AND ABOVE the lowest
 * forgotten ordinal: a partial drain can later advance the watermark past
 * forgotten ARRIVALS, after which even the lowest retained arrival sits
 * above delivered frames the tracker no longer knows about - so the drain
 * records the floor and clamps every report below it.
 * @param {Array<[number, number]>} ranges
 * @param {number} ord
 * @returns {number} the lowest forgotten delivered ordinal, or 0
 */
function retainAboveRange(ranges, ord) {
	let i = 0;
	while (i < ranges.length && ranges[i][1] + 1 < ord) i++;
	if (i < ranges.length && ord >= ranges[i][0] - 1 && ord <= ranges[i][1] + 1) {
		if (ord < ranges[i][0]) ranges[i][0] = ord;
		if (ord > ranges[i][1]) ranges[i][1] = ord;
		while (i + 1 < ranges.length && ranges[i + 1][0] <= ranges[i][1] + 1) {
			ranges[i][1] = Math.max(ranges[i][1], ranges[i + 1][1]);
			ranges.splice(i + 1, 1);
		}
		return 0;
	}
	if (ranges.length < MAX_PENDING_ABOVE) {
		ranges.splice(i, 0, [ord, ord]);
		return 0;
	}
	if (i < ranges.length) {
		// Keep the closest ranges; the last one is furthest from today's hole.
		ranges.splice(i, 0, [ord, ord]);
		const dropped = ranges.pop();
		return dropped === undefined ? ord : dropped[0];
	}
	// Beyond every retained range with the array full: the arrival cannot be
	// recorded at all.
	return ord;
}

/** @param {Array<[number, number]>} ranges @param {number} ord */
function aboveRangesContain(ranges, ord) {
	for (let i = 0; i < ranges.length; i++) {
		if (ord < ranges[i][0]) return false;
		if (ord <= ranges[i][1]) return true;
	}
	return false;
}

/**
 * Fold one relayed frame's ordinal into the (topic, origin) stream tracker.
 *
 * The classification that matters is the FIRST sighting of a stream, where an
 * ordinal above 1 is ambiguous: this worker either joined a stream already in
 * flight (nothing was owed to it) or was attached and lost the prefix. `birth`
 * (the origin's instant of stamping ordinal 1) against `attachedAt` (ours)
 * decides it - both readings on the process-shared timeline, so the comparison
 * is exact rather than skewed by each thread's own wall-clock anchor. Ties go to
 * the benign reading: an equal birth and attach baselines rather than reports.
 *
 * Thereafter it is plain contiguity: the next ordinal advances the watermark and
 * drains anything buffered above it, a lower one is a duplicate, and a higher
 * one opens a hole.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `recordSeen`), and `nowFn` is called ONLY when a hole opens - never on the
 * contiguous path - so a healthy relay pays no clock read per frame.
 *
 * @param {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, saturated: boolean, forgottenFloor: number, holeSince: number }>>} streams
 * @param {string} topic
 * @param {number} origin - the publishing worker's thread id
 * @param {number} ord - the origin's per-topic relay ordinal for this frame
 * @param {number} birth - origin's process-monotonic instant of this stream's ordinal 1
 * @param {number} attachedAt - our process-monotonic relay-attach instant
 * @param {() => number} nowFn - process-monotonic clock, read lazily
 * @returns {void}
 */
export function recordOriginStream(streams, topic, origin, ord, birth, attachedAt, nowFn) {
	if (typeof ord !== 'number' || typeof origin !== 'number' || typeof birth !== 'number') return;
	let byOrigin = streams.get(topic);
	if (byOrigin === undefined) {
		byOrigin = new Map();
		streams.set(topic, byOrigin);
	}
	const st = byOrigin.get(origin);
	if (st === undefined) {
		if (ord > 1 && birth > attachedAt) {
			// We were already attached when this stream started, so ordinal 1 was
			// owed to us and never came: the prefix below `ord` is missing.
			byOrigin.set(origin, { w: 0, hi: ord, above: new Set([ord]), aboveMax: ord, aboveRanges: [], saturated: false, forgottenFloor: Infinity, holeSince: nowFn() });
		} else {
			// The stream predates our attach (or this IS its head): whatever came
			// before was never ours to receive. Baseline here and track from now on.
			byOrigin.set(origin, { w: ord, hi: ord, above: null, aboveMax: -Infinity, aboveRanges: [], saturated: false, forgottenFloor: Infinity, holeSince: 0 });
		}
		return;
	}
	if (ord > st.hi) st.hi = ord;
	if (ord <= st.w) return; // already covered: a duplicate or a late reorder below the watermark
	if (ord === st.w + 1) {
		st.w = ord;
		if (st.above !== null) {
			// This frame may plug the current hole. Drain both exact retained
			// ordinals and compact delivered ranges until the next real hole.
			for (;;) {
				while (st.above.delete(st.w + 1)) st.w++;
				const range = st.aboveRanges[0];
				if (range === undefined || range[0] !== st.w + 1) break;
				st.w = range[1];
				st.aboveRanges.shift();
			}
			if (st.above.size === 0 && st.aboveRanges.length === 0) {
				// Nothing known is outstanding, so resume from everything that has
				// actually arrived. This equals `hi` while the bounded summaries cover
				// the window; assigning it explicitly preserves the lower-bound policy
				// after both retention bounds have been exceeded.
				st.above = null;
				st.aboveMax = -Infinity;
				st.aboveRanges.length = 0;
				st.saturated = false;
				st.forgottenFloor = Infinity;
				st.holeSince = 0;
				st.w = st.hi;
			} else {
				if (st.above.size === 0) st.aboveMax = -Infinity;
				// Anything still buffered sits behind a DIFFERENT hole, which only
				// became the blocking one just now: its age starts here, not at the
				// closed one's. Dating it from the older hole would confirm it early
				// enough to call a frame still in flight lost.
				st.holeSince = nowFn();
			}
		}
		return;
	}
	// A higher ordinal with at least one missing below it.
	// The two cache resets here are DEFENSIVE, not load-bearing: every path that
	// nulls `above` already resets them, so `above === null` implies the cache is
	// clean. Deleting them leaves the suite green, and that is expected rather than
	// a coverage hole - they exist so the invariant holds locally instead of by an
	// argument about three other call sites.
	if (st.above === null) { st.above = new Set(); st.aboveMax = -Infinity; st.aboveRanges.length = 0; st.saturated = false; st.forgottenFloor = Infinity; }
	if (st.holeSince === 0) st.holeSince = nowFn();
	// The buffer keeps the N SMALLEST ordinals seen above the hole, because the
	// report boundary is the LOWEST arrival above it - everything between the
	// watermark and that lowest arrival is what never came. Simply dropping
	// arrivals once the buffer is full would leave a larger ordinal defining the
	// boundary while a smaller one that DID arrive went unrecorded, and the report
	// would then name delivered frames as lost: with a reorder deeper than the cap
	// and the high block first, one lost frame was reported as 98 and
	// `relay_gap_frames_total` incremented by 98.
	//
	// The scan is bounded by the cap and only runs on an already-damaged stream
	// that has exceeded it. The watermark is deliberately NOT moved here - that
	// would swallow the very frame we are waiting for if it arrives late.
	if (st.above.has(ord) || aboveRangesContain(st.aboveRanges, ord)) return;
	if (st.above.size < MAX_PENDING_ABOVE) {
		st.above.add(ord);
		if (ord > st.aboveMax) st.aboveMax = ord;
	} else if (ord < st.aboveMax) {
		// ORDER OF THE TWO TESTS IS A PERFORMANCE DECISION, not a semantic one - the
		// branch is entered on the same inputs either way. The numeric compare goes
		// first because it rejects the common post-drop shape (a stream still
		// arriving in order behind one missing frame, where every ordinal is above
		// the maximum) in one comparison. Putting the Set lookup first walks the
		// 64-entry buffer on every relayed frame for as long as the hole stays
		// open, which measured +126% against the previous policy.
		//
		// The duplicate test itself is load-bearing wherever it sits: re-adding a
		// value the buffer already holds would still evict the maximum, shrinking
		// the set by one and forgetting an ordinal that ARRIVED - the drain would
		// later stop on it and report it lost, which is the very class this
		// retention exists to close. Duplicate re-delivery is expected input here.
		//
		// The maximum is CACHED rather than rescanned per arrival; rescanning made
		// the same shape ~10x more expensive per relayed frame.
		const evicted = st.aboveMax;
		st.above.delete(evicted);
		st.above.add(ord);
		let m = -Infinity;
		for (const s of st.above) if (s > m) m = s;
		st.aboveMax = m;
		{ const forgot = retainAboveRange(st.aboveRanges, evicted); if (forgot) { st.saturated = true; if (forgot < st.forgottenFloor) st.forgottenFloor = forgot; } }
	} else {
		// Compact every delivered ordinal outside the exact buffer. Remembering
		// only the old scalar minimum prevented one false positive, but closing an
		// earlier reorder then erased a genuine later loss
		// (1,3..66,68..80,2 silently skipped 67).
		{ const forgot = retainAboveRange(st.aboveRanges, ord); if (forgot) { st.saturated = true; if (forgot < st.forgottenFloor) st.forgottenFloor = forgot; } }
	}
}

/**
 * Take every hole that has now outlived the grace, reporting each exactly once.
 *
 * DRAINING, not projecting: a reported hole is consumed, and the stream
 * re-baselines at the highest ordinal that has ARRIVED and resumes clean
 * tracking. So one lost frame yields one report rather than a state the worker
 * restates on every tick forever, a later loss on the same stream is reported as
 * its own event, and nothing accumulates - the buffer is released at the report.
 *
 * While retention has forgotten nothing (the exact buffer plus the compact
 * ranges record every arrival above the watermark), EVERY hole in the coverage
 * is certain and every one is eventually reported - but each on its OWN grace.
 * Only the blocking hole has an age (`holeSince` dates the first), so the
 * drain is staged: it reports the aged first hole, consumes exactly the first
 * covered run, and re-ages, and the next drain confirms the next hole once it
 * has itself persisted. A buffer holding [3,4,7,8] over watermark 1 reports
 * the loss of 2 now and the loss of 5,6 one grace later, so `count` sums to
 * real proven loss without ever confirming a frame still inside its reorder
 * window on an older hole's clock. Once retention has forgotten a delivered
 * ordinal (`saturated`), absence stops meaning loss at and above the lowest
 * forgotten arrival: the report falls back to the first hole clamped below
 * that floor - a partial drain can have advanced the watermark past forgotten
 * ARRIVALS, so even the lowest retained arrival can sit above delivered
 * frames - and the window above re-baselines silently, the documented
 * lower-bound trade. Reporting a forgotten arrival as lost could restart a
 * healthy worker.
 *
 * Each entry names what was lost (`topic`, the `origin` that sent it, and the
 * missing ordinal range), which is the whole of the finding: the worker calling
 * this IS the worker that lost the frames. Nothing here is compared against
 * another worker, so a dead origin's stream, a late joiner's missing prefix, and
 * a restarted worker's empty map are all simply absent from the report rather
 * than a disagreement to resolve.
 *
 * @param {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, saturated: boolean, forgottenFloor: number, holeSince: number }>>} streams
 * @param {number} nowMs - process-monotonic reading
 * @param {number} graceMs - see GAP_CONFIRM_MS
 * @returns {{ topic: string, origin: number, from: number, to: number, count: number }[]}
 */
export function takeConfirmedGaps(streams, nowMs, graceMs) {
	/** @type {{ topic: string, origin: number, from: number, to: number, count: number }[]} */
	const gaps = [];
	for (const [topic, byOrigin] of streams) {
		for (const [origin, st] of byOrigin) {
			if (st.holeSince === 0 || nowMs - st.holeSince < graceMs) continue;
			if (st.saturated) {
				// Retention forgot at least one DELIVERED ordinal. Absence stops
				// meaning loss at and above the lowest forgotten ordinal: a
				// partial drain can have advanced the watermark past forgotten
				// arrivals, after which even the lowest retained arrival sits
				// above delivered frames the tracker no longer knows about. So
				// report only the first hole, clamped below the forgotten floor;
				// anything wider would risk naming delivered frames as lost, and
				// a report can restart a worker under RESTART_ON_STATE_DIVERGENCE.
				let lowestAbove = Infinity;
				for (const s of st.above) if (s < lowestAbove) lowestAbove = s;
				const from = st.w + 1;
				const lowestRanged = st.aboveRanges.length === 0 ? Infinity : st.aboveRanges[0][0];
				// The boundary is the lowest ARRIVAL above the hole - exact-buffer
				// minimum or first compact range - further clamped by the lowest
				// FORGOTTEN arrival, which bounds what absence can still prove.
				const to = Math.min(lowestAbove, lowestRanged, st.forgottenFloor) - 1;
				// `to < from` means everything between the watermark and the
				// boundary either ARRIVED or can no longer be judged. There is
				// nothing to report, and an inverted or zero-width range must
				// never be emitted: consumers read `count` into
				// relay_gap_frames_total and a `[from, to]` span into an
				// operator-facing log line.
				if (to >= from) gaps.push({ topic, origin, from, to, count: to - from + 1 });
				// The window above the report is unknowable; re-baseline at the
				// highest arrival, exactly the documented lower-bound trade.
				st.w = st.hi;
				st.above = null;
				st.aboveMax = -Infinity;
				st.aboveRanges.length = 0;
				st.saturated = false;
				st.forgottenFloor = Infinity;
				st.holeSince = 0;
			} else {
				// Retention is a complete record of every arrival above the
				// watermark, so every uncovered run below the coverage frontier is
				// certainly lost - but only the BLOCKING hole has outlived the
				// grace. A later hole has no age of its own (holeSince dates the
				// first), and confirming it with the first hole's clock would call
				// a frame still inside its reorder window lost. So the drain is
				// STAGED: report the aged first hole, consume exactly the first
				// covered run, and re-age - each further hole earns its own grace
				// on a later drain, the same rule the record path applies when a
				// drain exposes the next hole. A buffer holding [3,4,7,8] over
				// watermark 1 therefore reports the loss of 2 now and the loss of
				// 5,6 one grace later, and `count` still sums to real proven loss.
				const exact = st.above === null ? [] : Array.from(st.above).sort((a, b) => a - b);
				const ranges = st.aboveRanges;
				// The first covered run: start at the lowest arrival and extend
				// while the next item (exact ordinal or range, whichever is lower;
				// the two are disjoint by construction) stays contiguous.
				let e = 0;
				let r = 0;
				let runEnd = -Infinity;
				let runStart = Infinity;
				while (e < exact.length || r < ranges.length) {
					let lo;
					let hi;
					let fromRange;
					if (r >= ranges.length || (e < exact.length && exact[e] < ranges[r][0])) {
						lo = exact[e];
						hi = exact[e];
						fromRange = false;
					} else {
						lo = ranges[r][0];
						hi = ranges[r][1];
						fromRange = true;
					}
					if (runEnd === -Infinity) {
						runStart = lo;
						runEnd = hi;
					} else if (lo <= runEnd + 1) {
						if (hi > runEnd) runEnd = hi;
					} else {
						break;
					}
					if (fromRange) r++;
					else e++;
				}
				// The blocking hole is [w+1, runStart-1]; a hole is open, so the
				// lowest arrival sits at least two above the watermark.
				gaps.push({ topic, origin, from: st.w + 1, to: runStart - 1, count: runStart - 1 - st.w });
				// Consume the reported hole and its bounding run; keep everything
				// above for its own drain.
				st.w = runEnd;
				if (st.above !== null) for (const s of Array.from(st.above)) { if (s <= runEnd) st.above.delete(s); }
				while (st.aboveRanges.length > 0 && st.aboveRanges[0][1] <= runEnd) st.aboveRanges.shift();
				if ((st.above === null || st.above.size === 0) && st.aboveRanges.length === 0) {
					// Nothing remains above: the stream is clean from the highest
					// arrival, which the consumed run necessarily ended at.
					st.w = st.hi;
					st.above = null;
					st.aboveMax = -Infinity;
					st.saturated = false;
					st.forgottenFloor = Infinity;
					st.holeSince = 0;
				} else {
					// The next hole becomes the blocking one only now, so its age
					// starts now - never at the reported hole's open instant.
					if (st.above !== null && st.above.size === 0) st.aboveMax = -Infinity;
					st.holeSince = nowMs;
				}
			}
		}
	}
	return gaps;
}

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
 * Topics that have been published through a `shared: true` wire codec, mapped to the
 * codec's capability. A topic enters on its FIRST shared publish (which also
 * migrates the topic's current subscribers into cohorts); the subscribe path reads
 * this so a LATER joiner of an already-shared topic is dual-subscribed into the right
 * cohort at subscribe time, and the close path reads it to release each shared
 * topic's wire-id reference. Per worker (one process/worker per module instance),
 * which is all the single-instance fan-out needs: a client only ever talks to its
 * home worker, so each worker's cohort topics + wire-ids are self-consistent.
 * @type {Map<string, string>}
 */
export const sharedTopics = new Map();

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
