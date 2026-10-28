import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legacyDiagnosticPrefixes } from '../src/runtime/diagnostic.js';
import { readLeadAtPin } from './lead-pin.js';

const file = 'docs/legacy-diagnostic-prefixes.v1.json';
const oracle = readLeadAtPin([file]).get(file);

describe('legacy diagnostic prefix identity', () => {
	it('preserves the complete pinned family inventory byte for byte', () => {
		expect(oracle, 'the pinned legacy prefix inventory must be available').not.toBeNull();
		const published = readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
		expect(published).toBe(oracle.replace(/\r\n/g, '\n'));
		expect(legacyDiagnosticPrefixes()).toEqual(JSON.parse(oracle));
	});
});
