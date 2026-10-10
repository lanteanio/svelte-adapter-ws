import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const request = (url, version = '1.1') => `GET ${url} HTTP/${version}\r\nHost: x\r\nCookie: session=x\r\n\r\n`;
const serverSource = `export class Server {
 async init() {}
 respond(request) {
  const [mode, size] = new URL(request.url).pathname.slice(1).split('/');
  const count = Number(size) || 0;
  const headers = { 'content-type': 'text/plain;charset=UTF-8' };
  if (mode === 'custom') Object.assign(headers, {
   date: 'Mon, 01 Jan 2001 00:00:00 GMT', uwebsockets: 'custom', connection: 'custom'
  });
  if (mode === 'stream') return new Response(new ReadableStream({ start(controller) {
   controller.enqueue(new TextEncoder().encode('w'.repeat(Math.ceil(count / 2))));
   controller.enqueue(new TextEncoder().encode('w'.repeat(Math.floor(count / 2))));
   controller.close();
  }}), { headers });
  return new Response('w'.repeat(count), { headers });
 }
}`;

// The release boundary includes response headers and HTTP body framing.
// User-supplied Date/uWebSockets fields do not replace the automatic fields.
const cases = [
 ['fixed', 16218, false, false], ['fixed', 16219, true, false],
 ['fixed', 16055, false, true], ['fixed', 16056, true, true],
 ['custom', 16140, false, false], ['custom', 16141, true, false],
 ['stream', 16192, false, false], ['stream', 16193, true, false]
];

for (const secure of [false, true]) describe(`HTTP read byte limit over ${secure ? 'TLS' : 'TCP'}`, () => {
 let payload, runtime;
 const prefix = `HTTP_READ_LIMIT_${secure}_`;
 beforeAll(async () => {
  if (secure) {
   const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
   process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
   process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
   process.env[prefix + 'SSL_WATCH'] = '0';
  }
  payload = buildRuntime({ serverSource, replace: { ENV_PREFIX: JSON.stringify(prefix) } });
  runtime = await bootRuntime(payload);
 }, 60000);
 afterAll(async () => {
  await runtime?.close(); payload?.cleanup();
  for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
 });
 it.each(cases)('%s body %i released=%s after earlier response=%s', async (mode, size, released, queued) => {
  const bytes = (queued ? request('/fixed/1') : '') + request(`/${mode}/${size}`) + request('/bad', '1.0');
  const { raw, closed } = await rawConversation(runtime.port, [[0, bytes]], { secure });
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(released
   ? [...(queued ? ['HTTP/1.1 200'] : []), 'HTTP/1.1 200', 'HTTP/1.1 505']
   : ['HTTP/1.1 505']);
  expect(closed).toBe(true);
 });
});