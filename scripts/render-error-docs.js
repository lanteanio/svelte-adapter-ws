// Renders docs/errors.md from the error registry, so every `help:` link in
// src/runtime/error-registry.js resolves to a real section. The registry is
// the single source of truth; edit it and re-run this script:
//
//   node scripts/render-error-docs.js
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
import { createRequire } from 'node:module';
import { DIAGNOSTIC_PREFIX } from '../src/runtime/diagnostic-format.js';
import { scanEmittedEvents, findGhostRegistryEntries, findUnindexedFailures, validateErrorRegistry } from './error-event-coverage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A table cell: a pipe would end the column and a newline the row. */
function cell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Where each sibling package keeps its own error reference. This page is the
// adapter-owned part of one ecosystem index, and a reader who arrived at it
// holding a line from the client or the extensions package needs to be told
// where that package's reference lives rather than concluding the line is
// undocumented.
const SIBLING_ERROR_DOCUMENTS = Object.freeze([
	Object.freeze({ repo: 'svelte-realtime', label: 'svelte-realtime errors', documentPath: 'docs/errors.md' }),
	Object.freeze({ repo: 'svelte-adapter-uws-extensions', label: 'svelte-adapter-uws-extensions errors', documentPath: 'docs/errors.md' })
]);

// A prerelease links the siblings' dev branch, a release their main: the
// reference a reader wants is the one that shipped beside the version they
// are running.
const packageVersion = createRequire(import.meta.url)('../package.json').version;
const siblingRef = String(packageVersion).includes('-') ? 'dev' : 'main';

// Console entries index plain console lines rather than diagnostic events:
// their event fields are registry keys that never appear in a log, so listing
// them beside the emitted events would overstate what the pipeline carries.
const consoleEntries = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission === 'console');
const diagnosticEntries = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission !== 'console');

const scan = scanEmittedEvents();
const errors = [...validateErrorRegistry(ADAPTER_ERROR_REGISTRY), ...findGhostRegistryEntries(ADAPTER_ERROR_REGISTRY, scan), ...findUnindexedFailures(scan)];
if (errors.length) throw new Error(errors.join('\n'));
const indexedEvents = new Set(ADAPTER_ERROR_REGISTRY.map((entry) => entry.event));
const unindexed = scan.events.filter((record) => !indexedEvents.has(record.event));
const scannedNames = new Set(scan.events.map((record) => record.event));
const emittedCount = scan.events.length + diagnosticEntries.filter((entry) => !scannedNames.has(entry.event)).length;

const lines = [
	'# Adapter error reference',
	'',
	'Search this page with the exact stable ID, code, event, or beginning of the',
	'message you saw. Every operator-facing failure the runtime can emit is indexed',
	'here with its cause, what it means for traffic, whether anything recovers on its',
	'own, and what to do next: ' + diagnosticEntries.length + ' entries carrying a stable ID and operator',
	'guidance, plus ' + consoleEntries.length + ' indexing consequential plain console lines that never enter',
	'the diagnostic pipeline - each of those is printed through the registry and',
	'carries its stable ID tag, so the emitted text cannot drift from the prefix',
	'indexed here.',
	'',
	'Generated from `src/runtime/error-registry.js` by',
	'`node scripts/render-error-docs.js`; edit the registry, not this file.',
	'',
	'This is the adapter-owned part of the ecosystem index. The sibling packages',
	'generate and ship their own runtime-owned references on the same release channel:',
	''
];

for (const sibling of SIBLING_ERROR_DOCUMENTS) {
	lines.push('- [' + sibling.label + '](https://github.com/lanteanio/' + sibling.repo + '/blob/' + siblingRef + '/' + sibling.documentPath + ')');
}

lines.push(
	'',
	'| Stable ID | Code or event | Searchable message prefix |',
	'|---|---|---|'
);

/**
 * An inline code span that renders `value` exactly: the fence is one backtick
 * longer than the longest run inside it, and a value that starts or ends with a
 * backtick, or starts and ends with a space, is padded with one space each
 * side - the one case CommonMark strips a space, which it then strips again.
 * @param {string} value
 */
function codeSpan(value) {
	const text = String(value);
	let longest = 0;
	for (const run of text.match(/`+/g) || []) longest = Math.max(longest, run.length);
	const fence = '`'.repeat(longest + 1);
	const pad = /^`|`$/.test(text) || (/^ /.test(text) && / $/.test(text)) ? ' ' : '';
	return fence + pad + text + pad + fence;
}

for (const entry of ADAPTER_ERROR_REGISTRY) {
	lines.push(
		'| [' + entry.id + '](#' + entry.anchor + ') | `' + cell(entry.code || entry.event) +
		'` | ' + codeSpan(cell(entry.messagePrefix)) + ' |'
	);
}

lines.push(
	'',
	'## Emitted diagnostic event coverage',
	'',
	'This inventory is derived at generation time by scanning `src/runtime/`,',
	'`src/observability.js`, `src/vite.js`, and `src/testing.js` for emitted diagnostic events; the runtime emits ' + emittedCount + ' distinct events.',
	'The ' + diagnosticEntries.length + ' indexed above carry stable IDs and full operator guidance; the remaining ' + unindexed.length,
	'are informational. That split is enforced by severity rather than by a list: an emitted event',
	'is exempt from the indexed reference only while every severity it is emitted at is',
	'informational, so promoting one to a warning or an error fails generation until it is indexed.',
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
	lines.push('- ' + codeSpan(cell(entry.messagePrefix)) + ' - [' + entry.id + '](#' + entry.anchor + ')');
}
lines.push(
	'',
	'### Informational events',
	'',
	'These carry no stable ID and no recovery guidance because they report normal operation',
	'rather than a failure. Each is emitted on the shared diagnostic line format, so its',
	'searchable log prefix is:',
	'',
	'`[' + DIAGNOSTIC_PREFIX + ' source=svelte-adapter-ws component=<component> event=<event> severity=<severity>] <message>`',
	'',
	'| Event | Component | Severity | Emitting sources |',
	'|---|---|---|---|'
);
for (const record of unindexed) {
	lines.push(
		'| `' + record.event + '` | ' +
		(record.components.length ? record.components.map((component) => '`' + component + '`').join(', ') : 'varies by call site') + ' | ' +
		(record.severities.length ? record.severities.join(', ') : 'varies by call site') + ' | ' +
		record.sources.map((source) => '[' + source + '](../' + source + ')').join(', ') + ' |'
	);
}
lines.push('');

for (const entry of ADAPTER_ERROR_REGISTRY) {
	lines.push(
		'',
		'<a id="' + entry.anchor + '"></a>',
		'## `' + entry.id + '`',
		'',
		'- **Code/event:** `' + (entry.code || entry.event) + '`',
		'- **Message prefix:** ' + codeSpan(entry.messagePrefix),
		'- **Cause:** ' + entry.cause,
		'- **Consequence:** ' + entry.consequence,
		'- **Automatic recovery:** ' + entry.automaticRecovery,
		'- **Next action:** ' + entry.nextAction,
		...(entry.link ? ['- **Operator shortlink:** `' + entry.link + '`'] : []),
		'- **Runtime help:** `' + entry.help + '`',
		'- **Runtime sources:** ' + entry.sources.map((source) =>
			'[' + source + '](../' + source.replace(/\\/g, '/') + ')'
		).join(', ')
	);
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
