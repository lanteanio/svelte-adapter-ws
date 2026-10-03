// The main request handler: the routing spine every HTTP exchange walks.
// Order is load-bearing and mirrors the family contract:
//   health/readiness -> static fast path -> platform hardening -> method gate
//   -> prerendered lookup -> header policy -> SSR catch-all.

// Substituted by the adapter's build step; free identifiers until then.
/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
import { staticCache, counters } from './state.js';
import { serveStatic, tryPrerendered, encodedStaticEntry } from './static-assets.js';
import { ALLOWED_METHODS, FORBIDDEN_METHODS, send400, send405, send500 } from './http-helpers.js';
import { collectRequestHeaders, firstHeaderValue, framingRefusal, isFramingHeader } from '../utils/request-headers.js';
import { handleSSR } from './ssr.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { lifecycleState, requestDone, openRequestSignal, closeRequestSignal } from './lifecycle.js';
import { monotonicNow } from '../runtime.js';
import { ADMIN_PATH } from './config.js';
import { adminMounted } from './admin.js';
import { windowsReservedPath } from '../utils/windows-path.js';
import { invalidRequestTarget } from '../utils/request-target.js';
import { addExactMount, entersExactMount } from './exact-mounts.js';

// Read once: the platform does not change under a running process.
const WINDOWS = process.platform === 'win32';

// What makes the URL parser drop a segment of a raw path: a dot segment, a
// `%2e` in any case (a dot segment spelled encoded), and the backslash a
// special scheme reads as a separator. The whitespace it strips never gets
// this far: node's parser refuses it in a request line. A dot inside a name,
// as in `/__data.json`, changes nothing, so such a path skips the URL parse.
// See the resolution checks below, which are its only readers.
const DROPS_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)|\\|%2e/i;

// An escape of an ASCII character, which is all a reachable prefix or exact
// mount is made of: a mount is matched on the raw target, and a target
// carrying anything but visible ASCII is refused before it is routed. Decoding
// only these reads every escape that could spell such a mount and cannot
// throw, as a decoder for the whole of UTF-8 does on an escape it cannot read.
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
/** @param {string} _ @param {string} hex */
const asciiFromEscape = (_, hex) => String.fromCharCode(parseInt(hex, 16));

// Any authority works: the check compares pathnames, which resolve the same
// under all of them.
const RESOLUTION_BASE = 'http://a';

// The reserved namespace as the MOUNT matches it, derived once. `null` when no
// prefix is configured, so the check is one comparison away from off.
const ADMIN_PREFIX = ADMIN_PATH === false ? null : ADMIN_PATH + '/';

/**
 * Realtime HTTP routes, installed by handler.js when the websocket lane is
 * built in: the GET answer on the WebSocket path, the upgrade gate's waiting
 * room, and the authenticate preflight endpoint. Null when realtime is off -
 * the checks then cost one comparison.
 * @type {{
 *   wsPath: string,
 *   tryAuthenticateRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, state: { aborted: boolean }) => boolean,
 *   serveWsPathGet: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => boolean,
 *   tryWaitingRoomRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => boolean,
 *   tryAdminRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, state: { aborted: boolean }) => boolean,
 *   exactPaths: string[]
 * } | null}
 */
let realtimeRoutes = null;

// The probes are matched exactly as spelled, like every path the realtime
// routes add below; see exact-mounts.js.
if (HEALTH_CHECK_PATH !== false) addExactMount(HEALTH_CHECK_PATH);
if (READINESS_CHECK_PATH !== false) addExactMount(READINESS_CHECK_PATH);

