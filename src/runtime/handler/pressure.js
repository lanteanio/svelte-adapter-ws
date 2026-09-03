// The 1 Hz pressure sampler behind `platform.pressure`, `platform.onPressure`
// and `platform.onPublishRate`. Reads the window counters the publish paths
// bump, folds the bounded backpressure walk and the kernel signals, and
// mutates the ONE stable snapshot object in place. Listeners fire only on a
// `reason` transition, at most once per tick.

import { createMemoryWallReader } from '../utils/memory-wall.js';
import { createOsPressureSampler } from '../utils/os-pressure.js';
import { applyCapacityReason, computePressureReason, computeTopPublishers } from '../utils/pressure.js';
import { samplePressureValue } from '../wire.js';
import {
	foldConnectionBackpressure, takeBackpressureDropWindow,
	BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES
} from '../utils/backpressure.js';
import { setIntervalTimer, clearIntervalTimer, wallEpoch } from '../runtime.js';
import { emitOperationalEvent } from '../diagnostic.js';
import {
	counters, pressureListeners, pressureSnapshot, publishRateListeners,
	topicPublishStats, wsConnections
} from './state.js';

/**
 * Default pressure thresholds. Designed to be safe rather than tight: no
 * false positives in the steady state of a healthy small app. Overridden
 * per-deployment via the `pressure` field on the WebSocket options; any
 * threshold may be `false` to disable that signal.
 */
export const DEFAULT_PRESSURE_THRESHOLDS = {
	memoryHeapUsedRatio: 0.85,
	publishRatePerSec: 10000,
	subscriberRatio: 50,
	sampleIntervalMs: 1000,
	topicPublishRatePerSec: 5000,
	topicPublishBytesPerSec: 10 * 1024 * 1024,
	psiCpuSome: 60,
	psiMemoryFull: 15,
	psiIoFull: 50,
	cpuThrottledRatio: 0.25
};

/**
 * Merge configured thresholds over the defaults. Shapes were validated at
 * build time (config-guards); an interval under 100ms is clamped to the
 * default so a typo cannot spin the sampler hot.
 *
 * @param {Record<string, unknown> | undefined} opts
 */
export function normalizePressureThresholds(opts) {
	const merged = { ...DEFAULT_PRESSURE_THRESHOLDS, ...(opts && typeof opts === 'object' ? opts : {}) };
	if (typeof merged.sampleIntervalMs !== 'number' || !(merged.sampleIntervalMs >= 100)) {
		merged.sampleIntervalMs = DEFAULT_PRESSURE_THRESHOLDS.sampleIntervalMs;
	}
	return merged;
}

const memoryWall = createMemoryWallReader();
const osPressure = createOsPressureSampler();


/**
 * Sample once: fold the counters into the snapshot, fire listeners on a
 * reason transition. Exported so tests drive samples without real timers.
 *
 * @param {ReturnType<typeof normalizePressureThresholds>} thresholds
 */
