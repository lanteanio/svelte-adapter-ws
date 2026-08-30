// Renders the public entry-point catalog into README.md from the package
// export map, so the documented surface cannot drift from the surface npm
// actually resolves. The export map plus docs/entry-points.json are the
// single source of truth; edit those and re-run this script:
//
//   node scripts/render-entry-points.js
//
// Role, environment, stability and deprecation are the lead adapter's own
// declarations for each subpath, carried verbatim so a consumer reading
// either README gets the same answer; test/export-parity.test.js holds them
// to it.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const START = '<!-- public-entry-points:start -->';
const END = '<!-- public-entry-points:end -->';

/** @param {string} subpath */
function specifier(subpath) {
	return subpath === '.' ? 'svelte-adapter-ws' : 'svelte-adapter-ws' + subpath.slice(1);
}

export function renderEntryPoints() {
	const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	const meta = JSON.parse(readFileSync(path.join(repoRoot, 'docs', 'entry-points.json'), 'utf8'));

	const rows = ['| Entry point | Role | Environment | Stability | Deprecation |', '|---|---|---|---|---|'];
	for (const subpath of Object.keys(pkg.exports)) {
		const entry = meta[subpath];
		if (!entry) throw new Error(`docs/entry-points.json has no entry for ${subpath}`);
		rows.push(
			`| \`${specifier(subpath)}\` | ${entry.role} | ${entry.environment} | ` +
			`${entry.stability} | ${entry.deprecation} |`
		);
	}
	return rows.join('\n');
}

/** @param {string} readme */
export function spliceEntryPoints(readme) {
	const nl = readme.includes('\r\n') ? '\r\n' : '\n';
	const start = readme.indexOf(START);
	const end = readme.indexOf(END);
	if (start === -1 || end === -1) {
		throw new Error(`README.md is missing the ${START} / ${END} markers`);
	}
	const table = renderEntryPoints().replace(/\n/g, nl);
	return readme.slice(0, start + START.length) + nl + table + nl + readme.slice(end);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const readmePath = path.join(repoRoot, 'README.md');
	const next = spliceEntryPoints(readFileSync(readmePath, 'utf8'));
	writeFileSync(readmePath, next);
	const count = Object.keys(JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).exports).length;
	console.log(`README.md entry-point catalog rendered (${count} entries).`);
}
