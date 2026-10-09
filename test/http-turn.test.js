// A request's own turn, as the line keeps it: its writes are held on the
// socket from the hand-out until the turn ends, and the turn ends when the
// next request is handed out on any connection, when the setImmediate after
// the hand-out runs, or once the held bytes fill the native tier's cork
// buffer. On the line alone, with stand-in sockets.

import { describe, expect, it } from 'vitest';
import { inOwnTurn, releaseTurnIfFull, servePipelined } from '../src/runtime/handler/http-helpers.js';

function connection() {
	const socket = /** @type {any} */ ({ corked: 0, writableLength: 0, destroyed: false, cork() { this.corked++; }, uncork() { if (this.corked > 0) this.corked--; } });
	Object.defineProperty(socket, 'writableCorked', { get() { return this.corked; } });
	const req = /** @type {any} */ ({ socket });
	const res = /** @type {any} */ ({ socket, writableEnded: false, _last: false, on() {} });
	return { socket, req, res };
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
