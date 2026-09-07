// The main request handler: the routing spine every HTTP exchange walks.
// Order is load-bearing and mirrors the family contract:
//   health/readiness -> static fast path -> platform hardening -> method gate
//   -> prerendered lookup -> header policy -> SSR catch-all.

// Substituted by the adapter's build step; free identifiers until then.
/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
import { staticCache, counters } from './state.js';
import { serveStatic, tryPrerendered } from './static-assets.js';
import { ALLOWED_METHODS, FORBIDDEN_METHODS, send400, send405, send500 } from './http-helpers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { handleSSR } from './ssr.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { lifecycleState, requestDone } from './lifecycle.js';
import { monotonicNow } from '../runtime.js';
import { ADMIN_PATH } from './config.js';
import { adminMounted } from './admin.js';

const IS_WIN32 = process.platform === 'win32';

// Characters through which a raw path can reach a DIFFERENT path than the one
// spelled: dot segments in either spelling, the backslash a special scheme
// reads as a separator, the whitespace the URL parser strips, and the percent
// that lets a segment spell any character at all. See the admin-prefix check
// below, which is the only reader.
const MAY_RESOLVE = /[.%\\\t\n\r]/;

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
 *   tryAuthenticateRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => boolean,
 *   serveWsPathGet: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => void,
 *   tryWaitingRoomRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => boolean,
 *   tryAdminRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, state: { aborted: boolean }) => boolean
 * } | null}
 */
let realtimeRoutes = null;

