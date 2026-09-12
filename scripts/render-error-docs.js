// Renders docs/errors.md from the error registry, so every `help:` link in
// src/runtime/error-registry.js resolves to a real section. The registry is
// the single source of truth; edit it and re-run this script:
//
//   node scripts/render-error-docs.js
//
// The GitHub anchor for a `## ADAPTER-ERR-*` heading is the lowercased id,
// which is exactly each entry's `anchor` field - the check below keeps that
// true so a registry edit cannot silently break its own help link.
//
// The page opens with the two indexes an operator reads it for: a row per id
// carrying the code or event and the searchable start of the line, and a list
// keyed the other way round - by the event name a sink reports, or by the
// printed prefix for the lines that never enter the diagnostic pipeline. Both
// are derived from the registry, so an entry cannot appear in one and be
// missing from the other.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A table cell: a pipe would end the column and a newline the row. */
function cell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Console entries index plain console lines rather than diagnostic events:
// their event fields are registry keys that never appear in a log, so listing
// them beside the emitted events would overstate what the pipeline carries.
const consoleEntries = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission === 'console');
const diagnosticEntries = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission !== 'console');

const lines = [
	'# Adapter error reference',
	'',
	'Search this page with the exact stable ID, code, event, or the beginning of the',
	'message you saw. Every operator-facing failure the runtime can emit is indexed',
	'here with its cause, what it means for traffic, whether anything recovers on its',
	'own, and what to do next: ' + diagnosticEntries.length + ' entries for failures that enter the diagnostic',
	'pipeline, and ' + consoleEntries.length + ' indexing consequential plain console lines that never do - each',
	'of those is printed through the registry and carries its stable ID tag, so the',
	'emitted text cannot drift from the prefix indexed here.',
	'',
	'Generated from `src/runtime/error-registry.js` by',
	'`node scripts/render-error-docs.js`; edit the registry, not this file.',
	'',
	'| Stable ID | Code or event | Searchable message prefix |',
	'|---|---|---|'
];

for (const entry of ADAPTER_ERROR_REGISTRY) {
	lines.push(
		'| [' + entry.id + '](#' + entry.anchor + ') | `' + cell(entry.code || entry.event) +
		'` | `' + cell(entry.messagePrefix) + '` |'
	);
}

lines.push(
	'',
	'## Indexed events and console lines',
	'',
	'Indexed events:',
	''
);
for (const entry of diagnosticEntries) {
	lines.push('- `' + entry.event + '` - [' + entry.id + '](#' + entry.anchor + ')');
}
lines.push(
	'',
	'Indexed console lines (no diagnostic event; the searchable key is the printed prefix and',
	'the stable ID tag on the line):',
	''
);
for (const entry of consoleEntries) {
	lines.push('- `' + cell(entry.messagePrefix) + '` - [' + entry.id + '](#' + entry.anchor + ')');
}
lines.push('');

for (const entry of ADAPTER_ERROR_REGISTRY) {
	const expectedAnchor = entry.id.toLowerCase();
	if (entry.anchor !== expectedAnchor) {
		throw new Error(`anchor mismatch for ${entry.id}: registry says '${entry.anchor}', heading yields '${expectedAnchor}'`);
	}
	lines.push(`## ${entry.id}`, '');
	if (entry.severity) lines.push(`Severity: ${entry.severity}`, '');
	if (entry.messagePrefix) {
		lines.push('Log line begins:', '', '```', entry.messagePrefix, '```', '');
	}
	if (entry.cause) lines.push(`**Cause.** ${entry.cause}`, '');
	if (entry.consequence) lines.push(`**Consequence.** ${entry.consequence}`, '');
	if (entry.automaticRecovery) lines.push(`**Automatic recovery.** ${entry.automaticRecovery}`, '');
	if (entry.nextAction) lines.push(`**What to do.** ${entry.nextAction}`, '');
	if (entry.link) lines.push(`Further reading: ${entry.link}`, '');
}

const outPath = path.join(repoRoot, 'docs', 'errors.md');
const rendered = lines.join('\n') + '\n';

// --check verifies instead of writing. Without it a CI step spelled
// `render-error-docs.js --check` regenerates the file and reports success, so
// a stale reference passes the very gate meant to catch it. An unknown flag
// that silently does the destructive thing is worse than no flag at all.
if (process.argv.includes('--check')) {
	const current = existsSync(outPath) ? readFileSync(outPath, 'utf8').split('\r\n').join('\n') : null;
	if (current !== rendered) {
		console.error('docs/errors.md is out of date; run: node scripts/render-error-docs.js');
		process.exit(1);
	}
	console.log('docs/errors.md is current (' + ADAPTER_ERROR_REGISTRY.length + ' entries).');
} else {
	writeFileSync(outPath, rendered);
	console.log('docs/errors.md rendered (' + ADAPTER_ERROR_REGISTRY.length + ' entries).');
}
