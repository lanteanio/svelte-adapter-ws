// The 1 Hz pressure sampler behind `platform.pressure`, `platform.onPressure`
// and `platform.onPublishRate`. Reads the window counters the publish paths
// bump, folds the bounded backpressure walk and the kernel signals, and
// mutates the ONE stable snapshot object in place. Listeners fire only on a
// `reason` transition, at most once per tick.

import { createMemoryWallReader } from '../utils/memory-wall.js';
import { createOsPressureSampler } from '../utils/os-pressure.js';
import { computePressureReason, computeTopPublishers } from '../utils/pressure.js';
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

/** Whether the per-topic bump is armed (both topic thresholds off skips it). */
let topicTrackingOn = true;

/**
 * Hot-path bump for one publish: the window counter always, the per-topic
 * stats only while a topic threshold is armed.
 *
 * @param {string} topic
 * @param {number} bytes
 */
export function notePublish(topic, bytes) {
	counters.publishCountWindow++;
	if (!topicTrackingOn) return;
	const entry = topicPublishStats.get(topic);
	if (entry) {
		entry.m++;
		entry.b += bytes;
	} else {
		topicPublishStats.set(topic, { m: 1, b: bytes });
	}
}

/**
 * Sample once: fold the counters into the snapshot, fire listeners on a
 * reason transition. Exported so tests drive samples without real timers.
 *
 * @param {ReturnType<typeof normalizePressureThresholds>} thresholds
 */
export function samplePressureOnce(thresholds) {
	const interval = thresholds.sampleIntervalMs / 1000;
	const publishRate = interval > 0 ? counters.publishCountWindow / interval : 0;
	counters.publishCountWindow = 0;

	const connections = wsConnections.size;
	const subscriberRatio = connections > 0 ? counters.totalSubscriptions / connections : 0;

	const { maxBufferedBytes, backpressuredConnections } = foldConnectionBackpressure(
		/** @type {any} */ (wsConnections), BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES
	);
	const { droppedFrames, droppedBytes } = takeBackpressureDropWindow(counters);

	const mem = process.memoryUsage();
	// Distance to the nearest memory WALL, not arena fullness: heapUsed
	// against the V8 limit, rss against the cgroup limit - the kernel's OOM
	// killer charges the whole resident set, never the JS heap alone.
	const heapUsedRatio = memoryWall.ratio(mem);
	const memoryMB = mem.rss / (1024 * 1024);
	counters.lastHeapUsedRatio = heapUsedRatio;

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
	const value = samplePressureValue(sampleReadings, thresholds, counters.leaseSaturationPeak);
	// Halved per tick with a floor: an asymptotic decay would keep a once-
	// saturated worker reading a nonzero value for a thousand quiet ticks.
	counters.leaseSaturationPeak = counters.leaseSaturationPeak < 0.002 ? 0 : counters.leaseSaturationPeak * 0.5;

	const previousReason = pressureSnapshot.reason;
	const transitioned = reason !== previousReason;
	pressureSnapshot.sampledAt = wallEpoch();
	pressureSnapshot.value = value;
	pressureSnapshot.subscriberRatio = subscriberRatio;
	pressureSnapshot.publishRate = publishRate;
	pressureSnapshot.memoryMB = memoryMB;
	pressureSnapshot.reason = reason;
	pressureSnapshot.active = reason !== 'NONE';
	pressureSnapshot.psi = os.psi;
	pressureSnapshot.cpuThrottle = os.cpuThrottle;
	pressureSnapshot.maxBufferedBytes = maxBufferedBytes;
	pressureSnapshot.backpressuredConnections = backpressuredConnections;
	pressureSnapshot.droppedFrames = droppedFrames;
	pressureSnapshot.droppedBytes = droppedBytes;
	pressureSnapshot.topPublishers = topPublishers;

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
		// prints one line at the crossing, re-armed once it falls back below.
		for (const offender of overThreshold) {
			if (alarmedRunawayTopics.has(offender.topic)) continue;
			alarmedRunawayTopics.add(offender.topic);
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.pressure',
				event: 'pressure.runaway-publisher',
				severity: 'warn',
				dataClass: 'none',
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
		for (const topic of alarmedRunawayTopics) {
			if (!stillOver.has(topic)) alarmedRunawayTopics.delete(topic);
		}
	}
}

/** Topics currently latched by the no-listener runaway alarm. @type {Set<string>} */
const alarmedRunawayTopics = new Set();

/** @type {any} */
let samplerTimer = null;

/**
 * Start the sampler. Idempotent; the timer never holds the loop open.
 * @param {Record<string, unknown> | undefined} pressureOptions
 */
export function startPressureSampler(pressureOptions) {
	if (samplerTimer !== null) return;
	const thresholds = normalizePressureThresholds(pressureOptions);
	topicTrackingOn = thresholds.topicPublishRatePerSec !== false || thresholds.topicPublishBytesPerSec !== false;
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
