import { firstHeaderValue } from '../utils/request-headers.js';

// Set only for heads that carried non-ASCII bytes. The native WebSocket router
// counts key bytes before its JavaScript binding decodes the header string.
const KEY_BYTES = Symbol('svelte-adapter-ws.header-key-bytes');
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Decode node's byte strings as the native binding does. Call once before
 * handing the parsed request to routing or application code. Keep the raw key
 * byte count for the native route gate, independently of its decoded length.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function decodeRequestHeaders(req) {
	const raw = req.rawHeaders;
	if (raw[KEY_BYTES] !== undefined) return;
	let changed = false;
	for (let i = 1; i < raw.length; i += 2) {
		if (!NON_ASCII.test(raw[i])) continue;
		if (!changed) {
			Object.defineProperty(raw, KEY_BYTES, { value: firstHeaderValue(raw, 'sec-websocket-key').length });
			changed = true;
		}
		raw[i] = Buffer.from(raw[i], 'latin1').toString('utf8');
	}
	if (changed) {
		// IncomingMessage caches these lazy views; reset either view if node or
		// an earlier parser callback has already materialized it.
		req.headers = /** @type {any} */ (null);
		req.headersDistinct = /** @type {any} */ (null);
	}
}

/** @param {string[]} rawHeaders */
export function webSocketKeyByteLength(rawHeaders) {
	return rawHeaders[KEY_BYTES] ?? firstHeaderValue(rawHeaders, 'sec-websocket-key').length;
}
