import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

describe.each(['ready', 'draining'])('fixed probe framing while %s', lifecycle => {
 let payload, runtime;
 beforeAll(async () => {
  payload = buildRuntime(); runtime = await bootRuntime(payload);
  if (lifecycle === 'draining') runtime.handler.beginDrain();
 });
 afterAll(async () => { await runtime?.close(); payload?.cleanup(); });
 it.each([['GET', '/healthz'], ['HEAD', '/healthz'], ['GET', '/readyz'], ['HEAD', '/readyz']])('%s %s retains its fixed body length', async (method, route) => {
  const body = route === '/healthz' ? 'OK' : lifecycle;
  const status = route === '/healthz' || lifecycle === 'ready' ? 200 : 503;
  const { raw, closed } = await rawConversation(runtime.port, [[0,
   `${method} ${route} HTTP/1.1\r\nHost: localhost\r\n\r\n` +
   'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  ]]);
  expect(closed).toBe(true);
  const boundary = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, boundary);
  expect(head).toMatch(new RegExp('^HTTP/1.1 ' + status + ' '));
  expect(head).toMatch(new RegExp('\\r\\ncontent-length: ' + body.length + '(?:\\r\\n|$)', 'i'));
  expect(head).not.toMatch(/\r\n(?:transfer-encoding|content-type):/i);
  expect(raw.slice(boundary + 4)).toMatch(new RegExp('^' + (method === 'GET' ? body : '') + 'HTTP/1.1 200 '));
 });
});
