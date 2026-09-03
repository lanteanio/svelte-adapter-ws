// The vendored-file parity gate: every file this adapter carries verbatim
// from the lead adapter is held byte-identical MECHANICALLY - content must
// equal the lead's after the package-name substitution and the explicitly
// recorded adaptations below. Any other divergence fails, so a vendored copy
// cannot drift silently and an edit that belongs in the lead cannot land
// only here. Like the platform parity gate, a missing lead checkout FAILS
// rather than skips: a drift gate without its oracle is not a gate.
//
// The manifest lives in test/vendored-manifest.json: one entry per vendored
// file, optionally with recorded `{ lead, ours }` adaptation hunks - `lead`
// is the exact text as it appears AFTER the package-name substitution, and
// `ours` is what this repo carries instead. Keep adaptations to what MUST
// differ (a header paragraph whose claim would be untrue here, an import
// path that has no counterpart); everything else stays verbatim so the lead
// remains the single place the logic evolves.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAD, readLeadAtPin, repoRoot, uwsRoot } from './lead-pin.js';


/**
 * @typedef {{ lead: string, ours: string }} Adaptation
 * @typedef {{ file: string, leadFile?: string, adaptations?: Adaptation[] }} VendoredEntry
 *   `file` is repo-relative and doubles as the lead-relative path unless
 *   `leadFile` overrides it.
 */

/** @type {VendoredEntry[]} */
const VENDORED = JSON.parse(
	readFileSync(path.join(repoRoot, 'test', 'vendored-manifest.json'), 'utf8')
);

/** @param {string} raw */
function normalize(raw) {
	return raw.replace(/\r\n/g, '\n');
}

/** @type {Map<string, string | null>} */
const LEAD_SOURCES = readLeadAtPin([
	'src/safe-url.js',
	...VENDORED.map((entry) => entry.leadFile ?? entry.file)
]);

/** @param {string} leadRelativePath */
function leadSourceOf(leadRelativePath) {
	return LEAD_SOURCES.get(leadRelativePath.split(path.sep).join('/')) ?? null;
}

describe('vendored files stay byte-identical to the lead', () => {
	it('finds the lead checkout its oracle reads from', () => {
		expect(
			existsSync(path.join(uwsRoot, 'src', 'safe-url.js')),
			`svelte-adapter-uws checkout not found at ${uwsRoot}; set UWS_SRC to its path`
		).toBe(true);
	});

	it('can read the lead at the pinned revision', () => {
		expect(
			leadSourceOf('src/safe-url.js'),
			`the lead checkout at ${uwsRoot} has no commit ${LEAD.rev}; fetch it, or ` +
			'bump rev in test/vendored-lead.json to a revision it does have'
		).not.toBe(null);
	});

	for (const entry of VENDORED) {
		it(`${entry.file} matches the lead modulo the recorded adaptations`, () => {
			const leadRelative = entry.leadFile ?? entry.file;
			const oursPath = path.join(repoRoot, entry.file);
			const leadSource = leadSourceOf(leadRelative);
			expect(
				leadSource,
				`lead file missing at ${LEAD.rev}: ${leadRelative}`
			).not.toBe(null);
			expect(existsSync(oursPath), `vendored file missing: ${oursPath}`).toBe(true);

			let expected = normalize(/** @type {string} */ (leadSource))
				.replace(/svelte-adapter-uws/g, 'svelte-adapter-ws');
			for (const adaptation of entry.adaptations ?? []) {
				expect(
					expected.includes(adaptation.lead),
					`recorded adaptation no longer matches the lead in ${entry.file}; ` +
					're-derive it from the current lead source'
				).toBe(true);
				// `all` marks a hunk that recurs (a renamed type used many
				// times); default is exactly-once so an unexpected repeat of a
				// single-site hunk still fails.
				expected = adaptation.all
					? expected.replaceAll(adaptation.lead, adaptation.ours)
					: expected.replace(adaptation.lead, adaptation.ours);
			}
			expect(normalize(readFileSync(oursPath, 'utf8'))).toBe(expected);
		});
	}
});
