import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEmittedEvents, findUnindexedFailures, findGhostRegistryEntries } from '../scripts/error-event-coverage.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = [];
afterEach(() => {
	for (const directory of fixtures.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
		expect(existsSync(directory)).toBe(false);
	}
});
const generate = (directory = root, mode = '--check') => spawnSync(process.execPath, ['scripts/render-error-docs.js', mode], { cwd: directory, encoding: 'utf8' });

// Mutations must never touch the production source tree: other test workers
// enumerate it for reachability checks and real-runtime payload builds.
function fixture(source, entries = []) {
	const directory = mkdtempSync(join(tmpdir(), 'error-event-coverage-'));
	fixtures.push(directory);
	for (const file of [
		'scripts/error-event-coverage.js',
		'scripts/render-error-docs.js',
		'src/runtime/diagnostic-format.js',
		'src/runtime/observability-manifest.js',
		'src/runtime/transport-metrics.js'
	]) {
		mkdirSync(dirname(join(directory, file)), { recursive: true });
		copyFileSync(join(root, file), join(directory, file));
	}
	mkdirSync(join(directory, 'docs'));
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
	writeFileSync(join(directory, 'src/runtime/error-registry.js'),
		'export const ADAPTER_ERROR_IDS = ' + JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.id.replace('ADAPTER-ERR-', '').replaceAll('-', '_'), entry.id]))) + ';\n' +
		'export const ADAPTER_ERROR_REGISTRY = ' + JSON.stringify(entries) + ';\n');
	writeFileSync(join(directory, 'src/runtime/fixture.js'), source);
	return directory;
}

const indexedEntry = {
	id: 'ADAPTER-ERR-FIXTURE', anchor: 'adapter-err-fixture',
	event: 'runtime.fixture.failed', code: null, emission: 'direct',
	component: 'runtime.fixture', severity: 'error', problemPrefix: 'Fixture failed.',
	messagePrefix: '[lantean/diagnostic source=svelte-adapter-ws component=runtime.fixture event=runtime.fixture.failed severity=error] Fixture failed.',
	cause: 'The fixture failed.', consequence: 'The fixture operation stops.',
	automaticRecovery: 'No automatic recovery.', nextAction: 'Repair the fixture.',
	help: 'docs/errors.md#adapter-err-fixture', sources: ['src/runtime/fixture.js']
};
const indexedSource = "emitOperationalEvent({ component: 'runtime.fixture', event: 'runtime.fixture.failed', severity: 'error' });\n";

describe('production diagnostic coverage', () => {
	it('scans the runtime, dev server and testing entry points', () => {
		const scan = scanEmittedEvents();
		expect(scan.events.length).toBeGreaterThan(30);
		const sources = new Set(scan.events.flatMap((event) => event.sources));
		for (const file of ['src/runtime/handler/realtime.js', 'src/vite.js', 'src/testing.js']) expect(sources.has(file), file).toBe(true);
		expect(sources.has('src/runtime/error-registry.js')).toBe(false);
		expect(findUnindexedFailures(scan)).toEqual([]);
		expect(findGhostRegistryEntries(undefined, scan)).toEqual([]);
	});

	it('keeps the generated inventory and informational table current', () => {
		const result = generate();
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		const docs = readFileSync(new URL('../docs/errors.md', import.meta.url), 'utf8');
		expect(docs).toContain('## Emitted diagnostic event coverage');
		expect(docs).toContain('### Informational events');
		expect(docs).toContain('| Event | Component | Severity | Emitting sources |');
	});
});

describe('isolated diagnostic coverage fixtures', () => {
	it.each(['src/observability.js', 'src/vite.js', 'src/testing.js'])('rejects an uncatalogued failure emitted from %s', (source) => {
		const directory = fixture('');
		writeFileSync(join(directory, source), indexedSource);
		const result = generate(directory, '--write');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('runtime.fixture.failed');
		expect(result.stderr).toContain('emitted by ' + source);
		expect(result.stderr).toContain('failure with no entry');
		expect(existsSync(join(directory, 'docs/errors.md'))).toBe(false);
	});

	it.each(['warn', 'warning', 'error', 'fatal'])('fails the real generator for a new %s event', (severity) => {
		const directory = fixture(`emitOperationalEvent({ component: 'runtime.fixture', event: 'runtime.fixture.failed', severity: '${severity}' });\n`);
		const result = generate(directory, '--write');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('runtime.fixture.failed');
		expect(result.stderr).toContain('failure with no entry');
		expect(existsSync(join(directory, 'docs/errors.md'))).toBe(false);
	});

	it('requires an index when severity is not a literal', () => {
		const directory = fixture("emitOperationalEvent({ component: 'runtime.fixture', event: 'runtime.fixture.dynamic', severity });\n");
		const result = generate(directory, '--write');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('runtime.fixture.dynamic (severity not a literal');
		expect(result.stderr).toContain('failure with no entry');
	});

	it('permits informational events and inventories their source and severity', () => {
		const directory = fixture("emitOperationalEvent({ component: 'runtime.fixture', event: 'runtime.fixture.ready', severity: 'info' });\n");
		const result = generate(directory, '--write');
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(generate(directory).status).toBe(0);
		const docs = readFileSync(join(directory, 'docs/errors.md'), 'utf8');
		expect(docs).toContain('| `runtime.fixture.ready` | `runtime.fixture` | info | [src/runtime/fixture.js](../src/runtime/fixture.js) |');
	});

	it('rejects a registry entry without an emission', () => {
		const directory = fixture('', [indexedEntry]);
		const result = generate(directory, '--write');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('ADAPTER-ERR-FIXTURE: event runtime.fixture.failed is not emitted');
	});

	it('accepts a complete indexed entry and checks the generated reference', () => {
		const directory = fixture(indexedSource, [indexedEntry]);
		const result = generate(directory, '--write');
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(generate(directory).status).toBe(0);
	});

	it.each(['cause', 'consequence', 'automaticRecovery', 'nextAction'])('rejects an indexed entry with blank %s guidance', (field) => {
		const directory = fixture(indexedSource, [{ ...indexedEntry, [field]: '  ' }]);
		const result = generate(directory, '--write');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('ADAPTER-ERR-FIXTURE: missing ' + field);
		expect(existsSync(join(directory, 'docs/errors.md'))).toBe(false);
	});
});
