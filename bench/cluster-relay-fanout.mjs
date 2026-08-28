// The cluster relay fan-out bench: cross-worker publish latency against the
// single-process baseline. One client triggers a publish; every subscriber's
// receive latency is measured from the trigger send. In cluster mode the
// subscribers that landed on the OTHER worker can only have been reached
// through the primary's relay, so their column prices the relay hop itself.
//
// Run: node bench/cluster-relay-fanout.mjs
// Single-process runs everywhere; the cluster half needs Linux (SO_REUSEPORT)
// and reports SKIPPED elsewhere. Informational: it prints medians and tails,
// and fails only if delivery itself breaks.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { buildRuntime, bootRuntime } from '../test/helpers/build-runtime.js';
import WebSocket from 'ws';

const SUBSCRIBERS = 16;
const ROUNDS = 400;
const WARMUP_ROUNDS = 50;

const WS_OPTS = {
	allowedOrigins: '*',
	upgradeRateLimit: 0,
	authPathRateLimit: 0
};

const WS_HANDLER = `
import { threadId } from 'node:worker_threads';
export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'whoami') {
		platform.send(ws, 'sys', 'tid', threadId);
	} else if (cmd.cmd === 'publish') {
		platform.publish(cmd.topic, cmd.event, cmd.data, { seq: false });
	}
}
`;

function fail(message) {
	console.error('CLUSTER-RELAY BENCH FAILED: ' + message);
	process.exitCode = 1;
}

function quantile(sorted, q) {
	if (sorted.length === 0) return NaN;
	const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[at];
}

function report(label, samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const fmt = (v) => (v / 1e6).toFixed(3) + 'ms';
	console.log(
		`  ${label}: n=${sorted.length} p50=${fmt(quantile(sorted, 0.5))} ` +
		`p90=${fmt(quantile(sorted, 0.9))} p99=${fmt(quantile(sorted, 0.99))}`
	);
}

async function client(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw) => {
		const at = process.hrtime.bigint();
		let json = null;
		try { json = JSON.parse(raw.toString()); } catch { /* keep raw-only */ }
		const frame = { json, at };
		frames.push(frame);
		for (const waiter of waiters.splice(0)) waiter(frame);
	});
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	return {
		ws,
		send: (obj) => ws.send(JSON.stringify(obj)),
		next: (match) => new Promise((resolve, reject) => {
			const existing = frames.find(match);
			if (existing) { resolve(existing); return; }
			const timer = setTimeout(() => reject(new Error('frame timeout')), 8000);
			const check = (frame) => {
				if (match(frame)) { clearTimeout(timer); resolve(frame); }
				else waiters.push(check);
			};
			waiters.push(check);
		}),
		drain: () => { frames.length = 0; }
	};
}

async function subscribe(c, topic) {
	c.send({ type: 'subscribe', topic, ref: 1 });
	await c.next((f) => f.json?.type === 'subscribed' && f.json?.topic === topic);
}

/**
 * Run rounds against a booted server and return per-subscriber-class samples:
 * 'local' single-process, else 'same-worker' / 'relayed' relative to the
 * worker the publisher's connection landed on.
 * @param {number} port
 * @param {'single' | 'cluster'} mode
 */
async function measure(port, mode) {
	const publisher = await client(port);
	let publisherTid = null;
	if (mode === 'cluster') {
		publisher.send({ cmd: 'whoami' });
		publisherTid = (await publisher.next((f) => f.json?.event === 'tid')).json.data;
	}
	const subs = [];
	for (let i = 0; i < SUBSCRIBERS; i++) {
		const c = await client(port);
		if (mode === 'cluster') {
			c.send({ cmd: 'whoami' });
			const tid = (await c.next((f) => f.json?.event === 'tid')).json.data;
			c.klass = tid === publisherTid ? 'same-worker' : 'relayed';
		} else {
			c.klass = 'local';
		}
		await subscribe(c, 'bench.room');
		subs.push(c);
	}
	/** @type {Record<string, number[]>} */
	const samples = {};
	for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
		for (const c of subs) c.drain();
		const t0 = process.hrtime.bigint();
		publisher.send({ cmd: 'publish', topic: 'bench.room', event: 'tick', data: { round } });
		await Promise.all(subs.map(async (c) => {
			const frame = await c.next((f) => f.json?.event === 'tick' && f.json?.data?.round === round);
			if (round >= WARMUP_ROUNDS) {
				(samples[c.klass] ??= []).push(Number(frame.at - t0));
			}
		}));
	}
	publisher.ws.close();
	for (const c of subs) c.ws.close();
	return samples;
}

// --- single-process baseline -------------------------------------------------
console.log('single-process baseline:');
{
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	const rt = await bootRuntime(payload);
	try {
		const samples = await measure(rt.port, 'single');
		if (!samples.local || samples.local.length !== ROUNDS * SUBSCRIBERS) {
			fail('baseline delivery incomplete');
		}
		report('local (one process)', samples.local ?? []);
	} finally {
		await rt.close();
		payload.cleanup();
	}
}

// --- cluster: publisher-local vs relay-crossed -------------------------------
if (process.platform !== 'linux') {
	console.log('cluster half: SKIPPED (needs Linux SO_REUSEPORT accept distribution)');
} else {
	console.log('cluster (CLUSTER_WORKERS=2):');
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	const port = await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const p = probe.address().port;
			probe.close(() => resolve(p));
		});
	});
	const proc = spawn(process.execPath, [path.join(payload.dir, 'index.js')], {
		env: { ...process.env, CLUSTER_WORKERS: '2', HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT: '5' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let out = '';
	proc.stdout.on('data', (c) => { out += c; });
	proc.stderr.on('data', (c) => { out += c; });
	const exited = new Promise((resolve) => proc.on('exit', resolve));
	try {
		await new Promise((resolve, reject) => {
			const t0 = Date.now();
			const poll = () => {
				if ((out.match(/listening on :\d+/g) || []).length >= 2) { resolve(undefined); return; }
				if (Date.now() - t0 > 30000) { reject(new Error('fleet boot timeout\n' + out)); return; }
				setTimeout(poll, 50);
			};
			poll();
		});
		const samples = await measure(port, 'cluster');
		const total = (samples['same-worker']?.length ?? 0) + (samples.relayed?.length ?? 0);
		if (total !== ROUNDS * SUBSCRIBERS) fail('cluster delivery incomplete');
		if (samples['same-worker']) report("publisher's own worker", samples['same-worker']);
		if (samples.relayed) report('crossed the relay', samples.relayed);
	} finally {
		proc.kill('SIGTERM');
		await exited;
		payload.cleanup();
	}
}

console.log(process.exitCode ? 'BENCH FAILED' : 'BENCH COMPLETE');
