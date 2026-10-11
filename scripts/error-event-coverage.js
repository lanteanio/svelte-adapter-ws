import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { DIAGNOSTIC_PREFIX } from '../src/runtime/diagnostic-format.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The emitted-event inventory is derived from the runtime source at generation
// time, so a new diagnostic emission makes --check fail until --write reruns.
// The registry module is excluded from the scan: its event fields declare the
// index itself, and counting them as emissions would make the ghost-entry
// validation below vacuous.
const EVENT_SCAN_DIRECTORIES = Object.freeze(['src/runtime']);
// src/testing.js is a published entry point that emits diagnostics of its own,
// so leaving it unscanned let a shipped failure event escape the coverage gate.
const EVENT_SCAN_FILES = Object.freeze(['src/observability.js', 'src/vite.js', 'src/testing.js']);
const EVENT_SCAN_EXCLUDED = Object.freeze(['src/runtime/error-registry.js']);
const EVENT_LITERAL = /event: '([a-z][a-z0-9.-]*)'/;
const EVENT_CONTEXT_LINES = 6;

// The runtime spells the same band both ways at different call sites, so both
// count as a failure here rather than one silently escaping the coverage gate.
const FAILURE_SEVERITIES = new Set(['fatal', 'error', 'warn', 'warning']);
const INFORMATIONAL_SEVERITIES = new Set(['debug', 'info', 'trace']);

function eventScanFiles() {
	const files = [];
	const walk = (relativeDirectory) => {
		for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
			const relativePath = relativeDirectory + '/' + entry.name;
			if (entry.isDirectory()) walk(relativePath);
			else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(relativePath);
		}
	};
	for (const directory of EVENT_SCAN_DIRECTORIES) walk(directory);
	for (const file of EVENT_SCAN_FILES) if (existsSync(join(root, file))) files.push(file);
	return files.filter((file) => !EVENT_SCAN_EXCLUDED.includes(file)).sort();
}

/**
 * Every diagnostic event the runtime emits as a literal, with the component
 * and severity read from the surrounding emission when they are literals too.
 * Also collects which ADAPTER_ERROR_IDS keys the runtime references, because
 * registry-backed events are emitted through the registry helpers rather than
 * as event-name literals.
 *
 * @returns {{ events: { event: string, components: string[], severities: string[], sources: string[] }[], idKeyReferences: Set<string> }}
 */
export function scanEmittedEvents() {
	const byEvent = new Map();
	const idKeyReferences = new Set();
	for (const file of eventScanFiles()) {
		const content = readFileSync(join(root, file), 'utf8');
		for (const reference of content.matchAll(/ADAPTER_ERROR_IDS\.([A-Z0-9_]+)/g)) {
			idKeyReferences.add(reference[1]);
		}
		// An emission may derive its identity from the registry entry instead
		// of repeating it as literals: `const X = adapterErrorDefinition(
		// ADAPTER_ERROR_IDS.KEY)` then `event: X.event`. Resolve those through
		// the registry so the inventory covers both spellings.
		const derivedBindings = new Map();
		for (const def of content.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*adapterErrorDefinition\(ADAPTER_ERROR_IDS\.([A-Z0-9_]+)\)/g)) {
			derivedBindings.set(def[1], def[2]);
		}
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			const derived = /event: ([A-Za-z_$][\w$]*)\.event\b/.exec(lines[index]);
			if (derived && derivedBindings.has(derived[1])) {
				const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS[derivedBindings.get(derived[1])]);
				if (entry) {
					let record = byEvent.get(entry.event);
					if (!record) {
						record = { event: entry.event, components: new Set(), severities: new Set(), sources: new Set() };
						byEvent.set(entry.event, record);
					}
					record.sources.add(file);
					record.components.add(entry.component);
					record.severities.add(entry.severity);
					continue;
				}
			}
			const match = EVENT_LITERAL.exec(lines[index]);
			if (!match) continue;
			let record = byEvent.get(match[1]);
			if (!record) {
				record = { event: match[1], components: new Set(), severities: new Set(), sources: new Set() };
				byEvent.set(match[1], record);
			}
			record.sources.add(file);
			const first = Math.max(0, index - EVENT_CONTEXT_LINES);
			const last = Math.min(lines.length - 1, index + EVENT_CONTEXT_LINES);
			for (let context = first; context <= last; context++) {
				const component = /component: '([a-z][a-z0-9.-]*)'/.exec(lines[context]);
				if (component) record.components.add(component[1]);
				const severity = /(?:severity|level): '([a-z]+)'/.exec(lines[context]);
				if (severity) record.severities.add(severity[1]);
			}
		}
	}
	const events = [...byEvent.values()]
		.map((record) => ({
			event: record.event,
			components: [...record.components].sort(),
			severities: [...record.severities].sort(),
			sources: [...record.sources].sort()
		}))
		.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
	return { events, idKeyReferences };
}

