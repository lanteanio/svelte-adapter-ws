// Structured operational events. One line per event on stderr, prefixed and
// JSON-bodied so log collectors can parse without a custom format. Severity
// maps to the console channel; `dataClass` documents what the attributes may
// contain ('none' | 'pseudonymous' | 'personal') - nothing here ever logs
// request bodies or credentials, and events default to pseudonymous ids only.

/**
 * @typedef {{
 *   source: string,
 *   component: string,
 *   event: string,
 *   severity: 'info' | 'warn' | 'error',
 *   dataClass: 'none' | 'pseudonymous' | 'personal',
 *   message: string,
 *   attributes?: Record<string, unknown>
 * }} OperationalEvent
 */

/**
 * @param {OperationalEvent} event
 */
export function emitOperationalEvent(event) {
	const line = `[${event.source}] ${event.event}: ${event.message}` +
		(event.attributes ? ' ' + safeJson(event.attributes) : '');
	if (event.severity === 'error') console.error(line);
	else if (event.severity === 'warn') console.warn(line);
	else console.log(line);
}

/**
 * Render an error for event attributes: name and message always, stack only
 * for non-Error throwables (an Error's stack is reachable from the log line's
 * context; a thrown string has nothing else).
 *
 * @param {unknown} err
 * @returns {{ name: string, message: string }}
 */
export function diagnosticError(err) {
	if (err instanceof Error) {
		return { name: err.name, message: err.message };
	}
	return { name: 'NonError', message: String(err) };
}

/** @param {unknown} value */
function safeJson(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return '"[unserializable]"';
	}
}

export const DIAGNOSTIC_PREFIX = 'lantean/diagnostic';

/**
 * Render one structured diagnostic as a single ASCII console line, in the
 * family's `[lantean/diagnostic ...]` shape so collectors parse both adapters
 * with one rule. JSON escapes retain the exact structured value while
 * preventing C1 controls, bidi overrides, and non-ASCII payload text from
 * reordering the surrounding terminal line.
 *
 * @param {{ source: string, component: string, event: string, severity: string, message: string, attributes?: Record<string, unknown> }} record
 * @returns {string}
 */
export function formatDiagnostic(record) {
	const suffix = asciiJson({
		source: record.source,
		component: record.component,
		event: record.event,
		severity: record.severity,
		message: record.message,
		attributes: record.attributes ?? null
	});
	return `[${DIAGNOSTIC_PREFIX} source=${record.source} component=${record.component} event=${record.event} severity=${record.severity}] ${record.message} ${suffix}`;
}

/** @param {unknown} value */
function asciiJson(value) {
	const raw = safeJson(value);
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code >= 0x20 && code <= 0x7e) out += raw[i];
		else out += '\\u' + code.toString(16).padStart(4, '0');
	}
	return out;
}
