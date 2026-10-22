// drainCoalesced, the pump behind sendCoalesced: insertion order, the send
// status contract, latest-wins under replacement made during a send, and the
// bound on reentrant work.

import { describe, it, expect, vi } from 'vitest';
import { drainCoalesced } from '../src/runtime/utils/backpressure.js';

describe('drainCoalesced', () => {
	it('drains NaN values without mistaking them for replacements', () => {
		const pending = new Map([['a', NaN]]);
		const values = [];
		drainCoalesced(pending, (value) => { values.push(value); return 1; });
		expect(values).toEqual([NaN]);
		expect(pending.size).toBe(0);
	});

	it('keeps a replacement queued when a send returns backpressure or drop', () => {
		for (const status of [0, 2]) {
			const pending = new Map([['a', 1], ['b', 2]]);
			drainCoalesced(pending, () => { pending.set('a', 3); return status; });
			expect([...pending]).toEqual([['a', 3], ['b', 2]]);
			const values = [];
			drainCoalesced(pending, (value) => { values.push(value); return 1; });
			expect(values).toEqual([3, 2]);
		}
	});

	it('contains nested drains of one map and still drains independent maps', () => {
		const pending = new Map([['a', 1]]);
		const independent = new Map([['b', 2]]);
		const values = [];
		let nested = 0;
		drainCoalesced(pending, (value) => {
			drainCoalesced(pending, () => { nested++; return 1; });
			drainCoalesced(independent, (other) => {
				drainCoalesced(pending, () => { nested++; return 1; });
				values.push(other);
				return 1;
			});
			values.push(value);
			return 1;
		});
		expect(values).toEqual([2, 1]);
		expect(nested).toBe(0);
		expect(pending.size).toBe(0);
	});

	it('yields repeated replacement while still visiting unrelated keys', () => {
		const pending = new Map([['a', 1], ['b', 2]]);
		const visited = [];
		expect(drainCoalesced(pending, (value, key) => {
			visited.push(key);
			if (key === 'a') pending.set(key, value + 1);
			return 1;
		})).toBe(true);
		expect(visited).toEqual(['a', 'a', 'b']);
		expect([...pending]).toEqual([['a', 3]]);
	});

	it('bounds a callback that keeps appending new keys', () => {
		const pending = new Map([['a', 0]]);
		let calls = 0;
		expect(drainCoalesced(pending, (value) => {
			pending.set('next:' + ++calls, value + 1);
			return 1;
		})).toBe(true);
		expect(calls).toBe(2);
		expect([...pending.values()]).toEqual([2]);
	});
	it('releases the active drain after a callback throws', () => {
		const pending = new Map([['a', 1]]);
		expect(() => drainCoalesced(pending, () => { throw new Error('send failed'); })).toThrow('send failed');
		const values = [];
		drainCoalesced(pending, (value) => { values.push(value); return 1; });
		expect(values).toEqual([1]);
		expect(pending.size).toBe(0);
	});

	// uWS send-status contract (see platform.js): 1 = sent clean, 0 = enqueued
	// behind backpressure (accepted, delivered in order, socket now under
	// pressure), 2 = dropped past maxBackpressure. drainCoalesced continues on a
	// clean send and stops on backpressure or drop.
	const SUCCESS = 1;
	const BACKPRESSURE = 0;
	const DROPPED = 2;

	function makeSender(results) {
		const sent = [];
		const queue = results.slice();
		return {
			sent,
			send: (value) => {
				sent.push(value);
				return queue.length ? queue.shift() : SUCCESS;
			}
		};
	}

	it('is a no-op on an empty map', () => {
		const pending = new Map();
		const { sent, send } = makeSender([]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([]);
		expect(pending.size).toBe(0);
	});

	it('sends every entry in insertion order on a clean drain', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, SUCCESS, SUCCESS]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2, 3]);
		expect(pending.size).toBe(0);
	});

	it('preserves the original slot when a key is overwritten', () => {
		// Reproduces the latest-wins, order-stable contract: setting an existing
		// key replaces the value but keeps the slot. A user calling sendCoalesced
		// rapid-fire on the same key never reorders the rest of the queue.
		const pending = new Map();
		pending.set('a', 1);
		pending.set('b', 2);
		pending.set('a', 99);
		const { sent, send } = makeSender([SUCCESS, SUCCESS]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([99, 2]);
	});

	it('stops on DROPPED and leaves the entry in the map for retry', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, DROPPED]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2]);
		expect([...pending]).toEqual([
			['b', 2],
			['c', 3]
		]);
	});

	it('removes the entry on BACKPRESSURE but stops pumping', () => {
		// BACKPRESSURE means uWS accepted the bytes into its buffer. The entry is
		// effectively delivered and can be removed, but we stop sending more so
		// the kernel has a chance to drain before we keep pushing.
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const { sent, send } = makeSender([SUCCESS, BACKPRESSURE]);
		drainCoalesced(pending, send);
		expect(sent).toEqual([1, 2]);
		expect([...pending]).toEqual([['c', 3]]);
	});

	it('resumes from where it stopped on the next call', () => {
		const pending = new Map([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		const first = makeSender([DROPPED]);
		drainCoalesced(pending, first.send);
		expect(first.sent).toEqual([1]);
		expect([...pending]).toEqual([
			['a', 1],
			['b', 2],
			['c', 3]
		]);

		const second = makeSender([SUCCESS, SUCCESS, SUCCESS]);
		drainCoalesced(pending, second.send);
		expect(second.sent).toEqual([1, 2, 3]);
		expect(pending.size).toBe(0);
	});

	it('overwrites coalesce target across a stalled drain', () => {
		// First flush hits backpressure and leaves 'a' pending. A new
		// sendCoalesced on the same key updates the value in place. The next
		// drain delivers the latest value, not the stale one.
		const pending = new Map();
		pending.set('a', 'v1');
		const stalled = makeSender([DROPPED]);
		drainCoalesced(pending, stalled.send);
		expect(stalled.sent).toEqual(['v1']);

		pending.set('a', 'v2');
		const resumed = makeSender([SUCCESS]);
		drainCoalesced(pending, resumed.send);
		expect(resumed.sent).toEqual(['v2']);
		expect(pending.size).toBe(0);
	});

	it('only invokes send for the latest value when serialization is deferred', () => {
		// Models the lazy-stringify path the platform method uses: the map
		// holds the unserialized triple, the send callback does the work.
		// Rapid overwrites on a single key must materialize exactly once.
		const pending = new Map();
		const stringify = vi.fn((m) => JSON.stringify(m));
		const send = (msg) => { stringify(msg); return SUCCESS; };

		pending.set('price', { v: 1 });
		pending.set('price', { v: 2 });
		pending.set('price', { v: 3 });

		drainCoalesced(pending, send);
		expect(stringify).toHaveBeenCalledTimes(1);
		expect(stringify).toHaveBeenCalledWith({ v: 3 });
	});
});
