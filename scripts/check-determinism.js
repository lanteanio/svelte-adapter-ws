#!/usr/bin/env node
/**
 * Guard that framework source reads the clock, RNG and timers through the
 * injectable runtime module (runtime.js) rather than the raw native primitives.
 * Routing every nondeterministic primitive through one swappable module is what
 * lets a seeded harness replay behavior exactly; a raw call left anywhere is a
 * silent hole that makes a replay diverge.
 *
 * Dependency-free (no eslint); CI runs it as `npm run check:determinism` in
 * the unit job.
 *
 * Known evasion holes, accepted for a dependency-free line scanner (closing
 * them means an import-graph-aware lint): an aliased import
 * (`import { randomBytes as rb }`) escapes the name patterns; a reference
 * that is not called on the same line (`const f = Date.now`, or a call split
 * across lines) escapes the trailing-paren match; ALLOW_FILES matches by
 * basename, so ANY file named runtime.js or client-runtime.js is exempt
 * wherever it lives; lines that LOOK like comments are skipped textually, so
 * a multi-line template-literal line starting with `//` or `*` is invisible;
 * and the determinism-allow marker is honored anywhere on a line, string
 * content included. The scan is a ratchet against honest drift, not a
 * sandbox against adversarial code - review still owns intent.
 *
 * Modes:
 *   - default: WARN. Prints a per-file summary of raw call sites and exits 0, so
 *     the guard can land before every call site is routed through the module.
 *   - a framework source file under src/ must be clean: a raw call in it FAILS
 *     (exit 1). Enforcement is a subtree prefix (see ENFORCE_EXCEPT), so a
 *     relocated or newly added module is covered automatically - a ratchet that
 *     cannot regress.
 *   - `--strict`: treat every finding as an error (the end state, once the whole
 *     surface is migrated).
 *   - `--verbose`: list every finding, not just per-file counts.
 *
 * A single line may opt out with a trailing `// determinism-allow: <reason>`
 * comment (for the genuinely cosmetic init-time log timers and the like).
 *
 * @module scripts/check-determinism
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const verbose = process.argv.includes('--verbose');

// The only files permitted to touch the native primitives: the runtime module
// is the single binding point. Matched by basename so the per-repo path (src/runtime/
// vs shared/) does not matter.
const ALLOW_FILES = new Set(['runtime.js', 'client-runtime.js']);

// Enforcement is a subtree prefix: every framework source file under src/ must
// stay clean (the runtime module in ALLOW_FILES is exempt by basename, and so
// is any dev-only file in ENFORCE_EXCEPT). The ratchet is structural - a
// relocated or newly added module under src/ is enforced automatically, with no
// per-file list to maintain.
const ENFORCE_EXCEPT = new Set([
	// Nothing yet. This adapter has no dev-server surface (SvelteKit dev runs
	// under Vite); every file under src/ is either build-time code or the
	// served runtime, and both stay clean.
]);

function isEnforced(rel) {
	return rel.startsWith('src/') && !ENFORCE_EXCEPT.has(rel);
}

// Path segments that are never framework runtime source. Applied OUTSIDE the
// enforced src/ subtree only: under src/, a directory named like one of these
// (a future src/test/ or src/build/) would otherwise silently leave the scan,
// which is exactly the regression the structural ratchet exists to prevent.
const SKIP_SEGMENTS = new Set([
	'node_modules', 'test', 'tests', '__tests__', 'bench', 'benchmarks', 'scripts', 'probe',
	'fixture', 'fixtures', '.svelte-kit', 'dist', 'build', 'coverage', 'examples',
	'example', 'docs', '.git'
]);
// These two are skipped everywhere, src/ included - never first-party source.
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git']);
// Suffix skips apply OUTSIDE src/ only, like the segment skips and for the
// same reason: a test or config file placed under src/ is enforced as source
// rather than silently leaving the ratchet. One entry per scanned extension.
const SKIP_SUFFIX = [
	'.test.js', '.test.mjs', '.test.cjs',
	'.spec.js', '.spec.mjs', '.spec.cjs',
	'.config.js', '.config.mjs', '.config.cjs'
];
const SCAN_EXT = ['.js', '.mjs', '.cjs'];

function isUnderSrc(rel) {
	return rel === 'src' || rel.startsWith('src/');
}

// Ordered most-specific-first so a dotted form wins over the bare form on the
// same line (we report one primitive per line).
const PATTERNS = [
	['Date.now', /\bDate\s*\.\s*now\s*\(/],
	['new Date', /\bnew\s+Date\b/],
	['performance.now', /\bperformance\s*\.\s*now\s*\(/],
	['Math.random', /\bMath\s*\.\s*random\s*\(/],
	['crypto.randomUUID', /\bcrypto\s*\.\s*randomUUID\s*\(/],
	['crypto.randomBytes', /\bcrypto\s*\.\s*randomBytes\s*\(/],
	['crypto.randomInt', /\bcrypto\s*\.\s*randomInt\s*\(/],
	['getRandomValues', /\bgetRandomValues\s*\(/],
	['randomUUID', /\brandomUUID\s*\(/],
	['randomBytes', /\brandomBytes\s*\(/],
	['randomInt', /\brandomInt\s*\(/],
	['setTimeout', /\bsetTimeout\s*\(/],
	['setInterval', /\bsetInterval\s*\(/],
	['setImmediate', /\bsetImmediate\s*\(/],
	['clearTimeout', /\bclearTimeout\s*\(/],
	['clearInterval', /\bclearInterval\s*\(/],
	['queueMicrotask', /\bqueueMicrotask\s*\(/],
	['process.hrtime', /\bprocess\s*\.\s*hrtime\b/],
	['process.nextTick', /\bprocess\s*\.\s*nextTick\s*\(/],
	// The served runtime targets Bun, so Bun's own clock/timer spellings are
	// part of the raw surface, not an exotic case.
	['Bun.sleepSync', /\bBun\s*\.\s*sleepSync\s*\(/],
	['Bun.sleep', /\bBun\s*\.\s*sleep\s*\(/],
	['Bun.nanoseconds', /\bBun\s*\.\s*nanoseconds\s*\(/]
];

function shouldSkipPath(rel) {
	if (ALLOW_FILES.has(basename(rel))) return true;
	if (isUnderSrc(rel)) return false;
	if (SKIP_SUFFIX.some((suf) => rel.endsWith(suf))) return true;
	return rel.split('/').some((s) => SKIP_SEGMENTS.has(s));
}

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		let st;
		try { st = statSync(abs); } catch { continue; }
		// Normalize to forward slashes so the ENFORCED set (and the printed
		// report) read the same on Windows and POSIX. ENFORCED entries are
		// written with forward slashes; a raw backslash path would silently
		// skip enforcement on Windows.
		const rel = relative(root, abs).split('\\').join('/');
		if (st.isDirectory()) {
			if (ALWAYS_SKIP_DIRS.has(entry)) continue;
			if (!isUnderSrc(rel) && SKIP_SEGMENTS.has(entry)) continue;
			walk(abs, out);
		} else if (SCAN_EXT.some((e) => abs.endsWith(e)) && !shouldSkipPath(rel)) {
			out.push(rel);
		}
	}
}

function scanFile(rel) {
	const findings = [];
	const text = readFileSync(join(root, rel), 'utf8');
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // comment line
		if (/\/\/\s*determinism-allow:/.test(line)) continue; // explicit opt-out
		for (const [name, re] of PATTERNS) {
			if (re.test(line)) {
				findings.push({ rel, line: i + 1, primitive: name, snippet: trimmed.slice(0, 80) });
				break; // one primitive per line keeps the report readable
			}
		}
	}
	return findings;
}

const files = [];
walk(root, files);
files.sort();

const all = [];
for (const rel of files) all.push(...scanFile(rel));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`check-determinism: ${pkg.name}@${pkg.version}`);
console.log(`  ${files.length} framework source file(s) scanned, ${all.length} raw native-primitive call site(s) found.`);

const errors = all.filter((f) => strict || isEnforced(f.rel));
const warnings = all.filter((f) => !errors.includes(f));

// Per-file summary so CI output stays bounded; --verbose lists each site.
const byFile = new Map();
for (const f of warnings) byFile.set(f.rel, (byFile.get(f.rel) || 0) + 1);
if (byFile.size) {
	console.log(`  warn (route these through runtime.js as their area is migrated):`);
	for (const [rel, n] of [...byFile.entries()].sort()) {
		console.log(`    ~ ${rel}: ${n}`);
		if (verbose) for (const f of warnings.filter((w) => w.rel === rel)) {
			console.log(`        ${f.line}: ${f.primitive}  ${f.snippet}`);
		}
	}
}

if (errors.length) {
	console.error(`\ncheck-determinism FAILED (${errors.length} enforced violation(s)):`);
	for (const f of errors) console.error(`  x ${f.rel}:${f.line}  ${f.primitive}  ${f.snippet}`);
	console.error(`  Route these through runtime.js, or annotate the line with "// determinism-allow: <reason>".`);
	process.exit(1);
}

console.log(`  OK - no enforced violations${strict ? '' : ' (warn mode)'}.`);
