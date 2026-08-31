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

const IS_WIN32 = process.platform === 'win32';

/**
 * Realtime HTTP routes, installed by handler.js when the websocket lane is
 * built in: the GET answer on the WebSocket path, the upgrade gate's waiting
 * room, and the authenticate preflight endpoint. Null when realtime is off -
 * the checks then cost one comparison.
 * @type {{
 *   wsPath: string,
 *   tryAuthenticateRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => boolean,
 *   serveWsPathGet: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => void,
 *   tryWaitingRoomRoute: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, search: string) => boolean
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
	const state = { aborted: false };
	// 'close' fires exactly once per exchange - after a finished response AND
	// after a torn-down one - so it is the single accounting point. A close
	// before the response finished is a client abort.
	res.on('close', () => {
		if (!res.writableFinished) state.aborted = true;
		counters.inFlightCount--;
		requestDone();
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
		if (HEALTH_CHECK_PATH !== false && pathname === HEALTH_CHECK_PATH) {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('OK');
			return;
		}
		if (READINESS_CHECK_PATH !== false && pathname === READINESS_CHECK_PATH) {
			const lifecycle = lifecycleState();
			if (lifecycle === 'ready') {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('ready');
			} else {
				res.writeHead(503, { 'content-type': 'text/plain' });
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
