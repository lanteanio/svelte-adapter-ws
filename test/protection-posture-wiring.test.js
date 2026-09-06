// Follower-only coverage for the protection posture where it is wired into
// THIS transport, which the ported lead suites cannot reach:
//
//   - the live 1 Hz sampler in handler/pressure.js is the only sampler this
//     adapter runs, and it is the one that layers CAPACITY, ticks the posture
//     and drives the export heartbeat,
//   - the production upgrade path in handler/realtime.js runs a per-IP
//     limiter the createTestServer harness does not, so the one branch that
//     must NOT feed the escalation has no live driver anywhere else, and
//   - handler/realtime.js and handler/platform.js cannot be imported (their
//     build-substituted globals are free identifiers until the adapter emits
//     the runtime), so those wiring facts are pinned against the source.
//
// The state machine itself is covered in protection-posture-unit.test.js and
// its live coupling in protection-posture.test.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizePressureThresholds, samplePressureOnce } from '../src/runtime/handler/pressure.js';
import { counters, pressureListeners, pressureSnapshot, publishRateListeners, topicPublishStats } from '../src/runtime/handler/state.js';
import { createPosture } from '../src/runtime/utils/pressure.js';
import { createUpgradeAdmission } from '../src/runtime/utils/upgrade-admission.js';

// Publish rate is the cheapest signal to drive from outside: one counter, no
// connection set to populate. Every other signal is disabled so the sample's
// reason is exactly what this test put there.
const THRESHOLDS = normalizePressureThresholds({
	publishRatePerSec: 1,
	memoryHeapUsedRatio: false,
	subscriberRatio: false,
	psiCpuSome: false,
	psiMemoryFull: false,
	psiIoFull: false,
	cpuThrottledRatio: false
});

/** Drive one sample with (or without) publish load. */
function sample(active) {
	counters.publishCountWindow = active ? 10 : 0;
	samplePressureOnce(THRESHOLDS);
}

beforeEach(() => {
	counters.activePosture = null;
	counters.postureExportHook = null;
	counters.lastBasePressureReason = 'NONE';
	counters.publishCountWindow = 0;
	counters.totalSubscriptions = 0;
	counters.leaseSaturationPeak = 0;
	counters.droppedFramesWindow = 0;
	counters.droppedBytesWindow = 0;
	counters.egressDeliveriesWindow = 0;
	counters.egressBytesWindow = 0;
	counters.egressRefusedTopicWindow = 0;
	counters.egressRefusedTenantWindow = 0;
	topicPublishStats.clear();
	pressureListeners.clear();
	publishRateListeners.clear();
	pressureSnapshot.reason = 'NONE';
	pressureSnapshot.active = false;
});

describe('the live sampler carries the posture', () => {
	it('leaves the snapshot untouched while no posture is engaged', () => {
		sample(true);
		expect(pressureSnapshot.reason).toBe('PUBLISH_RATE');
		sample(false);
		expect(pressureSnapshot.reason).toBe('NONE');
	});

	it('layers CAPACITY onto the reported reason once the posture is engaged', () => {
		counters.activePosture = createPosture({
			admission: createUpgradeAdmission({ maxConcurrent: 2 }),
			getThresholds: () => THRESHOLDS,
			pin: 'elevated'
		});
		sample(false);
		// The base reason is NONE on an idle worker; the engaged posture is what
		// makes the snapshot report CAPACITY.
		expect(counters.lastBasePressureReason).toBe('NONE');
		expect(pressureSnapshot.reason).toBe('CAPACITY');
		expect(pressureSnapshot.active).toBe(true);
	});

	it('keeps MEMORY ahead of CAPACITY, and records the base reason unlayered', () => {
		counters.activePosture = createPosture({
			admission: createUpgradeAdmission({ maxConcurrent: 2 }),
			getThresholds: () => THRESHOLDS,
			pin: 'siege'
		});
		// A zero memory threshold fires on any reading, which is the cheapest
		// way to force the MEMORY branch without filling a heap.
		const memoryThresholds = normalizePressureThresholds({
			memoryHeapUsedRatio: 0,
			publishRatePerSec: false,
			subscriberRatio: false,
			psiCpuSome: false,
			psiMemoryFull: false,
			psiIoFull: false,
			cpuThrottledRatio: false
		});
		samplePressureOnce(memoryThresholds);
		expect(counters.lastBasePressureReason).toBe('MEMORY');
		expect(pressureSnapshot.reason).toBe('MEMORY');
	});

	it('ticks the posture from the BASE reason, so an auto level can still relax', () => {
		counters.activePosture = createPosture({
			admission: createUpgradeAdmission({ maxConcurrent: 2 }),
			getThresholds: () => THRESHOLDS
		});
		// Sustained publish load escalates to elevated.
		for (let i = 0; i < 5; i++) sample(true);
		expect(counters.activePosture.level).toBe('elevated');
		// From here the REPORTED reason is CAPACITY on every sample. Ticking on
		// that layered reason would mean the machine never sees a calm sample
		// and the level could never come back down; ticking on the base reason
		// relaxes it. A long quiet stretch is the discriminator.
		sample(false);
		expect(pressureSnapshot.reason).toBe('CAPACITY');
		expect(counters.lastBasePressureReason).toBe('NONE');
		for (let i = 0; i < 20; i++) sample(false);
		expect(counters.activePosture.level).toBe('normal');
		expect(pressureSnapshot.reason).toBe('NONE');
	});

	it('pushes the export heartbeat once per sample, and only when one is configured', () => {
		let pushes = 0;
		sample(false);
		expect(pushes).toBe(0);
		counters.postureExportHook = () => { pushes++; };
		sample(false);
		sample(true);
		sample(false);
		expect(pushes).toBe(3);
	});
});

