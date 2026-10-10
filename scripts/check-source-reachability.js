#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeImports } from './check-tracked-imports.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Generated/file-loaded entries and explicitly retained family utilities.
export const SOURCE_ENTRY_POINTS = Object.freeze({
	'src/runtime/index.js': 'Copied by the adapter to the generated server process entry.',
	'src/plugins/cursor/cursor-worker.js': 'Loaded by the cursor client with Worker(new URL(..., import.meta.url)).',
	'src/runtime/utils/cookies-string.js': 'Kept byte-identical to the lead file by the vendored manifest.'
});

/** Modules reachable from package exports and explicitly declared source roots. */
export function findOrphanModules(rootDirectory = root, additionalEntries = SOURCE_ENTRY_POINTS) {
	const modules = new Map();
	const walk = (directory) => {
		for (const entry of readdirSync(join(rootDirectory, directory), { withFileTypes: true })) {
			const file = directory + '/' + entry.name;
			if (entry.isDirectory()) walk(file);
			else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
				try {
					const imports = relativeImports(readFileSync(join(rootDirectory, file), 'utf8'));
					modules.set(file, imports.map(({ specifier }) => posix.normalize(posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, '')))));
				} catch (error) {
					throw new Error(file + ': cannot read module imports: ' + error.message);
				}
			}
		}
	};
	walk('src');
	if (modules.size === 0) throw new Error('No JavaScript source modules were found under src/.');
	const pkg = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8'));
	const entries = new Set();
	const collect = (value) => {
		if (typeof value === 'string' && value.startsWith('./')) {
			const file = posix.normalize(value);
			if (modules.has(file)) entries.add(file);
		} else if (value && typeof value === 'object') {
			for (const child of Object.values(value)) collect(child);
		}
	};
	collect(pkg.exports);
	if (entries.size === 0) throw new Error('Package exports do not identify any JavaScript source entry.');
	for (const [file, reason] of Object.entries(additionalEntries)) {
		if (typeof reason !== 'string' || !reason.trim()) throw new Error(file + ': source entry needs a reason.');
		if (!modules.has(file)) throw new Error(file + ': declared source entry does not exist.');
		entries.add(file);
	}
	const reachable = new Set();
	const visit = (file) => {
		if (reachable.has(file) || !modules.has(file)) return;
		reachable.add(file);
		for (const target of modules.get(file)) visit(target);
	};
	for (const entry of entries) visit(entry);
	return { orphans: [...modules.keys()].filter((file) => !reachable.has(file)).sort(), scanned: modules.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { orphans, scanned } = findOrphanModules();
		if (orphans.length) throw new Error('Source modules unreachable from package exports or declared entries:\n' + orphans.map((file) => '  ' + file).join('\n'));
		console.log('check-source-reachability: ' + scanned + ' modules reachable from declared entries.');
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
