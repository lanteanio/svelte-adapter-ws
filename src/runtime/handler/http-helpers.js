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

/** @param {import('node:http').ServerResponse} res */
export function send405(res) {
	if (res.headersSent) return;
	res.writeHead(405, { allow: ALLOW_HEADER, 'content-type': 'text/plain' });
	res.end('Method Not Allowed');
}

/** @param {import('node:http').ServerResponse} res */
export function send400(res) {
	if (res.headersSent) return;
	res.writeHead(400, { 'content-type': 'text/plain' });
	res.end('Bad Request');
}

/** @param {import('node:http').ServerResponse} res */
export function send413(res) {
	if (res.headersSent) return;
	res.writeHead(413, { 'content-type': 'text/plain' });
	res.end('Content Too Large');
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
	res.writeHead(500, headers);
	res.end('Internal Server Error');
}
