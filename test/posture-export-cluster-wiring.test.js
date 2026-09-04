// Who owns the posture export's socket, pinned against the source.
//
// The export is one filesystem path and the option is a build-time constant, so
// every worker used to evaluate the same install: each unlinked the previous
// owner's socket and bound its own, only the last to bind stayed reachable, and
// the first worker to shut down removed whichever socket was live. A consumer
// then read one bind-order-chosen thread's posture and believed it was the
// server's, which is worse than reading none - the export exists so an
// edge-defense daemon can act on it, and it would have acted on a quiet worker
// while a sibling was under siege.
//
// WHY SOURCE TEXT. The primary's half lives inside `if (is_primary)` in
// runtime/index.js, which is only entered with CLUSTER_WORKERS set, and this
// runtime refuses CLUSTER_WORKERS off Linux because SO_REUSEPORT cannot
// distribute accepts anywhere else (test/cluster-boot.test.js pins that
// refusal). The worker's half lives in handler/realtime.js, which cannot be
// imported at all: its build-substituted globals are free identifiers until
// the adapter emits the runtime. The aggregation rules themselves are driven
// directly in test/posture-collector.test.js.
//
// Every carve below asserts BOTH its anchors. A missed closing anchor makes
// `indexOf` return -1 and the slice widen to nearly the whole file, where a
// `not.toContain` gets easier to satisfy rather than harder.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** @param {string} rel */
function readSource(rel) {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const realtimeSource = readSource('../src/runtime/handler/realtime.js');
const indexSource = readSource('../src/runtime/index.js');

/** The source between two anchors, with BOTH anchors asserted. */
function block(source, from, to) {
	const start = source.indexOf(from);
	expect(start, `anchor not found: ${JSON.stringify(from)}`).toBeGreaterThan(-1);
	const end = source.indexOf(to, start + from.length);
	expect(end, `closing anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
		.toBeGreaterThan(-1);
	return source.slice(start, end);
}

function occurrences(source, pattern) {
	return [...source.matchAll(pattern)].length;
}

describe('a clustered worker reports its posture inward instead of binding', () => {
	const worker = block(
		realtimeSource,
		'const POSTURE_EXPORT = wsOptions.postureExport;',
		'\n/**'
	);

	it('decides on the topology, not on an environment variable of its own', () => {
		// `hasMultipleWorkers()` reads the worker count the primary threaded
		// into workerData, which is the same fact the cluster sequence policy
		// decides on. A second spelling of "am I clustered" is a second thing
		// to keep in step.
		expect(worker).toContain('if (parentPort && hasMultipleWorkers()) {');
		expect(realtimeSource).toContain("import { hasMultipleWorkers } from './cluster-sequence-policy.js';");
	});

	it('binds the socket on exactly one branch, and not the clustered one', () => {
		// The whole defect was N binders for one path. One call site in this
		// module, inside the single-process arm.
		expect(occurrences(realtimeSource, /startPostureExport\(/g), 'a second bind site appeared').toBe(1);
		const clustered = block(worker, 'if (parentPort && hasMultipleWorkers()) {', '\t} else {');
		expect(clustered, 'the clustered worker binds the socket itself').not.toContain('startPostureExport(');
		expect(clustered).toContain('counters.postureExporter = null;');
		const single = block(worker, '\t} else {', '\n\t}\n} else {');
		expect(single).toContain('const exporter = startPostureExport(exportPath, postureLine);');
		expect(single).toContain('counters.postureExportHook = () => exporter.broadcast();');
	});

	it('carries the path with the report, since the primary never sees the options', () => {
		const clustered = block(worker, 'if (parentPort && hasMultipleWorkers()) {', '\t} else {');
		expect(clustered).toContain(
			"parentPort.postMessage({ type: 'posture', threadId, path: exportPath, line: postureLine() });"
		);
		// The report is keyed by the reporting thread, so the import naming it is
		// what the pin is about - the list beside it grows with other lanes.
		expect(realtimeSource).toMatch(/import \{[^}]*\bparentPort\b[^}]*\bthreadId\b[^}]*\} from 'node:worker_threads';/);
		// A throw here would take down the sample that called it. The primary
		// being gone is already reported by the cadence stopping.
		expect(clustered).toMatch(/}\s*catch\s*{/);
	});

	it('reports once before the first sample, so a boot-time consumer is not met with silence', () => {
		const clustered = block(worker, 'if (parentPort && hasMultipleWorkers()) {', '\t} else {');
		const hookAssigned = clustered.indexOf('counters.postureExportHook = () => {');
		const hookCalled = clustered.indexOf('counters.postureExportHook();');
		expect(hookAssigned, 'the clustered arm no longer installs a hook').toBeGreaterThan(-1);
		expect(hookCalled, 'the clustered arm never sends its first report').toBeGreaterThan(-1);
		expect(hookCalled, 'the first report is sent before the hook it uses exists')
			.toBeGreaterThan(hookAssigned);
	});
});

describe('the primary owns the socket and serves the deployment', () => {
	const primary = block(
		indexSource,
		'const postureAggregate = createPostureAggregator();',
		'\n\t/** Answer every requester'
	);

	it('binds lazily, once, and never while shutting down', () => {
		// Binding is driven by a worker's report rather than by boot, because
		// the path is a per-build websocket option this thread never reads.
		expect(primary).toContain('if (postureExporter !== null || shutting_down) return;');
		expect(primary).toContain("if (typeof exportPath !== 'string' || exportPath.length === 0) return;");
		expect(primary).toContain('postureExporter = startPostureExport(exportPath, () => postureAggregate.line());');
		expect(occurrences(indexSource, /startPostureExport\(/g), 'the primary binds from more than one site').toBe(1);
	});

	it('drives the cadence itself at a fixed rate, and stops it when nothing is serving', () => {
		// Driving it from the workers' samples would make the cadence N lines a
		// second and a function of the worker count, when a consumer reads it
		// as a liveness signal.
		expect(primary).toContain('postureCadence = setIntervalTimer(() => {');
		expect(primary).toContain('}, 1000);');
		expect(primary).toContain('if (postureAggregate.line() === null) return;');
	});

	it('takes a worker report, and pushes immediately only on a transition', () => {
		const branch = block(indexSource, "} else if (msg.type === 'posture') {", "} else if (msg.type === 'publish') {");
		expect(branch).toContain('bindPostureExport(msg.path);');
		expect(branch).toContain('if (postureAggregate.note(msg.threadId, msg.line) && postureExporter !== null) {');
		expect(branch).toContain('postureExporter.broadcast();');
		// The bind has to happen before the note, or the very first report
		// arrives at an aggregate no socket is serving and is only seen a
		// cadence window later.
		expect(branch.indexOf('bindPostureExport('), 'the first report is noted before the socket exists')
			.toBeLessThan(branch.indexOf('postureAggregate.note('));
	});

	it('retires an exited worker from the aggregate', () => {
		// The aggregate is the WORST worker, so a thread that died in siege
		// would hold the whole deployment at siege for as long as the primary
		// runs.
		const death = block(indexSource, 'metricsCollections.retire(deadThreadId);', '\n\t\t\t// Release the relay rings');
		expect(death).toContain('postureAggregate.retire(deadThreadId);');
	});

	it('releases the path during shutdown, while this thread still owns it', () => {
		const shutdown = block(indexSource, 'closePostureExport();', '\n\t\t// Backstop, not the budget');
		expect(shutdown, 'the export is closed after the workers are told to exit')
			.toContain('// Step 3: tell workers to drain and exit.');
		expect(primary).toContain('clearIntervalTimer(postureCadence);');
		expect(primary).toContain('postureExporter.close();');
	});
});