/**
 * A registry entry whose event nothing in the runtime emits is a ghost: its
 * documentation promises text that can never appear in a log. An entry counts
 * as emitted when its event is in the scanned inventory, when the runtime
 * references its ADAPTER_ERROR_IDS key, or when one of its declared source
 * files carries the event, the stable ID, or the key reference.
 *
 * @param {typeof ADAPTER_ERROR_REGISTRY} entries
 * @param {ReturnType<typeof scanEmittedEvents>} scan
 * @returns {string[]}
 */
export function findGhostRegistryEntries(entries = ADAPTER_ERROR_REGISTRY, scan = scanEmittedEvents()) {
	const errors = [];
	const keyById = new Map(Object.entries(ADAPTER_ERROR_IDS).map(([key, value]) => [value, key]));
	const scannedEvents = new Set(scan.events.map((record) => record.event));
	for (const entry of entries) {
		if (scannedEvents.has(entry.event)) continue;
		const key = keyById.get(entry.id);
		if (key && scan.idKeyReferences.has(key)) continue;
		let referenced = false;
		for (const source of entry.sources || []) {
			const sourcePath = resolve(root, source);
			if (isAbsolute(source) || relative(root, sourcePath).startsWith('..') || !existsSync(sourcePath)) continue;
			const content = readFileSync(sourcePath, 'utf8');
			if (content.includes("'" + entry.event + "'") ||
				content.includes(entry.id) ||
				(key && content.includes('ADAPTER_ERROR_IDS.' + key))) {
				referenced = true;
				break;
			}
		}
		if (!referenced) {
			errors.push((entry.id || 'registry entry') + ': event ' + entry.event +
				' is not emitted by any scanned runtime source and is not referenced from its declared sources');
		}
	}
	return errors;
}

/**
 * A failure the runtime can emit but the reference does not index is the defect
 * this document exists to prevent: an operator pastes the text and finds a row
 * with no cause and no recovery. Informational events are exempt BY SEVERITY,
 * not by name, so a new one is only exempt while it stays informational.
 *
 * An event whose severity is not a literal cannot be proven informational, so
 * it must be indexed - unknown is treated as a failure rather than waved past.
 *
 * @param {ReturnType<typeof scanEmittedEvents>} scan
 * @param {typeof ADAPTER_ERROR_REGISTRY} entries
 * @returns {string[]}
 */
export function findUnindexedFailures(scan = scanEmittedEvents(), entries = ADAPTER_ERROR_REGISTRY) {
	const indexed = new Set(entries.map((entry) => entry.event));
	const unindexed = [];
	for (const record of scan.events) {
		if (indexed.has(record.event)) continue;
		const informational = record.severities.length > 0 &&
			record.severities.every((severity) => INFORMATIONAL_SEVERITIES.has(severity));
		if (!informational) unindexed.push(record);
	}
	if (!unindexed.length) return [];
	return unindexed.map((record) => record.event + ' (severity ' +
		(record.severities.join('/') || 'not a literal') + ', emitted by ' + record.sources.join(', ') +
		') is a failure with no entry in ADAPTER_ERROR_REGISTRY; add one with cause, consequence,' +
		' automatic recovery, and next action, then rerun --write');
}

