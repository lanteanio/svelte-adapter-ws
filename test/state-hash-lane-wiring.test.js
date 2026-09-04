// The cross-worker state-hash lane, pinned where it is wired.
//
// The lane exists to catch a publish that reached some workers and not another.
// Everything about it is arranged so that it can only ever report a real
// disagreement, and almost every way of getting it wrong produces a lane that
// reports nothing and looks healthy:
//
//   - jitter the PERIOD instead of the first fire and workers drift out of the
//     primary's epoch bucket, so a bucket never fills and nothing is ever
//     judged - a silent false negative in the one mechanism that exists to
//     catch silent divergence;
//   - let a still-booting worker into the live set and it either stalls every
//     bucket or is judged a phantom minority;
//   - leave an exited worker in the detector and its bucket never fills again;
//   - put the quiet lane on the restart path and an ordinary respawn, which
//     legitimately holds none of its siblings' quiet history, becomes a kill
//     loop on an idle cluster.
//
// WHY SOURCE TEXT. The primary half lives inside `if (is_primary)` in
// runtime/index.js, entered only with CLUSTER_WORKERS set, and this runtime
// refuses CLUSTER_WORKERS off Linux because SO_REUSEPORT cannot distribute
// accepts (test/cluster-boot.test.js pins that refusal). The worker half lives
// in handler/realtime.js, which cannot be imported: its build-substituted
// globals are free identifiers until the adapter emits the runtime. The
// detector's own decision rules are driven directly in
// test/state-hash-detector.test.js, and the map it hashes in
// test/state-convergence.test.js.
//
// Every carve asserts BOTH anchors: a missed closing anchor widens the slice to
// nearly the whole file, where a negative assertion gets easier to satisfy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** @param {string} rel */
function readSource(rel) {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const realtime = readSource('../src/runtime/handler/realtime.js');
const index = readSource('../src/runtime/index.js');

/** The source between two anchors, with BOTH anchors asserted. */
function block(source, from, to) {
	const start = source.indexOf(from);
	expect(start, `anchor not found: ${JSON.stringify(from)}`).toBeGreaterThan(-1);
	const end = source.indexOf(to, start + from.length);
	expect(end, `closing anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
		.toBeGreaterThan(-1);
	return source.slice(start, end);
}

const reporter = block(
	realtime,
	'const STATE_HASH_INTERVAL_MS = wsOptions.stateHashIntervalMs ?? 0;',
	'\nconst messageAdmission ='
);

describe('the worker reports, and only where there is someone to disagree with', () => {
	it('is off by default and off in a single process', () => {
		// Two conditions, not one: an interval with no siblings would schedule a
		// timer that reports into nothing, and siblings with no interval is the
		// documented default.
		expect(reporter).toContain('if (parentPort && STATE_HASH_INTERVAL_MS > 0) {');
		expect(realtime).toContain('const STATE_HASH_INTERVAL_MS = wsOptions.stateHashIntervalMs ?? 0;');
	});

	it('jitters the FIRST report and holds the period constant', () => {
		// The whole trap. A per-worker phase spreads the herd; a per-worker
		// PERIOD spreads the workers across buckets that then never fill, and a
		// lane that never judges anything reports no divergence forever.
		expect(reporter).toContain('const firstReportDelay = randomFloat() * STATE_HASH_INTERVAL_MS;');
		expect(reporter).toContain('const stateHashKickoff = setTimer(() => {');
		expect(reporter).toContain('const stateHashTimer = setIntervalTimer(reportStateHash, STATE_HASH_INTERVAL_MS);');
		// Every repeating timer in this lane, listed - so a second one, or one
		// whose period is a jittered local rather than the constant, fails by
		// showing what it became. A negative lookahead would not: `\s*` can
		// backtrack to zero width and satisfy it against the correct call.
		expect(
			reporter.match(/setIntervalTimer\([^)]*\)/g) ?? [],
			'the reporting PERIOD is jittered, so workers drift out of the shared bucket'
		).toEqual(['setIntervalTimer(reportStateHash, STATE_HASH_INTERVAL_MS)']);
		// And the jitter is drawn from the injectable RNG, so a seeded harness
		// reproduces the phase rather than being flaky about it.
		expect(realtime).toMatch(/import \{[^}]*\brandomFloat\b[^}]*\} from '\.\.\/runtime\.js';/);
	});

	it('holds neither timer open', () => {
		// A clustered process that will not exit is the failure an unref'd
		// reporter avoids; both the one-shot and the repeat need it.
		expect(reporter).toContain('if (stateHashTimer.unref) stateHashTimer.unref();');
		expect(reporter).toContain('if (stateHashKickoff.unref) stateHashKickoff.unref();');
	});

	it('reports structure only, keyed by the reporting thread', () => {
		expect(reporter).toContain(
			"parentPort.postMessage({ type: 'state-hash', hash, quietHash, threadId, intervalMs: STATE_HASH_INTERVAL_MS });"
		);
		// The two halves are hashed apart, or the quiet lane could not be
		// log-only while the active lane carries restart authority.
		expect(reporter).toContain('const { active, quiet } = partitionActiveTopics(maxSeenSeq, reporterPrevSeqs, reporterLastChanged, reporterTick);');
		expect(reporter).toContain('const hash = computeStateHash({ topicSeqs: active });');
		expect(reporter).toContain('const quietHash = computeStateHash({ topicSeqs: quiet });');
		// The interval rides the report because the primary sizes its bucket
		// from it and never sees the per-build websocket options.
		expect(reporter).toContain('intervalMs: STATE_HASH_INTERVAL_MS');
	});

	it('lends the registry bound its activity window', () => {
		// The bound may forget a subscriber-free topic to stay inside its
		// ceiling, and a sibling that still holds it then hashes differently.
		// Safe only while the topic is QUIET - the active lane can restart a
		// worker over a disagreement - so eviction must not take a topic whose
		// seq moved inside the reporter's window.
		// The WHOLE line, so a probe neutralized in place - `if (false) seqBound
		// .useQuietProbe(...)` - fails here rather than satisfying a needle that
		// only asks whether the call is written down somewhere.
		expect(reporter).toContain('\n\tseqBound.useQuietProbe((topic) => {');
		expect(reporter).toContain('return changedAt !== undefined && reporterTick - changedAt > 1;');
	});

	it('raises its own counter from the notice, since the primary owns no registry', () => {
		expect(reporter).toContain("mStateDivergence?.inc({ role: msg.role === 'minority' ? 'minority' : 'majority' });");
		// The keyed snapshot is a cold path taken only after the aggregate has
		// fired, and it is capped by this worker's own limit so a bad primary
		// message cannot inflate it.
		expect(reporter).toContain('? Math.min(msg.topicLimit, DIVERGENCE_TOPIC_LIMIT)');
		expect(reporter).toContain('workerData?.divergenceDiagnosticKey');
	});
});

