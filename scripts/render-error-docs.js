// Renders docs/errors.md from the error registry, so every `help:` link in
// src/runtime/error-registry.js resolves to a real section. The registry is
// the single source of truth; edit it and re-run this script:
//
//   node scripts/render-error-docs.js
//
// The GitHub anchor for a `## ADAPTER-ERR-*` heading is the lowercased id,
// which is exactly each entry's `anchor` field - the check below keeps that
// true so a registry edit cannot silently break its own help link.

import { writeFileSync } from 'node:fs';
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

writeFileSync(path.join(repoRoot, 'docs', 'errors.md'), lines.join('\n') + '\n');
console.log(`docs/errors.md rendered (${ADAPTER_ERROR_REGISTRY.length} entries).`);