export function validateErrorRegistry(entries) {
	const errors = [];
	const ids = new Set();
	const anchors = new Set();
	const prefixes = new Set();
	for (const [index, entry] of entries.entries()) {
		const label = entry.id || 'entry ' + (index + 1);
		if (!/^ADAPTER-ERR-[A-Z0-9-]+$/.test(entry.id || '')) errors.push(label + ': invalid stable id');
		if (ids.has(entry.id)) errors.push(label + ': duplicate stable id');
		ids.add(entry.id);
		if (!/^adapter-err-[a-z0-9-]+$/.test(entry.anchor || '')) errors.push(label + ': invalid anchor');
		if (anchors.has(entry.anchor)) errors.push(label + ': duplicate anchor');
		anchors.add(entry.anchor);
		if (prefixes.has(entry.messagePrefix)) errors.push(label + ': duplicate messagePrefix');
		prefixes.add(entry.messagePrefix);
		for (const field of ['event', 'messagePrefix', 'cause', 'consequence', 'automaticRecovery', 'nextAction', 'help']) {
			if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(label + ': missing ' + field);
		}
		if (entry.help !== 'docs/errors.md#' + entry.anchor) errors.push(label + ': help route does not match anchor');
		// `link` is displayed by the runtime itself (the See: suffix on adapter
		// error messages), so its characters are load-bearing operator output:
		// only the registered shortlink domain is acceptable, and the value is
		// rendered into this generated document so any change is reviewed there.
		if (entry.link !== undefined && entry.link !== null &&
			(typeof entry.link !== 'string' || !/^https:\/\/svti\.me\/[a-z0-9-]+$/.test(entry.link))) {
			errors.push(label + ': link must be an https://svti.me/<slug> shortlink');
		}
		if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
			errors.push(label + ': missing sources');
		} else {
			for (const source of entry.sources) {
				const sourcePath = resolve(root, source);
				if (isAbsolute(source) || relative(root, sourcePath).startsWith('..') || !existsSync(sourcePath)) {
					errors.push(label + ': missing or out-of-root source: ' + source);
				}
			}
		}
		if (entry.code !== null && (typeof entry.code !== 'string' || !entry.code)) {
			errors.push(label + ': code must be a string or null');
		}
		// The emission shapes produce different lines. Validating the
		// declared prefix against the shape is what stops the reference promising
		// text no log will ever contain.
		const head = '[' + DIAGNOSTIC_PREFIX + ' source=svelte-adapter-ws component=' + entry.component +
			' event=' + entry.event + ' severity=';
		if (entry.emission === 'thrown') {
			if (entry.component !== null || entry.severity !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a thrown entry carries no component, severity, or problemPrefix');
			}
		} else if (entry.emission === 'composed' || entry.emission === 'direct') {
			if (typeof entry.component !== 'string' || typeof entry.problemPrefix !== 'string') {
				errors.push(label + ': an emitted entry needs a component and a problemPrefix');
			}
			if (!FAILURE_SEVERITIES.has(entry.severity)) errors.push(label + ': invalid operational severity');
			if (entry.emission === 'composed' && entry.severity !== 'fatal' && entry.severity !== 'error') {
				errors.push(label + ': a composed entry is fatal or error');
			}
			const body = entry.emission === 'composed' ? entry.event + ': ' + entry.problemPrefix : entry.problemPrefix;
			if (entry.messagePrefix !== head + entry.severity + '] ' + body) {
				errors.push(label + ': ' + entry.emission + ' prefix does not match component, event, severity, and problemPrefix');
			}
		} else if (entry.emission === 'head') {
			if (typeof entry.component !== 'string' || entry.severity !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a head entry carries a component but no fixed severity or problemPrefix');
			}
			if (entry.messagePrefix !== head) errors.push(label + ': head prefix does not stop where the variation begins');
		} else if (entry.emission === 'console') {
			// A console entry's prefix is the literal line beginning, so it must
			// not claim the diagnostic head it never carries, it must state a
			// real failure severity even though no event pipeline enforces one,
			// and it must open with an owned family tag - the attribution gate
			// admits adapterConsoleLine output on the strength of this check.
			if (entry.component !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a console entry carries no component or problemPrefix');
			}
			if (!FAILURE_SEVERITIES.has(entry.severity)) errors.push(label + ': invalid operational severity');
			if (entry.messagePrefix.startsWith('[' + DIAGNOSTIC_PREFIX)) {
				errors.push(label + ': a console prefix must not claim the diagnostic line head');
			}
			if (!/^\[(?:svelte-adapter-ws|tls|ws|primary)\] /.test(entry.messagePrefix)) {
				errors.push(label + ': a console prefix must open with an owned family tag');
			}
		} else {
			errors.push(label + ': unknown emission ' + JSON.stringify(entry.emission));
		}
	}
	return errors;
}
