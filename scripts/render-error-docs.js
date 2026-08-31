// Renders docs/errors.md from the error registry, so every `help:` link in
// src/runtime/error-registry.js resolves to a real section. The registry is
// the single source of truth; edit it and re-run this script:
//
//   node scripts/render-error-docs.js
//
// The GitHub anchor for a `## ADAPTER-ERR-*` heading is the lowercased id,
// which is exactly each entry's `anchor` field - the check below keeps that
// true so a registry edit cannot silently break its own help link.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const lines = [
	'# Adapter error reference',
	'',
	'Every operator-facing failure the runtime can emit, indexed by its stable',
	'`ADAPTER-ERR-*` id. Generated from `src/runtime/error-registry.js` by',
	'`node scripts/render-error-docs.js`; edit the registry, not this file.',
	''
];

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