/** @param {NonNullable<typeof realtimeRoutes>} routes */
export function installRealtimeRoutes(routes) {
	realtimeRoutes = routes;
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
	const state = { aborted: false, responseStarted: false, closedByServer: false };
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

	const url = req.url || '/';
	const q = url.indexOf('?');
	const pathname = q === -1 ? url : url.slice(0, q);
	const search = q === -1 ? '' : url.slice(q);
	const method = req.method || 'GET';
	const isGetLike = method === 'GET' || method === 'HEAD';

	// Probe routes answer before anything else so an orchestrator's checks can
	// never be shadowed by a static asset of the same name. Liveness answers OK
	// even during drain (the process lives); readiness reports the lifecycle
	// state so a balancer routes away the moment drain begins.
	if (method === 'GET') {
		// The probes are length-framed like every other fixed-shape answer:
		// uWS derives a length from the body it is handed, and a balancer
		// probing with HEAD gets no size at all when the header is absent.
		if (HEALTH_CHECK_PATH !== false && pathname === HEALTH_CHECK_PATH) {
			const body = 'OK';
			res.writeHead(200, {
				'content-type': 'text/plain',
				'content-length': String(Buffer.byteLength(body))
			});
			res.end(body);
			return;
		}
		if (READINESS_CHECK_PATH !== false && pathname === READINESS_CHECK_PATH) {
			const lifecycle = lifecycleState();
			if (lifecycle === 'ready') {
				const body = 'ready';
				res.writeHead(200, {
					'content-type': 'text/plain',
					'content-length': String(Buffer.byteLength(body))
				});
				res.end(body);
			} else {
				res.writeHead(503, {
					'content-type': 'text/plain',
					'content-length': String(Buffer.byteLength(lifecycle))
				});
				res.end(lifecycle);
			}
			return;
		}
	}

	if (realtimeRoutes !== null) {
		// A plain GET on the WebSocket path is a client that forgot (or was
		// stripped of) its upgrade headers - answer with the status that says
		// so instead of rendering the app's 404. Under a full upgrade gate the
		// same URL is a browser NAVIGATION into a queue, so the answer is the
		// capacity refusal the upgrade door would have given.
		if (pathname === realtimeRoutes.wsPath && isGetLike) {
			realtimeRoutes.serveWsPathGet(req, res, pathname, search);
			return;
		}
		// The waiting room's poll and holding page. Both are read-only and
		// answer before the static index so a same-named asset can never
		// shadow the queue a browser is sitting in.
		if (isGetLike && realtimeRoutes.tryWaitingRoomRoute(req, res, pathname, search)) return;
		if (realtimeRoutes.tryAuthenticateRoute(req, res, pathname)) return;
		// The reserved admin prefix, last of the realtime routes and above the
		// static lane. The exact realtime routes above beat it - the WebSocket
		// path, the authenticate endpoint, both waiting-room paths, and the two
		// probes for the methods each answers - and it beats the static and SSR
		// catch-all, so a same-named asset cannot shadow an admin path. Note the
		// probes are GET-only, so a HEAD on a probe path nested under the admin
		// prefix reaches the admin handler; uWS routes the same way, because a
		// method-scoped route does not claim the other methods either.
		if (realtimeRoutes.tryAdminRoute(req, res, pathname, state)) return;
	}

	// Static fast path: one Map lookup on the RAW undecoded pathname, five
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

	// Windows filesystem hardening: NTFS alternate data streams (':') and 8.3
	// short names ('~') can alias an indexed file under a different spelling.
	// The in-memory cache is immune, but SvelteKit's own read() lane and app
	// routes may touch disk, so the platform-specific spellings are refused at
	// the edge on the platform where they exist. Checked on the DECODED form
	// too - the lanes this protects operate on decoded paths, so an encoded
	// `%3A` must not slip past a gate that only reads the raw spelling.
	if (IS_WIN32) {
		let decoded = pathname;
		if (pathname.includes('%')) {
			try {
				decoded = decodeURIComponent(pathname);
			} catch {
				send400(res);
				return;
			}
		}
		if (pathname.includes(':') || pathname.includes('~') || decoded.includes(':') || decoded.includes('~')) {
			send400(res);
			return;
		}
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
	// The scan decides almost every request for free, and what bounds it to
	// these five characters is that a path can arrive in the prefix only by
	// DROPPING a segment - a dot segment (`.`, or `%2e`), a backslash (a path
	// separator for a special scheme, so `..\` and `\` both count), or one of
	// the whitespace characters the URL parser strips - or by SPELLING one of
	// the prefix's own characters percent-encoded (`%`). Everything else the
	// parser rewrites only lengthens a segment, and a `#` truncates without
	// touching the head, so neither can carry a target into a prefix its raw
	// form was outside of.
	if (ADMIN_PREFIX !== null && adminMounted && MAY_RESOLVE.test(pathname) &&
		!pathname.startsWith(ADMIN_PREFIX)) {
		try {
			// Pathname resolution does not depend on the authority, so this uses
			// a fixed base rather than deriving the request's own origin (which
			// reads proxy headers and can throw). Concatenated, not passed as a
			// base, so a `//host` target resolves as a path and not as an
			// authority.
			const resolved = new URL(RESOLUTION_BASE + pathname).pathname;
			if (resolved.startsWith(ADMIN_PREFIX)) { send400(res); return; }
			// Decoded the STRONGER way, with `decodeURIComponent` rather than the
			// router's gentler decode, because the two lanes below disagree: the
			// prerendered lookup decodes this way, while SvelteKit's router
			// leaves `%2F` encoded. Decoding the stronger way covers both -
			// anything the router would place inside the prefix lands there
			// under this reading too - and what it refuses beyond the router's
			// reading is exactly a target spelling the reserved prefix with an
			// encoded separator, which no app path needs.
			//
			// A target neither call can parse is left to the lanes below, which
			// read the same characters and answer for them there; the only
			// decision made here is the prefix one.
			if (resolved.includes('%') && decodeURIComponent(resolved).startsWith(ADMIN_PREFIX)) {
				send400(res);
				return;
			}
		} catch { /* not a path this check can rule on */ }
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
	}

	// Full header collection under the family duplicate policy. Node's own
	// req.headers merge silently picks between duplicated singleton headers
	// and comma-joins the proxy identity headers; the policy bag refuses the
	// former (request-smuggling shape) and keeps the last line of the latter.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		send400(res);
		return;
	}
	// SvelteKit reads request headers off the node request object; install the
	// policy bag so the app sees exactly the values the runtime resolved
	// against (own property shadows the IncomingMessage prototype getter).
	Object.defineProperty(req, 'headers', { value: headers, configurable: true });

	const direct = req.socket?.remoteAddress || '';
	// handleSSR contains its own error handling; this catch covers only a
	// throw from that handling itself, which must never become an unhandled
	// rejection that kills the process.
	handleSSR(req, res, headers, direct, state, direct).catch(() => {
		try { send500(res); } catch { /* exchange already gone */ }
	});
}
