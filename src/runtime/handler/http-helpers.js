// Fixed-shape error responses over node:http. Each guards on headersSent so a
// late failure can never write a second response into an exchange whose first
// byte already left; the caller owns deciding whether that situation is fatal.

import { STATUS_CODES } from 'node:http';

// The methods this adapter can deliver to a route. Node's parser only accepts
// registered methods, so the gate here is about the three the fetch spec
// forbids (`new Request()` throws a TypeError for them - surfaced as a
// generic 500 and an error-log line per request, which made probing TRACE a
// one-line way to fill an operator's error log). They can never reach an
// application route, so they are refused at the edge with the status the RFC
// requires.
export class PayloadTooLargeError extends Error {
	constructor() { super('Payload too large'); }
}

export const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

// RFC 9110: a 405 response MUST generate an Allow header. These are the
// methods ALLOWED_METHODS carries, which is what this adapter can deliver.
export const ALLOW_HEADER = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Finish a generated response whose payload is a fixed text, length-framed.
 * uWS derives a content-length from the body handed to `res.end()`, while node
 * frames a `writeHead()` that names no length as chunked, so the length is
 * written here. A HEAD needs nothing more: node drops the payload of a HEAD
 * itself, and the header still names the size the GET would carry.
 *
 * The reason phrase is set here rather than left to node. A writeHead that
 * threw on a header node refuses has already set `statusMessage`, which a
 * later writeHead keeps, so the 500 that follows it would read `500 OK`; and
 * node still spells 413 by its pre-RFC 9110 name, where the family writes
 * `Content Too Large`. writeHead keeps a `statusMessage` it finds set.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string} text
 */
export function endText(res, status, headers, text) {
	res.statusMessage = status === 413 ? 'Content Too Large' : STATUS_CODES[status] || '';
	res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(text)) });
	res.end(text);
}

/**
 * Stage the headers a relayed Response carries, one setHeader at a time,
 * before anything commits the status. node's writeHead commits the status -
 * and, for a 204 or 304, that no body follows - before it validates the
 * headers it is handed, so a value it refuses there would leave the 500 that
 * answers it framed for a body it never gets; setHeader refuses the same
 * values without touching either. A refused header clears whatever was
 * staged and rethrows, so the caller's own failure path writes a clean answer.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Iterable<[string, string | string[]]>} entries
 */
export function stageHeaders(res, entries) {
	try {
		for (const [name, value] of entries) res.setHeader(name, value);
	} catch (err) {
		for (const name of res.getHeaderNames()) res.removeHeader(name);
		throw err;
	}
}

/**
 * The Content-Length a response that carries no content reports, or null for
 * none. A 204 never reports one: RFC 9110 8.6 forbids Content-Length there. A
 * 304 reports one only when the app declared it, because the header is
 * permitted on a 304 only when it names the length of the 200's content, and
 * a zero on a 304 for a rendered page is never that. A HEAD is the same case:
 * the header may only name the GET's content length, and the Response carries
 * that only when whoever built it declared it - SvelteKit does for a rendered
 * page, an app answering HEAD itself does by hand - so a HEAD reports the
 * declared length or none. Every other bodyless response names zero, whatever
 * it declared: a length with no bytes behind it would leave the client
 * waiting for them.
 *
 * node writes whatever length it is handed, a 204 included, and frames a
 * GET that names none as chunked, so every writer of a bodyless answer asks
 * here rather than passing the Response's own header through.
 *
 * @param {number} status
 * @param {string | null | undefined} declaredLength the response's own
 *   Content-Length header, when it carries one
 * @param {boolean} headOnly the request was a HEAD
 * @returns {number | null}
 */
export function bodylessLength(status, declaredLength, headOnly) {
	if (status === 204) return null;
	if (status === 304 || headOnly) {
		if (!declaredLength) return null;
		const length = parseInt(declaredLength, 10);
		return length >= 0 ? length : null;
	}
	return 0;
}

// Every one of these is length-framed through endText. The bodies are fixed,
// so the length is exact rather than an estimate.

