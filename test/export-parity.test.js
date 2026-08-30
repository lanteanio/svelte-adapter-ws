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

	it('points every shared subpath at the same relative targets as the lead', () => {
		const lead = exportsOf(uwsRoot);
		for (const [subpath, condition] of Object.entries(ours)) {
			expect(condition, `${subpath} target shape`).toEqual(lead[subpath]);
		}
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
