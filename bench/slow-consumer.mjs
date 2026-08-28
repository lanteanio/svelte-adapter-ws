// The slow-consumer bench: proves the flow-control path actually engages.
// A zero stub in platform.pressure would silently disable flow control, so
// this bench fails loudly unless (1) a paused consumer's outbound queue is
// seen by the sampler, (2) frames are shed at the ceiling and counted, and
// (3) the connection recovers to a clean snapshot after the consumer resumes.
//
// Run: node bench/slow-consumer.mjs
// Exit code 0 = flow control engaged and recovered; 1 = it did not.

import { buildRuntime, bootRuntime } from '../test/helpers/build-runtime.js';
import WebSocket from 'ws';

const MAX_BACKPRESSURE = 256 * 1024; // lowered so loopback triggers fast
const FRAME_BYTES = 16 * 1024;
const N_CLIENTS = 8;
const PUBLISH_BURSTS = 400;

const WS_OPTS = {
	maxPayloadLength: 1024 * 1024,
	idleTimeout: 120,
	maxBackpressure: MAX_BACKPRESSURE,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false
};

function fail(message) {
	console.error('SLOW-CONSUMER BENCH FAILED: ' + message);
	process.exitCode = 1;
}

const payload = buildRuntime({
	replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
	wsHandlerSource: 'export function close() {}\n'
});
const rt = await bootRuntime(payload);
const { platform } = rt.handler;

const clients = [];
for (let i = 0; i < N_CLIENTS; i++) {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	ws.send(JSON.stringify({ type: 'subscribe', topic: 'firehose', ref: i }));
	clients.push(ws);
}
await new Promise((r) => setTimeout(r, 100));

// Stage 1: warm - everyone reading, queues near zero.
for (let i = 0; i < 20; i++) platform.publish('firehose', 'tick', 'w'.repeat(1024));
await new Promise((r) => setTimeout(r, 1200));
const warm = { ...platform.pressure };
console.log(`warm: maxBufferedBytes=${warm.maxBufferedBytes} backpressured=${warm.backpressuredConnections} dropped=${warm.droppedFrames}`);

// Stage 2: overload - one client stops reading at the TCP level, the
// firehose keeps publishing. Its server-side queue must climb into the
// sampler's view and the ceiling must shed.
const slow = clients[0];
slow._socket.pause();
const bigPayload = 'x'.repeat(FRAME_BYTES);
for (let i = 0; i < PUBLISH_BURSTS; i++) {
	platform.publish('firehose', 'tick', bigPayload);
	if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
}
await new Promise((r) => setTimeout(r, 1200));
const overload = { ...platform.pressure };
console.log(`overload: maxBufferedBytes=${overload.maxBufferedBytes} backpressured=${overload.backpressuredConnections} dropped=${overload.droppedFrames} value=${overload.value.toFixed(3)}`);

if (overload.maxBufferedBytes === 0) {
	fail(String.raw`the sampler never saw the paused consumer outbound queue (zero-stub symptom)`);
}
if (overload.backpressuredConnections < 1) {
	fail('no connection counted as backpressured while one was paused under a firehose');
}
if (overload.droppedFrames === 0) {
	fail('nothing was shed at the maxBackpressure ceiling - flow control did not engage');
}

// Stage 3: recovery - the consumer resumes; queues drain, the next windows
// report clean.
slow._socket.resume();
const t0 = Date.now();
let recovered = null;
while (Date.now() - t0 < 8000) {
	await new Promise((r) => setTimeout(r, 1100));
	const s = platform.pressure;
	if (s.maxBufferedBytes === 0 && s.droppedFrames === 0 && s.backpressuredConnections === 0) {
		recovered = Date.now() - t0;
		break;
	}
}
if (recovered === null) {
	fail('the paused consumer never recovered to a clean snapshot within 8s of resuming');
} else {
	console.log(`recovery: clean snapshot after ${recovered}ms`);
}

for (const ws of clients) ws.terminate();
await rt.handler.shutdown({ timeoutMs: 2000 });
payload.cleanup();

if (process.exitCode !== 1) {
	console.log('SLOW-CONSUMER BENCH PASSED: backpressure observed, shed at the ceiling, recovered.');
}
