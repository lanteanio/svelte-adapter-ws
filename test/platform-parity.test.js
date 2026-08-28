// The PLATFORM_KEYS parity site: every key on the lead adapter's production
// platform object must exist on this adapter's platform, read mechanically
// from both sources by AST so a key added to the family surface fails a test
// here instead of failing an app that swapped adapters.
//
// The lead checkout is resolved from UWS_SRC or the sibling directory. Its
// absence FAILS the suite rather than skipping: a parity gate that silently
// stands down when its oracle is missing is not a gate. CI provides the
// sibling checkout the same way the family's own cross-repo checks do.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uwsRoot = process.env.UWS_SRC || path.resolve(repoRoot, '..', 'svelte-adapter-uws');

/**
 * Collect the non-computed own property keys of the first object literal
 * assigned to a `platform` const in a file. Computed (symbol) keys are
 * invisible to a drop-in consumer's property reads and deliberately skipped.
 *
 * @param {string} filePath
 * @returns {Set<string>}
 */
function platformKeys(filePath) {
	const source = readFileSync(filePath, 'utf8');
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	/** @type {Set<string>} */
	const keys = new Set();
	for (const node of /** @type {any} */ (ast).body) {
		const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
		if (declaration?.type !== 'VariableDeclaration') continue;
		for (const declarator of declaration.declarations) {
			if (declarator.id?.name !== 'platform' || declarator.init?.type !== 'ObjectExpression') continue;
			for (const property of declarator.init.properties) {
				if (property.type !== 'Property' || property.computed) continue;
				if (property.key.type === 'Identifier') keys.add(property.key.name);
				else if (property.key.type === 'Literal') keys.add(String(property.key.value));
			}
			return keys;
		}
	}
	throw new Error(`no platform object literal found in ${filePath}`);
}

describe('platform surface parity with the lead adapter', () => {
	it('finds the lead checkout its oracle reads from', () => {
		expect(
			existsSync(path.join(uwsRoot, 'src', 'runtime', 'handler', 'platform.js')),
			`svelte-adapter-uws checkout not found at ${uwsRoot}; set UWS_SRC to its path - ` +
			'the parity gate needs the lead source as its oracle'
		).toBe(true);
	});

	it('carries every key of the lead production platform', () => {
		const lead = platformKeys(path.join(uwsRoot, 'src', 'runtime', 'handler', 'platform.js'));
		const ours = platformKeys(path.join(repoRoot, 'src', 'runtime', 'handler', 'platform.js'));
		expect(lead.size).toBeGreaterThan(5);
		expect(ours.size).toBeGreaterThan(5);
		const missing = [...lead].filter((key) => !ours.has(key));
		expect(
			missing,
			'platform keys present on the lead adapter but missing here (a drop-in app would crash reading them): ' +
			missing.join(', ')
		).toEqual([]);
	});
});

describe('wire revision parity', () => {
	it('declares the same protocol revision, byte-identical', () => {
		const ours = readFileSync(path.join(repoRoot, 'protocol.schema.json'));
		const schema = JSON.parse(ours.toString());
		expect(schema.$id).toMatch(/revision-1$/);
		const leadSchemaPath = path.join(uwsRoot, 'protocol.schema.json');
		expect(existsSync(leadSchemaPath)).toBe(true);
		expect(ours.equals(readFileSync(leadSchemaPath))).toBe(true);
	});
});
