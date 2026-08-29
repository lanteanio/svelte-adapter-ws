// The vendored-file parity gate: every file this adapter carries verbatim
// from the lead adapter is held byte-identical MECHANICALLY - content must
// equal the lead's after the package-name substitution and the explicitly
// recorded adaptations below. Any other divergence fails, so a vendored copy
// cannot drift silently and an edit that belongs in the lead cannot land
// only here. Like the platform parity gate, a missing lead checkout FAILS
// rather than skips: a drift gate without its oracle is not a gate.
//
// Recording an adaptation: add `{ lead, ours }` to the file's entry - `lead`
// is the exact text as it appears AFTER the package-name substitution, and
// `ours` is what this repo carries instead. Keep adaptations to what MUST
// differ (a header paragraph whose claim would be untrue here, an import
// path that has no counterpart); everything else stays verbatim so the lead
// remains the single place the logic evolves.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uwsRoot = process.env.UWS_SRC || path.resolve(repoRoot, '..', 'svelte-adapter-uws');

/**
 * @typedef {{ lead: string, ours: string }} Adaptation
 * @typedef {{ file: string, leadFile?: string, adaptations?: Adaptation[] }} VendoredEntry
 *   `file` is repo-relative and doubles as the lead-relative path unless
 *   `leadFile` overrides it.
 */

/** @type {VendoredEntry[]} */
const VENDORED = [
	{
		file: 'src/safe-url.js',
		adaptations: [
			{
				lead:
					' * This is the single canonical copy for the ecosystem: it lives here in the\n' +
					' * adapter (the layer every package depends on) and is re-exported by\n' +
					' * `svelte-adapter-ws-extensions/safe-url`; `svelte-realtime` imports it\n' +
					' * directly. There is intentionally no second copy to drift.',
				ours:
					' * The ecosystem\'s canonical copy lives in svelte-adapter-uws (the lead\n' +
					' * adapter); this package carries the same validator so `./safe-url` resolves\n' +
					' * identically whichever adapter an app installs. The family conformance\n' +
					' * suite holds the two in lockstep.'
			}
		]
	},
	{ file: 'src/safe-url.d.ts' },
	{ file: 'test/safe-url.test.js' }
];

/** @param {string} raw */
function normalize(raw) {
	return raw.replace(/\r\n/g, '\n');
}

describe('vendored files stay byte-identical to the lead', () => {
	it('finds the lead checkout its oracle reads from', () => {
		expect(
			existsSync(path.join(uwsRoot, 'src', 'safe-url.js')),
			`svelte-adapter-uws checkout not found at ${uwsRoot}; set UWS_SRC to its path`
		).toBe(true);
	});

	for (const entry of VENDORED) {
		it(`${entry.file} matches the lead modulo the recorded adaptations`, () => {
			const leadPath = path.join(uwsRoot, entry.leadFile ?? entry.file);
			const oursPath = path.join(repoRoot, entry.file);
			expect(existsSync(leadPath), `lead file missing: ${leadPath}`).toBe(true);
			expect(existsSync(oursPath), `vendored file missing: ${oursPath}`).toBe(true);

			let expected = normalize(readFileSync(leadPath, 'utf8'))
				.replace(/svelte-adapter-uws/g, 'svelte-adapter-ws');
			for (const adaptation of entry.adaptations ?? []) {
				expect(
					expected.includes(adaptation.lead),
					`recorded adaptation no longer matches the lead in ${entry.file}; ` +
					're-derive it from the current lead source'
				).toBe(true);
				expected = expected.replace(adaptation.lead, adaptation.ours);
			}
			expect(normalize(readFileSync(oursPath, 'utf8'))).toBe(expected);
		});
	}
});
