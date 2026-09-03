// A booted worker must satisfy the merge's completeness rule, and this is the
// assertion that distinguishes the metrics lane landing from half-landing.
//
// src/runtime/utils/metrics-merge.js counts a worker toward
// `metrics_snapshot_workers_reporting` only when every required worker counter
// FAMILY is registered and every required worker GAUGE carries a real numeric
// sample. A partial landing therefore does not look partial: it produces a
// document reporting 0 of N workers, which reads as a total cluster failure and
// fires the shipped alert pack on a healthy fleet.
//
// The required sets are derived from the manifest here rather than restated, so
// a signal added upstream widens this test instead of silently escaping it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { SIGNALS } from '../src/runtime/observability-manifest.js';
import { METRIC_REGISTRATIONS_SAMPLE } from '../src/runtime/utils/metrics.js';
import { mergeSamples } from '../src/runtime/utils/metrics-merge.js';

// A registry shaped like the `metrics` option contract, recording what the
// runtime asks it for.
const REGISTRY_SRC = `
const counters = new Map();
const gauges = new Map();
const histograms = new Map();
export default {
	counter(name) {
		let c = counters.get(name);
		if (c === undefined) { c = { inc() {} }; counters.set(name, c); }
		return c;
	},
	gauge(name) {
		let g = gauges.get(name);
		if (g === undefined) { g = { set() {} }; gauges.set(name, g); }
		return g;
	},
	histogram(name) {
		let h = histograms.get(name);
		if (h === undefined) { h = { observe() {} }; histograms.set(name, h); }
		return h;
	},
	serialize() { return ''; }
};
`;

const WS_OPTS = {
	metrics: './metrics.js',
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
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

const REQUIRED = SIGNALS.filter((s) => s.merged !== true && s.optional !== true && s.scope === 'worker');
const REQUIRED_COUNTERS = REQUIRED.filter((s) => s.type === 'counter').map((s) => s.name);
const REQUIRED_GAUGES = REQUIRED.filter((s) => s.type !== 'counter').map((s) => s.name);

/** @type {any} */
let payload;
/** @type {any} */
let rt;
/** @type {any[]} */
let samples;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: 'export function message() {}\n',
		metricsRegistrySource: REGISTRY_SRC
	});
	rt = await bootRuntime(payload);
	// One request so the HTTP lane has something to have counted, then wait for
	// the 1 Hz sampler to fill every gauge. Polled to a deadline rather than
	// slept past: a fixed sleep is a guess about the sampler's phase on a busy
	// machine, and it fails as a missing gauge - which reads as this lane being
	// broken rather than as the test being early.
	await fetch(`${rt.origin}/__nonexistent`).catch(() => {});
	const deadline = Date.now() + 15000;
	for (;;) {
		samples = rt.handler.collectLocalMetrics();
		const sampled = new Set(samples.filter((s) => s && typeof s.value === 'number').map((s) => s.name));
		if (REQUIRED_GAUGES.every((n) => sampled.has(n))) break;
		if (Date.now() > deadline) break; // let the assertions name what is missing
		await new Promise((r) => setTimeout(r, 50));
	}
}, 60000);

afterAll(async () => {
	await rt?.close();
	payload?.cleanup?.();
});

