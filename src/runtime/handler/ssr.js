import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { server } from '../_init.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { resolveRequestId } from '../utils/request-id.js';
import { randomUuid, setTimer, clearTimer } from '../runtime.js';
import { PayloadTooLargeError, send400, send413, send500, endText, bodylessLength, stageHeaders } from './http-helpers.js';
import { origin, address_header, xff_depth, body_size_limit, get_origin, trusted_proxies, warnUntrustedClaim } from './config.js';
import { platform } from './platform.js';
import { chunkBytes, declaresBodyPastCap, isDedupBufferable, readBodyUpTo } from './ssr-dedup.js';
import { negotiateEncoding } from '../utils/content-coding.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';

/* global ENV_PREFIX */
/* global WS_OPTIONS */

// Maximum number of in-flight dedup keys tracked simultaneously.
const MAX_SSR_DEDUP = 500;

// Maximum response body size (bytes) that may be shared across waiters.
// Responses larger than this are not shared - each waiter makes its own call.
const MAX_SSR_DEDUP_BODY = 512 * 1024;

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array, oneString: boolean }} SharedResponse
 */

/**
 * In-flight SSR dedup map. Key is "<METHOD>\0<ORIGIN>\0<URL>".
 * Value is a Promise that resolves to a SharedResponse (shareable) or null (not shareable).
 * @type {Map<string, Promise<SharedResponse | null>>}
 */
const ssrInflight = new Map();

// Dynamic response compression: only compress text content types above a threshold.
// Static files use build-time precompression and are never affected by this.
const COMPRESS_MIN_SIZE = 1024;

// BREACH defense: dynamic compression of credentialed responses turns the
// response length into a side channel that leaks any secret reflected
// alongside attacker-influenced input (CSRF tokens, session IDs, API keys in
// the page body). Compression is skipped on every request that carries a
// `Cookie` or `Authorization` header; apps that have audited their
// reflected-input surface opt back in via
// `websocket.compressCredentialedResponses`.
const COMPRESS_CREDENTIALED = WS_OPTIONS?.compressCredentialedResponses === true;

const COMPRESSIBLE_TYPES = new Set([
	'text/html', 'text/css', 'text/plain', 'text/xml', 'text/javascript',
	'text/csv', 'text/markdown',
	'application/json', 'application/xml', 'application/javascript',
	'application/xhtml+xml', 'application/ld+json', 'application/manifest+json',
	'application/rss+xml', 'application/atom+xml',
	'image/svg+xml'
]);

/**
 * The request body as a ReadableStream over node's incoming message, read for
 * ANY method that is not GET or HEAD: a body needs no content-type to be a
 * body, and a client that omits the header still sent the bytes. The limit is
 * enforced as the chunks arrive and trips as PayloadTooLargeError inside the
 * stream, so a route that pipes the body into its response sees the failure
 * mid-stream, where the exchange is then aborted rather than ended cleanly.
 * Backpressure pauses the socket while the consumer is behind.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit - bytes, or Infinity
 * @param {{ aborted: boolean }} state
 * @returns {ReadableStream<Uint8Array>}
 */
export function readBody(req, limit, state) {
	let initialized = false;
	// Set once the stream is finished, from either side: the request ended,
	// failed or passed the limit, or the consumer cancelled. The listeners
	// stand down from then on. A chunk still arriving after a cancel would
	// otherwise be enqueued into a closed controller, which throws inside the
	// request's event listener, where nothing catches it and the process exits.
	let done = false;
	return new ReadableStream({
		start(controller) {
			if (state.aborted) controller.error(new Error('Request aborted'));
		},
		pull(controller) {
			if (state.aborted) {
				try { controller.error(new Error('Request aborted')); } catch { /* already closed */ }
				return;
			}
			if (initialized) {
				req.resume();
				return;
			}
			initialized = true;
			let size = 0;
			req.on('data', (/** @type {Buffer} */ chunk) => {
				if (done || state.aborted) return;
				size += chunk.byteLength;
				if (limit !== Infinity && size > limit) {
					done = true;
					controller.error(new PayloadTooLargeError());
					req.pause();
					return;
				}
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if (controller.desiredSize !== null && controller.desiredSize <= 0) req.pause();
			});
			req.on('end', () => {
				if (done) return;
				done = true;
				controller.close();
			});
			req.on('error', (err) => {
				if (done) return;
				done = true;
				try { controller.error(err); } catch { /* already closed */ }
			});
		},
		cancel() {
			// What is still on its way is discarded, and the socket keeps being
			// read so the connection reaches its next request.
			done = true;
			req.resume();
		}
	});
}

