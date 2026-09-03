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
export const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

// RFC 9110: a 405 response MUST generate an Allow header. These are the
// methods ALLOWED_METHODS carries, which is what this adapter can deliver.
const ALLOW_HEADER = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

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