describe('a booted worker reports a complete metrics document', () => {
	it('carries the registration inventory the merge needs to judge it at all', () => {
		// Without this marker the merge cannot prove registration and refuses to
		// count the worker, whatever else the report holds.
		const marker = samples.find((s) => s?.name === METRIC_REGISTRATIONS_SAMPLE);
		expect(marker, 'no registration marker in the report').toBeDefined();
		expect(Array.isArray(marker.families)).toBe(true);
	});

	it('registers every required worker counter family', () => {
		const marker = samples.find((s) => s?.name === METRIC_REGISTRATIONS_SAMPLE);
		const registered = new Set(marker?.families ?? []);
		const missing = REQUIRED_COUNTERS.filter((n) => !registered.has(n));
		// Registration is all-or-nothing: the merge treats a registered counter
		// with no events as a truthful zero, but an unregistered family makes the
		// whole worker incomplete.
		expect(missing, 'required counter families not registered').toEqual([]);
	});

	it('samples every required worker gauge with a real number', () => {
		const sampled = new Set(
			samples.filter((s) => s && typeof s.value === 'number').map((s) => s.name)
		);
		const missing = REQUIRED_GAUGES.filter((n) => !sampled.has(n));
		// A gauge cannot be inferred from registration - the merge wants a real
		// reading, which only the sampler hook can produce.
		expect(missing, 'required gauges carrying no numeric sample').toEqual([]);
	});

	it('counts itself toward metrics_snapshot_workers_reporting', () => {
		// The end-to-end statement, through the merge's own judgement rather than
		// a restatement of its rule.
		const doc = mergeSamples([{ worker: 1, samples }], { expected: 1, reporting: 1 });
		const line = String(doc)
			.split('\n')
			.find((l) => l.startsWith('metrics_snapshot_workers_reporting'));
		expect(line, 'no reporting line in the merged document').toBeDefined();
		expect(line).toBe('metrics_snapshot_workers_reporting 1');
	});

	it('gives every required signal a non-empty HELP line on a booted worker', () => {
		// The sentence an operator reads to interpret a number, asserted where
		// they actually meet it: the document a real worker produces.
		//
		// Deliberately NOT compared against the manifest text. The renderer
		// reads its help from the manifest too, so an equality check moves with
		// whatever it is meant to be checking and cannot fail - proved by
		// rewording an entry and watching that version stay green. What this
		// asserts instead is that the line is THERE and carries a sentence: a
		// signal absent from the document, or emitted with an empty help, is a
		// number an operator meets with nothing to read it by.
		const doc = String(mergeSamples([{ worker: 1, samples }], { expected: 1, reporting: 1 }));
		const helpFor = new Map();
		for (const line of doc.split('\n')) {
			const m = /^# HELP (\S+) (.*)$/.exec(line);
			if (m) helpFor.set(m[1], m[2]);
		}
		const missing = REQUIRED.filter((s) => !helpFor.has(s.name)).map((s) => s.name);
		expect(missing, 'required signals with no HELP line in the rendered document').toEqual([]);
		const blank = REQUIRED.filter((s) => (helpFor.get(s.name) || '').trim() === '').map((s) => s.name);
		expect(blank, 'required signals whose rendered HELP is empty').toEqual([]);
	});
});

// The outcome family answers "did this publish reach anyone", and every lane
// in the family has to answer it the same way. The single-publish lanes deduct
// an excluded socket that holds the topic; the two batch lanes read the bare
// subscriber count, so a publish that reached nobody counted as delivered.
// "Broadcast to the room excluding the sender" makes that every publish into a
// room of one.
describe('the outcome family counts a publish that reached nobody as no_subscribers', () => {
	const DRIVER = `
export function open() {}
export function close() {}
export function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd !== 'drive') return;
	// Every call excludes the only subscriber, so nothing reaches a socket.
	platform.publish('solo', 'e', 1, { excludeWs: ws });
	platform.publishBatched([
		{ topic: 'solo', event: 'a', data: 1, options: { excludeWs: ws } },
		{ topic: 'solo', event: 'b', data: 2, options: { excludeWs: ws } }
	]);
	platform.send(ws, 'outcome', 'done', { ok: true });
}
`;

	it('deducts the excluded socket on the batch lanes too', async () => {
		const built = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: DRIVER,
			metricsRegistrySource: REGISTRY_SRC
		});
		const server = await bootRuntime(built);
		const { default: WebSocket } = await import('ws');
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		/** @type {any[]} */
		const frames = [];
		ws.on('message', (raw, isBinary) => {
			if (isBinary) return;
			try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
		});
		try {
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
			ws.send(JSON.stringify({ type: 'subscribe', topic: 'solo', ref: 1 }));
			await new Promise((res) => {
				const tick = () => (frames.some((f) => f?.type === 'subscribed') ? res(undefined) : setTimeout(tick, 5));
				tick();
			});
			ws.send(JSON.stringify({ cmd: 'drive' }));
			await new Promise((res) => {
				const tick = () => (frames.some((f) => f?.topic === 'outcome') ? res(undefined) : setTimeout(tick, 5));
				tick();
			});

			const out = server.handler.collectLocalMetrics()
				.filter((s) => s?.name === 'ws_publish_outcomes_total');
			const by = (v) => out
				.filter((s) => s.labels && s.labels.outcome === v)
				.reduce((n, s) => n + s.value, 0);
			// Three logical publishes, none of which reached a socket.
			expect(by('delivered'), 'a publish nobody received counted as delivered').toBe(0);
			expect(by('no_subscribers')).toBe(3);
		} finally {
			ws.close();
			await server.close();
			built.cleanup();
		}
	}, 60000);
});