/**
 * Build the Web Request for a node exchange the lead's way: the declared
 * content-length is refused up front when it exceeds the limit, and every
 * non-GET/HEAD request carries its body stream whatever headers it sent.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} baseOrigin
 * @param {Record<string, string>} headers - the collected lowercase headers
 * @param {{ aborted: boolean }} state
 * @returns {Request | null} null when the declared length already exceeds the limit
 */
export function buildRequest(req, baseOrigin, headers, state) {
	const method = req.method || 'GET';
	let body;
	if (method !== 'GET' && method !== 'HEAD') {
		const cl = parseInt(headers['content-length'], 10);
		if (!isNaN(cl) && body_size_limit !== Infinity && cl > body_size_limit) return null;
		body = readBody(req, body_size_limit, state);
	}
	return new Request(baseOrigin + req.url, {
		method,
		headers,
		body,
		// @ts-expect-error
		duplex: 'half'
	});
}

/**
 * Pick the coding a single-chunk body is sent with, or '' to send it as is:
 * compressible types past the size floor, when the client negotiated a coding
 * and the app set none, and only when the coded body is actually smaller.
 *
 * @param {Response} response
 * @param {Uint8Array} body
 * @param {string} acceptEncoding - '' suppresses compression (BREACH defense)
 * @returns {{ body: Uint8Array, encoding: string }}
 */
function compressWhole(response, body, acceptEncoding) {
	if (!acceptEncoding || body.byteLength < COMPRESS_MIN_SIZE || response.headers.has('content-encoding')) {
		return { body, encoding: '' };
	}
	const ctRaw = response.headers.get('content-type') || '';
	const semi = ctRaw.indexOf(';');
	const ct = semi === -1 ? ctRaw : ctRaw.slice(0, semi).trimEnd();
	if (!COMPRESSIBLE_TYPES.has(ct)) return { body, encoding: '' };
	// The header's weights decide, not a substring: `br;q=0` is a refusal, and
	// `gzip;q=1, br;q=0.5` prefers gzip.
	const chosen = negotiateEncoding(acceptEncoding, true, true);
	if (chosen === '') return { body, encoding: '' };
	const compressed = chosen === 'br'
		? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
		: gzipSync(body, { level: 6 });
	if (compressed.byteLength >= body.byteLength) return { body, encoding: '' };
	return { body: compressed, encoding: chosen };
}

/**
 * Write a Response onto the node response, framed the way uWS frames what it
 * is handed: a body that turns out to be one chunk (the common SSR shape) goes
 * out whole with its length, compressed first when the client negotiated a
 * coding; a body that keeps streaming goes out chunked from its first byte and
 * is never buffered or compressed, so an SSE stream is never parked; a
 * bodyless answer says what bodylessLength allows. The Response's own
 * Content-Length never passes through. The whole write is awaited, so a body
 * that fails mid-stream surfaces here as a throw.
 *
 * A source that fails mid-body (a rejecting `reader.read()`) leaves the loop
 * without `streamDone`, and the exchange is then closed abruptly rather than
 * ended: a clean EOF on a partial body would read as a successful but
 * truncated response. The failure is rethrown so the caller reports it; the
 * close it caused is marked as the server's, so that report is not mistaken
 * for a client abort.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean, responseStarted?: boolean, closedByServer?: boolean }} state
 * @param {string} [acceptEncoding] '' suppresses compression (BREACH defense)
 * @param {boolean} [headOnly] the request was a HEAD: headers go out, the
 *   body never does
 */
