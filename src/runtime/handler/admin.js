// Reserved admin / observability route. The app's WebSocket handler may export
// an `admin(request)` function (svelte-realtime's auth-gated introspection
// handler is the canonical one); when present, the adapter mounts it at the
// reserved `/__realtime/*` prefix ahead of the static and SSR lanes so admin
// traffic never hits page routing.
//
// This is pure transport plumbing: it bridges a node:http request to the
// framework-agnostic Web `Request` -> `Response` contract the app handler
// speaks, and writes the response back. ALL authorization lives in the app
// handler (it is handed the full Request, headers and all, and decides); the
// adapter never inspects or short-circuits the auth decision. A handler that
// throws or rejects yields a generic 500 with no detail leaked to the client.

import { origin, get_origin, body_size_limit } from './config.js';
import { FORBIDDEN_METHODS, send405 } from './http-helpers.js';
import { getRequest } from '../kit-node-bridge.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { wsModule } from '../ws-handler-bridge.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

// Substituted by the adapter's build step; a free identifier until then.
/* global WS_OPTIONS */

const wsOptions = WS_OPTIONS || {};

/** The configured mount prefix, or `false` when the auto-mount is disabled. */
export const ADMIN_PATH = wsOptions.adminPath !== undefined ? wsOptions.adminPath : '/__realtime';

/** True once the operator has confirmed the app handler gates its own requests. */
export const ADMIN_AUTH_ACKNOWLEDGED = wsOptions.adminAuthAcknowledged === true;

// The prefix every admin URL starts with, or null when nothing is mounted. The
// trailing slash is the whole match rule: the lead registers a `<prefix>/*`
// wildcard, which answers `/__realtime/` and `/__realtime/anything` but neither
// the bare prefix nor `/__realtimezzz`.
const MOUNT_PREFIX =
	ADMIN_PATH !== false && typeof wsModule.admin === 'function' ? ADMIN_PATH + '/' : null;

/** Whether the route is mounted at all - false disarms every check below. */
export const adminMounted = MOUNT_PREFIX !== null;

/**
 * Write a small JSON error body for a transport-level failure (the app handler
 * threw, or the request could not be constructed). The app handler owns all
 * application-level status codes; this only covers the plumbing failing.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendAdminError(res, status, message) {
	if (res.headersSent) return;
	res.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	});
	res.end(JSON.stringify({ error: message }));
}

/**
 * Write a Web `Response` back to the node response. Admin payloads are small
 * fully-buffered JSON, so the whole body is read into one Buffer and written in
 * one call - no streaming/backpressure machinery. A default
 * `x-content-type-options: nosniff` is filled in when the handler did not set
 * one, matching the SSR response writer.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean }} state
 */
async function writeAdminResponse(res, response, state) {
	/** @type {Buffer | null} */
	let body = null;
	try {
		if (response.body) body = Buffer.from(await response.arrayBuffer());
	} catch {
		if (!state.aborted) sendAdminError(res, 500, 'internal error');
		return;
	}
	if (state.aborted || res.headersSent) return;
	/** @type {Record<string, string | string[]>} */
	const headers = {};
	let hasContentTypeOptions = false;
	for (const [key, value] of response.headers) {
		// content-length is implied by the body we write; set-cookie is emitted
		// via getSetCookie() so multiple cookies are not folded.
		if (key === 'content-length' || key === 'set-cookie') continue;
		if (key === 'x-content-type-options') hasContentTypeOptions = true;
		headers[key] = value;
	}
	if (!hasContentTypeOptions) headers['x-content-type-options'] = 'nosniff';
	const cookies = response.headers.getSetCookie();
	if (cookies.length) headers['set-cookie'] = cookies;
	// The handler's own content-length was dropped above; write the one the
	// buffered body actually has. uWS derives it from the body it is handed, so
	// omitting it here would answer chunked where the family answers with a
	// length - and leave a HEAD reply, whose body node strips, with no size at
	// all. Statuses defined to carry no body must not carry the header.
	const bodiless = response.status === 204 || response.status === 304 || response.status < 200;
	if (!bodiless) headers['content-length'] = String(body ? body.byteLength : 0);
	res.writeHead(response.status, headers);
	// node strips the body of a HEAD (and of a bodiless status) itself, so the
	// empty reply is a plain end() rather than a dedicated call.
	if (body && body.byteLength) res.end(body);
	else res.end();
}

