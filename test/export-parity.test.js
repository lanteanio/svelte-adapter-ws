// The export-subpath gate: this adapter is a drop-in replacement for the lead
// adapter, so every subpath it declares must be one the lead declares too, and
// must be spelled and shaped the way the lead spells it. A subpath that exists
// only here is the break the family exists to prevent - an app that imports it
// cannot move back. Like the vendored parity gate, a missing lead checkout
// FAILS rather than skips: a parity gate without its oracle is not a gate.
//
// The other half is that a declared subpath must actually work. A types or
// default target that points at a file which is absent, or a module that
// throws on import, is a broken subpath that publint alone will not catch
// once the file exists but its own imports do not resolve.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uwsRoot = process.env.UWS_SRC || path.resolve(repoRoot, '..', 'svelte-adapter-uws');

/** @param {string} root */
function exportsOf(root) {
	return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).exports;
}

const ours = exportsOf(repoRoot);

describe('declared subpaths stay inside the lead surface', () => {
	it('finds the lead checkout its oracle reads from', () => {
		expect(
			existsSync(path.join(uwsRoot, 'package.json')),
			`svelte-adapter-uws checkout not found at ${uwsRoot}; set UWS_SRC to its path`
		).toBe(true);
	});

	it('declares no subpath the lead does not', () => {
		const lead = exportsOf(uwsRoot);
		const invented = Object.keys(ours).filter((subpath) => !(subpath in lead));
		expect(
			invented,
			'these subpaths exist only here; a consumer that imports them cannot ' +
			'move back to the lead. Keep the code internal and propose the subpath ' +
			'on the lead instead'
		).toEqual([]);
	});

	// The other direction, and the one a drift gate forgets: refusing invented
	// subpaths says nothing about MISSING ones, so the surface can shrink
	// silently. Deleting a subpath from the export map used to pass every
	// assertion in this file, which made "all of the lead's subpaths ship" a
	// hand count wearing a test's clothes.
	it('declares every subpath the lead declares', () => {
		const lead = exportsOf(uwsRoot);
		const missing = Object.keys(lead).filter((subpath) => !(subpath in ours));
		expect(
			missing,
			'the lead declares these and this package does not; an app that imports ' +
			'one cannot move here, which is the same broken promise in the other ' +
			'direction'
		).toEqual([]);
	});

	it('points every shared subpath at the same relative targets as the lead', () => {
		const lead = exportsOf(uwsRoot);
		for (const [subpath, condition] of Object.entries(ours)) {
			expect(condition, `${subpath} target shape`).toEqual(lead[subpath]);
			// ORDER, not just content. Node and TypeScript resolve export
			// conditions in declaration order and take the first match, so a
			// map with `default` ahead of `types` type-checks as `any` while
			// deep-equalling a correct one - toEqual cannot see it.
			expect(
				Object.keys(condition),
				`${subpath} condition order (first match wins at resolution time)`
			).toEqual(Object.keys(lead[subpath]));
		}
	});

	// An export map is only as good as the tarball behind it. `files` decides
	// what npm actually ships, and nothing else in this suite reads it: with
	// `src` dropped, every subpath above still resolves from the working tree
	// and every one of them 404s for an installed consumer.
	it('ships every declared target inside the packaged files', () => {
		const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
		const roots = (pkg.files ?? []).map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
		const uncovered = [];
		for (const [subpath, condition] of Object.entries(ours)) {
			for (const target of Object.values(condition)) {
				const rel = String(target).replace(/^\.\//, '');
				if (!roots.some((root) => rel === root || rel.startsWith(root + '/'))) {
					uncovered.push(`${subpath} -> ${target}`);
				}
			}
		}
		expect(
			uncovered,
			'these export targets are outside every `files` entry, so the published ' +
			'tarball would not contain them'
		).toEqual([]);
	});
});

describe('every declared subpath resolves', () => {
	for (const [subpath, condition] of Object.entries(ours)) {
		it(`${subpath} has both targets on disk and imports`, async () => {
			for (const target of Object.values(condition)) {
				expect(
					existsSync(path.join(repoRoot, target)),
					`${subpath} points at a missing file: ${target}`
				).toBe(true);
			}
			const mod = await import(
				pathToFileURL(path.join(repoRoot, condition.default)).href
			);
			expect(Object.keys(mod).length, `${subpath} exports nothing`).toBeGreaterThan(0);
		});
	}
});

// The catalog half: README documents the surface, and both the table and the
// declarations behind it are held to their sources - the export map for which
// subpaths exist, the lead's own catalog for what each one is.

/** Parses a lead/local `public-entry-points` markdown block into rows. */
function catalogRows(markdown) {
	const start = markdown.indexOf('<!-- public-entry-points:start -->');
	const end = markdown.indexOf('<!-- public-entry-points:end -->');
	expect(start, 'public-entry-points markers missing').toBeGreaterThan(-1);
	expect(end, 'public-entry-points markers missing').toBeGreaterThan(start);
	return markdown
		.slice(start, end)
		.split(/\r?\n/)
		.filter((line) => line.trim().startsWith('|'))
		.slice(2)
		.map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

describe('the entry-point catalog stays true to its sources', () => {
	const meta = JSON.parse(readFileSync(path.join(repoRoot, 'docs', 'entry-points.json'), 'utf8'));

	it('describes exactly the subpaths the package declares', () => {
		expect(Object.keys(meta)).toEqual(Object.keys(ours));
	});

	it('has a README table matching the renderer', async () => {
		const { renderEntryPoints } = await import('../scripts/render-entry-points.js');
		const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
		const rendered = renderEntryPoints().split('\n').map((line) =>
			line.split('|').slice(1, -1).map((cell) => cell.trim())
		);
		expect(
			catalogRows(readme),
			'run: node scripts/render-entry-points.js'
		).toEqual(rendered.slice(2));
	});

	it('carries the lead declaration for every subpath', () => {
		const lead = new Map(
			catalogRows(readFileSync(path.join(uwsRoot, 'README.md'), 'utf8')).map((cells) => {
				const name = cells[0].replaceAll('`', '');
				const subpath = name === 'svelte-adapter-uws' ? '.' : '.' + name.slice('svelte-adapter-uws'.length);
				// The lead's Guide column links into its own README, which has
				// no counterpart here; the declarations either side of it do.
				return [subpath, { role: cells[1], environment: cells[2], stability: cells[3], deprecation: cells[5] }];
			})
		);
		for (const [subpath, entry] of Object.entries(meta)) {
			expect(lead.get(subpath), `${subpath} is absent from the lead catalog`).toBeDefined();
			expect(entry, `${subpath} declaration`).toEqual(lead.get(subpath));
		}
	});
});
