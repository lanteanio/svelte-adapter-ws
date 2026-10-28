// Server log lines name this adapter in their leading tag. The bare [ws],
// [tls], [primary] and [pressure] tags belong to svelte-adapter-uws in the
// family's shared prefix table, so a line printed here under one of them is
// attributed to the other package by every parser that follows that table.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDiagnostic } from '../src/observability.js';
import { ADAPTER_ERROR_REGISTRY, adapterConsoleLine } from '../src/runtime/error-registry.js';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const BARE = /(['"`])\[(ws|tls|primary|pressure|adapter-ws\/testing)\] /;

/** @param {string} dir @returns {string[]} */
function sources(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return entry.name.endsWith('.js') ? [full] : [];
	});
}

describe('server log prefixes', () => {
	it('print no string that opens with a bare prefix another package owns', () => {
		// The browser client is excluded: its console is the browser's, which no
		// server log parser reads.
		const files = sources(srcRoot).filter((file) => path.relative(srcRoot, file).replace(/\\/g, '/') !== 'client.js');
		expect(files.length).toBeGreaterThan(50);
		const offenders = [];
		for (const file of files) {
			readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
				if (BARE.test(line)) offenders.push(path.relative(srcRoot, file) + ':' + (i + 1) + ': ' + line.trim());
			});
		}
		expect(offenders).toEqual([]);
	});

	it.each([
		['svelte-adapter-ws/runtime.websocket', 'runtime.websocket'],
		['svelte-adapter-ws/runtime.tls', 'runtime.tls'],
		['svelte-adapter-ws/runtime.primary', 'runtime.primary'],
		['svelte-adapter-ws/runtime.testing', 'runtime.testing']
	])('attributes [%s] lines to this adapter', (prefix, component) => {
		expect(parseDiagnostic(`[${prefix}] listener failed`, { defaultSeverity: 'warn' })).toMatchObject({
			format: 'legacy',
			record: { source: 'svelte-adapter-ws', component, event: 'diagnostic.legacy', severity: 'warn' }
		});
	});

	it('attributes every indexed console line to this adapter', () => {
		const consoleEntries = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission === 'console');
		expect(consoleEntries.length).toBeGreaterThan(20);
		for (const entry of consoleEntries) {
			const parsed = parseDiagnostic(adapterConsoleLine(entry.id, ' detail'), { defaultSeverity: 'error' });
			expect(parsed?.record.source, entry.id).toBe('svelte-adapter-ws');
			expect(parsed?.record.attributes.legacyPrefix.startsWith('svelte-adapter-ws'), entry.id).toBe(true);
		}
	});
});
