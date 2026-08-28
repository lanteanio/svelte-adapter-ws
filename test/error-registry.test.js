// The error catalog stays tied to reality: every entry must have a live emit
// site under src/, every source path it names must exist, and docs/errors.md
// must carry exactly the registry's entries. A catalog row nothing can emit
// is operator misdirection - it ships in the package and reads as a failure
// mode this runtime has.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY, adapterConsoleLine } from '../src/runtime/error-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

/** @type {{ f: string, s: string }[]} */
const corpus = [];
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(abs);
		else if (entry.name.endsWith('.js') && !abs.includes('error-registry')) {
			corpus.push({ f: abs, s: readFileSync(abs, 'utf8') });
		}
	}
};
walk(srcRoot);

/** @param {any} entry */
function emitSites(entry) {
	const key = entry.id.replace('ADAPTER-ERR-', '').replace(/-/g, '_');
	const hits = new Set();
	for (const c of corpus) {
		if (entry.event && c.s.includes(`'${entry.event}'`)) hits.add(c.f);
		if (c.s.includes(entry.id)) hits.add(c.f);
		if (c.s.includes(`ADAPTER_ERROR_IDS.${key}`)) hits.add(c.f);
	}
	return hits;
}

describe('error catalog', () => {
	it('has a live emit site for every entry', () => {
		const dead = ADAPTER_ERROR_REGISTRY
			.filter((entry) => emitSites(entry).size === 0)
			.map((entry) => entry.id);
		expect(
			dead,
			'catalog entries nothing under src/ can emit (delete the entry, or wire the site through the registry): ' + dead.join(', ')
		).toEqual([]);
	});

	it('names only source files that exist', () => {
		const missing = [];
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			for (const source of entry.sources) {
				if (!existsSync(path.join(repoRoot, source))) missing.push(`${entry.id} -> ${source}`);
			}
		}
		expect(missing, missing.join('\n')).toEqual([]);
	});

	it('keeps ids, key names and anchors aligned', () => {
		expect(ADAPTER_ERROR_REGISTRY.length).toBe(Object.keys(ADAPTER_ERROR_IDS).length);
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			expect(entry.anchor).toBe(entry.id.toLowerCase());
			expect(entry.help).toBe('docs/errors.md#' + entry.anchor);
		}
	});

	it('renders a console line for every console-emitted entry', () => {
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			if (entry.emission !== 'console') continue;
			const line = adapterConsoleLine(entry.id, 'detail');
			expect(line.startsWith(entry.messagePrefix)).toBe(true);
			expect(line).toContain('[' + entry.id + ']');
		}
	});

	it('matches docs/errors.md entry for entry', () => {
		const docs = readFileSync(path.join(repoRoot, 'docs', 'errors.md'), 'utf8');
		const documented = new Set(
			[...docs.matchAll(/^## (ADAPTER-ERR-[A-Z-]+)$/gm)].map((match) => match[1])
		);
		const inRegistry = new Set(ADAPTER_ERROR_REGISTRY.map((entry) => entry.id));
		const undocumented = [...inRegistry].filter((id) => !documented.has(id));
		const stale = [...documented].filter((id) => !inRegistry.has(id));
		expect(undocumented, 'run: node scripts/render-error-docs.js - missing from docs: ' + undocumented.join(', ')).toEqual([]);
		expect(stale, 'run: node scripts/render-error-docs.js - stale in docs: ' + stale.join(', ')).toEqual([]);
	});
});
