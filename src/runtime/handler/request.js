// The main request handler: the routing spine every HTTP exchange walks.
// Order is load-bearing and mirrors the family contract:
//   health/readiness -> static fast path -> platform hardening -> method gate
//   -> prerendered lookup -> header policy -> SSR catch-all.

// Substituted by the adapter's build step; free identifiers until then.
/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
import { staticCache, counters } from './state.js';
import { serveStatic, tryPrerendered } from './static-assets.js';
import { ALLOWED_METHODS, FORBIDDEN_METHODS, send400, send405 } from './http-helpers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { handleSSR } from './ssr.js';
import { lifecycleState, requestDone } from './lifecycle.js';

const IS_WIN32 = process.platform === 'win32';

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

	// Static fast path: one Map lookup on the RAW undecoded pathname, four
	// header reads, nothing else. Because the index holds prerendered HTML
	// under its clean aliases too, most prerendered pages are also served here.
	// An encoded traversal misses by construction - the cache simply has no
	// such key.
	if (isGetLike) {
		const entry = staticCache.get(pathname);
		if (entry) {
			const h = req.headers;
			serveStatic(
				res,
				entry,
				/** @type {string} */ (h['accept-encoding']) || '',
				/** @type {string} */ (h['if-none-match']) || '',
				method === 'HEAD',
				/** @type {string} */ (h['range']) || '',
				/** @type {string} */ (h['if-range']) || ''
			);
			return;
		}
	}

	// Windows filesystem hardening: NTFS alternate data streams (':') and 8.3
	// short names ('~') can alias an indexed file under a different spelling.
	// The in-memory cache is immune, but SvelteKit's own read() lane and app
	// routes may touch disk, so the platform-specific spellings are refused at
	// the edge on the platform where they exist.
	if (IS_WIN32 && (pathname.includes(':') || pathname.includes('~'))) {
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

	// Prerendered pages that need decoding or trailing-slash normalization.
	if (isGetLike) {
		const h = req.headers;
		const served = tryPrerendered(
			res,
			pathname,
			search,
			/** @type {string} */ (h['accept-encoding']) || '',
			/** @type {string} */ (h['if-none-match']) || '',
			method === 'HEAD',
			/** @type {string} */ (h['range']) || '',
			/** @type {string} */ (h['if-range']) || ''
		);
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
	handleSSR(req, res, headers, direct, state, direct);
}