async function writeResponse(res, response, state, acceptEncoding, headOnly = false) {
	if (state.aborted) {
		// Nothing will consume this body; cancel it so the render's upstream
		// (a fetch response, a DB cursor held by the stream source) is
		// released now instead of at GC.
		await response.body?.cancel().catch(() => {});
		return;
	}
	if (!response.body) {
		state.responseStarted = true;
		const length = bodylessLength(response.status, response.headers.get('content-length'), headOnly);
		if (writeHeaders(res, response, length)) res.end();
		return;
	}
	if (response.body.locked) {
		state.responseStarted = true;
		endText(res, 500, { 'content-type': 'text/plain' },
			'Fatal error: Response body is locked. ' +
				"This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
		);
		return;
	}

	// HEAD: SvelteKit renders it as the GET - its endpoint lane routes HEAD to
	// the GET handler and hands that Response back unchanged, and pages render
	// in full - and leaves dropping the body to the server. node would drop the
	// bytes, but reading them would still cost the whole render, so the body is
	// never read: the declared Content-Length is reported or none. No encoding
	// is negotiated for it either: the length named is the identity one and no
	// Content-Encoding or Vary of the adapter's own accompanies it, so a HEAD
	// sent with Accept-Encoding sees a consistent identity header set rather
	// than the coded length the GET would carry (RFC 9110 9.3.2 lets a HEAD
	// omit fields settled only while generating the content; the GET's coded
	// length is one).
	if (headOnly) {
		state.responseStarted = true;
		const length = bodylessLength(response.status, response.headers.get('content-length'), true);
		if (writeHeaders(res, response, length)) res.end();
		response.body.cancel().catch(() => {});
		return;
	}

	const reader = response.body.getReader();
	let streaming = false;
	let streamDone = false;
	try {
		const first = await reader.read();
		if (state.aborted) return;
		if (first.done) {
			state.responseStarted = true;
			if (writeHeaders(res, response, 0)) res.end();
			return;
		}
		const firstBytes = chunkBytes(first.value);
		// The second read decides single-chunk vs streaming, but it must never
		// WITHHOLD a streaming shell: a page whose next chunk arrives seconds
		// later (a load() streaming a promise) would otherwise ship its first
		// byte only when its second exists. A buffered body settles its second
		// read within a few microtasks; anything parked on real I/O loses the
		// race and streams chunked from the first chunk on.
		const STREAMING = Symbol('streaming');
		let microtasks = Promise.resolve();
		for (let i = 0; i < 8; i++) microtasks = microtasks.then(() => {});
		/** @type {Promise<ReadableStreamReadResult<Uint8Array>> | null} */
		let pendingRead = reader.read();
		const raced = await Promise.race([pendingRead, microtasks.then(() => STREAMING)]);
		if (state.aborted) return;
		const second = raced === STREAMING ? null : /** @type {ReadableStreamReadResult<Uint8Array>} */ (raced);
		if (second !== null && second.done) {
			// A string chunk goes out as is: the family's native tier decides
			// on the chunk's own byteLength, and a string has none.
			const whole = compressWhole(response, firstBytes, typeof first.value === 'string' ? '' : acceptEncoding || '');
			state.responseStarted = true;
			if (writeHeaders(res, response, whole.body.byteLength, whole.encoding)) res.end(whole.body);
			return;
		}

		/** @type {Uint8Array[]} */
		const ready = [firstBytes];
		if (second !== null) {
			ready.push(chunkBytes(second.value));
			pendingRead = null;
		}
		state.responseStarted = true;
		// node frames this answer chunked unless the request is HTTP/1.0
		// without `TE: chunked`, which it answers close-delimited instead.
		if (!writeHeaders(res, response, null, '', res.useChunkedEncodingByDefault)) return;
		streaming = true;
		for (;;) {
			let value;
			if (ready.length > 0) {
				value = /** @type {Uint8Array} */ (ready.shift());
			} else {
				const read = await (pendingRead ?? reader.read());
				pendingRead = null;
				if (read.done) { streamDone = true; break; }
				value = chunkBytes(read.value);
			}
			if (state.aborted) break;
			if (!res.write(value)) {
				const drained = await waitForDrain(res, 30000);
				if (!drained) break;
				if (state.aborted) break;
			}
		}
	} finally {
		if (streaming && !state.aborted) {
			if (streamDone) {
				res.end();
			} else {
				state.closedByServer = true;
				res.destroy();
			}
		}
		reader.cancel().catch(() => {});
	}
}

