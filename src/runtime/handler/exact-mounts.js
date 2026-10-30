// The paths the adapter answers ahead of the catch-all, exactly as spelled:
// the probes, the auth path, the waiting-room pages, and the WebSocket path
// while an admission ceiling answers its GETs. Without a ceiling that path's
// GETs are the application's, so it is not one.
//
// Each is matched on the raw target, so a target that resolves, decodes or
// asks for SvelteKit data onto one of them without being spelled as it would
// miss the mount and reach the app's router as the mounted path. The request
// handler asks `entersExactMount` and refuses such a target. One set per
// module: a worker runs one runtime.

/** @type {Set<string>} */
const exactMounts = new Set();

/**
 * The exact mounts spelled with percent-escapes, by their decoded reading.
 * A mount is matched only in its written spelling, while SvelteKit's router
 * reads the decoded path, so any other spelling decoding onto it - lowercase
 * hex, a raw character the escape stands for - would reach the app as the
 * mounted path. Kept apart from `exactMounts`, which the catch-all also reads
 * after its own ASCII decode: an escaped spelling there would match a target
 * that only decodes to that spelling (`%2520` to `%20`), a different path.
 * Empty unless a mount carries an escape, so a request pays for the lookup
 * only on a deployment that has one.
 * @type {Map<string, string>}
 */
const escapedMounts = new Map();

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * `path` with each run of escapes decoded where it forms UTF-8 text, and left
 * as written where it does not, so a malformed escape does not hide the rest.
 * @param {string} path
 */
function decodedReading(path) {
	return path.replace(ESCAPE_RUN, (run) => {
		try { return decodeURIComponent(run); } catch { return run; }
	});
}

/**
 * The page path SvelteKit answers `path` for. A route-resolution request
 * (`/__route.js`) and a data request (`/__data.json`, `.html__data.json`) are
 * answered for the page in front of the suffix, and a data request for a page
 * spelled with a trailing slash carries that slash in a query parameter,
 * read here as SvelteKit reads it - parsed only when a mount is at stake.
 *
 * `/healthz/` is left to the application, and its data with it. The mount is
 * never matched for that pathname, so it is not a spelling the adapter
 * shadows; SvelteKit's router matches it to the same route as `/healthz`, and
 * whether it redirects the page, serves it or both is the application's
 * `trailingSlash`, which the catch-all cannot see. Refusing it would break a
 * page an app serves there on purpose.
 *
 * @param {string} path
 * @param {string | undefined} query
 */
function kitPagePath(path, query) {
	if (path.endsWith('/__route.js')) return path.slice(0, -11) || '/';
	let page;
	if (path.endsWith('/__data.json')) page = path.slice(0, -12);
	else if (path.endsWith('.html__data.json')) page = path.slice(0, -16) + '.html';
	else return path;
	// Parsed behind a `?` of its own: the constructor drops one leading `?`, and
	// a query that itself begins with one (`??name=1`) keeps it in the first
	// name, as the request URL SvelteKit parses does.
	if (query && (exactMounts.has(page + '/') || exactMounts.has(page || '/')) &&
		new URLSearchParams('?' + query).get('x-sveltekit-trailing-slash') === '1') page += '/';
	return page || '/';
}

/** @param {string} path a path the adapter answers ahead of the catch-all */
export function addExactMount(path) {
	if (path.includes('%')) escapedMounts.set(decodedReading(path), path);
	else exactMounts.add(path);
}

/**
 * Whether `path`, read as SvelteKit's router reads it, is an exact mount that
 * the raw target `raw` does not spell. The catch-all refuses such a target: it
 * was routed past the mount on its raw spelling and would reach the app's
 * router as the mounted path. The raw spelling itself reaches the catch-all
 * only for a method the mount does not answer, and goes on to the app.
 *
 * A mount spelled with escapes is judged by decoded readings instead. Without
 * one that costs one size check; with one, a page carrying no escape is its own
 * decoded reading and costs one lookup.
 *
 * @param {string} path  the raw target or its resolved reading
 * @param {string} raw  the raw target
 * @param {string} [query]  the raw query, which carries a data request's trailing slash
 */
export function entersExactMount(path, raw, query) {
	const page = kitPagePath(path, query);
	if (page !== raw && exactMounts.has(page)) return true;
	if (escapedMounts.size === 0) return false;
	const mount = escapedMounts.get(page.includes('%') ? decodedReading(page) : page);
	return mount !== undefined && mount !== raw;
}

/**
 * `entersExactMount` for the catch-all's ASCII-decoded reading, which is
 * checked against the plain mounts only: decoding it again for an escaped
 * mount would read `%2520` as a space.
 *
 * @param {string} decoded  an ASCII-decoded reading of the raw target
 * @param {string} raw  the raw target
 * @param {string} [query]  the raw query
 */
export function entersPlainMount(decoded, raw, query) {
	const page = kitPagePath(decoded, query);
	return page !== raw && exactMounts.has(page);
}
