import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const health = 'GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n';
let payload, runtime;
beforeAll(async () => {
 payload = buildRuntime({ serverSource: `export class Server {
  async init() {}
  respond(request) { return Response.json({ value: request.headers.get('x-probe') }); }
 }` });
 runtime = await bootRuntime(payload);
});
afterAll(async () => { await runtime?.close(); payload?.cleanup(); });

describe('request parser callback transitions', () => {
 it.each([false, true])('restores normalization between plain batches with separate reads=%s', async separate => {
  const middle = 'GET /reflect HTTP/1.1\r\nHost: localhost\r\nX-Probe: a\xc3\xa9b\r\n\r\n';
  const writes = separate ? [[0, health], [25, middle], [50, health]] : [[0, health + middle + health]];
  const { raw, closed } = await rawConversation(runtime.port, writes, { wait: 350 });
  expect(closed).toBe(false);
  expect(raw.match(/HTTP\/1\.1 200/g)?.length).toBe(3);
  expect(Buffer.from(raw, 'latin1').toString('utf8')).toContain('"value":"a\u00e9b"');
 });
 it('restores a framed request before returning to plain batches', async () => {
  const middle = 'POST /reflect HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc';
  const { raw, closed } = await rawConversation(runtime.port, [[0, health], [25, middle], [50, health]], { wait: 350 });
  expect(closed).toBe(false);
  expect(raw.match(/HTTP\/1\.1 200/g)?.length).toBe(3);
 });
});