describe('the primary judges a bucket once every live worker has reported', () => {
	const arm = block(index, "} else if (msg.type === 'state-hash') {", "} else if (msg.type === 'state-divergence-detail') {");

	it('constructs the detector with an epoch width and the primary clock', () => {
		expect(index).toContain('const stateHashDetector = createStateHashDetector({ epochMs: state_hash_epoch_ms > 0 ? state_hash_epoch_ms : 60000, monotonicNow });');
	});

	it('counts only workers that have confirmed themselves alive', () => {
		// A still-booting worker (lastHeartbeat 0) can neither stall a bucket
		// nor be judged a phantom minority.
		expect(arm).toContain('for (const [w, m] of workers) if (m.lastHeartbeat > 0) liveThreadIds.push(w.threadId);');
	});

	it("sizes the bucket from the worker's advertised period, not from a guess", () => {
		// Twice the period, so one fixed-period round from every worker lands in
		// one bucket. This is the half of the jitter contract that lives here.
		expect(arm).toContain('const epochMs = state_hash_epoch_ms > 0');
		expect(arm).toContain(': 2 * (msg.intervalMs > 0 ? msg.intervalMs : 30000);');
	});

	it('runs the quiet lane first and never lets it restart anyone', () => {
		const quiet = block(arm, "if (typeof msg.quietHash === 'number') {", 'const divergence = stateHashDetector.record(');
		expect(quiet).toContain('stateHashDetector.recordQuiet(msg.threadId, msg.quietHash, liveThreadIds, epochMs);');
		expect(quiet).toContain("event: 'divergence.quiet-state',");
		expect(quiet, 'the quiet lane can terminate a worker').not.toContain('requestWorkerExit');
		// Counts and an epoch only: the record must not carry topic evidence.
		expect(quiet, 'the quiet record carries a diagnostic id, which is the active lane\'s shape')
			.not.toContain('diagnosticId');
	});

	it('names only an opaque id in the log, and keeps the evidence behind it', () => {
		expect(arm).toContain('const diagnosticId = beginDivergenceCollection(divergence, liveThreadIds);');
		expect(arm).toContain('attributes: { diagnosticId }');
		// Per-thread hashes and keyed summaries are identifier-bearing, so the
		// production signal must not carry them.
		expect(arm, 'the divergence log line carries per-thread evidence')
			.not.toMatch(/attributes:\s*\{[^}]*\bhash\b/);
	});

	it('terminates a minority worker only behind the explicit switch', () => {
		expect(arm).toContain('if (restart_on_state_divergence) {');
		const gated = arm.slice(arm.indexOf('if (restart_on_state_divergence) {'));
		expect(gated).toContain('requestWorkerExit(w, 1);');
		// One reader of the env var, so the gate cannot be half-applied.
		expect(index).toContain("const restart_on_state_divergence = env('RESTART_ON_STATE_DIVERGENCE', '') === '1';");
		expect([...index.matchAll(/requestWorkerExit\(w, 1\)/g)].length, 'a second ungated termination site appeared').toBe(1);
	});

	it('drops an exited worker from the comparison', () => {
		// A thread that will never report again must not hold a bucket open, or
		// the lane stops judging the workers that are still alive.
		const death = block(index, 'postureAggregate.retire(deadThreadId);', '\n\t\t\t// Release the relay rings');
		expect(death).toContain('stateHashDetector.forget(deadThreadId);');
	});

	it('replays retained records to a worker only once it is ready', () => {
		// Ready means the handler graph has installed its listener; replaying
		// earlier lets the boot-time control backlog eat the message.
		expect(index).toContain('const replayDivergenceDiagnostics = () => {');
		const ready = block(index, "if (msg.type === 'ready') {", "} else if (msg.type === 'heartbeat-ack') {");
		expect(ready).toContain('replayDivergenceDiagnostics();');
	});

	it('accepts second-stage evidence only from a thread the collection expected', () => {
		const detail = block(index, "} else if (msg.type === 'state-divergence-detail') {", "} else if (msg.type === 'metrics-request') {");
		expect(detail).toContain('entry.expectedThreadIds.includes(reporter)');
		expect(detail).toContain('if (entry.reports.size === entry.expectedThreadIds.length) {');
	});
});
