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

import { LEAD, readLeadAtPin, repoRoot, uwsRoot } from './lead-pin.js';

// The lead is read at the revision this repo vendored from, never from its
// working tree: that checkout belongs to a live session, and a file saved
// there mid-edit would move this gate on a change that is not ours and is not
// even committed. It also makes the verdict reproducible - the same two
// checkouts answer the same way on any machine.
const LEAD_SOURCES = readLeadAtPin(['src/runtime/handler/platform.js', 'protocol.schema.json']);

/**
 * Collect the non-computed own property keys of the first object literal
 * assigned to a `platform` const in a file. Computed (symbol) keys are
 * invisible to a drop-in consumer's property reads and deliberately skipped.
 *
 * @param {string} filePath
 * @returns {Set<string>}
 */
function platformKeys(source) {
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
		const leadSource = LEAD_SOURCES.get('src/runtime/handler/platform.js');
		expect(
			leadSource,
			`the lead checkout at ${uwsRoot} has no commit ${LEAD.rev}; fetch it, or bump ` +
			'rev in test/vendored-lead.json to a revision it does have'
		).not.toBe(null);
		const lead = platformKeys(/** @type {string} */ (leadSource));
		const ours = platformKeys(readFileSync(path.join(repoRoot, 'src', 'runtime', 'handler', 'platform.js'), 'utf8'));
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
		const leadSchema = LEAD_SOURCES.get('protocol.schema.json');
		expect(
			leadSchema,
			`the lead checkout at ${uwsRoot} has no protocol.schema.json at ${LEAD.rev}`
		).not.toBe(null);
		// Byte-identical, and the schema is checked out with -text so no
		// line-ending normalization stands between the two copies.
		expect(ours.toString()).toBe(leadSchema);
	});
});
