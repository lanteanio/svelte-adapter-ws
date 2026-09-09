// The facade contract in isolation: the tri-state send synthesized from
// bufferedAmount and the ceiling, and throw-on-closed for the accessors -
// the two behaviors the ws library does not provide and sibling packages
// depend on.

import { describe, expect, it } from 'vitest';
import { wrapWebSocket, CLOSED_MESSAGE } from '../src/runtime/handler/ws-facade.js';
import { registerSocket, unregisterSocket } from '../src/runtime/handler/topic-registry.js';

/**
 * @param {{ readyState?: number, bufferedAmount?: number }} [init]
 */
function fakeRawWs(init = {}) {
	/** @type {any} */
	const raw = {
		readyState: init.readyState ?? 1,
		bufferedAmount: init.bufferedAmount ?? 0,
		sent: /** @type {any[]} */ ([]),
		terminated: false,
		send(payload, _opts, cb) {
			this.sent.push(payload);
			if (cb) this._cb = cb;
		},
		terminate() { this.terminated = true; this.readyState = 3; },
		close() { this.readyState = 3; },
		_socket: { remoteAddress: '203.0.113.9' }
	};
	return raw;
}

/** @param {any} raw @param {object} [opts] */
function facadeFor(raw, opts = {}) {
	registerSocket(raw);
	return wrapWebSocket(raw, { tag: 'ud' }, {
		maxBackpressure: 1024,
		closeOnBackpressureLimit: false,
		compressionEnabled: false,
		...opts
	});
}

describe('tri-state send synthesis', () => {
	it('answers 1 for a clean flush', () => {
		const raw = fakeRawWs();
		const facade = facadeFor(raw);
		expect(facade.send('hello')).toBe(1);
		expect(raw.sent).toEqual(['hello']);
		unregisterSocket(raw);
	});

	it('answers 0 when bytes stay buffered behind backpressure', () => {
		const raw = fakeRawWs();
		raw.send = function (payload, _opts, cb) {
			this.sent.push(payload);
			this.bufferedAmount = 512;
			if (cb) this._cb = cb;
		};
		const facade = facadeFor(raw);
		expect(facade.send('queued')).toBe(0);
		expect(raw.sent).toEqual(['queued']);
		unregisterSocket(raw);
	});

	it('answers 2 and sheds without sending past the ceiling', () => {
		const raw = fakeRawWs({ bufferedAmount: 4096 });
		let dropped = 0;
		const facade = facadeFor(raw, { onDrop: (bytes) => { dropped = bytes; } });
		expect(facade.send('shed-me')).toBe(2);
		expect(raw.sent).toEqual([]);
		expect(dropped).toBe('shed-me'.length);
		expect(raw.terminated).toBe(false);
		unregisterSocket(raw);
	});

	it('terminates the pinned consumer under closeOnBackpressureLimit', () => {
		const raw = fakeRawWs({ bufferedAmount: 4096 });
		const facade = facadeFor(raw, { closeOnBackpressureLimit: true });
		expect(facade.send('shed-me')).toBe(2);
		expect(raw.terminated).toBe(true);
		unregisterSocket(raw);
	});

	it('fires the drain hook once per pressure episode when the buffer empties', () => {
		const raw = fakeRawWs();
		let drains = 0;
		raw.send = function (payload, _opts, cb) {
			this.sent.push(payload);
			this.bufferedAmount = 256;
			this._cb = cb;
		};
		const facade = facadeFor(raw, { onDrain: () => { drains++; } });
		expect(facade.send('a')).toBe(0);
		// Flush callback with bytes still buffered: no drain yet.
		raw._cb();
		expect(drains).toBe(0);
		// Buffer empties: exactly one drain.
		raw.bufferedAmount = 0;
		raw._cb();
		raw._cb();
		expect(drains).toBe(1);
		unregisterSocket(raw);
	});
});

describe('throw-on-closed contract', () => {
	it('throws from every accessor a liveness sweep relies on', () => {
		const raw = fakeRawWs({ readyState: 3 });
		const facade = facadeFor(raw);
		for (const call of [
			() => facade.send('x'),
			() => facade.subscribe('t'),
			() => facade.unsubscribe('t'),
			() => facade.getBufferedAmount(),
			() => facade.publish('t', 'x')
		]) {
			expect(call).toThrow(CLOSED_MESSAGE);
		}
		// userData outlives the handle, as the family's socket keeps it: a
		// caller that reads it after the close is not thrown at, and the send
		// above is where the closed socket refuses.
		expect(() => facade.getUserData()).not.toThrow();
		// close/end stay safe no-ops - nothing reaps through them.
		expect(() => facade.close()).not.toThrow();
		expect(() => facade.end(1000)).not.toThrow();
		unregisterSocket(raw);
	});

	it('keeps userData identity for the connection life while open', () => {
		const raw = fakeRawWs();
		const facade = facadeFor(raw);
		expect(facade.getUserData()).toBe(facade.getUserData());
		unregisterSocket(raw);
	});
});

describe('address encoding', () => {
	it('returns raw IPv4 bytes', () => {
		const raw = fakeRawWs();
		const facade = facadeFor(raw);
		expect([...new Uint8Array(facade.getRemoteAddress())]).toEqual([203, 0, 113, 9]);
		unregisterSocket(raw);
	});

	it('returns 16 bytes for IPv6 and text form verbatim', () => {
		const raw = fakeRawWs();
		raw._socket.remoteAddress = '2001:db8::1';
		const facade = facadeFor(raw);
		expect(new Uint8Array(facade.getRemoteAddress()).byteLength).toBe(16);
		expect(new TextDecoder().decode(facade.getRemoteAddressAsText())).toBe('2001:db8::1');
		unregisterSocket(raw);
	});
});
