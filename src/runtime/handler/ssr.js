import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { server } from '../_init.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { resolveRequestId } from '../utils/request-id.js';
import { randomUuid, setTimer, clearTimer } from '../runtime.js';
import { PayloadTooLargeError, send400, send413, send500 } from './http-helpers.js';
import { origin, address_header, xff_depth, body_size_limit, get_origin, trusted_proxies, warnUntrustedClaim } from './config.js';
import { platform } from './platform.js';
import { isDedupBufferable } from './ssr-dedup.js';
import { acceptsCoding } from './static-assets.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';

/* global ENV_PREFIX */
/* global WS_OPTIONS */

// Maximum number of in-flight dedup keys tracked simultaneously.
const MAX_SSR_DEDUP = 500;

// Maximum response body size (bytes) that may be shared across waiters.
// Responses larger than this are not shared - each waiter makes its own call.
const MAX_SSR_DEDUP_BODY = 512 * 1024;

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array }} SharedResponse
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
 * Default-fill `x-content-type-options: nosniff` when the response did not
 * already set one - the header is safe in every legitimate scenario (it tells
 * the browser not to MIME-sniff away the server's declared content-type) and
 * closes a known MIME-confusion vector for any SSR response whose author
 * forgets to set the header explicitly. Apps that want a different policy
 * just include their own header on the Response - the default-fill only fires
 * when the response is silent on the matter.
 *
 * Other header defaults (Referrer-Policy, X-Frame-Options, CSP) are
 * intentionally NOT defaulted here. CSP needs app-specific care for
 * inline-hydration / iframe shapes; X-Frame-Options breaks legitimate embeds;
 * Referrer-Policy choices vary by app. Those are app-level decisions and the
 * right tier is `hooks.server.js`.
 *
 * @param {Response} response
 * @returns {Response}
 */
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
			let done = false;
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

function ensureNosniff(response) {
	if (response.headers.has('x-content-type-options')) return response;
	try {
		response.headers.set('x-content-type-options', 'nosniff');
		return response;
	} catch {
		// Immutable headers (a Response passed through fetch) - rebuild.
		const headers = new Headers(response.headers);
		headers.set('x-content-type-options', 'nosniff');
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}
}

/**
 * Compress a small, finite SSR response body when the client negotiated a
 * coding, mirroring the family policy: only single-chunk bodies (the common
 * SSR shape) are compressed, so a streaming response is never buffered and an
 * SSE stream is never parked. Returns a Response ready for setResponse - the
 * input Response's body is consumed either way.
 *
 * @param {Response} response
 * @param {string} acceptEncoding - '' suppresses compression (BREACH defense)
 * @returns {Promise<Response>}
 */
async function maybeCompress(response, acceptEncoding) {
	if (!response.body || !acceptEncoding || response.headers.has('content-encoding')) {
		return response;
	}
	const ctRaw = response.headers.get('content-type') || '';
	const semi = ctRaw.indexOf(';');
	const ct = semi === -1 ? ctRaw : ctRaw.slice(0, semi).trimEnd();
	if (!COMPRESSIBLE_TYPES.has(ct)) return response;
	const useBr = acceptsCoding(acceptEncoding, 'br');
	const useGz = !useBr && acceptsCoding(acceptEncoding, 'gzip');
	if (!useBr && !useGz) return response;

	// Read ahead one chunk to see whether this is a single-chunk body. A body
	// that keeps streaming is reassembled around the chunks already read and
	// passed through untouched - compression never buffers an unbounded body.
	const reader = response.body.getReader();
	const first = await reader.read();
	if (first.done) {
		return new Response(null, response);
	}
	// The second read decides single-chunk vs streaming, but it must never
	// WITHHOLD a streaming shell: a page whose next chunk arrives seconds
	// later (a load() streaming a promise) would otherwise ship its first
	// byte only when its second exists. A buffered body settles its second
	// read within a few microtasks; anything parked on real I/O loses the
	// race and streams uncompressed from the first chunk on.
	const STREAMING = Symbol('streaming');
	let microtasks = Promise.resolve();
	for (let i = 0; i < 8; i++) microtasks = microtasks.then(() => {});
	/** @type {Promise<ReadableStreamReadResult<Uint8Array>> | null} */
	let pendingRead = reader.read();
	const second = await Promise.race([pendingRead, microtasks.then(() => STREAMING)]);
	if (second !== STREAMING && !(/** @type {ReadableStreamReadResult<Uint8Array>} */ (second).done)) {
		// Second chunk already exists: replay both and pipe the rest.
		pendingRead = null;
	}
	if (second === STREAMING || pendingRead === null) {
		const secondValue = second === STREAMING
			? null
			: /** @type {ReadableStreamReadResult<Uint8Array>} */ (second).value;
		const replay = new ReadableStream({
			start(controller) {
				controller.enqueue(first.value);
				if (secondValue) controller.enqueue(secondValue);
			},
			async pull(controller) {
				const read = pendingRead ?? reader.read();
				pendingRead = null;
				const { done, value } = await read;
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			}
		});
		return new Response(replay, response);
	}

	let body = first.value;
	if (body.byteLength < COMPRESS_MIN_SIZE) {
		return new Response(body, response);
	}
	const compressed = useBr
		? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
		: gzipSync(body, { level: 6 });
	if (compressed.byteLength >= body.byteLength) {
		return new Response(body, response);
	}
	const headers = new Headers(response.headers);
	headers.set('content-encoding', useBr ? 'br' : 'gzip');
	headers.set('content-length', String(compressed.byteLength));
	headers.append('vary', 'Accept-Encoding');
	return new Response(compressed, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/**
 * Write a Response onto the node response, with the default-nosniff fill and
 * the single-chunk compression pass applied first. The whole write is
 * awaited, so a body that fails mid-stream surfaces here as a throw.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean, responseStarted?: boolean, closedByServer?: boolean }} state
 * @param {string} [acceptEncoding]
 */
async function writeResponse(res, response, state, acceptEncoding) {
	if (state.aborted) {
		// Nothing will consume this body; cancel it so the render's upstream
		// (a fetch response, a DB cursor held by the stream source) is
		// released now instead of at GC.
		await response.body?.cancel().catch(() => {});
		return;
	}
	const finalResponse = await maybeCompress(ensureNosniff(response), acceptEncoding || '');
	if (state.aborted) {
		await finalResponse.body?.cancel().catch(() => {});
		return;
	}
	await streamResponse(res, finalResponse, state);
}

/**
 * Write the response headers. A header the transport refuses (a name or
 * value with characters node will not put on the wire) turns the whole
 * response into a 500 before any byte starts, the same answer Kit's own node
 * writer gives.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @returns {boolean} false when a header was refused and the 500 was written
 */
function writeHeaders(res, response) {
	for (const [key, value] of response.headers) {
		if (key === 'set-cookie') continue;
		try {
			res.setHeader(key, value);
		} catch (error) {
			for (const name of res.getHeaderNames()) res.removeHeader(name);
			res.writeHead(500);
			res.end(String(error));
			return false;
		}
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) res.setHeader('set-cookie', cookies);
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
 * Stream a Response body onto the node response, awaiting the whole write.
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
 */
async function streamResponse(res, response, state) {
	if (!response.body) {
		if (state.aborted) return;
		state.responseStarted = true;
		if (writeHeaders(res, response)) res.end();
		return;
	}
	if (response.body.locked) {
		if (state.aborted) return;
		state.responseStarted = true;
		res.writeHead(500, { 'content-type': 'text/plain' });
		res.end(
			'Fatal error: Response body is locked. ' +
				"This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
		);
		return;
	}
	const reader = response.body.getReader();
	let streaming = false;
	let streamDone = false;
	try {
		if (state.aborted) return;
		state.responseStarted = true;
		if (!writeHeaders(res, response)) return;
		streaming = true;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) { streamDone = true; break; }
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
		// requests so writeResponse() leaves the body uncompressed. HEAD gets
		// the same suppression - node discards the body anyway, so compressing
		// it would be pure event-loop cost an anonymous client can mint.
		const respAcceptEncoding = ((isCredentialedRequest && !COMPRESS_CREDENTIALED) || method === 'HEAD')
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
						respAcceptEncoding
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
						await writeResponse(res, response, state, respAcceptEncoding);
						return;
					}
					const varyHeader = response.headers.get('vary');
					if (varyHeader) {
						const personalized = varyHeader.toLowerCase().split(',').some(
							(p) => { const t = p.trim(); return t !== '' && t !== 'accept-encoding'; }
						);
						if (personalized) {
							resolveShared(null);
							await writeResponse(res, response, state, respAcceptEncoding);
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
						await writeResponse(res, response, state, respAcceptEncoding);
						return;
					}

					// Buffer the body, but only up to the share cap: the cap bounds
					// MEMORY, not just sharing. A body that overruns it was never
					// going to be shared, so the leader stops buffering right there,
					// marks the key non-shareable, and streams the remainder -
					// concurrent unique-URL requests cannot park arbitrarily large
					// bodies in RAM waiting for a size check at the end.
					const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
					/** @type {Uint8Array[]} */
					const chunks = [];
					let buffered = 0;
					let overran = false;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						chunks.push(value);
						buffered += value.byteLength;
						if (buffered > MAX_SSR_DEDUP_BODY) { overran = true; break; }
					}
					if (state.aborted) {
						resolveShared(null);
						await reader.cancel().catch(() => {});
						return;
					}

					if (overran) {
						resolveShared(null);
						const replay = new ReadableStream({
							start(controller) {
								for (const chunk of chunks) controller.enqueue(chunk);
							},
							async pull(controller) {
								const { done, value } = await reader.read();
								if (done) controller.close();
								else controller.enqueue(value);
							},
							cancel(reason) {
								return reader.cancel(reason);
							}
						});
						await writeResponse(
							res,
							new Response(replay, {
								status: response.status,
								statusText: response.statusText,
								headers: response.headers
							}),
							state,
							respAcceptEncoding
						);
						return;
					}

					const body = new Uint8Array(buffered);
					let offset = 0;
					for (const chunk of chunks) {
						body.set(chunk, offset);
						offset += chunk.byteLength;
					}

					resolveShared(/** @type {SharedResponse} */ ({
						status: response.status,
						statusText: response.statusText,
						headers: /** @type {[string, string][]} */ ([...response.headers]),
						body
					}));

					// Serve the leader's own response from the same buffer
					await writeResponse(
						res,
						new Response(body, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers
						}),
						state,
						respAcceptEncoding
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
		await writeResponse(res, response, state, respAcceptEncoding);
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
