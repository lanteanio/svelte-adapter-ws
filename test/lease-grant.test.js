// The send-gate window sizer in isolation. leaseGrantSize is pure - the
// caller supplies the live readings - so these cases pin the calibration
// (the 0.7 heap gate against the memory-wall ratio, the 25 subscriber gate,
// the 0.05 scale clamp, the floor) that wire.js documents as pinned here.

import { describe, expect, it } from 'vitest';
import { leaseGrantSize, DEFAULT_GRANT } from '../src/runtime/wire.js';

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
		// The window is base * (1 - heapRatio): heap headroom IS the scale.
		expect(mild).toBe(Math.round(BASE * 0.25));
		expect(deep).toBe(Math.round(BASE * 0.05));
	});

	it('scales by 25/ratio past the subscriber gate', () => {
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 50 })).toBe(BASE / 2);
		expect(leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 100 })).toBe(BASE / 4);
	});

	it('multiplies combined pressure below either single axis', () => {
		const heapOnly = leaseGrantSize({ heapRatio: 0.8, subscriberRatio: 1 });
		const subsOnly = leaseGrantSize({ heapRatio: 0.2, subscriberRatio: 50 });
		const both = leaseGrantSize({ heapRatio: 0.8, subscriberRatio: 50 });
		expect(both).toBe(Math.round(BASE * 0.2 * 0.5));
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