/**
 * Hand the built Request to the app handler and write its Response back.
 * Resolved through Promise.resolve so a SYNCHRONOUS throw inside the app
 * handler is caught here too, not just a rejected promise.
 *
 * @param {Request} request
 * @param {import('node:http').ServerResponse} res
 * @param {{ aborted: boolean }} state
 * @param {any} span the active tracing span, or null without a provider
 */
function runAdminHandler(request, res, state, span) {
	return Promise.resolve()
		.then(() => wsModule.admin(request))
		.then((response) => {
			if (state.aborted) return;
			if (!(response instanceof Response)) {
				sendAdminError(res, 500, 'internal error');
				return;
			}
			return writeAdminResponse(res, response, state);
		})
		.catch((err) => {
			try { span?.recordException?.(err); } catch { /* provider gone */ }
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.admin',
				event: 'admin.handler-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The admin handler failed; the request was answered 500.',
				attributes: { error: diagnosticError(err) }
			});
			if (!state.aborted) sendAdminError(res, 500, 'internal error');
		});
}

/**
 * Build the Web Request off the node request, then run the handler.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} baseOrigin
 * @param {{ aborted: boolean }} state
 * @param {any} span
 */
async function bridgeAdminRequest(req, res, baseOrigin, state, span) {
	/** @type {Request} */
	let request;
	try {
		// GET/HEAD carry no body; other methods stream through the same
		// primitive the SSR lane uses, under the global body-size cap.
		request = await getRequest({
			base: baseOrigin,
			request: req,
			bodySizeLimit: body_size_limit === Infinity ? undefined : body_size_limit
		});
	} catch (err) {
		if (state.aborted) return;
		const status = /** @type {{ status?: number }} */ (err)?.status;
		if (status === 413) sendAdminError(res, 413, 'payload too large');
		else sendAdminError(res, 400, 'bad request');
		return;
	}
	await runAdminHandler(request, res, state, span);
}

/**
 * The reserved admin route. Returns true once it has taken ownership of the
 * exchange, false when the path is not under the mounted prefix and the
 * request belongs to another lane.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {{ aborted: boolean }} state the request edge's own abort flag
 * @returns {boolean}
 */
export function tryAdminRoute(req, res, pathname, state) {
	if (MOUNT_PREFIX === null || !pathname.startsWith(MOUNT_PREFIX)) return false;

	const method = req.method || 'GET';
	// Same refusal as the main request edge, repeated here because this branch
	// answers ABOVE that gate: a forbidden method would otherwise reach
	// `new Request()` and throw instead of answering 405.
	if (FORBIDDEN_METHODS.has(method)) {
		send405(res);
		return true;
	}

	// Repeated header lines are merged per header class. A repeated framing /
	// identity header cannot be merged into one meaning, and the admin handler
	// authorizes off these headers, so an ambiguous one is refused here rather
	// than handed on as whichever line happened to arrive last.
	/** @type {Record<string, string>} */
	const headers = {};
	if (collectRequestHeaders(req.rawHeaders, headers) !== null) {
		sendAdminError(res, 400, 'bad request');
		return true;
	}

	// `get_origin` derives the base origin from the Host (and proxy) headers
	// when ORIGIN is unset - the zero-config default. It throws on a missing or
	// malformed Host (or PROTOCOL/PORT header), which a client can trivially
	// trigger, so it MUST be guarded. A usable origin is the client's
	// responsibility, so this is a 400.
	let baseOrigin;
	try {
		baseOrigin = origin || get_origin(headers);
	} catch {
		sendAdminError(res, 400, 'bad request');
		return true;
	}

	// A declared Content-Length over the cap is refused before any body is
	// read, mirroring the SSR handler.
	if (method !== 'GET' && method !== 'HEAD') {
		const declared = parseInt(/** @type {string} */ (headers['content-length']), 10);
		if (!isNaN(declared) && body_size_limit !== Infinity && declared > body_size_limit) {
			sendAdminError(res, 413, 'payload too large');
			return true;
		}
	}

	// The bridge reads headers off the node request object, whose own merge is
	// not the family duplicate policy; install the policy bag so the admin
	// handler sees exactly the values resolved above (an own property shadows
	// the IncomingMessage prototype getter).
	Object.defineProperty(req, 'headers', { value: headers, configurable: true });

	if (!tracingEnabled) {
		void bridgeAdminRequest(req, res, baseOrigin, state, null);
		return true;
	}
	void traceOperation('adapter.http.admin', {
		kind: 'server',
		parent: extractTraceContext(headers),
		attributes: { 'http.request.method': method, 'http.route.type': 'admin' }
	}, (span) => bridgeAdminRequest(req, res, baseOrigin, state, span));
	return true;
}
