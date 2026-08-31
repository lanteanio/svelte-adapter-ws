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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uwsRoot = process.env.UWS_SRC || path.resolve(repoRoot, '..', 'svelte-adapter-uws');

/**
 * The lead revision this repo vendored from. Read the lead at THAT commit, not
 * from its working tree: the lead is a live checkout with its own session, and
 * a file saved there mid-edit would turn this gate red for a change that is
 * not ours and is not even committed yet. Pinning also makes "carried from the
 * lead" reproducible - the same two checkouts give the same verdict on any
 * machine, today and next month.
 *
 * Moving to a newer lead is deliberate: bump `rev` in test/vendored-lead.json,
 * re-derive every vendored file against it, read what changed, and commit the
 * pin with the re-vendored files.
 */
const LEAD = JSON.parse(readFileSync(path.join(repoRoot, 'test', 'vendored-lead.json'), 'utf8'));

/**
 * Every vendored file's content at the pinned lead revision, read in ONE
 * `git cat-file --batch` pass. A `git show` per entry is the obvious spelling
 * and costs a process per file - around a minute of pure spawn overhead across
 * this manifest, paid on every suite run.
 *
 * The batch protocol answers each request line with `<sha> <type> <size>` and
 * then exactly `size` BYTES followed by a newline, or `<request> missing`. The
 * size is in bytes, so the payload has to be sliced out of a Buffer and decoded
 * after - slicing a decoded string would desynchronise the reader on the first
 * file containing any multi-byte character.
 *
 * @param {string[]} leadRelativePaths
 * @returns {Map<string, string | null>} null value = absent at that revision
 */
function readLeadAtPin(leadRelativePaths) {
	/** @type {Map<string, string | null>} */
	const out = new Map();
	const requests = leadRelativePaths.map((p) => p.split(path.sep).join('/'));
	if (requests.length === 0) return out;

	let stdout;
	try {
		stdout = execFileSync('git', ['-C', uwsRoot, 'cat-file', '--batch'], {
			input: requests.map((p) => `${LEAD.rev}:${p}`).join('\n') + '\n',
			maxBuffer: 512 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'ignore']
		});
	} catch {
		for (const p of requests) out.set(p, null);
		return out;
	}

	let at = 0;
	for (const request of requests) {
		const newline = stdout.indexOf(0x0a, at);
		if (newline === -1) { out.set(request, null); continue; }
		const header = stdout.toString('utf8', at, newline);
		if (header.endsWith(' missing')) { out.set(request, null); at = newline + 1; continue; }
		const size = Number(header.slice(header.lastIndexOf(' ') + 1));
		const start = newline + 1;
		out.set(request, stdout.toString('utf8', start, start + size));
		at = start + size + 1; // trailing newline the batch writer appends
	}
	return out;
}


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