/**
 * Write the response headers, with the Content-Length this writer settled on
 * in place of any the Response declared.
 *
 * `x-content-type-options: nosniff` is filled in when the response did not set
 * one - the header is safe in every legitimate scenario (it tells the browser
 * not to MIME-sniff away the server's declared content-type) and closes a
 * known MIME-confusion vector for any SSR response whose author forgets to
 * set it. Apps that want a different policy include their own header on the
 * Response. Other header defaults (Referrer-Policy, X-Frame-Options, CSP) are
 * intentionally NOT defaulted here: CSP needs app-specific care for
 * inline-hydration / iframe shapes, X-Frame-Options breaks legitimate embeds,
 * and Referrer-Policy choices vary by app. Those are app-level decisions and
 * the right tier is `hooks.server.js`.
 *
 * A header the transport refuses (a name or value with characters node will
 * not put on the wire) turns the whole response into a 500 before any byte
 * starts, the same answer Kit's own node writer gives.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {number | null} length the Content-Length to write, or null for none
 * @param {string} [encoding] the content coding the body was sent with
 * @param {boolean} [chunked] node will frame this answer chunked, so a
 *   Trailer the Response carries can go out with it
 * @returns {boolean} false when a header was refused and the 500 was written
 */
function writeHeaders(res, response, length, encoding = '', chunked = false) {
	/** @type {Array<[string, string | string[]]>} */
	const staged = [];
	let hasContentTypeOptions = false;
	for (const [key, value] of response.headers) {
		// The framing is this writer's to decide: a Response relayed from
		// `fetch()` carries the upstream's Transfer-Encoding, and passing it
		// through beside the length written for a whole body is a message no
		// HTTP/1.1 client will read. A Trailer goes out only on a chunked
		// answer; node refuses it on any other.
		if (key === 'set-cookie' || key === 'content-length' || key === 'transfer-encoding') continue;
		if (key === 'trailer' && !chunked) continue;
		if (key === 'x-content-type-options') hasContentTypeOptions = true;
		staged.push([key, value]);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) staged.push(['set-cookie', cookies]);
	// Checked whole before the first is set: a refused header (a cookie
	// value included) is answered with the 500, not thrown past a response
	// already marked as started, where nothing would answer it.
	try {
		stageHeaders(res, staged);
	} catch (error) {
		endText(res, 500, {}, String(error));
		return false;
	}
	if (!hasContentTypeOptions) res.setHeader('x-content-type-options', 'nosniff');
	if (encoding) {
		res.setHeader('content-encoding', encoding);
		const vary = res.getHeader('vary');
		res.setHeader('vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
	}
	if (length !== null) res.setHeader('content-length', String(length));
	res.writeHead(response.status);
	return true;
}

/**
 * Wait for the socket to drain, bounded: a reader that never drains would
 * otherwise hold the render forever.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when drained, false on the deadline
 */
function waitForDrain(res, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {any} */
		let timer = null;
		const done = (ok) => {
			if (timer !== null) clearTimer(timer);
			res.off('drain', onDrain);
			res.off('close', onClose);
			resolve(ok);
		};
		const onDrain = () => done(true);
		const onClose = () => done(false);
		timer = setTimer(() => done(false), timeoutMs);
		res.once('drain', onDrain);
		res.once('close', onClose);
	});
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, string>} headers - policy-collected header bag (also
 *   installed as req.headers by the caller, so SvelteKit sees the same values)
 * @param {string} remoteAddress - effective client-facing socket address
 * @param {{ aborted: boolean }} state
 * @param {string} [directAddress] - direct socket peer; decides ADDRESS_HEADER trust
 */
export function handleSSR(req, res, headers, remoteAddress, state, directAddress = remoteAddress) {
	if (!tracingEnabled) {
		return handleSSRTraced(req, res, headers, remoteAddress, state, directAddress, null);
	}
	return traceOperation('adapter.http.ssr', {
		kind: 'server',
		parent: extractTraceContext(headers),
		attributes: {
			'http.request.method': req.method,
			'network.protocol.name': 'http'
		}
	}, (span) => handleSSRTraced(req, res, headers, remoteAddress, state, directAddress, span));
}