export function samplePressureOnce(thresholds) {
	const interval = thresholds.sampleIntervalMs / 1000;
	// Retained before the window is drained: the metrics hook below runs after
	// this fold and cannot read a counter the fold zeroes as it reads it.
	const publishCount = counters.publishCountWindow;
	counters.lastPublishCount = publishCount;
	const publishRate = interval > 0 ? publishCount / interval : 0;
	counters.publishCountWindow = 0;

	// Publish-egress figures for the window just closed, drained exactly like
	// the publish count above: read into the snapshot, then zeroed so the next
	// window starts fresh. One stable nested object, mutated in place.
	pressureSnapshot.egress.deliveries = counters.egressDeliveriesWindow;
	pressureSnapshot.egress.bytes = counters.egressBytesWindow;
	pressureSnapshot.egress.refusedTopic = counters.egressRefusedTopicWindow;
	pressureSnapshot.egress.refusedTenant = counters.egressRefusedTenantWindow;
	counters.egressDeliveriesWindow = 0;
	counters.egressBytesWindow = 0;
	counters.egressRefusedTopicWindow = 0;
	counters.egressRefusedTenantWindow = 0;

	const connections = wsConnections.size;
	counters.lastConnections = connections;
	const subscriberRatio = connections > 0 ? counters.totalSubscriptions / connections : 0;

	const { maxBufferedBytes, backpressuredConnections } = foldConnectionBackpressure(
		/** @type {any} */ (wsConnections), BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES
	);
	const { droppedFrames, droppedBytes } = takeBackpressureDropWindow(counters);
	// The shed window is consumed by the call above, so the cumulative counters
	// the metrics hook advances have to read it from here.
	counters.lastDroppedFrames = droppedFrames;
	counters.lastDroppedBytes = droppedBytes;

	const mem = process.memoryUsage();
	// Distance to the nearest memory WALL, not arena fullness: heapUsed
	// against the V8 limit, rss against the cgroup limit - the kernel's OOM
	// killer charges the whole resident set, never the JS heap alone.
	const heapUsedRatio = memoryWall.ratio(mem);
	const memoryMB = mem.rss / (1024 * 1024);
	counters.lastHeapUsedRatio = heapUsedRatio;
	counters.lastResidentBytes = mem.rss;

	const os = osPressure.sample(thresholds.sampleIntervalMs);
	/** @type {any} */
	const sampleReadings = { heapUsedRatio, publishRate, subscriberRatio };
	if (os.psi !== null) {
		sampleReadings.psiCpuSome10 = os.psi.cpuSome10;
		sampleReadings.psiMemoryFull10 = os.psi.memoryFull10;
		sampleReadings.psiIoFull10 = os.psi.ioFull10;
	}
	if (os.cpuThrottle !== null) {
		sampleReadings.cpuThrottledRatio = os.cpuThrottle.throttledRatio;
	}

	const { topPublishers, overThreshold } = computeTopPublishers(topicPublishStats, interval, thresholds);
	topicPublishStats.clear();

	const reason = computePressureReason(sampleReadings, thresholds);
	counters.lastBasePressureReason = reason;
	// Layer the protection posture's CAPACITY reason on top of the pure
	// pressure reason. With no posture engaged this is the base reason
	// unchanged. The level read here is the one the gate enforced across the
	// window just measured; the posture advances for the NEXT sample below.
	const effectiveReason = counters.activePosture !== null
		? applyCapacityReason(reason, counters.activePosture.level)
		: reason;
	const value = samplePressureValue(sampleReadings, thresholds, counters.leaseSaturationPeak);
	// Halved per tick with a floor: an asymptotic decay would keep a once-
	// saturated worker reading a nonzero value for a thousand quiet ticks.
	counters.leaseSaturationPeak = counters.leaseSaturationPeak < 0.002 ? 0 : counters.leaseSaturationPeak * 0.5;

	const previousReason = pressureSnapshot.reason;
	const transitioned = effectiveReason !== previousReason;
	// Stamp the fold as complete before anything publishes it, so the freshness
	// gauge dates the sample it is exported with rather than the previous one.
	counters.lastSampleWallMs = wallEpoch();
	pressureSnapshot.sampledAt = counters.lastSampleWallMs;
	pressureSnapshot.value = value;
	pressureSnapshot.subscriberRatio = subscriberRatio;
	pressureSnapshot.publishRate = publishRate;
	pressureSnapshot.memoryMB = memoryMB;
	pressureSnapshot.reason = effectiveReason;
	pressureSnapshot.active = effectiveReason !== 'NONE';
	pressureSnapshot.psi = os.psi;
	pressureSnapshot.cpuThrottle = os.cpuThrottle;
	pressureSnapshot.maxBufferedBytes = maxBufferedBytes;
	pressureSnapshot.backpressuredConnections = backpressuredConnections;
	pressureSnapshot.droppedFrames = droppedFrames;
	pressureSnapshot.droppedBytes = droppedBytes;
	pressureSnapshot.topPublishers = topPublishers;

	// Advance the posture once per sample, AFTER folding the snapshot - the
	// level just read drove this sample's reason; the tick decides the next.
	// It rides this timer, so no second one is introduced. The posture must
	// read the BASE pressure signal, never the CAPACITY-layered one: once the
	// level is engaged `effectiveReason` is CAPACITY every sample, so feeding
	// the layered activity back would mean the relaxation dwell never sees a
	// calm sample and the level could never come down.
	if (counters.activePosture !== null) counters.activePosture.tick({ active: reason !== 'NONE' });

	// Sample the registry gauges on the same cadence. Null unless a metrics
	// registry is configured, so the zero-config sampler is unchanged. This is
	// the ONLY driver for every sampled gauge the signal manifest declares
	// required, so it runs on the live fold above, never on a second timer.
	if (counters.metricsSampleHook !== null) {
		counters.metricsSampleHook({
			transition: transitioned ? { from: previousReason, to: effectiveReason } : null,
			os
		});
	}

	// Push the posture line to export subscribers on the same cadence - the
	// 1 Hz heartbeat is the export contract, and silence means the adapter is
	// gone. Null unless a posture export is configured.
	if (counters.postureExportHook !== null) counters.postureExportHook();

	// Snapshot the listener sets before iterating: a Set iterator visits
	// entries added during iteration, so a re-arming listener could spin the
	// tick forever.
	if (transitioned) {
		for (const listener of [...pressureListeners]) {
			try { listener(pressureSnapshot); } catch { /* listener owns its errors */ }
		}
	}
	// The runaway-publisher alarm, not a firehose: listeners fire only when a
	// topic crossed one of the configured per-topic thresholds, and receive
	// exactly the offenders.
	if (publishRateListeners.size > 0 && overThreshold.length > 0) {
		for (const listener of [...publishRateListeners]) {
			try { listener(overThreshold); } catch { /* listener owns its errors */ }
		}
	} else if (overThreshold.length > 0) {
		// No listener to hand the offenders to: report the condition on the
		// diagnostic pipeline instead, latched per topic so a sustained runaway
		// prints one line at the crossing. The latch re-arms only after the
		// topic stays below the threshold for a full dwell of samples - a
		// publisher oscillating around the threshold must not print a line
		// every other tick.
		for (const offender of overThreshold) {
			if (alarmedRunawayTopics.has(offender.topic)) {
				alarmedRunawayTopics.set(offender.topic, 0);
				continue;
			}
			alarmedRunawayTopics.set(offender.topic, 0);
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.pressure',
				event: 'pressure.runaway-publisher',
				severity: 'warn',
				// Topic names commonly embed user or session identifiers.
				dataClass: 'pseudonymous',
				message: 'A publisher crossed a configured per-topic pressure threshold.',
				attributes: {
					topic: offender.topic,
					messagesPerSec: offender.messagesPerSec,
					bytesPerSec: offender.bytesPerSec
				}
			});
		}
	}
	if (alarmedRunawayTopics.size > 0) {
		const stillOver = new Set(overThreshold.map((entry) => entry.topic));
		for (const [topic, belowTicks] of alarmedRunawayTopics) {
			if (stillOver.has(topic)) continue;
			if (belowTicks + 1 >= RUNAWAY_REARM_TICKS) alarmedRunawayTopics.delete(topic);
			else alarmedRunawayTopics.set(topic, belowTicks + 1);
		}
	}
}

// One quiet minute at the 1 Hz default cadence before a topic may alarm again.
const RUNAWAY_REARM_TICKS = 60;

/**
 * Topics latched by the no-listener runaway alarm, each with its count of
 * consecutive below-threshold samples toward re-arming.
 * @type {Map<string, number>}
 */
const alarmedRunawayTopics = new Map();

/** @type {any} */
let samplerTimer = null;

/**
 * Start the sampler. Idempotent; the timer never holds the loop open.
 * @param {Record<string, unknown> | undefined} pressureOptions
 */
export function startPressureSampler(pressureOptions) {
	if (samplerTimer !== null) return;
	const thresholds = normalizePressureThresholds(pressureOptions);
	samplerTimer = setIntervalTimer(() => samplePressureOnce(thresholds), thresholds.sampleIntervalMs);
	if (typeof samplerTimer?.unref === 'function') samplerTimer.unref();
}

/** Stop the sampler (shutdown, test teardown). Safe when never started. */
export function stopPressureSampler() {
	if (samplerTimer !== null) {
		clearIntervalTimer(samplerTimer);
		samplerTimer = null;
	}
}