/**
 * Read a source with its line endings normalized.
 *
 * The anchors below are written with LF, and this repo checks out CRLF under
 * git's autocrlf - so an anchor spanning a line break matches only on whichever
 * of the two the working tree happens to hold. Normalizing here is what keeps
 * these pins from passing locally and failing on a fresh clone.
 *
 * @param {string} rel
 * @returns {string}
 */
function readSource(rel) {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const realtimeSource = readSource('../src/runtime/handler/realtime.js');
const platformSource = readSource('../src/runtime/handler/platform.js');
const lifecycleSource = readSource('../src/runtime/handler/lifecycle.js');

/** The source between two anchors, so a branch is asserted on its own text. */
function block(source, from, to) {
	const start = source.indexOf(from);
	expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
	const end = source.indexOf(to, start + from.length);
	expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(-1);
	return source.slice(start, end);
}

function occurrences(source, pattern) {
	return [...source.matchAll(pattern)].length;
}

describe('the production upgrade path counts each refusal on the right accumulator', () => {
	it('has exactly the four capacity reject sites and the one rate-limit site', () => {
		// Four capacity sites: the siege short-circuit, the handshake ceiling,
		// the deferred-queue overflow, and the live-connection permit. A fifth
		// would mean a refusal was counted twice, or the per-IP branch was
		// wired to the wrong accumulator.
		expect(occurrences(realtimeSource, /\.recordCapacityReject\(\)/g)).toBe(4);
		expect(occurrences(realtimeSource, /\.recordRateLimitReject\(\)/g)).toBe(1);
	});

	it('records the per-IP 429 as a rate-limit reject, never as capacity pressure', () => {
		// An attack-driven 429 storm must never push the posture toward siege:
		// createPosture keeps the two accumulators apart deliberately, and this
		// is the only branch in the file that must land on the inert one. The
		// harness runs no per-IP limiter, so nothing else can observe it.
		const rateLimit = block(
			realtimeSource,
			'if (upgradeRateLimiter.exceeded(clientIp, now())) {',
			'\n\t}'
		);
		expect(rateLimit).toContain('recordRateLimitReject()');
		expect(rateLimit).not.toContain('recordCapacityReject()');
		expect(rateLimit).toContain("noteUpgradeRejection(headers, 'ip_rate_limit')");
	});

	it('refuses at siege before any slot is acquired', () => {
		const siege = block(
			realtimeSource,
			"if (postureLevel() === 'siege') {",
			'\n\t}'
		);
		expect(siege).toContain('recordCapacityReject()');
		expect(siege).toContain("noteUpgradeRejection(null, 'siege')");
		expect(siege).toContain('serveUpgradeRefusal()');
		expect(siege).not.toContain('tryAcquire');
		// Placement is the whole point: a short-circuit that ran after the gate
		// had taken a slot would hold one per refused upgrade.
		expect(realtimeSource.indexOf("if (postureLevel() === 'siege') {"))
			.toBeLessThan(realtimeSource.indexOf('const handshakeAcquired ='));
	});

	it('counts the handshake ceiling, the deferred overflow and the connection permit as capacity', () => {
		expect(block(realtimeSource, 'if (!handshakeAcquired) {', '\n\t}'))
			.toContain('recordCapacityReject()');
		expect(block(realtimeSource, 'function rejectDeferredOverflow() {', '\n\t}'))
			.toContain('recordCapacityReject()');
		expect(block(realtimeSource, 'if (!admission.tryAcquireConnection()) {', '\n\t}'))
			.toContain('recordCapacityReject()');
	});

	it('widens the refusal Retry-After band with the posture', () => {
		const retryAfter = block(realtimeSource, 'function refusalRetryAfter() {', '\n}');
		expect(retryAfter).toContain('const lvl = postureLevel();');
		expect(retryAfter).toContain("lvl === 'siege' ? 1.5 : lvl === 'elevated' ? 1.0 : 0.5");
		expect(retryAfter).toContain('WAITING_ROOM.jitteredRetryAfter(spread)');
		expect(retryAfter).toContain('jitterRetryAfter(REFUSAL_RETRY_AFTER_SECONDS, spread)');
	});

	it('answers a browser navigation to the WebSocket path the way the upgrade door answers', () => {
		// Without the posture test a sieged server hands a navigation
		// `426 upgrade required` and then refuses the upgrade it just asked for.
		// The siege test sits OUTSIDE the armed guard because the upgrade
		// short-circuit refuses on posture alone: gating it behind
		// ADMISSION_ARMED reinstates the mismatch for a deployment that pins
		// siege and configures no ceiling. Both halves are driven live in
		// test/protection-posture-live.test.js; this pins the shape that makes
		// the unarmed case reachable at all.
		expect(block(realtimeSource, 'export function serveWsPathGet(', '\n}'))
			.toContain("if (postureLevel() !== 'siege' && (!ADMISSION_ARMED || admission.hasCapacity())) {");
	});

	it('holds the waiting room at siege and doubles the poll cadence it serves', () => {
		const room = block(realtimeSource, 'export function tryWaitingRoomRoute(', '\n}');
		expect(room).toContain("if (postureLevel() !== 'siege' && admission.hasCapacity()) {");
		expect(room).toContain("const pollAfterMs = postureLevel() === 'siege'");
		expect(room).toContain('WAITING_ROOM.pollIntervalMs * 2');
		// The served number is what the client honours, so the widened cadence
		// has to reach the body rather than only the local.
		expect(room).toContain("',\"pollAfterMs\":' + pollAfterMs");
	});
});

describe('the posture reaches the surfaces that report and tear it down', () => {
	it('reads platform.protection through the live machine', () => {
		const getter = block(platformSource, '\tget protection() {', '\n\t},');
		expect(getter).toContain("counters.activePosture !== null ? counters.activePosture.level : 'normal'");
	});

	it('stops both auditors when the drain begins and drops the export only at the end', () => {
		// The auditors report to nobody outside the process, so nothing is owed
		// them once the drain starts. The export is the opposite: its steady
		// cadence is documented as a liveness signal, so cutting it at
		// beginDrain would report the adapter gone while this worker is still
		// serving every connection it has left.
		const teardown = block(lifecycleSource, 'async function performShutdown(opts) {', 'const server = httpServer;');
		expect(teardown).toContain('counters.consistencyAuditor?.stop();');
		expect(teardown).toContain('counters.consistencyAuditor = null;');
		expect(teardown).toContain('counters.resourceGrowthAuditor?.stop();');
		expect(teardown).toContain('counters.resourceGrowthAuditor = null;');
		expect(teardown).not.toContain('counters.postureExporter?.close();');

		const closer = block(lifecycleSource, 'function closePostureExport() {', '\n}');
		expect(closer).toContain('counters.postureExporter?.close();');
		expect(closer).toContain('counters.postureExporter = null;');
		expect(closer).toContain('counters.postureExportHook = null;');
		// Called after the listener is closed and the drain has been awaited,
		// and on the no-server path too so a boot that never listened still
		// removes its socket.
		expect(lifecycleSource).toMatch(/await listenerClosed;\s*\r?\n(\s*\/\/[^\n]*\n)*\s*closePostureExport\(\);/);
	});

	it('assigns the export holders on both branches so a re-run drops a stale hook', () => {
		const exportBlock = block(realtimeSource, 'const POSTURE_EXPORT = wsOptions.postureExport;', '\n}\n');
		expect(exportBlock).toContain('counters.postureExporter = exporter;');
		expect(exportBlock).toContain('counters.postureExportHook = () => exporter.broadcast();');
		expect(exportBlock).toContain('counters.postureExporter = null;');
		expect(exportBlock).toContain('counters.postureExportHook = null;');
		expect(exportBlock).toContain(
			'websocket.postureExport must be a socket path string or { path } (or omitted)'
		);
	});

	it('keeps the growth probes off the registries that grow with topic cardinality', () => {
		// topicSeqs and sharedTopics climb with topic count BY DESIGN, so
		// probing them would make the auditor self-fire a false leak.
		const probes = block(realtimeSource, 'probes: structuralResourceProbes({', '}),');
		expect(probes).toContain('wsConnections');
		expect(probes).toContain('topicPublishStats');
		expect(probes).toContain('lastPublishWarnAt');
		expect(probes).toContain('decodeCache');
		expect(probes).toContain('envelopePrefixCache');
		expect(probes).toContain('staticCache');
		expect(probes).not.toContain('topicSeqs');
		expect(probes).not.toContain('sharedTopics');
	});

	it('reads the live subscription total at call time, not at boot', () => {
		// A captured value freezes the cap accountant at zero and the
		// summed-bookkeeping cross-check then reports drift no membership
		// explains, on every tick, forever.
		const snapshot = block(realtimeSource, 'const buildAuditSnapshot = ', '});');
		expect(snapshot).toContain('totalSubscriptions: counters.totalSubscriptions,');
		expect(realtimeSource.indexOf('const buildAuditSnapshot = '))
			.toBeGreaterThan(realtimeSource.indexOf('setSubscriptionAccountingHook((delta)'));
	});
});
