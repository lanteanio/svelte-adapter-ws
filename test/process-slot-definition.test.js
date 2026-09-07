// The process-wide slots hang off globalThis under Symbol.for keys, so one
// accessor on Object.prototype takes the publication for every module copy at
// once. Each of these keys is written exactly once per process, so an accessor
// is what a bare assignment would meet on first use. The cases install the
// accessor first and then use the slot through its public entry point, so
// they fail against an assignment and pass only when the write defines an own
// property.

import { describe, expect, it } from 'vitest';
import {
	WS_SUBSCRIPTIONS, setCohortHooks, setSubscriptionAccountingHook, trackedSubscribe, trackedUnsubscribe,
	accountClosedLogicalSubscriptions, isSettledSubscriptionRegistry
} from '../src/runtime/utils/ws-symbols.js';

describe('the process-wide slots are defined, not assigned', () => {
	/** Install an accessor on Object.prototype for `key`, run `body`, restore. */
	function underAccessor(key, body) {
		const before = Object.getOwnPropertyDescriptor(globalThis, key);
		if (before) delete globalThis[key];
		/** @type {unknown[]} */
		const stolen = [];
		Object.defineProperty(Object.prototype, key, {
			set(v) { stolen.push(v); },
			get() { return undefined; },
			configurable: true
		});
		try {
			body(stolen);
		} finally {
			// @ts-expect-error - a symbol-keyed accessor on the prototype
			delete Object.prototype[key];
			delete globalThis[key];
			if (before) Object.defineProperty(globalThis, key, before);
		}
	}

	it('the cohort hooks are installed where the fan-out reads them', () => {
		underAccessor(Symbol.for('adapter-uws.cohort-hooks'), (stolen) => {
			const joined = [];
			setCohortHooks((_ws, _ud, topic) => { joined.push(topic); }, null);
			expect(stolen, 'the hooks object reached an inherited setter').toEqual([]);
			expect(Object.hasOwn(globalThis, Symbol.for('adapter-uws.cohort-hooks'))).toBe(true);
			// Through the public path: a tracked subscribe on a connection that
			// holds no registry yet must reach the hook just installed.
			const subs = new Set();
			const ws = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }), subscribe() { return true; } };
			trackedSubscribe(ws, 'room:1');
			expect(joined).toEqual(['room:1']);
			setCohortHooks(null, null);
		});
	});

	it('the subscription accounting hook is installed, not swallowed', () => {
		underAccessor(Symbol.for('adapter-uws.subscription-accounting-hook'), (stolen) => {
			const deltas = [];
			expect(setSubscriptionAccountingHook((delta, topic) => { deltas.push([delta, topic]); })).toBe(false);
			expect(stolen).toEqual([]);
			const subs = new Set();
			const ws = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }), subscribe() { return true; }, unsubscribe() { return true; } };
			trackedSubscribe(ws, 'room:2');
			trackedUnsubscribe(ws, 'room:2');
			expect(deltas).toEqual([[1, 'room:2'], [-1, 'room:2']]);
			setSubscriptionAccountingHook(null);
		});
	});

	it('a settled registry stays settled across calls', () => {
		underAccessor(Symbol.for('adapter-uws.settled-subscription-registries'), (stolen) => {
			const subs = new Set(['room:3']);
			// The close path settles the registry; a second release must find it
			// settled, or the membership is charged twice. Under an assignment
			// every call builds a fresh WeakSet and nothing is ever settled.
			expect(accountClosedLogicalSubscriptions(subs)).toBe(1);
			expect(stolen).toEqual([]);
			expect(isSettledSubscriptionRegistry(subs)).toBe(true);
			expect(accountClosedLogicalSubscriptions(subs), 'a settled registry releases nothing twice').toBe(0);
		});
	});
});
