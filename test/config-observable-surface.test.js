// Every eval-time knob the post-import guard compares must be readable back off
// the REAL built config module.
//
// `startRealRuntime` refuses to boot when the module it imported disagrees with
// the environment the caller asked for, and for an UNSET knob its expectation is
// the documented default rather than absence. So a knob the config module never
// exports reads back as undefined, never equals that default, and mismatches on
// every single boot - not only on the cached-module case the guard was written
// for. The message it throws names a shared fixture variant, which reads as a
// fixture problem rather than as a missing export, and that is what makes this
// worth pinning separately.
//
// WHY THE GUARD'S OWN SUITE CANNOT SEE THIS. `evalTimeEnvMismatches` is exercised
// against a hand-written object literal standing in for a booted module. Such an
// object carries every key by construction, so it can prove the comparison logic
// and still be blind to a module that omits one. These cases read the module the
// adapter actually builds.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { EVAL_TIME_ENV, OBSERVABLE, evalTimeEnvMismatches } from './helpers/real-runtime.js';
import { variantOut } from './fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('fixture', import.meta.url));

/** The built `handler/config.js` module namespace, imported under a scrubbed env. */
let config;

beforeAll(async () => {
	expect(buildFixtureOnce('default'), 'the default fixture variant must build').toBeTruthy();

	// Import under a KNOWN environment. The module reads all of these at eval, and
	// `process.env` is shared across a worker, so a value left by the developer's
	// shell would otherwise decide what this file measures.
	const before = EVAL_TIME_ENV.map((key) => /** @type {const} */ ([key, process.env[key]]));
	for (const key of EVAL_TIME_ENV) delete process.env[key];
	try {
		config = await import(
			pathToFileURL(path.join(fixtureDir, variantOut('default'), 'handler', 'config.js')).href
		);
	} finally {
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}, 120000);

describe('the built config exposes every knob the boot guard compares', () => {
	it('exports a readable value for each knob whose default is not absence', () => {
		// Two kinds of entry are excluded, and neither is an oversight. A
		// `presenceOnly` entry is declared uncomparable. And a knob whose documented
		// default IS absence - ORIGIN parses to undefined when unset, as do the
		// cert paths - reads back identically whether the module exports it or not,
		// which is also why the guard cannot trip over one. What remains is exactly
		// the set where a missing export is both detectable and harmful.
		const missing = OBSERVABLE.filter((entry) => !entry.presenceOnly)
			.filter((entry) => entry.expect(undefined, config) !== undefined)
			.filter((entry) => entry.read(config) === undefined)
			.map((entry) => entry.env)
			.sort();

		expect(
			missing,
			`src/runtime/handler/config.js exports nothing the guard can read for these, so ` +
			`startRealRuntime refuses every boot with "asked for <default>, module has (unset)": ` +
			`${missing.join(', ')}. Export the resolved value, spelled as the lead spells it.`
		).toEqual([]);
	});

	it('reports no mismatch for a boot that set no eval-time env at all', () => {
		expect(evalTimeEnvMismatches(config, {})).toEqual([]);
	});

	// The two cases above both pass when a comparison silently answers "nothing to
	// report", which is also what a broken comparator does. This one fails if the
	// guard has stopped looking at the real module, so their green means something.
	it('still names a knob whose asked-for value the module does not carry', () => {
		const mismatches = evalTimeEnvMismatches(config, { XFF_DEPTH: '3' });
		expect(mismatches.join(' | ')).toContain('XFF_DEPTH');
		expect(mismatches.join(' | ')).toContain('3');
	});
});