/** @param {unknown} span the active tracing span, or null without a provider */
async function handleSSRTraced(req, res, headers, remoteAddress, state, directAddress, span) {
	const requestId = resolveRequestId(headers['x-request-id']) || randomUuid();
	try {
		const base_origin = origin || get_origin(headers);

		/** @type {Request | null} */
		let request;
		try {
			request = buildRequest(req, base_origin, headers, state);
		} catch {
			send400(res);
			return;
		}
		if (request === null) {
			send413(res);
			return;
		}

		// Branch at definition time on the module-level constant address_header.
		// In the common case (no proxy), the closure captures only remoteAddress
		// and V8 sees a trivially-inlinable one-liner. When address_header IS set,
		// the closure captures the full set of proxy variables.
		const getClientAddress = address_header
			? () => {
				// Trusted-proxy gate: a header claim from a peer outside
				// TRUSTED_PROXIES is ignored, not an error - the request is a
				// direct client, and its socket address IS its address.
				if (trusted_proxies && !trusted_proxies.match(directAddress)) {
					warnUntrustedClaim(directAddress, `${address_header} header`);
					return remoteAddress;
				}
				if (!(address_header in headers)) {
					throw new Error(
						`Address header was specified with ${ENV_PREFIX + 'ADDRESS_HEADER'}=${address_header} but is absent from request`
					);
				}

				const value = headers[address_header] || '';

				if (address_header === 'x-forwarded-for') {
					// Reject absurdly long XFF headers (max ~8KB)
					if (value.length > 8192) {
						throw new Error('X-Forwarded-For header too large');
					}
					const addresses = value.split(',');

					if (xff_depth > addresses.length) {
						throw new Error(
							`${ENV_PREFIX + 'XFF_DEPTH'} is ${xff_depth}, but only found ${addresses.length} addresses`
						);
					}
					return addresses[addresses.length - xff_depth].trim();
				}

				return value;
			}
			: () => remoteAddress;

		// Per-request platform: same surface as the shared platform plus a unique
		// requestId for structured logging. Object.create keeps live getters and
		// sibling-installed keys intact via the prototype chain - a flat spread
		// would freeze them to their snapshot value at clone time.
		const requestPlatform = Object.create(platform);
		requestPlatform.requestId = requestId;

		const method = request.method;
		const headOnly = method === 'HEAD';

		// Dedup: for anonymous GET/HEAD requests that arrive concurrently for the
		// same URL, only the first (the leader) calls server.respond(). Subsequent
		// requests (waiters) await the leader's promise and reconstruct a Response
		// from the shared buffer. This prevents redundant SSR work during traffic
		// spikes on public pages.
		//
		// Dedup is skipped for:
		//   - Non-GET/HEAD methods (mutations must not be coalesced)
		//   - Authenticated requests (cookie or authorization header present)
		//   - When the dedup map is at capacity (safety valve)
		const isCredentialedRequest = !!(headers.cookie || headers.authorization);
		const canDedup =
			(method === 'GET' || method === 'HEAD') &&
			!isCredentialedRequest &&
			ssrInflight.size < MAX_SSR_DEDUP;
		// BREACH defense: suppress the accept-encoding signal for credentialed
		// requests so writeResponse() leaves the body uncompressed.
		const respAcceptEncoding = (isCredentialedRequest && !COMPRESS_CREDENTIALED)
			? ''
			: headers['accept-encoding'];

		if (canDedup) {
			// Include base_origin so virtual-hosting deployments (one instance
			// behind multiple `Host` aliases) keep per-tenant dedup buckets -
			// SvelteKit consults `request.url`'s host when rendering, so the
			// response IS host-dependent.
			const url = request.url.slice(base_origin.length);
			const dedupKey = method + '\0' + base_origin + '\0' + url;
			const existing = ssrInflight.get(dedupKey);

			if (existing) {
				// Waiter: await the leader's result. An aborted waiter consumes
				// nothing - the shared buffer needs no cancel.
				const shared = await existing;
				if (state.aborted) return;
				if (shared) {
					// Reconstruct a fresh Response from the shared buffer (zero-copy view)
					await writeResponse(
						res,
						new Response(shared.body, {
							status: shared.status,
							statusText: shared.statusText,
							headers: shared.headers
						}),
						state,
						shared.oneString ? '' : respAcceptEncoding,
						headOnly
					);
					return;
				}
				// Leader marked this non-shareable - fall through to our own call
			} else {
				// Leader: register the promise before any await so waiters attach to it
				let resolveShared;
				const sharedPromise = /** @type {Promise<SharedResponse | null>} */ (
					new Promise((r) => { resolveShared = r; })
				);
				ssrInflight.set(dedupKey, sharedPromise);
				// Always remove when settled, even on throw
				sharedPromise.finally(() => ssrInflight.delete(dedupKey));

				try {
					const response = await server.respond(request, { platform: requestPlatform, getClientAddress });
					if (state.aborted) {
						resolveShared(null);
						await response.body?.cancel().catch(() => {});
						return;
					}

					// Responses with Set-Cookie must not be shared (they're personalized).
					// Responses that declare Vary on anything other than Accept-Encoding
					// are personalized by some other request header (Accept-Language,
					// geo, feature flags, tenant, etc.) - sharing would serve the
					// leader's content to waiters that may legitimately differ.
					if (response.headers.has('set-cookie') || !response.body) {
						resolveShared(null);
						await writeResponse(res, response, state, respAcceptEncoding, headOnly);
						return;
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							await writeResponse(res, response, state, respAcceptEncoding, headOnly);
							return;
						}
					}

					// A never-ending SSE stream (see isDedupBufferable) must not be
					// buffered: arrayBuffer() on it would await forever, parking this
					// leader and every concurrent waiter on the same promise.
					// writeResponse chunk-streams it instead. Every other (finite)
					// render is buffered and shared below.
					if (!isDedupBufferable(response)) {
						resolveShared(null);
						await writeResponse(res, response, state, respAcceptEncoding, headOnly);
						return;
					}

					// Sharing is decided BEFORE the body is materialised. A declared
					// length past the cap streams at once; otherwise the body is
					// read only up to the cap, and a body that passes it is not
					// shared and streams on from where the read stopped. Reading
					// the whole body first and asking afterwards would hold every
					// large uncredentialed response in memory in full, per request,
					// which is what the cap exists to prevent.
					if (declaresBodyPastCap(response, MAX_SSR_DEDUP_BODY)) {
						resolveShared(null);
						await writeResponse(res, response, state, respAcceptEncoding, headOnly);
						return;
					}
					const read = await readBodyUpTo(/** @type {ReadableStream<Uint8Array>} */ (response.body), MAX_SSR_DEDUP_BODY);
					if (state.aborted) {
						resolveShared(null);
						if (!read.complete) read.stream.cancel().catch(() => {});
						return;
					}
					if (!read.complete) {
						resolveShared(null);
						await writeResponse(
							res,
							new Response(read.stream, {
								status: response.status,
								statusText: response.statusText,
								headers: response.headers
							}),
							state,
							respAcceptEncoding,
							headOnly
						);
						return;
					}

					resolveShared(/** @type {SharedResponse} */ ({
						status: response.status,
						statusText: response.statusText,
						headers: /** @type {[string, string][]} */ ([...response.headers]),
						body: read.bytes,
						oneString: read.oneString
					}));

					// Serve the leader's own response from the same buffer
					await writeResponse(
						res,
						new Response(read.bytes, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers
						}),
						state,
						read.oneString ? '' : respAcceptEncoding,
						headOnly
					);
				} catch (err) {
					resolveShared(null);
					throw err;
				}
				return;
			}
		}

		// Normal (non-dedup) path
		const response = await server.respond(request, { platform: requestPlatform, getClientAddress });
		if (state.aborted) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		await writeResponse(res, response, state, respAcceptEncoding, headOnly);
	} catch (err) {
		try { span?.recordException?.(err); } catch {}
		if (state.aborted && !state.closedByServer) return;
		if (err instanceof PayloadTooLargeError) {
			// The limit can also trip mid-stream, through a route that pipes the
			// request body into its response: the reader rejection aborts the
			// exchange in the stream teardown, and a 413 written there would be
			// a second response into a closed exchange - same rule as the 500.
			if (!state.aborted && !state.responseStarted) send413(res);
			return;
		}
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.ssr',
			event: 'runtime.ssr.failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'SvelteKit request handling failed.',
			attributes: { requestId, error: diagnosticError(err) }
		});
		// Once any byte of the real response has reached the wire, no error
		// response can be delivered: the streaming path has either ended or
		// abruptly closed the exchange, and writing a 500 into it would be a
		// second response. The event above is the failure's record.
		if (!state.aborted && !state.responseStarted) send500(res, requestId);
	}
}
