// Fixed-shape error responses over node:http. Each guards on headersSent so a
// late failure can never write a second response into an exchange whose first
// byte already left; the caller owns deciding whether that situation is fatal.

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

// Every one of these is length-framed. uWS derives a content-length from the
// body handed to `res.end()`, so leaving it off answers chunked where the
// family answers with a length, and leaves a HEAD reply - whose body node
// strips - carrying no size at all. The bodies here are fixed, so the length
// is exact rather than an estimate.

/** @param {import('node:http').ServerResponse} res */
export function send405(res) {
	if (res.headersSent) return;
	const body = 'Method Not Allowed';
	res.writeHead(405, {
		allow: ALLOW_HEADER,
		'content-type': 'text/plain',
		'content-length': String(Buffer.byteLength(body))
	});
	res.end(body);
}

/** @param {import('node:http').ServerResponse} res */
export function send400(res) {
	if (res.headersSent) return;
	const body = 'Bad Request';
	res.writeHead(400, {
		'content-type': 'text/plain',
		'content-length': String(Buffer.byteLength(body))
	});
	res.end(body);
}

/** @param {import('node:http').ServerResponse} res */
export function send413(res) {
	if (res.headersSent) return;
	const body = 'Content Too Large';
	res.writeHead(413, {
		'content-type': 'text/plain',
		'content-length': String(Buffer.byteLength(body))
	});
	res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} [requestId]
 */
export function send500(res, requestId) {
	if (res.headersSent) return;
	const body = 'Internal Server Error';
	/** @type {Record<string, string>} */
	const headers = {
		'content-type': 'text/plain',
		'content-length': String(Buffer.byteLength(body))
	};
	if (requestId) headers['x-request-id'] = requestId;
	res.writeHead(500, headers);
	res.end(body);
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
 * header block past the limit, 400 otherwise, and a bare destroy for a
 * socket that is already gone.
 *
 * @param {import('node:http').Server} server
 */
export function refuseUnparsedForbiddenMethods(server) {
	// CONNECT parses, but node hands it to the 'connect' event rather than the
	// request listener, and a server with no listener for it drops the socket.
	server.on('connect', (/** @type {any} */ _req, /** @type {import('node:net').Socket} */ socket) => {
		if (socket.writable) socket.end(FORBIDDEN_405_RAW);
		else socket.destroy();
	});
	server.on('clientError', (/** @type {any} */ err, /** @type {import('node:net').Socket} */ socket) => {
		if (!socket.writable || (err && err.code === 'ECONNRESET')) {
			socket.destroy();
			return;
		}
		if (err && err.code === 'HPE_INVALID_METHOD' && Buffer.isBuffer(err.rawPacket)) {
			const line = err.rawPacket.subarray(0, 8).toString('latin1');
			const method = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' ')).toUpperCase();
			if (FORBIDDEN_METHODS.has(method)) {
				socket.end(FORBIDDEN_405_RAW);
				return;
			}
		}
		const status = err && err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
		socket.end('HTTP/1.1 ' + status + '\r\nconnection: close\r\n\r\n');
	});
}
