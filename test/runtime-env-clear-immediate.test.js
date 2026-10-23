// A custom immediate scheduler owns its handles: setRuntimeEnv must never hand
// one to Node's clearImmediate, which only knows its own Immediate objects. A
// scheduler without clearImmediate gets a no-op canceller; the default env and
// a scheduler that brings its own keep their canceller.

import { afterEach, expect, it, vi } from 'vitest';
import { readReady } from '../src/runtime/handler/response-read.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/runtime/runtime.js';

afterEach(() => {
	resetRuntimeEnv();
	vi.restoreAllMocks();
});

async function readyRead() {
	const deferred = Promise.withResolvers();
	const active = readReady({ read: () => deferred.promise });
	await Promise.resolve();
	deferred.resolve({ done: true });
	expect(await active).toEqual({ done: true });
}

it('never passes a custom scheduler handle to the Node canceller', async () => {
	const nodeClear = vi.spyOn(globalThis, 'clearImmediate');
	const handle = Object.freeze({ custom: true });
	let scheduled = 0;
	setRuntimeEnv({ timers: { setImmediate() { scheduled++; return handle; } } });
	await readyRead();
	expect(scheduled).toBe(1);
	expect(nodeClear.mock.calls.some(([h]) => h === handle)).toBe(false);
});

it('uses the scheduler canceller when it brings one', async () => {
	const nodeClear = vi.spyOn(globalThis, 'clearImmediate');
	const cleared = [];
	const handle = Object.freeze({ custom: true });
	setRuntimeEnv({ timers: { setImmediate: () => handle, clearImmediate: (h) => cleared.push(h) } });
	await readyRead();
	expect(cleared).toEqual([handle]);
	expect(nodeClear.mock.calls.some(([h]) => h === handle)).toBe(false);
});

it('cancels a real Immediate through Node by default', async () => {
	const nodeClear = vi.spyOn(globalThis, 'clearImmediate');
	setRuntimeEnv({});
	await readyRead();
	expect(nodeClear).toHaveBeenCalledTimes(1);
});
