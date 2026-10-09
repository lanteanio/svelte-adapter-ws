// A request's own turn, as the line keeps it: its writes are held on the
// socket from the hand-out until the turn ends, and the turn ends when the
// next request is handed out on any connection, when the setImmediate after
// the hand-out runs, or once the held bytes fill the native tier's cork
// buffer. On the line alone, with stand-in sockets.

import { describe, expect, it } from 'vitest';
import { inOwnTurn, lineAhead, releaseTurnIfFull, servePipelined, upgradeTurn } from '../src/runtime/handler/http-helpers.js';

function connection() {
	/** @type {Record<string, Function[]>} */
	const socketListeners = {};
	const socket = /** @type {any} */ ({
		corked: 0, writableLength: 0, destroyed: false, _httpMessage: null,
		cork() { this.corked++; }, uncork() { if (this.corked > 0) this.corked--; },
		once(/** @type {string} */ event, /** @type {Function} */ fn) { (socketListeners[event] ??= []).push(fn); },
		emit(/** @type {string} */ event) { for (const fn of socketListeners[event] ?? []) fn(); }
	});
	Object.defineProperty(socket, 'writableCorked', { get() { return this.corked; } });
	const req = /** @type {any} */ ({ socket });
	/** @type {Record<string, Function[]>} */
	const resListeners = {};
	const res = /** @type {any} */ ({
		socket, writableEnded: false, _last: false,
		on(/** @type {string} */ event, /** @type {Function} */ fn) { (resListeners[event] ??= []).push(fn); },
		emit(/** @type {string} */ event) { for (const fn of resListeners[event] ?? []) fn.call(res); }
	});
	return { socket, req, res };
}

/** A response node is still writing on the socket: resolves its finish. */
function holder() {
	/** @type {Function[]} */
	const finish = [];
	return { once(/** @type {string} */ event, /** @type {Function} */ fn) { if (event === 'finish') finish.push(fn); }, finish() { for (const fn of finish.splice(0)) fn(); } };
}

describe('a request\'s turn', () => {
	it('holds the socket corked from the hand-out and ends at the next hand-out on any connection', async () => {
		const a = connection();
		const b = connection();
		let served = 0;
		servePipelined(a.req, a.res, () => { served++; });
		expect(inOwnTurn(a.res)).toBe(true);
		expect(a.socket.corked).toBe(1);
		servePipelined(b.req, b.res, () => { served++; });
		expect(served).toBe(2);
		expect(inOwnTurn(a.res), 'the next handler\'s turn ended the first').toBe(false);
		expect(a.socket.corked, 'its writes were released').toBe(0);
		expect(inOwnTurn(b.res)).toBe(true);
		expect(b.socket.corked).toBe(1);
		await new Promise((resolve) => setImmediate(resolve));
		expect(inOwnTurn(b.res), 'the setImmediate after the hand-out ends it').toBe(false);
		expect(b.socket.corked).toBe(0);
	});

	it('ends the hold once the held bytes reach the native tier\'s cork buffer', async () => {
		const c = connection();
		servePipelined(c.req, c.res, () => {});
		c.socket.writableLength = 16383;
		releaseTurnIfFull(c.res);
		expect(inOwnTurn(c.res), 'under the buffer it holds').toBe(true);
		c.socket.writableLength = 16384;
		releaseTurnIfFull(c.res);
		expect(inOwnTurn(c.res), 'at the buffer it releases').toBe(false);
		expect(c.socket.corked).toBe(0);
		await new Promise((resolve) => setImmediate(resolve));
		expect(c.socket.corked, 'the turn\'s end does not uncork twice').toBe(0);
	});

	it('keeps no finished answer alive in the line', () => {
		const e = connection();
		servePipelined(e.req, e.res, () => {});
		expect(lineAhead(e.socket)).toBe(e.res);
		e.res.writableEnded = true;
		e.res.emit('finish');
		const kept = lineAhead(e.socket);
		expect(kept, 'the response is replaced by a frozen stand-in').not.toBe(e.res);
		expect(kept.writableEnded).toBe(true);
		expect(Object.isFrozen(kept)).toBe(true);
	});

	it('lets a handshake go ahead only once every answer node is writing has finished', async () => {
		const f = connection();
		const first = holder();
		const second = holder();
		f.socket._httpMessage = first;
		const turn = upgradeTurn(f.req, f.socket);
		expect(turn, 'an answer still being written holds the handshake').not.toBeNull();
		let settled = /** @type {boolean | null} */ (null);
		/** @type {Promise<boolean>} */ (turn).then((ok) => { settled = ok; });
		await Promise.resolve();
		expect(settled).toBeNull();
		// node hands the socket to the next queued answer as this one finishes.
		f.socket._httpMessage = second;
		first.finish();
		await Promise.resolve();
		expect(settled, 'a second queued answer holds it again').toBeNull();
		f.socket._httpMessage = null;
		second.finish();
		await Promise.resolve();
		expect(settled).toBe(true);
		// Nothing in the way: at once.
		expect(upgradeTurn(f.req, f.socket)).toBeNull();
	});

	it('settles a waiting handshake as refused when the connection closes', async () => {
		const g = connection();
		g.socket._httpMessage = holder();
		const turn = /** @type {Promise<boolean>} */ (upgradeTurn(g.req, g.socket));
		g.socket.emit('close');
		expect(await turn).toBe(false);
	});

	it('does nothing for a response outside its turn', async () => {
		const d = connection();
		servePipelined(d.req, d.res, () => {});
		await new Promise((resolve) => setImmediate(resolve));
		d.socket.cork();
		d.socket.writableLength = 1 << 20;
		releaseTurnIfFull(d.res);
		expect(d.socket.corked, 'a cork the line does not own is left alone').toBe(1);
	});
});
