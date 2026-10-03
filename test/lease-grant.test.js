// The send-gate window sizer in isolation. leaseGrantSize is pure - the
// caller supplies the live readings - so these cases pin the calibration
// (the 0.7 heap gate against the memory-wall ratio, the 25 subscriber gate,
// the 0.05 scale clamp, the floor) that wire.js documents as pinned here.

import { describe, expect, it } from 'vitest';
import { leaseGrantSize, DEFAULT_GRANT } from '../src/runtime/wire.js';
import { normalizePressureThresholds } from '../src/runtime/handler/pressure.js';

const BASE = DEFAULT_GRANT.requestCount;

describe('leaseGrantSize', () => {
	it('hands an idle worker the full base window', () => {
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 1 })).toBe(BASE);
		// Both gates are strict: readings AT the threshold are still idle.
		expect(leaseGrantSize({ heapRatio: 0.7, subscriberRatio: 25 })).toBe(BASE);
	});

	it('shrinks the window past the 0.7 heap gate, monotonically with depth', () => {
		const mild = leaseGrantSize({ heapRatio: 0.75, subscriberRatio: 1 });
		const deep = leaseGrantSize({ heapRatio: 0.95, subscriberRatio: 1 });
		expect(mild).toBeLessThan(BASE);
		expect(deep).toBeLessThan(mild);
		// Above the knee the scale is the headroom left over the headroom the
		// knee had, (1 - heapRatio) / (1 - 0.7): full at the knee, linear to
		// the wall.
		expect(mild).toBe(Math.round(BASE * (0.25 / 0.3)));
		expect(deep).toBe(Math.round(BASE * (0.05 / 0.3)));
	});

	it('narrows along a ramp, never in a step', () => {
		// A step at the knee handed out the full window at one reading and under
		// a third of it a hair above, which no client pacing can follow. Across
		// the whole range a thousandth of a ratio moves the window by at most
		// what the ramp's slope allows, and never upward.
		let previous = leaseGrantSize({ heapRatio: 0, subscriberRatio: 1 });
		const slope = Math.ceil((BASE * 0.001) / 0.3) + 1;
		for (let i = 1; i <= 1000; i++) {
			const window = leaseGrantSize({ heapRatio: i / 1000, subscriberRatio: 1 });
			expect(window, `at ${i / 1000}`).toBeLessThanOrEqual(previous);
			expect(previous - window, `step at ${i / 1000}`).toBeLessThanOrEqual(slope);
			previous = window;
		}
		expect(leaseGrantSize({ heapRatio: 0.7, subscriberRatio: 1 }), 'full at the knee').toBe(BASE);
	});

	it('has narrowed to half the base by the time the shipped MEMORY threshold fires', () => {
		// The ramp starts before the alarm and is halfway down when it fires, so
		// the band where windows are smaller while the surface still reads NONE
		// is bounded. Read from the shipped defaults: moving either number
		// moves this.
		const threshold = /** @type {number} */ (normalizePressureThresholds(undefined).memoryHeapUsedRatio);
		expect(leaseGrantSize({ heapRatio: threshold, subscriberRatio: 1 })).toBe(Math.round(BASE / 2));
	});

	it('scales by 25/ratio past the subscriber gate', () => {
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 50 })).toBe(BASE / 2);
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 100 })).toBe(BASE / 4);
	});

	it('multiplies combined pressure below either single axis', () => {
		const heapOnly = leaseGrantSize({ heapRatio: 0.8, subscriberRatio: 1 });
		const subsOnly = leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 50 });
		const both = leaseGrantSize({ heapRatio: 0.8, subscriberRatio: 50 });
		expect(both).toBe(Math.round(BASE * (0.2 / 0.3) * 0.5));
		expect(both).toBeLessThan(heapOnly);
		expect(both).toBeLessThan(subsOnly);
	});

	it('never hands out less than the floor under maximal pressure', () => {
		// The scale clamps at 0.05 before the floor applies: against the
		// default base of 256 the clamp alone bottoms out at 13, above the
		// default floor of 8.
		expect(leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 500 })).toBe(13);
		// A base small enough that the clamped window falls under the floor
		// gets exactly the floor.
		expect(leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 500, base: 100 })).toBe(8);
		// A custom floor is honored.
		expect(leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 500, floor: 64 })).toBe(64);
	});

	it('treats non-numeric and negative readings as no pressure', () => {
		expect(leaseGrantSize({ heapRatio: NaN, subscriberRatio: NaN })).toBe(BASE);
		expect(leaseGrantSize({ heapRatio: -1, subscriberRatio: -5 })).toBe(BASE);
		expect(leaseGrantSize(/** @type {any} */ ({ heapRatio: '0.9', subscriberRatio: '50' }))).toBe(BASE);
		expect(leaseGrantSize(/** @type {any} */ ({}))).toBe(BASE);
	});
});
