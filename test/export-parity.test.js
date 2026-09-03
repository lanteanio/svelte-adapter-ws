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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { LEAD, readLeadAtPin, repoRoot, uwsRoot } from './lead-pin.js';

const ours = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).exports;

// The lead's own package manifest and README come from the PINNED revision,
// never from its working tree, for the same reason the vendored gate reads it
// there: the lead is a live checkout, and an unsaved edit on that side must not
// decide whether this suite is green.
const LEAD_META = readLeadAtPin(['package.json', 'README.md']);
const leadPkg = LEAD_META.get('package.json');
const leadReadme = LEAD_META.get('README.md');

function leadExports() {
	expect(leadPkg, `lead package.json missing at ${LEAD.rev}`).not.toBe(null);
	return JSON.parse(/** @type {string} */ (leadPkg)).exports;
}

describe('declared subpaths stay inside the lead surface', () => {
	it('finds the lead checkout its oracle reads from', () => {
		expect(
			existsSync(path.join(uwsRoot, 'package.json')),
			`svelte-adapter-uws checkout not found at ${uwsRoot}; set UWS_SRC to its path`
		).toBe(true);
		expect(
			leadPkg,
			`the lead checkout at ${uwsRoot} has no commit ${LEAD.rev}; fetch it, or ` +
			'bump rev in test/vendored-lead.json to a revision it does have'
		).not.toBe(null);
	});

	it('declares no subpath the lead does not', () => {
		const lead = leadExports();
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
		const lead = leadExports();
		const missing = Object.keys(lead).filter((subpath) => !(subpath in ours));
		expect(
			missing,
			'the lead declares these and this package does not; an app that imports ' +
			'one cannot move here, which is the same broken promise in the other ' +
			'direction'
		).toEqual([]);
	});

	it('points every shared subpath at the same relative targets as the lead', () => {
		const lead = leadExports();
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
		expect(leadReadme, `lead README.md missing at ${LEAD.rev}`).not.toBe(null);
		const lead = new Map(
			catalogRows(/** @type {string} */ (leadReadme)).map((cells) => {
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

// The NAME half of the same promise. Matching subpaths that resolve is not
// drop-in: an app moves back only if every name it imported from a subpath is
// there under the same spelling. Both directions matter - a name the lead has
// and this package does not is a hole an app falls into on the way here, and a
// name only this package has is one it cannot carry back.
//
// Both sides are read the same way, so the comparison cannot be an artifact of
// two different scanners: the runtime target is acorn-PARSED (a hand-rolled
// scanner cannot tell a regex literal from division, and one regex containing a
// quote swallows the rest of the file and reports zero exports), and the
// declaration target is a comment-stripped text scan (acorn does not read
// TypeScript, and a .d.ts carries no regex literals, so the hazard the parser
// exists for is absent there). `export * from './x.js'` is followed
// transitively on both sides; a bare specifier is a package boundary and its
// names belong to that package.

/** @param {string} rel */
function normalizeRel(rel) {
	return rel.replace(/^\.\//, '').split(path.sep).join('/');
}

/** @param {string} from @param {string} spec */
function resolveFrom(from, spec) {
	return normalizeRel(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
}

/**
 * Names a JS module exports, plus the relative modules it re-exports wholesale.
 * @param {string} src
 * @param {string} label
 */
function runtimeExportNames(src, label) {
	let ast;
	try {
		ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
	} catch (err) {
		throw new Error(`${label}: cannot be parsed to read its exports - ${/** @type {Error} */ (err).message}`);
	}
	/** @type {Set<string>} */
	const names = new Set();
	/** @type {string[]} */
	const follow = [];
	for (const node of ast.body) {
		if (node.type === 'ExportNamedDeclaration') {
			const d = node.declaration;
			if (d) {
				if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
					if (d.id) names.add(d.id.name);
				} else if (d.type === 'VariableDeclaration') {
					for (const decl of d.declarations) {
						if (decl.id.type === 'Identifier') names.add(decl.id.name);
					}
				}
			}
			for (const spec of node.specifiers) {
				const exported = spec.exported;
				const name = exported.type === 'Identifier' ? exported.name : exported.value;
				if (name && name !== 'default') names.add(name);
			}
		} else if (node.type === 'ExportAllDeclaration') {
			if (node.exported) {
				const name = node.exported.type === 'Identifier' ? node.exported.name : node.exported.value;
				if (name) names.add(name);
			} else {
				follow.push(String(node.source.value));
			}
		}
	}
	return { names, follow };
}

/** @param {string} src */
function stripComments(src) {
	let out = '';
	let i = 0;
	while (i < src.length) {
		if (src[i] === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (src[i] === '/' && src[i + 1] === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i += 2;
			out += ' ';
			continue;
		}
		out += src[i];
		i++;
	}
	return out;
}

/**
 * Names a `.d.ts` declares or re-exports, plus the relative declarations it
 * re-exports wholesale.
 * @param {string} raw
 */
function declaredNames(raw) {
	const src = stripComments(raw);
	/** @type {Set<string>} */
	const names = new Set();
	/** @type {string[]} */
	const follow = [];
	const declared = /(?:^|\n)\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of src.matchAll(declared)) names.add(m[1]);
	const list = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}/g;
	for (const m of src.matchAll(list)) {
		for (const part of m[1].split(',')) {
			const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
			if (name && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	const star = /(?:^|\n)\s*export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g;
	for (const m of src.matchAll(star)) names.add(m[1]);
	const all = /(?:^|\n)\s*export\s*\*\s+from\s*['"]([^'"]+)['"]/g;
	for (const m of src.matchAll(all)) follow.push(m[1]);
	return { names, follow };
}

/**
 * Every name a target exposes, following relative `export * from` chains.
 *
 * @param {(files: string[]) => Map<string, string | null>} readBatch
 * @param {string} entry
 * @param {(src: string, label: string) => { names: Set<string>, follow: string[] }} scan
 * @param {(rel: string) => string} [mapFollow] - rewrite a followed specifier,
 *   so a declaration chain follows into declarations rather than into the
 *   runtime modules their specifiers are spelled after
 */
function surfaceOf(readBatch, entry, scan, mapFollow = (rel) => rel) {
	/** @type {Set<string>} */
	const names = new Set();
	const seen = new Set();
	let pending = [normalizeRel(entry)];
	while (pending.length > 0) {
		const batch = pending.filter((file) => !seen.has(file));
		for (const file of batch) seen.add(file);
		if (batch.length === 0) break;
		const sources = readBatch(batch);
		pending = [];
		for (const file of batch) {
			const src = sources.get(file);
			// A re-export chain that dead-ends is a broken surface, not an empty
			// one; name the file rather than silently comparing fewer names.
			expect(src, `cannot read ${file} to read its exports`).not.toBe(null);
			const { names: found, follow } = scan(/** @type {string} */ (src), file);
			for (const name of found) names.add(name);
			for (const spec of follow) {
				if (spec.startsWith('.')) pending.push(mapFollow(resolveFrom(file, spec)));
			}
		}
	}
	return names;
}

/** @param {string[]} files */
function readOursBatch(files) {
	return new Map(files.map((file) => {
		try {
			return [file, readFileSync(path.join(repoRoot, file), 'utf8')];
		} catch {
			return [file, null];
		}
	}));
}

describe('every subpath exposes exactly the names the lead exposes', () => {
	const lead = leadExports();
	for (const [subpath, condition] of Object.entries(ours)) {
		for (const [kind, scan] of /** @type {const} */ ([['default', runtimeExportNames], ['types', declaredNames]])) {
			it(`${subpath} (${kind}) has the lead's name set`, () => {
				// A declaration re-export names a declaration: tsc reads a
				// wholesale re-export spelled './x.js' inside a .d.ts as ./x.d.ts.
				// Following the .js spelling literally would scan the runtime
				// module with the declaration scanner and drop every type in
				// x.d.ts while still reporting a matching name set.
				const mapFollow = kind === 'types'
					? (/** @type {string} */ rel) =>
						rel.endsWith('.d.ts') ? rel : rel.replace(/\.(?:js|ts)$/, '.d.ts')
					: undefined;
				const oursNames = surfaceOf(readOursBatch, condition[kind], scan, mapFollow);
				const leadNames = surfaceOf(readLeadAtPin, lead[subpath][kind], scan, mapFollow);
				expect(
					[...leadNames].filter((name) => !oursNames.has(name)).sort(),
					`the lead exposes these on ${subpath} and this package does not; an app ` +
					'that imports one cannot move here'
				).toEqual([]);
				expect(
					[...oursNames].filter((name) => !leadNames.has(name)).sort(),
					`these exist only here on ${subpath}; an app that imports one cannot move ` +
					'back to the lead. Keep the code internal and propose the name on the lead instead'
				).toEqual([]);
			});
		}
	}
});

// The declaration gate itself, held from the suite rather than only from a
// `check:*` script an operator has to remember to run: every named runtime
// export in the map must carry a declaration in the paired `.d.ts`.
describe('every runtime export carries a declaration', () => {
	it('passes scripts/check-types.js', () => {
		expect(() =>
			execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'check-types.js')], {
				cwd: repoRoot,
				stdio: ['ignore', 'pipe', 'pipe']
			})
		, 'run: node scripts/check-types.js').not.toThrow();
	});
});
