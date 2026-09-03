// Reading the lead adapter at the revision this repo vendored from.
//
// Every parity gate reads the lead at THAT commit, not from its working tree:
// the lead is a live checkout with its own session, and a file saved there
// mid-edit would turn a gate red for a change that is not ours and is not even
// committed. Pinning also makes "carried from the lead" reproducible - the same
// two checkouts give the same verdict on any machine, today and next month.
//
// Moving to a newer lead is deliberate: bump `rev` in test/vendored-lead.json,
// re-derive every vendored file against it, read what changed, and commit the
// pin with the re-vendored files.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const uwsRoot = process.env.UWS_SRC || path.resolve(repoRoot, '..', 'svelte-adapter-uws');

export const LEAD = JSON.parse(
	readFileSync(path.join(repoRoot, 'test', 'vendored-lead.json'), 'utf8')
);

/**
 * Every requested file's content at the pinned lead revision, read in ONE
 * `git cat-file --batch` pass. A `git show` per entry is the obvious spelling
 * and costs a process per file - around a minute of pure spawn overhead across
 * the vendored manifest, paid on every suite run.
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
export function readLeadAtPin(leadRelativePaths) {
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