/** @param {NonNullable<typeof realtimeRoutes>} routes */
export function installRealtimeRoutes(routes) {
	realtimeRoutes = routes;
	for (const path of routes.exactPaths) addExactMount(path);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleRequest(req, res) {
	counters.inFlightCount++;
	// `responseStarted` flips once any byte of the real response has reached
	// the wire, after which no error response can be sent; `closedByServer`
	// marks an abort this runtime caused (a source that failed mid-body), so
	// the failure is still reported where a client-initiated abort stays silent.
	/** @type {{ aborted: boolean, responseStarted: boolean, closedByServer: boolean, bodyReceived: boolean, signal: AbortSignal | null }} */
	const state = { aborted: false, responseStarted: false, closedByServer: false, bodyReceived: false, signal: null };
	// The RED observation rides the SAME terminal hook as the in-flight
	// accounting, so probes, realtime routes, static assets and SSR are all
	// counted through one funnel with the aborted/finished distinction already
	// made. Null unless a metrics registry is configured, which keeps the
	// zero-config path at one property read and no clock call.
	const metricsHook = counters.httpRequestHook;
	const startedAt = metricsHook === null ? 0 : monotonicNow();
	// 'close' fires exactly once per exchange - after a finished response AND
	// after a torn-down one - so it is the single accounting point. A close
	// before the response finished is a client abort.
	res.on('close', () => {
		if (!res.writableFinished) state.aborted = true;
		counters.inFlightCount--;
		requestDone();
		if (metricsHook !== null) {
			metricsHook(req.method || '', res.statusCode, state.aborted, (monotonicNow() - startedAt) / 1000);
		}
	});

	// A Transfer-Encoding naming anything but chunked is refused ahead of every
	// lane, the probes and the realtime routes included. The lanes that answer
	// before acting on a header set - a built asset, a prerendered page, the
	// probes, the waiting room, the non-upgrade answer on the WebSocket path -
	// would each have to remember, and the one that forgot would be the one a
	// fronting proxy polls. What the refusal protects is the CONNECTION, so it
	// does not matter which lane would have answered, and the connection ends
	// with the 400. Below the accounting hook, so it is counted like any other
	// answer.
	//
	// ONE lookup, the question the family's native tier can afford in front of
	// every route: an absent header and one sent empty read the same there,
	// and a repeat reads as its first line, so neither shape is refused here.
	// Both are refused where the whole header set is read, which the lanes
	// below that build one do. node's own parser already refuses a repeated
	// Transfer-Encoding and most spellings; what reaches this line is a coding
	// list that ends in chunked.
	if (framingRefusal(firstHeaderValue(req.rawHeaders, 'transfer-encoding') || undefined, undefined) !== null) {
		send400(res, true);
		return;
	}

	const url = req.url || '/';
	const q = url.indexOf('?');
	const pathname = q === -1 ? url : url.slice(0, q);
	const search = q === -1 ? '' : url.slice(q);
	const query = q === -1 ? '' : url.slice(q + 1);
	const method = req.method || 'GET';
	const isGetLike = method === 'GET' || method === 'HEAD';

	// Two things RFC 9112 does not allow in a target, refused in the path and
	// the query on every lane, the probes and the built asset below included:
	// a byte outside visible ASCII and a fragment. node's parser refuses the
	// raw bytes before any listener runs; a `#` it hands on, so `/healthz#frag`
	// would miss the probe and reach the app's router truncated.
	if (invalidRequestTarget(pathname, query)) {
		send400(res);
		return;
	}

	// Probe routes answer before anything else so an orchestrator's checks can
	// never be shadowed by a static asset of the same name. Liveness answers OK
	// even during drain (the process lives); readiness reports the lifecycle
	// state so a balancer routes away the moment drain begins.
	//
	// GET and HEAD both: HAProxy's `httpchk` and most uptime monitors probe with
	// HEAD by default, and a HEAD that fell through to the catch-all was
	// answered by the app's own 404. HEAD gets the GET status and the body's
	// length; node drops the body of a HEAD reply itself.
	if (isGetLike) {
		// The probes are length-framed like every other fixed-shape answer:
		// uWS derives a length from the body it is handed, and a balancer
		// probing with HEAD gets no size at all when the header is absent.
		// The length is the only header written: the family's probes carry no
		// content-type.
		if (HEALTH_CHECK_PATH !== false && pathname === HEALTH_CHECK_PATH) {
			const body = 'OK';
			res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
			res.end(body);
			return;
		}
		if (READINESS_CHECK_PATH !== false && pathname === READINESS_CHECK_PATH) {
			// The body is the state's own name: `ready`, or `starting`,
			// `draining` or `closed` behind a 503.
			const lifecycle = lifecycleState();
			res.writeHead(lifecycle === 'ready' ? 200 : 503, {
				'content-length': String(Buffer.byteLength(lifecycle))
			});
			res.end(lifecycle);
			return;
		}
	}

	if (realtimeRoutes !== null) {
		// A GET on the WebSocket path that the upgrade listener did not take:
		// an attempted handshake is refused, and with an admission ceiling a
		// browser NAVIGATION gets the answer the upgrade door would have given.
		// Anything else goes on to the application.
		if (pathname === realtimeRoutes.wsPath && isGetLike && realtimeRoutes.serveWsPathGet(req, res, pathname, search)) return;
		// The waiting room's poll and holding page. Both are read-only and
		// answer before the static index so a same-named asset can never
		// shadow the queue a browser is sitting in.
		if (isGetLike && realtimeRoutes.tryWaitingRoomRoute(req, res, pathname, search)) return;
		if (realtimeRoutes.tryAuthenticateRoute(req, res, pathname, state)) return;
		// The reserved admin prefix, last of the realtime routes and above the
		// static lane. The exact realtime routes above beat it - the WebSocket
		// path, the authenticate endpoint, both waiting-room paths, and the two
		// probes for the methods each answers - and it beats the static and SSR
		// catch-all, so a same-named asset cannot shadow an admin path. Note the
		// probes answer GET and HEAD only, so any other method on a probe path
		// nested under the admin prefix reaches the admin handler; uWS routes the
		// same way, because a method-scoped route does not claim the other
		// methods either.
		if (realtimeRoutes.tryAdminRoute(req, res, pathname, state)) return;
	}

	// Static fast path: one Map lookup on the RAW undecoded pathname, seven
	// header reads, nothing else. Because the index holds prerendered HTML
	// under its clean aliases too, most prerendered pages are also served here.
	// An encoded traversal misses by construction - the cache simply has no
	// such key. Assets whose names require percent-encoding get their decoded
	// second chance in tryPrerendered, below the platform hardening gate.
	if (isGetLike) {
		const entry = staticCache.get(pathname);
		if (entry) {
			const h = req.headers;
			const serve = () => serveStatic(
				res,
				entry,
				/** @type {string} */ (h['accept-encoding']) || '',
				/** @type {string} */ (h['if-none-match']) || '',
				method === 'HEAD',
				/** @type {string} */ (h['range']) || '',
				/** @type {string} */ (h['if-range']) || '',
				/** @type {string} */ (h['if-match']) || '',
				/** @type {string} */ (h['if-unmodified-since']) || '',
				/** @type {string} */ (h['if-modified-since']) || ''
			);
			if (tracingEnabled) {
				traceOperation('adapter.http.static', {
					kind: 'server',
					parent: extractTraceContext({
						traceparent: /** @type {string} */ (h['traceparent']),
						tracestate: /** @type {string} */ (h['tracestate'])
					}),
					attributes: { 'http.request.method': method, 'http.route.type': 'static' }
				}, serve);
			} else {
				serve();
			}
			return;
		}
	}

	// Windows: refuse a path naming an alternate data stream (`:`) or an 8.3
	// short name (`~`), in the raw spelling and the decoded one - every lane
	// below decodes before it opens anything.
	if (WINDOWS && windowsReservedPath(pathname)) {
		send400(res);
		return;
	}

	// The fetch specification forbids CONNECT/TRACE/TRACK outright, so
	// `new Request()` throws for them - surfaced as a generic 500 plus an
	// error-severity log line per request, which made probing TRACE a one-line
	// way to fill an operator's error log. They can never reach an application
	// route; refuse them at the edge with the status the RFC requires.
	if (!ALLOWED_METHODS.has(method)) {
		if (FORBIDDEN_METHODS.has(method)) {
			send405(res);
			return;
		}
		// Any other parser-accepted method passes through to SvelteKit, which
		// answers for its own routes.
	}

	// The lane is chosen from the RAW target - the admin route above matched
	// the request line as sent - while every lane below reads a DIFFERENT
	// spelling of it: the SSR Request resolves the path, and both the
	// prerendered lookup and SvelteKit's own router percent-decode it before
	// matching. So a target spelled outside the reserved admin prefix can still
	// ARRIVE inside it, two ways:
	//
	//   /foo/../__realtime/introspect   resolution drops a segment
	//   /%5f%5frealtime/introspect      decoding spells the prefix
	//
	// Neither matches the mount, so both fall through to the app's own routing
	// inside the namespace the adapter reserves and mounts ahead of page
	// routing. That is the mirror of the escape the admin lane refuses, and it
	// is refused the same way rather than rerouted: a target routed as one path
	// and read as another is ambiguous, and resolving it INTO the admin lane
	// would let a caller reach that lane through a spelling a fronting proxy's
	// ACL does not read as admin.
	//
	// Only while the admin route is actually mounted. The mount is what
	// reserves the prefix; without it both spellings reach the app regardless,
	// and refusing one of them would take away a path the app is serving.
	//
	// AHEAD OF THE PRERENDERED LOOKUP, because that lookup decodes too: a
	// prerendered page inside the prefix would otherwise be served for the
	// encoded spelling before this ever ran. The static fast path above needs no
	// such care - it matches the raw pathname against built asset keys, and an
	// encoded spelling matches none of them.
	//
	// `ADMIN_PREFIX` carries the trailing slash because that is the mount's own
	// test: `/__realtime/` and below go to the admin lane and the bare prefix
	// stays on the catch-all, so treating the bare prefix as reserved here
	// would refuse a resolved target whose direct spelling is served.
	//
	// The scans decide almost every request for free, and what bounds them is
	// that a path can arrive in the prefix only by DROPPING a segment - a dot
	// segment (`.`, `..`, or either spelled with `%2e`) or a backslash (a path
	// separator for a special scheme, so `..\` and `\` both count) - or by
	// SPELLING one of the prefix's own characters percent-encoded (`%`).
	// Everything else the parser rewrites only lengthens a segment or encodes
	// a character the prefix does not contain, and the whitespace it strips
	// and the `#` it truncates at are refused by the target check above.
	//
	// The adapter's EXACT mounts - the probes, the auth path, the waiting-room
	// pages, the WebSocket path where a ceiling answers its GETs - are matched
	// on the raw target the same way, so `/x/../healthz` misses the health
	// route and would reach the app's router as `/healthz`, and so would
	// `/healthz/__data.json`, which SvelteKit answers for the path in front of
	// the suffix. A target that resolves, decodes or strips onto one of them
	// without being spelled as it is refused here too.
	if (entersExactMount(pathname, pathname, query)) {
		send400(res);
		return;
	}
	const dropsSegment = DROPS_SEGMENT.test(pathname);
	if (dropsSegment || pathname.includes('%')) {
		let resolved = pathname;
		if (dropsSegment) {
			// Pathname resolution does not depend on the authority, so this uses
			// a fixed base rather than deriving the request's own origin (which
			// reads proxy headers and can throw). Concatenated, not passed as a
			// base, so a `//host` target resolves as a path and not as an
			// authority.
			try { resolved = new URL(RESOLUTION_BASE + pathname).pathname; } catch { /* read as sent */ }
		}
		const guardsPrefix = ADMIN_PREFIX !== null && adminMounted && !pathname.startsWith(ADMIN_PREFIX);
		if (entersExactMount(resolved, pathname, query) || (guardsPrefix && resolved.startsWith(ADMIN_PREFIX))) {
			send400(res);
			return;
		}
		if (resolved.includes('%')) {
			// Decoded the STRONGER way, `%2F` included, rather than the router's
			// gentler decode, because the two lanes below disagree: the
			// prerendered lookup decodes `%2F`, while SvelteKit's router leaves it
			// encoded. Decoding the stronger way covers both - anything the router
			// would place inside the prefix lands there under this reading too -
			// and what it refuses beyond the router's reading is exactly a target
			// spelling the reserved prefix with an encoded separator, which no app
			// path needs. An escape nothing can decode stays as it is, so a
			// target ending in one is still judged by the rest of its spelling:
			// SvelteKit answers such a path 400 itself, but only after the app's
			// `handle` hook has run on it.
			const decodedPath = resolved.replace(ASCII_ESCAPE, asciiFromEscape);
			if (entersExactMount(decodedPath, pathname, query) || (guardsPrefix && decodedPath.startsWith(ADMIN_PREFIX))) {
				send400(res);
				return;
			}
		}
	}

	// Prerendered pages that need decoding or trailing-slash normalization,
	// and static assets reachable only under a percent-encoded spelling.
	if (isGetLike) {
		const h = req.headers;
		const serve = () => tryPrerendered(
			res,
			pathname,
			search,
			/** @type {string} */ (h['accept-encoding']) || '',
			/** @type {string} */ (h['if-none-match']) || '',
			method === 'HEAD',
			/** @type {string} */ (h['range']) || '',
			/** @type {string} */ (h['if-range']) || '',
			/** @type {string} */ (h['if-match']) || '',
			/** @type {string} */ (h['if-unmodified-since']) || '',
			/** @type {string} */ (h['if-modified-since']) || ''
		);
		const served = tracingEnabled
			? traceOperation('adapter.http.prerendered', {
				kind: 'server',
				parent: extractTraceContext({
					traceparent: /** @type {string} */ (h['traceparent']),
					tracestate: /** @type {string} */ (h['tracestate'])
				}),
				attributes: { 'http.request.method': method, 'http.route.type': 'prerendered' }
			}, serve)
			: serve();
		if (served) return;

		// A static file whose name a browser percent-encodes, asked for that way:
		// the fast path above matched the target as sent. Traced as the static
		// answer it is, and only when there is a file to serve.
		const encodedFile = pathname.includes('%') ? encodedStaticEntry(pathname) : undefined;
		if (encodedFile !== undefined) {
			const serveEncoded = () => serveStatic(
				res,
				encodedFile,
				/** @type {string} */ (h['accept-encoding']) || '',
				/** @type {string} */ (h['if-none-match']) || '',
				method === 'HEAD',
				/** @type {string} */ (h['range']) || '',
				/** @type {string} */ (h['if-range']) || '',
				/** @type {string} */ (h['if-match']) || '',
				/** @type {string} */ (h['if-unmodified-since']) || '',
				/** @type {string} */ (h['if-modified-since']) || ''
			);
			if (tracingEnabled) {
				traceOperation('adapter.http.static', {
					kind: 'server',
					parent: extractTraceContext({
						traceparent: /** @type {string} */ (h['traceparent']),
						tracestate: /** @type {string} */ (h['tracestate'])
					}),
					attributes: { 'http.request.method': method, 'http.route.type': 'static' }
				}, serveEncoded);
			} else {
				serveEncoded();
			}
			return;
		}
	}

	// Full header collection under the family duplicate policy. Node's own
	// req.headers merge silently picks between duplicated singleton headers
	// and comma-joins the proxy identity headers; the policy bag refuses the
	// former (request-smuggling shape) and keeps the last line of the latter.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		// A framing refusal also ends the connection: its remaining bytes are
		// whatever the sender's own reading of the framing put there.
		send400(res, isFramingHeader(ambiguous));
		return;
	}
	// SvelteKit reads request headers off the node request object; install the
	// policy bag so the app sees exactly the values the runtime resolved
	// against (own property shadows the IncomingMessage prototype getter).
	Object.defineProperty(req, 'headers', { value: headers, configurable: true });

	const direct = req.socket?.remoteAddress || '';
	// The application's `request.signal`, aborted when the client goes away
	// before its request body has arrived in full, as SvelteKit's Node adapter
	// does - a form action that has its data finishes what it started. Only
	// the SSR lane pays for it - every lane above answered without one.
	const controller = openRequestSignal(res, state);
	// handleSSR contains its own error handling; this catch covers only a
	// throw from that handling itself, which must never become an unhandled
	// rejection that kills the process.
	handleSSR(req, res, headers, direct, state, direct).catch(() => {
		try { send500(res); } catch { /* exchange already gone */ }
	}).finally(() => closeRequestSignal(controller));
}
