import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

function exchange(port, secure, firstPath, duplicate, later, upgrade = '', trailingPath = null) {
 const first = `GET ${firstPath} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
 const refused = `GET ${upgrade ? '/ws' : '/refused'} HTTP/1.1\r\n` + (duplicate ? 'Host: x\r\nHost: y\r\n' : '') + upgrade + '\r\n' +
  (trailingPath ? `GET ${trailingPath} HTTP/1.1\r\nHost: localhost\r\n\r\n` : '');
 return new Promise((resolve, reject) => {
  const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
  let raw = '', sent = false, ended = false;
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('Host refusal did not close the connection')); }, 2500);
  socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(first + (later ? '' : refused)));
  socket.on('data', chunk => {
   raw += chunk.toString('latin1');
   if (later && !sent) {
    const end = raw.indexOf('\r\n\r\n');
    const length = end < 0 ? null : raw.slice(0, end).match(/\r\ncontent-length: (\d+)/i);
    if (length && raw.length >= end + 4 + Number(length[1])) { sent = true; socket.write(refused); }
   }
  });
  socket.on('end', () => { ended = true; });
  socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  socket.on('close', () => { clearTimeout(timer); resolve({ raw, ended }); });
 });
}

for (const lane of ['TCP', 'TLS', 'harness']) describe(`pipelined Host refusals on ${lane}`, () => {
 let runtime, payload;
 const prefix = `HOST_PIPELINE_${lane}_`;
 const callbackKey = `__hostPipelineCallbacks_${lane}`;
 const trailingPath = lane === 'harness' ? '/__realtime/trailing' : '/trailing';
 beforeAll(async () => {
  if (lane === 'harness') {
   const { createTestServer } = await import('../src/testing.js');
   runtime = await createTestServer({ handler: {
    upgrade() { globalThis[callbackKey]?.push('upgrade'); return {}; },
    admin() { globalThis[callbackKey]?.push('http'); return new Response('trailing'); }
   } });
   return;
  }
  if (lane === 'TLS') {
   const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
   process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
   process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
   process.env[prefix + 'SSL_WATCH'] = '0';
  }
  payload = buildRuntime({
   replace: {
    ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true',
    WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', compression: false, adminAuthAcknowledged: true })
   },
   wsHandlerSource: `export function upgrade() { globalThis[${JSON.stringify(callbackKey)}]?.push('upgrade'); return {}; }`,
   serverSource: `export class Server { async init() {} respond(request) {
    if (new URL(request.url).pathname === '/trailing') globalThis[${JSON.stringify(callbackKey)}]?.push('http');
    return new Response('sync');
   } }`
  });
  runtime = await bootRuntime(payload);
 }, 60000);
 afterAll(async () => {
  await runtime?.close(); payload?.cleanup();
  delete globalThis[callbackKey];
  for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
 });
 for (const firstPath of lane === 'harness' ? ['/healthz'] : ['/healthz', '/sync']) {
  for (const duplicate of [false, true]) for (const later of [false, true]) {
   it(`${duplicate ? 'duplicate' : 'missing'} Host after ${firstPath} in ${later ? 'a later' : 'the same'} read`, async () => {
    const { raw, ended } = await exchange(runtime.port, lane === 'TLS', firstPath, duplicate, later);
    expect([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match => match[1])).toEqual(later ? ['200', '400'] : ['400']);
    expect(raw.toLowerCase()).toContain('connection: close');
    expect(ended).toBe(true);
   });
  }
 }
 it('observes the trailing route when sent before the refusal', async () => {
  globalThis[callbackKey] = [];
  const { raw } = await exchange(runtime.port, lane === 'TLS', trailingPath, false, true);
  expect([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match => match[1])).toEqual(['200', '400']);
  expect(globalThis[callbackKey]).toEqual(['http']);
 });
 for (const [protocol, upgrade] of [
  ['h2c', 'Connection: Upgrade\r\nUpgrade: h2c\r\n'],
  ['websocket', 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n']
 ]) for (const duplicate of [false, true]) for (const later of [false, true]) {
  it(`${protocol} with ${duplicate ? 'duplicate' : 'missing'} Host in ${later ? 'a later' : 'the same'} read stops trailing callbacks`, async () => {
   globalThis[callbackKey] = [];
   const { raw, ended } = await exchange(runtime.port, lane === 'TLS', '/healthz', duplicate, later, upgrade, trailingPath);
   expect([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match => match[1])).toEqual(later ? ['200', '400'] : ['400']);
   expect(ended).toBe(true);
   expect(globalThis[callbackKey]).toEqual([]);
  });
 }

});