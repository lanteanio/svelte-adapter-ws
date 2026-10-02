// platform.sendCoalesced and the flush behind it, on the built platform over
// the real facade. The transport is scripted so a case can hold the socket at
// the backpressure ceiling (every send sheds, so the queue keeps its entries),
// release it, or close it, and then run the flush the facade's drain runs.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { buildRuntime } from './helpers/build-runtime.js';

/** @type {any} */
let payload;
/** @type {any} */
let platform;
/** @type {any} */
let flushCoalescedFor;
/** @type {any} */
let state;
/** @type {any} */
let symbols;

const MAX_BACKPRESSURE = 1024 * 1024;

/**
 * A connection whose transport records every text frame. `hold()` parks the
 * buffer at the ceiling so each send sheds, `release()` empties it, `close()`
 * makes the next send throw as a closed socket does.
 */
async function connect() {
	const dir = pathToFileURL(payload.dir).href;
	const { wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`);
	/** @type {string[]} */
	const frames = [];
	/** @type {any} */
	const rawWs = {
		readyState: 1,
		bufferedAmount: 0,
		send(data, _opts, cb) { if (typeof data === 'string') frames.push(data); cb?.(); },
		terminate() { this.readyState = 3; },
		close() { this.readyState = 3; },
		_socket: { remoteAddress: '10.0.0.1' }
	};
	const userData = /** @type {any} */ ({ remoteAddress: '10.0.0.1' });
	const facade = wrapWebSocket(rawWs, userData, {
		maxBackpressure: MAX_BACKPRESSURE,
		closeOnBackpressureLimit: false,
		compressionEnabled: false
	});
	return {
		facade,
		frames,
		pending: () => userData[symbols.WS_COALESCED],
		events: () => frames.map((f) => JSON.parse(f).event),
		hold() { rawWs.bufferedAmount = MAX_BACKPRESSURE; },
		release() { rawWs.bufferedAmount = 0; },
		close() { rawWs.readyState = 3; }
	};
}

beforeAll(async () => {
	payload = buildRuntime();
	const dir = pathToFileURL(payload.dir).href;
	state = await import(`${dir}/handler/state.js`);
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	const mod = await import(`${dir}/handler/platform.js`);
	platform = mod.platform;
	flushCoalescedFor = mod.flushCoalescedFor;
	state.envelopePrefixCache.clear();
}, 60000);

afterAll(() => {
	payload?.cleanup?.();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('sendCoalesced queues by the key it is given', () => {
	it('a held value is replaced in place and goes out once the socket drains', async () => {
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'k', topic: 't', event: 'first', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'k', topic: 't', event: 'second', data: 2 });
		expect(c.frames).toEqual([]);
		expect(c.pending().size).toBe(1);
		c.release();
		flushCoalescedFor(c.facade);
		expect(c.events()).toEqual(['second']);
		expect(c.pending().size).toBe(0);
	});

	it('calls without a key share one slot, whatever their topic and event', async () => {
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { topic: 'a', event: 'e', data: 1 });
		platform.sendCoalesced(c.facade, { topic: 'b', event: 'f', data: 2 });
		expect(c.pending().size).toBe(1);
		c.release();
		flushCoalescedFor(c.facade);
		expect(c.frames.map((f) => JSON.parse(f).topic)).toEqual(['b']);
	});
});

/** The registry lines console.error printed, with the error printed beside each. */
function reported(spy) {
	return spy.mock.calls
		.filter((call) => String(call[0]).includes('[ADAPTER-ERR-COALESCED-UNSERIALIZABLE]'))
		.map((call) => call[1]);
}

describe('a value JSON cannot carry', () => {
	it('throws the serializer error to the caller whose value flushes at once, after the rest went out', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'a', topic: 't', event: 'a', data: 1 });
		c.release();
		/** @type {any} */
		let thrown = null;
		try {
			platform.sendCoalesced(c.facade, { key: 'b', topic: 't', event: 'b', data: { n: 1n } });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(TypeError);
		expect(String(thrown.message)).toMatch(/BigInt/);
		expect(c.events(), 'the entry queued ahead of it still went out').toEqual(['a']);
		expect(c.pending().size, 'the failing entry is not kept').toBe(0);
		expect(reported(error), 'a thrown value is not also reported').toEqual([]);
	});

	it('drops and reports a queued value at the drain, and sends the rest', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'good', topic: 't', event: 'good', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'bad', topic: 't', event: 'bad', data: { n: 1n } });
		platform.sendCoalesced(c.facade, { key: 'late', topic: 't', event: 'late', data: 2 });
		c.release();
		expect(() => flushCoalescedFor(c.facade)).not.toThrow();
		expect(c.events()).toEqual(['good', 'late']);
		expect(c.pending().size).toBe(0);
		const errors = reported(error);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(TypeError);
		expect(String(errors[0].message)).toMatch(/BigInt/);
	});

	it('reports an older queued value flushed inside a later, unrelated call instead of throwing there', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'first', topic: 't', event: 'first', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'bad', topic: 't', event: 'bad', data: { n: 1n } });
		c.release();
		expect(() => platform.sendCoalesced(c.facade, { key: 'next', topic: 't', event: 'next', data: 2 })).not.toThrow();
		expect(c.events()).toEqual(['first', 'next']);
		expect(reported(error)).toHaveLength(1);
	});

	it('reports the very error a toJSON throws', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = await connect();
		const boom = new RangeError('no');
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'first', topic: 't', event: 'first', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'bad', topic: 't', event: 'bad', data: { toJSON() { throw boom; } } });
		c.release();
		flushCoalescedFor(c.facade);
		expect(reported(error)).toEqual([boom]);
	});

	it('refuses a value the serializer turns into nothing', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'first', topic: 't', event: 'first', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'fn', topic: 't', event: 'fn', data: () => 1 });
		platform.sendCoalesced(c.facade, { key: 'sym', topic: 't', event: 'sym', data: Symbol('s') });
		platform.sendCoalesced(c.facade, { key: 'num', topic: 't', event: 'num', data: { toJSON() { throw 42; } } });
		c.release();
		flushCoalescedFor(c.facade);
		expect(c.events()).toEqual(['first']);
		const errors = reported(error);
		expect(errors).toHaveLength(3);
		for (const err of errors) {
			expect(err).toBeInstanceOf(TypeError);
			expect(err.message).toBe('sendCoalesced data has no JSON form');
		}
	});

	it('sends a missing or undefined value as null', async () => {
		const c = await connect();
		platform.sendCoalesced(c.facade, { key: 'u', topic: 't', event: 'u' });
		expect(c.frames.map((f) => JSON.parse(f).data)).toEqual([null]);
	});
});

describe('a socket that closes with values queued', () => {
	it('drops the whole queue at the next flush and counts one abort', async () => {
		const c = await connect();
		c.hold();
		platform.sendCoalesced(c.facade, { key: 'a', topic: 't', event: 'a', data: 1 });
		platform.sendCoalesced(c.facade, { key: 'b', topic: 't', event: 'b', data: 2 });
		platform.sendCoalesced(c.facade, { key: 'c', topic: 't', event: 'c', data: 3 });
		expect(c.pending().size).toBe(3);
		c.release();
		c.close();
		const before = platform.closedWsAborts;
		flushCoalescedFor(c.facade);
		expect(platform.closedWsAborts - before).toBe(1);
		expect(c.pending().size, 'nothing is kept for a drain that will never come').toBe(0);
		expect(c.frames).toEqual([]);
	});
});
