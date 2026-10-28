#!/usr/bin/env node
// Write docs/legacy-diagnostic-prefixes.v1.json from the table parseDiagnostic
// uses for legacy lines. With --check, fail when the file is stale instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legacyDiagnosticPrefixes } from '../src/runtime/diagnostic.js';

const target = new URL('../docs/legacy-diagnostic-prefixes.v1.json', import.meta.url);
const expected = JSON.stringify(legacyDiagnosticPrefixes(), null, '\t') + '\n';
if (process.argv.includes('--check')) {
	let actual;
	try { actual = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch { actual = ''; }
	if (actual !== expected) {
		console.error(fileURLToPath(target) + ' is stale; run node scripts/generate-legacy-diagnostics.js');
		process.exit(1);
	}
} else writeFileSync(target, expected);
const { prefixes, families } = legacyDiagnosticPrefixes();
console.log(`legacy-diagnostics: ${prefixes.length} prefixes, ${families.length} families`);