/** @param {import('node:http').ServerResponse} res */
export function send405(res) {
	if (res.headersSent) return;
	endText(res, 405, { allow: ALLOW_HEADER, 'content-type': 'text/plain' }, 'Method Not Allowed');
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} [closeConnection] end the TCP connection with the response,
 *   for a refusal that leaves the connection's remaining bytes untrustworthy;
 *   node writes `connection: close` and closes once the answer is flushed
 */
export function send400(res, closeConnection = false) {
	if (res.headersSent) return;
	endText(res, 400, closeConnection
		? { 'content-type': 'text/plain', connection: 'close' }
		: { 'content-type': 'text/plain' }, 'Bad Request');
}

/** @param {import('node:http').ServerResponse} res */
export function send413(res) {
	if (res.headersSent) return;
	endText(res, 413, { 'content-type': 'text/plain' }, 'Content Too Large');
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} [requestId]
 */
export function send500(res, requestId) {
	if (res.headersSent) return;
	/** @type {Record<string, string>} */
	const headers = { 'content-type': 'text/plain' };
	if (requestId) headers['x-request-id'] = requestId;
	endText(res, 500, headers, 'Internal Server Error');
}

const FORBIDDEN_405_RAW =
	'HTTP/1.1 405 Method Not Allowed\r\n' +
	'allow: ' + ALLOW_HEADER + '\r\n' +
	'content-type: text/plain\r\n' +
	'content-length: 18\r\n' +
	'connection: close\r\n' +
	'\r\n' +
	'Method Not Allowed';

/**
 * Answer the forbidden methods node never hands to the request listener.
 * llhttp knows TRACE, so it reaches the method gate above; CONNECT is routed
 * to the 'connect' event instead, and TRACK is not a method llhttp
 * recognises, so the parser fails the request and node's default
 * `clientError` handling answers 400 and closes.
 * The family answers the three fetch-forbidden methods alike, 405 with
 * Allow, so the raw request line is read off the failed packet and answered
 * that way. Every other parser failure keeps node's own answer: 431 for a
 * header block past the limit, 408 for a request that timed out, 413 for
 * chunk extensions past the limit, 400 otherwise, written only when no
 * response is in flight on the socket, and a bare destroy for a socket that
 * is already gone.
 *
 * Every branch ends by destroying the socket once its answer is flushed. By
 * the time node emits either event it has detached the socket from HTTP
 * handling: no timeout, no parser, no place in the server's connection list.
 * A socket merely ended here would wait for the peer to close it, and a peer
 * that never does would hold it for the life of the process, out of reach of
 * closeAllConnections.
 *
 * @param {import('node:http').Server} server
 */
export function refuseUnparsedForbiddenMethods(server) {
	/**
	 * @param {import('node:net').Socket} socket
	 * @param {string} raw
	 */
	const answerAndClose = (socket, raw) => {
		socket.end(raw, () => socket.destroy());
	};
	// CONNECT parses, but node hands it to the 'connect' event rather than the
	// request listener, and a server with no listener for it drops the socket.
	server.on('connect', (/** @type {any} */ _req, /** @type {import('node:net').Socket} */ socket) => {
		if (socket.writable) answerAndClose(socket, FORBIDDEN_405_RAW);
		else socket.destroy();
	});
	server.on('clientError', (/** @type {any} */ err, /** @type {import('node:net').Socket} */ socket) => {
		// A response already on its way (a pipelined bad request behind a
		// streaming reply) gets no second status line written into its body;
		// the socket is destroyed as node would destroy it.
		const inFlight = /** @type {any} */ (socket)._httpMessage;
		if (!socket.writable || (err && err.code === 'ECONNRESET') || (inFlight && inFlight._headerSent)) {
			socket.destroy(err);
			return;
		}
		if (err && err.code === 'HPE_INVALID_METHOD' && Buffer.isBuffer(err.rawPacket)) {
			const line = err.rawPacket.subarray(0, 8).toString('latin1');
			const method = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' ')).toUpperCase();
			if (FORBIDDEN_METHODS.has(method)) {
				answerAndClose(socket, FORBIDDEN_405_RAW);
				return;
			}
		}
		const code = err && err.code;
		const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
			: code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout'
				: code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW' ? '413 Content Too Large'
					: '400 Bad Request';
		answerAndClose(socket, 'HTTP/1.1 ' + status + '\r\nconnection: close\r\n\r\n');
	});
}
