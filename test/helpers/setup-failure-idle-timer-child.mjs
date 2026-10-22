import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { startRealRuntime, connectRealClient } from './real-runtime.js';

// The fixture builds with the default idleTimeout of 120 s, so each
// connection's idle interval ticks every 60 s.
const IDLE_HALF_MS = 60000;
const failPoint = process.argv[2];

/** @type {Set<any>} */
const liveIdleIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = function (cb, ms, ...args) {
	const handle = realSetInterval(cb, ms, ...args);
	if (ms === IDLE_HALF_MS) liveIdleIntervals.add(handle);
	return handle;
};
globalThis.clearInterval = function (handle) {
	liveIdleIntervals.delete(handle);
	return realClearInterval(handle);
};

// One-shot throw from the server socket's listener registration for the
// chosen event, so connection setup fails after the 101 at that point. Only
// a registration after the runtime's pong listener counts: ws itself adds a
// 'close' listener for client tracking before handing the socket over.
let armed = false;
const realOn = EventEmitter.prototype.on;
EventEmitter.prototype.on = function (event, listener) {
	if (armed && event === failPoint && this?._isServer === true && this.listenerCount('pong') > 0) {
		armed = false;
		throw new Error('fixture listener registration failed');
	}
	return realOn.call(this, event, listener);
};

async function until(predicate, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= deadline) return false;
		await new Promise(r => setTimeout(r, 10));
	}
	return true;
}

const server = await startRealRuntime({ variant: 'setupfailure' });
let healthy;
try {
	const baseline = liveIdleIntervals.size;

	// Positive control: a healthy connection arms exactly one idle interval
	// and its close clears it.
	const warmup = await connectRealClient(server.wsUrl);
	assert.ok(await warmup.waitFor(frame => frame?.topic === 'probe'), 'warmup opened');
	assert.equal(liveIdleIntervals.size, baseline + 1, 'an open connection arms one idle interval');
	const warmupClosed = once(warmup.ws, 'close');
	warmup.close();
	await warmupClosed;
	assert.ok(await until(() => liveIdleIntervals.size === baseline), 'close clears the idle interval');

	armed = true;
	const failing = new WebSocket(server.wsUrl);
	let accepted = false;
	failing.once('open', () => { accepted = true; });
	const [code, reason] = await once(failing, 'close');
	assert.equal(armed, false, 'the injected failure fired');
	assert.equal(accepted, true, 'failure happened after the 101 handshake');
	assert.equal(code, 1011);
	assert.equal(reason.toString(), 'Connection setup failed');

	// The only-one-connection gate admits a fresh client once the failed
	// setup released its permit; by then the failed socket is fully gone.
	healthy = await connectRealClient(server.wsUrl);
	assert.ok(await healthy.waitFor(frame => frame?.topic === 'probe'), 'healthy client opened');
	assert.equal(liveIdleIntervals.size, baseline + 1, 'no idle interval survives the failed setup');
	console.log('SETUP_FAILURE_IDLE_TIMER_CLEAN');
} finally {
	healthy?.close();
	await server.stop();
	EventEmitter.prototype.on = realOn;
}
