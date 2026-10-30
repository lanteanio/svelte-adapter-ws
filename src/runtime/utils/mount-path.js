// The paths the adapter mounts on the router ahead of the application: the
// probes, the WebSocket and auth paths, the waiting-room pages, the admin
// prefix and the dev dashboard.
//
// uWS matches a mount against the request target byte for byte, so a mount is
// reachable only when it is spelled the way clients send it. Browsers, fetch
// and the ws client serialize a path with the WHATWG URL rules: they
// percent-encode spaces, quotes, angle brackets, `?`, `#`, `^` and every
// non-ASCII character with uppercase hex, turn `\` into `/` and resolve `.`
// and `..` segments away, while every other visible ASCII character goes out
// as it is; a literal `%` can only be written `%25`, and a tab, line feed or
// carriage return is dropped from any path. So a mount is admitted exactly
// when it is the spelling that serialization produces for its own decoded
// reading - `/pr%C3%BCfung`, never `/prüfung`, `/pr%c3%bcfung` or
// `/%70rufung` - plus two rules of the router
// itself: a segment starting with `:` is a parameter and one starting with `*`
// a wildcard, so neither may begin a segment (`/v1/items:get` is a plain path).
//
// A prefix mount (the admin prefix, the dev dashboard) is also spelled without
// escapes: the catch-all keeps an encoded target out of the admin prefix by
// reading its ASCII escapes, which only covers a prefix spelled in plain ASCII.

const ESCAPE = /%[0-9A-Fa-f]{2}/g;
const BARE_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const LOWERCASE_ESCAPE = /%(?:[0-9a-f][a-f]|[a-f][0-9a-f])/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A value for an error message that never throws, whatever it is.
 * @param {unknown} value
 */
function shown(value) {
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'object' && value !== null) return Object.prototype.toString.call(value);
	return String(value);
}

/** @param {string} ch */
function quoted(ch) {
	const code = ch.codePointAt(0) ?? 0;
	const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
	if (code <= 0x20 || code === 0x7f) return hex;
	if (code > 0x7e) return `"${ch}" (${hex})`;
	return ch === '"' ? `'"'` : `"${ch}"`;
}

/**
 * The path with every escape decoded, or null when the escapes are not UTF-8.
 * @param {string} value
 */
function decodePath(value) {
	if (!value.includes('%')) return value;
	const bytes = [];
	for (let i = 0; i < value.length;) {
		if (value[i] === '%') {
			bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
			i += 3;
		} else {
			const cp = /** @type {number} */ (value.codePointAt(i));
			const ch = String.fromCodePoint(cp);
			for (const b of new TextEncoder().encode(ch)) bytes.push(b);
			i += ch.length;
		}
	}
	try {
		return UTF8.decode(new Uint8Array(bytes));
	} catch {
		return null;
	}
}

/**
 * How a client spells one character of a path: what WHATWG serialization
 * produces for it, except a literal `%`, which a client can only write as
 * `%25` (the serializer leaves a written `%` alone, as the start of an
 * escape).
 * @param {string} ch
 */
function clientChar(ch) {
	if (ch === '%') return '%25';
	const url = new URL('http://h/x');
	url.pathname = '/x' + ch;
	return url.pathname.slice(2);
}

/**
 * The spelling a client sends for the path whose decoded reading is `decoded`.
 * @param {string} decoded
 */
function clientSpelling(decoded) {
	let out = '';
	for (const ch of decoded) out += ch === '/' ? '/' : clientChar(ch);
	return out;
}

/** A backslash and the characters the URL parser drops. */
const SEPARATE_REASON = /[\\\t\n\r]/;

/** Characters a client sends as they are, for the prefix-mount message. */
const PLAIN_ASCII = "letters, digits and - . _ ~ ! $ & ' ( ) * + , ; = : @ | [ ]";

/**
 * Why `value` cannot be mounted, or `null` when it can.
 *
 * @param {unknown} value
 * @param {{ prefix?: boolean }} [options] - `prefix` for a mount that owns the paths beneath it
 * @returns {string | null}
 */
