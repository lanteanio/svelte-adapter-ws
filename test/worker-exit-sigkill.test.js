// A wedged worker is resolved by process death, the way the whole family
// resolves it: the primary asks the worker to exit, and one still alive when
// the exit grace expires takes the process down with a self-SIGKILL for the
// orchestrator to respawn. The one thread is never terminated in place. This
// pins the registry entry that documents it, the console line it composes,
// and the primary's wiring: the exit fallback, the hard exit with live
// workers, and the restart-limit site that uses it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY, adapterConsoleLine } from '../src/runtime/error-registry.js';

/** @param {string} id */
function entryFor(id) {
	const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === id);
	if (!entry) throw new Error('no registry entry for ' + id);
	return entry;
}

const indexSource = readFileSync(new URL('../src/runtime/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/**
 * The text between two anchors, with both asserted present so a missed anchor
 * fails here instead of widening the slice to the whole file.
 * @param {string} source @param {string} open @param {string} close
 */
function between(source, open, close) {
	const start = source.indexOf(open);
	expect(start, `anchor missing: ${open}`).toBeGreaterThanOrEqual(0);
	const end = source.indexOf(close, start + open.length);
	expect(end, `anchor missing after ${open}: ${close}`).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('ADAPTER-ERR-WORKER-EXIT-SIGKILL', () => {
	it('is the id the family declares for a wedged worker, and the only one', () => {
		expect(ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL).toBe('ADAPTER-ERR-WORKER-EXIT-SIGKILL');
		const ids = ADAPTER_ERROR_REGISTRY.map((e) => e.id);
		expect(ids).toContain('ADAPTER-ERR-WORKER-EXIT-SIGKILL');
		expect(ids.filter((id) => /WORKER-EXIT/.test(id))).toEqual(['ADAPTER-ERR-WORKER-EXIT-SIGKILL']);
	});

	it('the composed line names the worker under the indexed prefix', () => {
		const line = adapterConsoleLine(
			ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL,
			'7 did not exit within 5000ms; SIGKILLing the process'
		);
		expect(line.startsWith('[primary] worker 7 did not exit within 5000ms')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-WORKER-EXIT-SIGKILL]');
	});

	it('describes process death, not a per-worker replacement', () => {
		// Written in the per-worker form ("the supervisor replaces it"), the
		// entry would promise a recovery the mechanism cannot deliver.
		const entry = entryFor(ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL);
		expect(entry.event).toBe('cluster.worker-exit-sigkill');
		expect(entry.cause).toContain('WHOLE PROCESS');
		expect(entry.consequence).toMatch(/Every worker dies/);
		expect(entry.automaticRecovery).toMatch(/^None inside the process/);
		expect(entry.automaticRecovery).not.toMatch(/supervisor replaces/);
		// The one exit request that prints no reason line of its own is the
		// shutdown budget expiring; the nextAction must keep naming it or the
		// operator hunts for a line that was never printed.
		expect(entry.nextAction).toContain('shutdown budget');
	});

	it('is what the quarantine and restart-limit entries hand off to', () => {
		const quarantine = entryFor(ADAPTER_ERROR_IDS.RELAY_SPILL_QUARANTINE);
		expect(quarantine.automaticRecovery).toContain('ADAPTER-ERR-WORKER-EXIT-SIGKILL');
		expect(quarantine.automaticRecovery).toMatch(/killing the whole process/);
		const limit = entryFor(ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT);
		expect(limit.consequence).toMatch(/hard-killing if other workers are still alive/);
	});
});

describe('the primary resolves a wedged worker by process death', () => {
	it('the exit fallback SIGKILLs the process and never terminates the thread', () => {
		const fallback = between(indexSource, 'function requestWorkerExit(', 'function primaryHardExit(');
		expect(fallback).toContain('ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL');
		expect(fallback).toContain("process.kill(process.pid, 'SIGKILL')");
		expect(fallback).not.toContain('.terminate(');
	});

	it('a terminal primary exit with live workers is a self-SIGKILL, without them a plain exit', () => {
		const hardExit = between(indexSource, 'function primaryHardExit(', 'const heartbeatSweep');
		expect(hardExit).toContain('if (workers.size > 0)');
		expect(hardExit).toContain("process.kill(process.pid, 'SIGKILL')");
		expect(hardExit).toContain('process.exit(code)');
	});

	it('an exhausted restart budget goes through the hard exit', () => {
		const exhausted = between(indexSource, 'onExhausted: (slot) => {', 'shuttingDown:');
		expect(exhausted).toContain('ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT');
		expect(exhausted).toContain('primaryHardExit(1)');
		expect(exhausted).not.toContain('process.exit(');
	});
});
