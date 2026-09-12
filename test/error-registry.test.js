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

	it('documents prefixes in the shape their emitter actually prints', () => {
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			if (entry.emission === 'direct') {
				// emitOperationalEvent prints the family's canonical diagnostic
				// head; a prefix that starts any other way is a line nothing
				// prints, and one whose fields disagree with the entry's own
				// component/event/severity is a line grep can never match.
				expect(
					entry.messagePrefix.startsWith(
						`[lantean/diagnostic source=svelte-adapter-ws component=${entry.component} ` +
						`event=${entry.event} severity=${entry.severity}] `
					),
					`${entry.id} documents a prefix its emitter never prints: ${entry.messagePrefix}`
				).toBe(true);
			}
			if (entry.emission === 'console') {
				// Console lines are plain, never the lantean diagnostic head.
				expect(entry.messagePrefix.includes('lantean/diagnostic'), entry.id).toBe(false);
				expect(() => adapterConsoleLine(entry.id)).not.toThrow();
			}
		}
	});

	it('opens with an index row per entry, carrying the code or event and the searchable prefix', () => {
		// The row is what an operator scanning the top of the page reads: the
		// id links to its section, the middle column is the key a sink reports
		// under, and the last is the start of the line as it is printed. A
		// missing row leaves an entry reachable only by scrolling.
		const docs = readFileSync(path.join(repoRoot, 'docs', 'errors.md'), 'utf8');
		const rows = new Map(
			[...docs.matchAll(/^\| \[(ADAPTER-ERR-[A-Z-]+)\]\(#([a-z0-9-]+)\) \| `([^`]*)` \| `([\s\S]*?)` \|$/gm)]
				.map((m) => [m[1], { anchor: m[2], key: m[3], prefix: m[4] }])
		);
		expect(rows.size, 'one index row per registry entry').toBe(ADAPTER_ERROR_REGISTRY.length);
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			const row = rows.get(entry.id);
			expect(row, entry.id + ' has no index row - run: node scripts/render-error-docs.js').toBeTruthy();
			expect(row.anchor, entry.id + ' index row links elsewhere').toBe(entry.anchor);
			expect(row.key, entry.id + ' index row names the wrong code or event').toBe(entry.code || entry.event);
			expect(row.prefix, entry.id + ' index row carries the wrong searchable prefix')
				.toBe(String(entry.messagePrefix).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
		}
	});

	it('lists every entry the other way round: by event, or by printed prefix for a console line', () => {
		// The second index answers the question a sink asks: given this event
		// name, which entry is it? A console-line entry has no event anyone
		// sees, so it is listed under the prefix that is printed instead.
		const docs = readFileSync(path.join(repoRoot, 'docs', 'errors.md'), 'utf8');
		const listed = new Map(
			[...docs.matchAll(/^- `([\s\S]*?)` - \[(ADAPTER-ERR-[A-Z-]+)\]\(#([a-z0-9-]+)\)$/gm)]
				.map((m) => [m[2], { key: m[1], anchor: m[3] }])
		);
		expect(listed.size, 'one list entry per registry entry').toBe(ADAPTER_ERROR_REGISTRY.length);
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			const row = listed.get(entry.id);
			expect(row, entry.id + ' is in no list - run: node scripts/render-error-docs.js').toBeTruthy();
			expect(row.anchor, entry.id + ' list entry links elsewhere').toBe(entry.anchor);
			const expected = entry.emission === 'console'
				? String(entry.messagePrefix).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
				: entry.event;
			expect(row.key, entry.id + ' is listed under the wrong key').toBe(expected);
		}
		// The two halves are the emission split, not a hand-kept pair of lists.
		const consoleIds = ADAPTER_ERROR_REGISTRY.filter((e) => e.emission === 'console').map((e) => e.id);
		const eventsBlock = docs.slice(docs.indexOf('Indexed events:'), docs.indexOf('Indexed console lines'));
		for (const id of consoleIds) {
			expect(eventsBlock.includes(id), id + ' prints a console line and must not be listed as an emitted event').toBe(false);
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
