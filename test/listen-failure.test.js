// A bind failure is the startup failure an operator hits most - a port already
// in use - and the whole value of the line it prints is the address that failed
// and the reason.
//
// It printed neither. The emit built its own record with `dataClass: 'none'`,
// which is not one of the four classes the observability schema declares, so
// `createDiagnostic` threw, `emitOperationalEvent` swallowed the throw by design
// (telemetry must not turn the failure it reports into a crash), and the last
// thing before `process.exit(1)` was a line about an invalid record shape. The
// catalog entry could not have rescued it either: its `problemPrefix` was null,
// and `adapterErrorProblem` throws on a null prefix, so the registry-built
// diagnostic could not be constructed at all.
//
// The end-to-end case below is the load-bearing one. A source-text pin over the
// emit site would pass while the runtime printed something else entirely, which
// is exactly how this survived: nothing here asserted what an operator sees.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { ADAPTER_ERROR_IDS, adapterErrorDefinition } from '../src/runtime/error-registry.js';
import { formatOperationalDiagnostic, listenFailureDiagnostic } from '../src/runtime/utils/operational-diagnostic.js';

/** @type {Array<() => void | Promise<void>>} */
const cleanups = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** Hold a port open so a boot against it must fail. */
function occupyPort() {
	return new Promise((resolve, reject) => {
		const holder = net.createServer();
		holder.once('error', reject);
		holder.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {net.AddressInfo} */ (holder.address());
			cleanups.push(() => new Promise((done) => holder.close(() => done(undefined))));
			resolve(port);
		});
	});
}

describe('the LISTEN catalog entry can build a diagnostic at all', () => {
	it('is a composed fatal on runtime.listener with a problem prefix', () => {
		const entry = adapterErrorDefinition(ADAPTER_ERROR_IDS.LISTEN);
		expect(entry.emission).toBe('composed');
		expect(entry.severity).toBe('fatal');
		expect(entry.component).toBe('runtime.listener');
		// A null prefix is not a cosmetic gap: adapterErrorProblem throws on one,
		// so listenFailureDiagnostic cannot construct a record and the bind
		// failure has nothing to print.
		expect(entry.problemPrefix, 'a null problemPrefix makes the diagnostic unbuildable').toEqual(expect.any(String));
	});

	it('formats a line naming the address, the id and the operator action', () => {
		const line = formatOperationalDiagnostic(
			listenFailureDiagnostic('127.0.0.1', 8080, Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))
		);
		expect(line).toContain('127.0.0.1:8080');
		expect(line).toContain(ADAPTER_ERROR_IDS.LISTEN);
		expect(line).toContain('severity=fatal');
		expect(line).toContain('component=runtime.listener');
		// The action is last in the composed pattern and the first thing a
		// record-level bound would truncate, so it is worth naming.
		expect(line).toMatch(/action: [^;]*port conflicts/);
	});

	it('carries the real errno, which this transport has and the record has a slot for', () => {
		const line = formatOperationalDiagnostic(
			listenFailureDiagnostic('127.0.0.1', 8080, Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))
		);
		expect(line).toContain('EADDRINUSE');
	});

	it('reports the bind reason a transport hands it, and the placeholder when there is none', () => {
		// The record declares an `error` field, and what fills it depends on the
		// transport rather than on this package: a transport that answers a
		// failed listen with a falsy socket has no reason to pass, while one
		// that rejects with EADDRINUSE has the whole answer and passes it. Both
		// records go through the same formatter, so an operator reads the cause
		// in the declared field either way.
		const entry = adapterErrorDefinition(ADAPTER_ERROR_IDS.LISTEN);
		const placeholder = listenFailureDiagnostic('127.0.0.1', 4321);
		expect(placeholder.error.code, 'the two-argument form keeps the placeholder').toBe('LISTEN_FAILED');

		const reported = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4321'), { code: 'EADDRINUSE' });
		const carried = listenFailureDiagnostic('127.0.0.1', 4321, reported);
		expect(carried.error, 'the reported error is carried, not copied into a new one').toBe(reported);
		const line = formatOperationalDiagnostic(carried);
		expect(line.startsWith(entry.messagePrefix), 'and the line still resolves to this entry').toBe(true);
		expect(line).toContain('EADDRINUSE');
		// A transport with no Error object of its own is not a shape error: the
		// record's own field builder takes a string.
		expect(formatOperationalDiagnostic(listenFailureDiagnostic('127.0.0.1', 4321, 'bind refused'))).toContain('bind refused');
		// An explicit null means "no reason", which is what the field's own
		// absent form is - it must not resurrect the placeholder.
		expect(listenFailureDiagnostic('127.0.0.1', 4321, null).error).toBe(null);
	});
});

describe('a real bind failure tells the operator what failed', () => {
	it('exits 1 naming the address and the error id, not a record-shape complaint', async () => {
		expect(buildFixtureOnce('default'), 'the default fixture variant must build').toBeTruthy();
		const taken = await occupyPort();
		const child = fileURLToPath(new URL('./helpers/listen-failure-child.mjs', import.meta.url));
		const proc = spawn(process.execPath, [child, '127.0.0.1', String(taken)], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		proc.stdout.on('data', (c) => { output += c; });
		proc.stderr.on('data', (c) => { output += c; });
		const code = await new Promise((resolve) => {
			proc.on('exit', (c) => resolve(c));
			cleanups.push(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); });
		});

		expect(code, `expected a failed bind to exit 1\n--- output ---\n${output}`).toBe(1);
		expect(output).toContain(`127.0.0.1:${taken}`);
		expect(output).toContain(ADAPTER_ERROR_IDS.LISTEN);
		// The bind error the transport reported is on the line, in the record's
		// own error field: this is what the call site passes, and a call site
		// that stopped passing it would print the placeholder instead.
		expect(output, 'the errno reaches the operator').toContain('EADDRINUSE');
		// The exact symptom this file exists for: the record was thrown away and
		// the operator was told about telemetry instead of about the port.
		expect(output, 'the diagnostic must be built, not dropped').not.toContain('invalid record shape');
		expect(output).not.toContain('dataClass is invalid');
	}, 60000);
});
