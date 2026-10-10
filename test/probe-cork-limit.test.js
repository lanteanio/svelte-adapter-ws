import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const health = 'GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n';
const bad = 'GET /bad HTTP/1.0\r\nHost: localhost\r\n\r\n';

describe.each([false, true])('probe pipeline cork limit with TLS=%s', secure => {
 let payload, runtime;
 const prefix = 'PROBE_CORK_LIMIT_';
 beforeAll(async () => {
  if (secure) {
   const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
   process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
   process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
   process.env[prefix + 'SSL_WATCH'] = '0';
  }
  payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
  runtime = await bootRuntime(payload);
 });
 afterAll(async () => {
  await runtime?.close(); payload?.cleanup();
  for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
 });
 it.each([32, 256])('releases completed probes only after %i answers fill the cork', async count => {
  const { raw, closed } = await rawConversation(runtime.port, [[0, health.repeat(count) + bad]], { secure });
  expect(closed).toBe(true);
  expect(raw.match(/HTTP\/1\.1 200/g)?.length ?? 0).toBe(count === 256 ? count : 0);
  expect(raw.match(/HTTP\/1\.1 505/g)?.length ?? 0).toBe(1);
  if (count === 256) expect(raw.indexOf('HTTP/1.1 505')).toBeGreaterThan(raw.lastIndexOf('HTTP/1.1 200'));
 });
});
