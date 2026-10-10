import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { inOwnTurn, lineAhead, servePipelined } from '../src/runtime/handler/http-helpers.js';

function exchange() {
 const socket = { writableCorked: 0, destroyed: false,
  cork() { this.writableCorked++; }, uncork() { this.writableCorked--; } };
 const req = { socket };
 const res = Object.assign(new EventEmitter(), { socket, writableEnded: false, _last: false });
 return { req, res, socket };
}

describe('synchronous probe turns', () => {
 it('finishes a completed answer without keeping its turn open', () => {
  const { req, res, socket } = exchange();
  servePipelined(req, res, () => {
   expect(inOwnTurn(res)).toBe(true);
   res.writableEnded = true;
  }, true);
  expect(inOwnTurn(res)).toBe(false);
  expect(socket.writableCorked).toBe(0);
  expect(lineAhead(socket)).not.toBe(res);
  expect(lineAhead(socket).writableEnded).toBe(true);
 });
 it('keeps a completed closing answer terminal for later requests', () => {
  const { req, res, socket } = exchange();
  servePipelined(req, res, () => { res.writableEnded = true; res._last = true; }, true);
  const next = Object.assign(new EventEmitter(), { socket, writableEnded: false, _last: false });
  let served = false;
  servePipelined(req, next, () => { served = true; }, true);
  expect(served).toBe(false);
  expect(lineAhead(socket)._last).toBe(true);
 });
 it('ends an asynchronous turn before the application immediate runs', async () => {
  const { req, res } = exchange();
  await new Promise((resolve, reject) => {
   servePipelined(req, res, () => {
    setImmediate(() => {
     try { expect(inOwnTurn(res)).toBe(false); resolve(); } catch (error) { reject(error); }
    });
   });
  });
 });
});
