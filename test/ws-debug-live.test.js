import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const handler = `
export function subscribe() { return true; }
export function message(ws, { data, platform }) {
 const message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
 if (message.type === 'actions') {
  platform.publish('debug-topic', 'ordinary', { value: 1 });
  platform.publishWire('debug-topic', 'binary', {}, { capability: 'debug:wire', schemaVersion: 1, encode() { return new Uint8Array([1,2,3]); } });
  for (const declined of [null, undefined]) platform.publishWire('debug-topic', 'declined', {}, { capability: 'debug:wire', schemaVersion: 1, encode() { return declined; } }, { excludeWs: ws });
  platform.publishBatched([{ topic: 'debug-topic', event: 'a', data: 1 }, { topic: 'debug-topic', event: 'b', data: 2 }]);
 }
 platform.send(ws, 'probe', 'done', {});
}
`;

function frames(ws) {
 const queue = [];
 const pending = [];
 ws.on('message', (data, binary) => {
  if (binary) return;
  const frame = JSON.parse(data.toString());
  const index = pending.findIndex(waiter => waiter.match(frame));
  if (index >= 0) { const waiter = pending.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(frame); }
  else queue.push(frame);
 });
 return match => {
  const index = queue.findIndex(match);
  if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
   const waiter = { match, resolve, timer: setTimeout(() => reject(new Error('frame not received')), 3000) };
   pending.push(waiter);
  });
 };
}

for (const enabled of [false, true]) it(`carries all lifecycle and publish debug sites with WS_DEBUG=${Number(enabled)}`, async () => {
 const previous = process.env.WS_DEBUG;
 process.env.WS_DEBUG = enabled ? '1' : '0';
 const log = vi.spyOn(console, 'log').mockImplementation(() => {});
 const payload = buildRuntime({ replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', idleTimeout: 120, compression: false }) }, wsHandlerSource: handler });
 let runtime, ws;
 try {
  runtime = await bootRuntime(payload);
  ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`);
  const receive = frames(ws);
  await once(ws, 'open');
  const welcome = await receive(frame => frame.type === 'welcome');
  ws.send(JSON.stringify({ type: 'hello', caps: ['debug:wire', 'batch'] }));
  ws.send(JSON.stringify({ type: 'subscribe', topic: 'debug-topic', ref: 1 }));
  await receive(frame => frame.type === 'subscribed');
  ws.send(JSON.stringify({ type: 'resume', sessionId: welcome.sessionId, lastSeenSeqs: {} }));
  await receive(frame => frame.type === 'resumed');
  ws.send(JSON.stringify({ type: 'ingress-bind', id: 1, kind: 'unknown-debug', target: 'debug-topic' }));
  ws.send(JSON.stringify({ type: 'actions' }));
  await receive(frame => frame.event === 'done');
  const closed = once(ws, 'close'); ws.close(1000); await closed;
  await vi.waitFor(() => expect(log.mock.calls.some(call => call[0] === '[ws] close code=%d connections=%d')).toBe(enabled));
  const calls = log.mock.calls.filter(call => typeof call[0] === 'string' && call[0].startsWith('[ws]'));
  if (!enabled) { expect(calls).toEqual([]); return; }
  expect(calls).toHaveLength(8);
  const named = prefix => calls.find(call => call[0].startsWith(prefix));
  expect(named('[ws] open')).toEqual(['[ws] open connections=%d session=%s', 1, welcome.sessionId]);
  expect(named('[ws] hello')).toEqual(['[ws] hello caps=%o', ['debug:wire', 'batch']]);
  expect(named('[ws] resume')).toEqual(['[ws] resume sessionId=%s', welcome.sessionId]);
  expect(named('[ws] ingress-bind')).toEqual(['[ws] ingress-bind for unregistered kind=%s (kept on JSON fallback)', 'unknown-debug']);
  expect(named('[ws] close')).toEqual(['[ws] close code=%d connections=%d', 1000, 0]);
  const publish = named('[ws] publish ');
  expect(publish).toEqual(['[ws] publish topicRef=%s eventRef=%s bytes=%d delivered=%s', expect.stringMatching(/^topic:/), expect.stringMatching(/^event:/), expect.any(Number), true]);
  expect(publish[3]).toBeGreaterThan(0);
  expect(named('[ws] publishWire')).toEqual(['[ws] publishWire topicRef=%s eventRef=%s payloadBytes=%d', publish[1], expect.stringMatching(/^event:/), 3]);
  expect(named('[ws] publishBatched')).toEqual(['[ws] publishBatched events=%d single-topic=%s fanoutTopicRef=%s delivered=%s', 2, true, publish[1], true]);
  expect(JSON.stringify(calls.filter(call => call[0].startsWith('[ws] publish')))).not.toContain('debug-topic');
 } finally {
  ws?.terminate(); await runtime?.close(); payload.cleanup(); log.mockRestore();
  if (previous === undefined) delete process.env.WS_DEBUG; else process.env.WS_DEBUG = previous;
 }
}, 60000);

it('disables the debug gate when the build has no WebSocket runtime', async () => {
 const previous = process.env.WS_DEBUG; process.env.WS_DEBUG = '1';
 const payload = buildRuntime({ replace: { WS_ENABLED: 'false' } });
 let runtime;
 try {
  runtime = await bootRuntime(payload);
  const config = await import(pathToFileURL(path.join(payload.dir, 'handler/config.js')).href);
  expect(config.wsDebug).toBe(false);
 } finally {
  await runtime?.close(); payload.cleanup();
  if (previous === undefined) delete process.env.WS_DEBUG; else process.env.WS_DEBUG = previous;
 }
}, 60000);
