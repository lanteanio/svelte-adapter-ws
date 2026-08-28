// The pressure sampler against synthetic state: threshold reasons, listener
// transition semantics, the drop window, and the live snapshot identity.

import { describe, expect, it, beforeEach } from 'vitest';
import {
	DEFAULT_PRESSURE_THRESHOLDS, normalizePressureThresholds, notePublish, samplePressureOnce
} from '../src/runtime/handler/pressure.js';
import {
	counters, pressureListeners, pressureSnapshot, publishRateListeners, topicPublishStats
} from '../src/runtime/handler/state.js';
import { recordBackpressureDrop } from '../src/runtime/utils/backpressure.js';

/** Reset the sampler-facing state between cases. */
beforeEach(() => {
	counters.publishCountWindow = 0;
	counters.totalSubscriptions = 0;
	counters.leaseSaturationPeak = 0;
	counters.droppedFramesWindow = 0;
	counters.droppedBytesWindow = 0;
	topicPublishStats.clear();
	pressureListeners.clear();
	publishRateListeners.clear();
	pressureSnapshot.reason = 'NONE';
	pressureSnapshot.active = false;
});

const thresholds = normalizePressureThresholds(undefined);

describe('normalizePressureThresholds', () => {
	it('merges over the family defaults and clamps a hot interval', () => {
		expect(normalizePressureThresholds(undefined)).toEqual(DEFAULT_PRESSURE_THRESHOLDS);
		const custom = normalizePressureThresholds({ publishRatePerSec: 500, sampleIntervalMs: 5 });
		expect(custom.publishRatePerSec).toBe(500);
		expect(custom.sampleIntervalMs).toBe(DEFAULT_PRESSURE_THRESHOLDS.sampleIntervalMs);
		expect(custom.subscriberRatio).toBe(50);
	});
});

describe('samplePressureOnce', () => {
	it('stamps sampledAt and reads NONE on a healthy worker', () => {
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.sampledAt).not.toBeNull();
		expect(pressureSnapshot.reason).toBe('NONE');
		expect(pressureSnapshot.active).toBe(false);
	});

	it('fires PUBLISH_RATE at the threshold and resets the window', () => {
		for (let i = 0; i < DEFAULT_PRESSURE_THRESHOLDS.publishRatePerSec; i++) notePublish('t', 10);
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.reason).toBe('PUBLISH_RATE');
		expect(pressureSnapshot.active).toBe(true);
		expect(pressureSnapshot.publishRate).toBe(DEFAULT_PRESSURE_THRESHOLDS.publishRatePerSec);
		// The window zeroes: the next quiet sample relaxes.
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.reason).toBe('NONE');
	});

	it('drains the exact drop window into the snapshot', () => {
		recordBackpressureDrop(counters, { byteLength: 1000 });
		recordBackpressureDrop(counters, { byteLength: 24 });
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.droppedFrames).toBe(2);
		expect(pressureSnapshot.droppedBytes).toBe(1024);
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.droppedFrames).toBe(0);
	});

	it('ranks top publishers by rate and clears the per-topic window', () => {
		for (let i = 0; i < 30; i++) notePublish('hot', 100);
		for (let i = 0; i < 5; i++) notePublish('warm', 100);
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.topPublishers[0].topic).toBe('hot');
		expect(pressureSnapshot.topPublishers[0].messagesPerSec).toBe(30);
		expect(topicPublishStats.size).toBe(0);
	});

	it('fires onPressure listeners only on a reason TRANSITION', () => {
		const seen = [];
		pressureListeners.add((snapshot) => seen.push(snapshot.reason));
		samplePressureOnce(thresholds); // NONE -> NONE: no fire
		expect(seen).toEqual([]);
		for (let i = 0; i < DEFAULT_PRESSURE_THRESHOLDS.publishRatePerSec; i++) notePublish('t', 10);
		samplePressureOnce(thresholds); // NONE -> PUBLISH_RATE
		samplePressureOnce(thresholds); // PUBLISH_RATE -> NONE
		samplePressureOnce(thresholds); // NONE -> NONE: no fire
		expect(seen).toEqual(['PUBLISH_RATE', 'NONE']);
	});

	it('reports a runaway publisher when nobody listens, latched per topic', () => {
		const topicThresholds = normalizePressureThresholds({ topicPublishRatePerSec: 50 });
		/** @type {string[]} */
		const warned = [];
		const originalWarn = console.warn;
		console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
		try {
			const drive = (topic) => {
				for (let i = 0; i < 500; i++) notePublish(topic, 10);
				samplePressureOnce(topicThresholds);
			};
			const runaway = () => warned.filter((line) => line.includes('pressure.runaway-publisher'));

			drive('runaway-a');
			expect(runaway().length).toBe(1);
			expect(runaway()[0]).toContain('runaway-a');

			// Still over on the next sample: latched, no second line.
			drive('runaway-a');
			expect(runaway().length).toBe(1);

			// A dip shorter than the re-arm dwell does not reset the latch.
			samplePressureOnce(topicThresholds);
			drive('runaway-a');
			expect(runaway().length).toBe(1);

			// With a listener registered the diagnostic line is suppressed
			// entirely - the offenders go to the listener instead.
			const seen = [];
			const listener = (offenders) => seen.push(offenders.map((o) => o.topic));
			publishRateListeners.add(listener);
			drive('runaway-b');
			publishRateListeners.delete(listener);
			expect(seen.flat()).toContain('runaway-b');
			expect(runaway().some((line) => line.includes('runaway-b'))).toBe(false);
		} finally {
			console.warn = originalWarn;
		}
	});

	it('folds the lease saturation peak into value and decays it', () => {
		counters.leaseSaturationPeak = 1;
		samplePressureOnce(thresholds);
		expect(pressureSnapshot.value).toBe(1);
		expect(counters.leaseSaturationPeak).toBe(0.5);
	});

	it('returns the LIVE snapshot object identity from consecutive samples', () => {
		const before = pressureSnapshot;
		samplePressureOnce(thresholds);
		expect(pressureSnapshot).toBe(before);
	});
});
