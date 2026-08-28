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
