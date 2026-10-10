import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const request = (url, version = '1.1') => 'GET ' + url + ' HTTP/' + version + '\r\nHost: x\r\n\r\n';
const serverSource = `export class Server {
 async init() {}
 respond(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/slow') return new Promise(resolve => setTimeout(() => resolve(new Response('slow')), 40));
  if (pathname === '/post') return request.text().then(() => new Response('post'));
  if (pathname === '/wide') return new Response('w'.repeat(20 * 1024));
  return new Response('sync');
 }
}`;

describe.each([false, true])('HTTP read response ordering with TLS=%s', secure => {
 let payload, runtime;
 const prefix = 'HTTP_READ_TURN_';
 beforeAll(async () => {
  if (secure) {
   const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
   process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
   process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
   process.env[prefix + 'SSL_WATCH'] = '0';
  }
  payload = buildRuntime({ serverSource, replace: { ENV_PREFIX: JSON.stringify(prefix) } });
  runtime = await bootRuntime(payload);
 });
 afterAll(async () => {
  await runtime?.close(); payload?.cleanup();
  for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
 });
 it.each(['/healthz', '/sync'])('drops the buffered %s answer before a version refusal', async first => {
  const { raw, closed } = await rawConversation(runtime.port, [[0, request(first) + request('/bad', '1.0')]], { secure });
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 505']);
  expect(closed).toBe(true);
 });
 it.each(['/healthz', '/sync'])('drops the buffered %s answer before a header refusal', async first => {
  const bad = 'GET /bad HTTP/1.1\r\nHost: x\r\nBad Header: x\r\n\r\n';
  const { raw, closed } = await rawConversation(runtime.port, [[0, request(first) + bad]], { secure });
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 400']);
  expect(closed).toBe(true);
 });
 it('drops earlier small answers when a later callback cannot finish', async () => {
  const { raw, closed } = await rawConversation(runtime.port, [[0, request('/sync') + request('/slow') + request('/sync')]], { secure });
  expect(raw).toBe('');
  expect(closed).toBe(true);
 });
 it('flushes a large answer before a later version refusal', async () => {
  const { raw, closed } = await rawConversation(runtime.port, [[0, request('/wide') + request('/bad', '1.0')]], { secure });
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 505']);
  expect(raw).toContain('w'.repeat(20 * 1024));
  expect(closed).toBe(true);
 });
 it('holds the read that completes a body before another callback waits', async () => {
  const first = 'POST /post HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\n';
  const { raw, closed } = await rawConversation(runtime.port, [[0, first], [25, 'x' + request('/sync') + request('/slow') + request('/sync')]], { secure });
  expect(raw).toBe('');
  expect(closed).toBe(true);
 });
 it('flushes a fully answered read before a later read is refused', async () => {
  const { raw, closed } = await rawConversation(runtime.port, [[0, request('/sync') + request('/sync')], [40, request('/bad', '1.0')]], { secure });
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200', 'HTTP/1.1 505']);
  expect(closed).toBe(true);
 });
});
