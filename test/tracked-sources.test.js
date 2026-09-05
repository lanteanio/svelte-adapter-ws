// Every module the shipped sources import must be IN GIT.
//
// The failure this exists for is quiet in exactly the wrong way: a hand-written
// module that an ignore rule happens to cover is present on the machine that
// wrote it, so every local suite passes and the package built from that working
// tree is complete - while a fresh clone has no such file and cannot import the
// entry point that imports it. Working tree green, clone broken. That pairing is
// why it survives.
//
// `npm pack --dry-run` does NOT answer this. It reads the working tree, so it
// lists untracked files happily: it says "this is in the tarball built from my
// disk", never "this is in git". The two questions look identical and are not,
// which is precisely how one of these went unnoticed in the sibling adapter.
//
// So the tracked set is the oracle here, never the filesystem.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every path git tracks, as forward-slash relative paths. */
function trackedFiles() {
	return execFileSync('git', ['ls-files'], { cwd: ROOT, maxBuffer: 1 << 28 })
		.toString('utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Relative specifiers imported or re-exported by a module.
 *
 * PARSED, not matched. A regex over the text reports the contents of strings and
 * comments as if they were imports, and this repo has all three: `src/index.js`
 * EMITS an import line inside a string literal, and `src/runtime/utils.js` names
 * an old path in a comment. Both read as missing modules to a scanner that
 * cannot tell code from prose.
 *
 * @param {string} source
 * @returns {string[]}
 */
function relativeSpecifiers(source) {
	const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	const found = [];
	/** @param {any} node */
	const visit = (node) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) { for (const child of node) visit(child); return; }
		const isStatic = node.type === 'ImportDeclaration' ||
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration';
		if (isStatic && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
			found.push(node.source.value);
		}
		// A dynamic import with a LITERAL specifier is as resolvable as a static
		// one; a computed one cannot be checked here and is left alone.
		if (node.type === 'ImportExpression' && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
			found.push(node.source.value);
		}
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
			visit(node[key]);
		}
	};
	visit(tree);
	return [...new Set(found.filter((s) => s.startsWith('.')))];
}

describe('the tracked sources are self-contained', () => {
	it('imports nothing that git does not track', () => {
		const tracked = new Set(trackedFiles());
		// .js only: acorn cannot parse TypeScript declarations, and the type surface
		// already has its own gates in check:types and check:declarations. The class
		// hunted here is a RUNTIME load failure in a fresh clone.
		const sources = [...tracked].filter((f) => f.startsWith('src/') && f.endsWith('.js'));

		// A scan that finds no sources would pass while checking nothing, and the
		// whole point here is that absence is the failure mode being hunted.
		expect(sources.length, 'the scan must find tracked sources at all').toBeGreaterThan(50);

		const missing = [];
		let checked = 0;
		for (const file of sources) {
			// From the WORKING TREE, not from HEAD: an import added alongside a file
			// that was never `git add`ed is the case being hunted, and reading HEAD
			// would only notice it one commit too late.
			const source = readFileSync(path.join(ROOT, file), 'utf8');
			for (const spec of relativeSpecifiers(source)) {
				// Resolved against the file's own directory, as node would, then
				// compared to the TRACKED set rather than to disk.
				const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
				checked++;
				if (tracked.has(resolved)) continue;
				// A directory specifier resolves through its index; a bare
				// specifier may omit the extension in a .d.ts reference.
				if (tracked.has(resolved + '.js') || tracked.has(resolved + '/index.js')) continue;
				if (tracked.has(resolved + '.d.ts')) continue;
				missing.push(`${file} imports '${spec}' -> ${resolved}, which git does not track`);
			}
		}

		expect(checked, 'the scan must resolve some specifiers').toBeGreaterThan(50);
		expect(
			missing,
			'a source imports a module that is not in git, so a fresh clone cannot load it:\n' + missing.join('\n')
		).toEqual([]);
	}, 60000);

	it('tracks no file under a directory named build', () => {
		// Generated output does not belong in git, and a SOURCE file under such a
		// directory is the shape that gets silently ignored. Either way the answer
		// is that source does not live under a directory called build.
		// DIRECTORY segments only - the final segment is the filename, and
		// `build-config.js` is an ordinary source file rather than a build output.
		const offenders = trackedFiles().filter((f) =>
			f.split('/').slice(0, -1).some((seg) => seg === 'build' || seg.startsWith('build-'))
		);
		expect(
			offenders,
			'tracked files sit under a build directory: ' + JSON.stringify(offenders)
		).toEqual([]);
	});
});
