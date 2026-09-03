#!/usr/bin/env node
/**
 * Compile every declaration file this package publishes.
 *
 * check-types.js answers a different question: it reads each subpath's runtime
 * module and its declaration file as TEXT and reports a name exported by one
 * and not declared by the other. That scan cannot see whether the declarations
 * it just matched actually COMPILE - a type referenced without its import, a
 * member whose type does not resolve, a generic used with the wrong arity all
 * pass a name scan untouched. publint and attw resolve the subpaths but do not
 * lib-check them either, so without this gate a declaration surface can be
 * broken in every consumer while all four existing checks report green.
 *
 * What a consumer sees when this is broken depends on their tsconfig, and both
 * outcomes are bad: with the default skipLibCheck:false (SvelteKit's generated
 * tsconfig sets none) their own `tsc` or `svelte-check` reports errors out of
 * node_modules; with skipLibCheck:true the file is skipped entirely and the
 * hook contract silently resolves to an error type, so the types stop meaning
 * anything without saying so.
 *
 * The oracle is package.json's own exports map - every `types` target it
 * publishes, compiled together under the settings a modern consumer uses, so
 * the gate cannot drift from what actually ships.
 *
 * Run as `npm run check:declarations`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/** Every declaration target the exports map publishes, deduplicated and in map order. */
const targets = [];
for (const entry of Object.values(pkg.exports ?? {})) {
	const types = entry && typeof entry === 'object' ? entry.types : null;
	if (typeof types === 'string' && !targets.includes(types)) targets.push(types);
}

if (targets.length === 0) {
	console.error('check-declarations: the exports map publishes no `types` target - nothing to compile.');
	process.exit(1);
}

const missing = targets.filter((t) => !existsSync(path.join(repoRoot, t)));
if (missing.length > 0) {
	console.error('check-declarations: exports map points at declaration files that do not exist:');
	for (const m of missing) console.error('  x ' + m);
	process.exit(1);
}

// nodenext is what a consumer on a modern SvelteKit app resolves with, and
// strict is what makes an unresolved name an error rather than an implicit any.
// dom is needed because the handler contract names Request, Response and
// Headers.
const tscArgs = [
	'--noEmit',
	'--strict',
	'--target', 'es2022',
	'--module', 'nodenext',
	'--moduleResolution', 'nodenext',
	'--lib', 'es2022,dom',
	...targets
];

// Run tsc's own JS entry through this node rather than the .bin shim: on
// Windows the shim is a .cmd, which execFile refuses to run without a shell,
// and going through a shell would swallow the compiler's exit code behind the
// shell's own.
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tsc)) {
	console.error(
		'check-declarations: typescript is not installed. It is a devDependency of this package - run `npm install`.'
	);
	process.exit(1);
}

try {
	execFileSync(process.execPath, [tsc, ...tscArgs], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' });
} catch (err) {
	const out = (err.stdout || '') + (err.stderr || '');
	console.error('check-declarations: the published declarations do not compile.\n');
	console.error(out.trim());
	process.exit(1);
}

console.log(
	`check-declarations: OK - ${targets.length} published declaration file(s) compile under ` +
	'strict nodenext.'
);