export function mountPathProblem(value, options = {}) {
	if (typeof value !== 'string' || value[0] !== '/') return "must be a path string starting with '/'";
	if (BARE_PERCENT.test(value)) return 'contains a "%" that starts no two-digit escape';
	if (options.prefix) {
		// A prefix takes no escapes, so it has no spelling for a character
		// clients encode: name the set it may use instead of one it may not.
		if (value.includes('%')) {
			return `contains an escape; a prefix mount is spelled in plain ASCII (${PLAIN_ASCII}), because the guard that keeps encoded spellings out of it reads ASCII escapes only`;
		}
		for (const ch of value) {
			// A separator, a backslash and the characters the parser drops have
			// reasons of their own, given below.
			if (ch !== '/' && !SEPARATE_REASON.test(ch) && clientChar(ch) !== ch) {
				return `contains ${quoted(ch)}, which clients send percent-encoded, and a prefix mount takes no escapes; spell it in plain ASCII (${PLAIN_ASCII})`;
			}
		}
	}
	if (LOWERCASE_ESCAPE.test(value)) {
		return `writes an escape in lowercase hex, which clients never send; write the path as ${JSON.stringify(value.replace(ESCAPE, (m) => m.toUpperCase()))}`;
	}
	const decoded = decodePath(value);
	if (decoded === null) return 'contains escapes that do not decode to UTF-8 text, which no client sends for a path';
	// The URL parser drops a tab, line feed or carriage return wherever it
	// appears, so no client spelling of the path can carry one.
	const stripped = /[\t\n\r]/.exec(decoded);
	if (stripped) {
		const name = stripped[0] === '\t' ? 'a tab' : stripped[0] === '\n' ? 'a line feed' : 'a carriage return';
		return `contains ${name}, which the URL parser removes from every path, so no client can request it`;
	}
	for (const segment of decoded.slice(1).split('/')) {
		if (segment === '.' || segment === '..') return `contains a "${segment}" segment, which clients resolve away before sending`;
	}
	if (decoded.includes('\\')) {
		return value.includes('\\')
			? 'contains "\\", which browsers send as "/"'
			: 'contains "%5C", an encoded "\\" that browsers send as "/"';
	}
	for (const segment of decoded.slice(1).split('/')) {
		if (segment[0] === ':' || segment[0] === '*') {
			return `has a segment starting with "${segment[0]}", which the router reads as a route parameter or wildcard`;
		}
	}
	const spelling = clientSpelling(decoded);
	if (spelling === value) return null;
	if (/%2F/i.test(value)) return 'contains "%2F", an encoded "/" that clients send as a separator';
	for (const ch of value) {
		if (ch !== '%' && ch !== '/' && clientChar(ch) !== ch) {
			return `contains ${quoted(ch)}, which clients send percent-encoded; write the path as ${JSON.stringify(spelling)}`;
		}
	}
	return `escapes a character clients send as it is; write the path as ${JSON.stringify(spelling)}`;
}

/**
 * Throw when `value` is not a path the router can be reached on.
 *
 * @param {string} option - the option as the operator writes it
 * @param {unknown} value
 * @param {typeof Error | typeof TypeError} [ErrorType]
 * @param {{ prefix?: boolean }} [options]
 */
export function assertMountPath(option, value, ErrorType = Error, options = {}) {
	const problem = mountPathProblem(value, options);
	if (problem === null) return;
	throw new ErrorType(
		`${option} ${problem} - got ${shown(value)}. A mounted path is matched on the request target exactly ` +
		'as a client sends it: the WHATWG URL spelling with uppercase escapes, and no segment starting with ":" or "*".'
	);
}

/** @param {string} path */
function withoutTrailingSlash(path) {
	return path.replace(/\/+$/, '') || '/';
}

/**
 * Throw when two mounts claim the same requests. An exact mount owns its own
 * path, spelled exactly; a prefix mount owns its path and everything under it.
 * Exact mounts may nest (`/health` and `/health/ready`), and `/healthz` and
 * `/healthz/` are two routes, but no two exact mounts may share a spelling, and
 * no exact mount may sit at or under a prefix mount, where the two would
 * answer the same request differently. A prefix ignores its trailing slashes.
 *
 * @param {Array<[string, string]>} exact - [option, path] of each exact mount in use
 * @param {Array<[string, string]>} [prefixes] - [option, path] of each prefix mount in use
 * @param {typeof Error | typeof TypeError} [ErrorType]
 */
export function assertDistinctMounts(exact, prefixes = [], ErrorType = Error) {
	/** @type {Map<string, string>} */
	const seen = new Map();
	for (const [option, path] of exact) {
		const other = seen.get(path);
		if (other !== undefined) {
			throw new ErrorType(`${option} (${JSON.stringify(path)}) must differ from ${other}; both would mount ${JSON.stringify(path)}.`);
		}
		seen.set(path, option);
	}
	for (const [prefixOption, prefixPath] of prefixes) {
		const prefix = withoutTrailingSlash(prefixPath);
		for (const [option, path] of exact) {
			if (path === prefix || withoutTrailingSlash(path) === prefix || path.startsWith(prefix + '/')) {
				throw new ErrorType(
					`${option} (${JSON.stringify(path)}) sits at or under ${prefixOption} (${JSON.stringify(prefixPath)}), ` +
					`which answers every path beneath it; move one of them.`
				);
			}
		}
	}
}
