// Fixed-shape error responses over node:http. Each guards on headersSent so a
// late failure can never write a second response into an exchange whose first
// byte already left; the caller owns deciding whether that situation is fatal.

import { STATUS_CODES, Server as HttpServer, validateHeaderName, validateHeaderValue } from 'node:http';
import { createRequire } from 'node:module';
import { firstHeaderValue } from '../utils/request-headers.js';
import { setImmediateTimer } from '../runtime.js';

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
 * Throw, as writeHead would, for a status node cannot write - before any
 * header is staged, so the 500 that answers it carries nothing of the
 * Response's, and no header value spelled for the wire meets a string body.
 *
 * @param {number} status
 */
export function assertWritableStatus(status) {
	if (!Number.isInteger(status) || status < 100 || status > 999) {
		throw Object.assign(new RangeError(`Invalid status code: ${status}`), { code: 'ERR_HTTP_INVALID_STATUS_CODE' });
	}
}

/**
 * A header value as the bytes the native tier puts on the wire. uWS writes
 * text as its UTF-8 bytes; node's HTTP/1.1 writer takes one byte per
 * character and refuses one past U+00FF, so a value past ASCII goes to node
 * as its UTF-8 bytes, one character each.
 *
 * @param {string} value
 */
export function wireValue(value) {
	if (!/[^\x00-\x7f]/.test(value)) return value;
	if (!LONE_SURROGATE.test(value)) return Buffer.from(value, 'utf8').toString('latin1');
	// uWS writes a lone surrogate as its three bytes (WTF-8), where
	// Buffer.from would put U+FFFD in its place.
	let out = '';
	for (let i = 0; i < value.length; i++) {
		let c = value.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
			const low = value.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
				i++;
			}
		}
		if (c < 0x80) out += String.fromCharCode(c);
		else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return out;
}

/** A surrogate half without its partner. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * What a header value needs beyond a copy: anything but visible ASCII and
 * tabs. A value without one is valid as it is and reads the same in latin1 and
 * UTF-8, so it skips both the spelling and node's own check.
 */
const NEEDS_SPELLING = /[^\t\x20-\x7e]/;

/**
 * A value that needs more than a copy, spelled and then checked by node.
 *
 * @param {string} name
 * @param {string | number} value
 */
function spelledValue(name, value) {
	const spelled = typeof value === 'string' ? wireValue(value) : value;
	validateHeaderValue(name, spelled);
	return spelled;
}

/**
 * Stage the headers a relayed Response carries, one setHeader at a time,
 * before anything commits the status. node's writeHead commits the status -
 * and, for a 204 or 304, that no body follows - before it validates the
 * headers it is handed, so a value it refuses there would leave the 500 that
 * answers it framed for a body it never gets. Every name and value is
 * checked before the first is set, so a refused one throws with the response
 * untouched and the caller's own failure path writes a clean answer; taking
 * headers back out would change that answer too, since node stops sending
 * Date once `date` is removed and forgets a `connection: close`.
 *
 * Values go out as `wireValue` spells them, so a value past ASCII reaches the
 * wire as its UTF-8 bytes on every lane that relays one.
 *
 * An array of entries is read in place, and a second list is made only for a
 * set that has a value to spell: this runs once per relayed response, and most
 * header sets are short and ASCII.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Iterable<[string, string | string[]]>} entries
 */
export function stageHeaders(res, entries) {
	const list = Array.isArray(entries) ? entries : [...entries];
	/** @type {Array<string | number | Array<string | number>> | null} */
	let spelled = null;
	for (let i = 0; i < list.length; i++) {
		const name = list[i][0];
		const value = list[i][1];
		validateHeaderName(name);
		let out = value;
		if (Array.isArray(value)) {
			for (let j = 0; j < value.length; j++) {
				const one = value[j];
				if (typeof one === 'string' && !NEEDS_SPELLING.test(one)) continue;
				if (out === value) out = value.slice();
				out[j] = spelledValue(name, one);
			}
		} else if (typeof value !== 'string' || NEEDS_SPELLING.test(value)) {
			out = spelledValue(name, value);
		}
		if (out !== value) {
			if (spelled === null) spelled = list.map((entry) => entry[1]);
			spelled[i] = out;
		}
	}
	for (let i = 0; i < list.length; i++) res.setHeader(list[i][0], spelled === null ? list[i][1] : spelled[i]);
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

/**
 * Whether the family's native tier reads this request line. It takes a
 * method, a space, a target that starts with `/`, a space and exactly
 * `HTTP/1.1`, and answers any other line 505 and closes, before the method,
 * the headers or the route count: HTTP/1.0, which nginx before 1.29.7 sends
 * by default, a line with no version, `HTTP/2.0` sent as text, `OPTIONS *`, a
 * target in absolute form. node parses those into a request; send505 answers
 * it, and refusedRequestLine reads the lines node's parser refuses itself.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function acceptsRequestLine(req) {
	return req.httpVersion === '1.1' && typeof req.url === 'string' && req.url.charCodeAt(0) === 47;
}

/**
 * The 505 for a request line the native tier does not read, see
 * acceptsRequestLine. The connection ends with it, as on the native tier.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function send505(res) {
	if (res.headersSent) return;
	endText(res, 505, { 'content-type': 'text/plain', connection: 'close' }, 'HTTP Version Not Supported');
}

/**
 * Whether an HTTP/1.1 request names no Host, which the native tier refuses
 * 400 as it reads the headers. The servers are built with
 * `requireHostHeader: false`, so such a request reaches the listener and the
 * connection's line rather than node's own 400, which never waits its turn.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function missesHost(req) {
	return req.headers.host === undefined && req.httpVersion === '1.1';
}

// The requests of one connection in the order it carried them, on the socket,
// and on each response handed out, the line it belongs to.
const LINE = Symbol('svelte-adapter-ws.pipeline');

// What a line keeps of an answer once it has finished, in place of the
// response, so an idle connection holds no response alive.
const FINISHED = Object.freeze({ writableEnded: true, _last: false });
const FINISHED_CLOSING = Object.freeze({ writableEnded: true, _last: true });

// On a response, true while the request it answers is in its own turn: the
// handler and the ticks and microtasks it queued, see servePipelined.
const TURN = Symbol('svelte-adapter-ws.turn');

/**
 * @typedef {{ req: import('node:http').IncomingMessage | null, res: import('node:http').ServerResponse | null, serve: (req: any, res: any) => void }} Waiting
 * @typedef {{ ahead: any, waiting: Waiting[], serve: (req: any, res: any) => void, scheduled: boolean }} Line
 */

/**
 * Hand each request to `serve` in the order its connection carried it, as
 * the family's native tier serves pipelined requests. It reads the next
 * request only once the one ahead has been handed to the application and the
 * ticks and microtasks that queued have run. If the answer ahead is still
 * waiting then, it closes the connection and neither request gets a byte it
 * did not already have; RFC 9112 9.3.2 has a client retry what a closed
 * connection left unanswered. It reads nothing behind an answer that ends the
 * connection, a 505 or a refusal that closes it. node parses on
 * and queues each response behind the last, so a request with an answer
 * ahead still open is decided once the turn is over, by `setImmediate`; one
 * with nothing ahead, or an answer ahead that has ended, is served at once.
 *
 * A request held here or dropped is not handed to `serve`, so nothing counts
 * it: node never ends a response it queued when the connection goes.
 *
 * The turn a request is handed out in is the native tier's cork: what a
 * handler writes in it leaves when the turn ends, and a connection closed in
 * it drops those bytes. The socket is corked for the turn and uncorked by the
 * `setImmediate` that ends it; inOwnTurn tells a writer which case it is in.
 * node flushes a response that ends in its turn at once, as a complete answer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} serve
 */
export function servePipelined(req, res, serve) {
	const socket = /** @type {any} */ (req.socket);
	/** @type {Line} */
	let line = socket[LINE];
	if (line === undefined) {
		line = { ahead: null, waiting: [], serve, scheduled: false };
		socket[LINE] = line;
	}
	const ahead = line.ahead;
	if (line.waiting.length === 0 && (ahead === null || ahead.writableEnded)) {
		if (ahead !== null && ahead._last) return;
		handOut(line, res);
		serve(req, res);
		return;
	}
	line.waiting.push({ req, res, serve: line.serve });
	if (!line.scheduled) nextInLine(socket, line);
}

/**
 * @param {Line} line
 * @param {import('node:http').ServerResponse} res
 */
function handOut(line, res) {
	line.ahead = res;
	/** @type {any} */ (res)[LINE] = line;
	/** @type {any} */ (res)[TURN] = true;
	res.on('finish', aheadFinished);
	// A response queued behind one node is still writing has no socket yet;
	// node holds its output itself until the one ahead has finished.
	const socket = res.socket;
	if (socket !== null) socket.cork();
	setImmediateTimer(turnEnded, res, socket);
}

/**
 * @param {any} res
 * @param {import('node:net').Socket | null} socket
 */
function turnEnded(res, socket) {
	res[TURN] = false;
	if (socket !== null && !socket.destroyed) socket.uncork();
}

/**
 * Whether the request this response answers is still in its own turn, so
 * the bytes written for it so far are held in the socket's cork and a close
 * now drops them, as the native tier's does.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function inOwnTurn(res) {
	return /** @type {any} */ (res)[TURN] === true;
}

/** @this {any} */
function aheadFinished() {
	const line = this[LINE];
	if (line.ahead === this) line.ahead = this._last ? FINISHED_CLOSING : FINISHED;
}

/**
 * @param {any} socket
 * @param {Line} line
 */
function nextInLine(socket, line) {
	line.scheduled = true;
	setImmediateTimer(() => {
		line.scheduled = false;
		const ahead = line.ahead;
		const next = line.waiting[0];
		if (socket.destroyed || next === undefined) {
			line.waiting.length = 0;
			return;
		}
		if (ahead !== null && !ahead.writableEnded) {
			line.waiting.length = 0;
			if (next.req === null) socket.destroy();
			else closeBehindWaitingAnswer(next.req);
			return;
		}
		if (ahead !== null && ahead._last) {
			line.waiting.length = 0;
			return;
		}
		line.waiting.shift();
		if (next.res !== null) handOut(line, next.res);
		next.serve(next.req, next.res);
		if (line.waiting.length > 0) nextInLine(socket, line);
	});
}

/**
 * Whether a handshake is refused before it is taken: the answer ahead of it
 * ends the connection, and nothing behind it is read. Any other handshake is
 * taken and waits its turn in the upgrade listener, see upgradeTurn.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function behindClosingAnswer(req) {
	/** @type {Line | undefined} */
	const line = /** @type {any} */ (req.socket)?.[LINE];
	if (line === undefined) return false;
	return line.waiting.length === 0 && line.ahead !== null && line.ahead.writableEnded && line.ahead._last === true;
}

/**
 * For the upgrade listener: null when a handshake can go ahead at once, or a
 * promise of whether it may. The native tier reads a handshake only in its
 * connection's order, once the request ahead has been handed over and its turn
 * has run, and closes the connection if that answer is still waiting then; the
 * handshake waits in the line for the same decision. It then waits for node to
 * write every HTTP answer still queued on the connection, so the 101 follows
 * them on the wire. False when the connection closed meanwhile.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @returns {Promise<boolean> | null}
 */
export function upgradeTurn(req, socket) {
	/** @type {Line | undefined} */
	const line = /** @type {any} */ (socket)[LINE];
	const inLine = line !== undefined && (line.waiting.length > 0 || (line.ahead !== null && !line.ahead.writableEnded));
	if (!inLine && /** @type {any} */ (socket)._httpMessage == null) return null;
	return new Promise((resolve) => {
		socket.once('close', () => resolve(false));
		const written = () => afterHttpAnswers(socket, resolve);
		if (!inLine) {
			written();
			return;
		}
		/** @type {Line} */ (line).waiting.push({ req, res: null, serve: written });
		if (!(/** @type {Line} */ (line).scheduled)) nextInLine(socket, /** @type {Line} */ (line));
	});
}

/**
 * @param {any} socket
 * @param {(ok: boolean) => void} resolve
 */
function afterHttpAnswers(socket, resolve) {
	const holder = socket._httpMessage;
	if (holder == null) {
		resolve(true);
		return;
	}
	// node hands the socket to the next queued answer as this one finishes.
	holder.once('finish', () => afterHttpAnswers(socket, resolve));
}

/**
 * For bytes node's parser refused after a request that closes the
 * connection: the native tier reads them as the next request once that one has
 * been handed over and its turn has run, and closes the connection unanswered
 * if its answer is still waiting then. False when the connection has no line
 * to wait in.
 *
 * @param {any} socket
 */
function closeAfterLastTurn(socket) {
	/** @type {Line | undefined} */
	const line = socket[LINE];
	if (line === undefined || (line.waiting.length === 0 && (line.ahead === null || line.ahead.writableEnded))) return false;
	line.waiting.push({ req: null, res: null, serve: () => {} });
	if (!line.scheduled) nextInLine(socket, line);
	return true;
}

/**
 * Close a connection on which a request was parsed while an earlier one is
 * still waiting for its answer, as the family's native tier does: neither gets
 * a byte, and the waiting one sees its client go. A request line the native
 * tier does not read gets its 505 first, and an HTTP/1.1 request without a
 * Host its 400, which the native tier writes as soon as it reads them.
 *
 * @param {import('node:http').IncomingMessage} req
 */
function closeBehindWaitingAnswer(req) {
	const socket = req.socket;
	const head = req.method === 'HEAD';
	const refusal = !acceptsRequestLine(req)
		? (head ? VERSION_505_HEAD_RAW : VERSION_505_RAW)
		: missesHost(req) ? (head ? BAD_TARGET_400_HEAD_RAW : BAD_TARGET_400_RAW) : null;
	if (refusal === null || !socket.writable) {
		socket.destroy();
		return;
	}
	socket.end(refusal, () => socket.destroy());
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

// The runtime's own 400, as send400 writes it, for a target node's parser
// refuses: the bytes after it can no longer be read, so it also closes. A HEAD
// gets the head alone, the length included.
const BAD_TARGET_400_HEAD_RAW =
	'HTTP/1.1 400 Bad Request\r\n' +
	'content-type: text/plain\r\n' +
	'content-length: 11\r\n' +
	'connection: close\r\n' +
	'\r\n';
const BAD_TARGET_400_RAW = BAD_TARGET_400_HEAD_RAW + 'Bad Request';

// send505 as raw bytes, for the requests node never hands the request
// listener. A HEAD gets the head alone, the length included.
const VERSION_505_HEAD_RAW =
	'HTTP/1.1 505 HTTP Version Not Supported\r\n' +
	'content-type: text/plain\r\n' +
	'content-length: 26\r\n' +
	'connection: close\r\n' +
	'\r\n';
const VERSION_505_RAW = VERSION_505_HEAD_RAW + 'HTTP Version Not Supported';

/**
 * Where node's parser refused a request whose line the native tier answers
 * 505 whatever else is wrong with it, see refusedRequestLine: the offset of
 * that line in the refused packet, or -1. The line is read only in the
 * connection's first read, which starts with the connection's first request
 * line, past the empty lines the native tier reads over; a later read can
 * begin inside a request, and node's answer stands. A request refused behind
 * another in that read leaves the first one's line to answer for: a line the
 * native tier reads keeps node's answer, and one it does not was answered 505
 * and ended the connection before this one was read.
 *
 * @param {any} err
 * @param {any} socket
 */
function refusedFirstLine(err, socket) {
	const packet = err?.rawPacket;
	if (!Buffer.isBuffer(packet) || socket.bytesRead !== packet.length) return -1;
	const at = firstLineAt(packet);
	return refusedRequestLine(packet, at) ? at : -1;
}

/**
 * Where a connection's first request line starts: past the CRLF pairs the
 * native tier reads over in front of it. A bare LF, or a CR followed by
 * anything but LF, is the line's first byte, and refusedRequestLine reads it
 * as a method ended before any space.
 *
 * @param {Buffer} packet
 */
function firstLineAt(packet) {
	let at = 0;
	while (at + 1 < packet.length && packet[at] === 13 && packet[at + 1] === 10) at += 2;
	return at;
}

/**
 * Whether the request line at `at` is one the native tier refuses 505, as
 * far as its bytes go. The native tier ends the method at the first byte that
 * is a control character, a space or outside ASCII, and the target at the
 * first control character or space; it then needs a space, a target starting
 * with `/`, a space, and exactly `HTTP/1.1` and CRLF, and refuses as soon
 * as the bytes so far cannot become that: `GET / HTTP/1.0` is refused before
 * its line has ended, and so is a tab inside the method or the target. A line
 * that starts with a space has an empty method, which the native tier hands
 * on; node's parser refuses it, and that answer stands.
 *
 * @param {Buffer} packet
 * @param {number} at
 */
function refusedRequestLine(packet, at) {
	const length = packet.length;
	let i = at;
	while (i < length && packet[i] > 32 && packet[i] < 128) i++;
	if (i === length) return false;
	if (i === at) {
		if (packet[i] === 32) return false;
		// A lone CR may still become an empty line; firstLineAt read every
		// pair, so one followed by any byte is the method's end.
		if (packet[i] === 13) return i + 1 < length;
		return true;
	}
	if (packet[i] !== 32) return true;
	i++;
	if (i === length) return false;
	if (packet[i] !== 47) return true;
	while (i < length && packet[i] > 32) i++;
	if (i === length) return false;
	if (packet[i] !== 32) return true;
	const end = packet.indexOf(10, i);
	const version = packet.toString('latin1', i + 1, end === -1 ? length : end + 1);
	return end === -1 ? !'HTTP/1.1\r\n'.startsWith(version) : version !== 'HTTP/1.1\r\n';
}

/**
 * Answer the forbidden methods node never hands to the request listener.
 * llhttp knows TRACE, so it reaches the method gate above; CONNECT is routed
 * to the 'connect' event instead, and TRACK is not a method llhttp
 * recognises, so the parser fails the request and node's default
 * `clientError` handling answers 400 and closes.
 * The family answers the three fetch-forbidden methods alike, 405 with
 * Allow, so the raw request line is read off the failed packet and answered
 * that way. A request target with a byte outside visible ASCII, which
 * RFC 9112 does not allow and node's parser refuses before any listener runs,
 * gets the 400 every lane writes for a target it refuses, body included, or
 * for a HEAD its length alone. Ahead of both, a request line the native tier
 * does not read gets the 505 the request listener writes for one, as the
 * native tier answers the line before anything else; a CONNECT gets it too
 * unless its target is in origin form and its version HTTP/1.1. A CONNECT
 * reads like any request in its connection's line: behind an answer that
 * ends the connection it is dropped unanswered, behind one still waiting it
 * waits its turn and the line closes the connection if that answer is still
 * waiting then, and otherwise it is answered once every answer ahead of it
 * is on the wire.
 * Every other parser failure keeps node's own answer: 431 for a
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
	server.on('connect', (/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:net').Socket} */ socket) => {
		if (!socket.writable) {
			socket.destroy();
			return;
		}
		// Behind an answer that ends the connection, node has ended the socket
		// by the time its turn comes, and nothing is written.
		const answer = () => {
			if (socket.writable) answerAndClose(socket, acceptsRequestLine(req) ? FORBIDDEN_405_RAW : VERSION_505_RAW);
			else socket.destroy();
		};
		const turn = upgradeTurn(req, socket);
		if (turn === null) answer();
		else turn.then((ok) => { if (ok) answer(); else socket.destroy(); });
	});
	server.on('clientError', (/** @type {any} */ err, /** @type {import('node:net').Socket} */ socket) => {
		// A response already on its way (a pipelined bad request behind a
		// streaming reply) gets no second status line written into its body;
		// the socket is destroyed as node would destroy it.
		// Bytes after a request that closes the connection: the native tier
		// reads them as the next request once that one has been handed over
		// and its turn has run, and closes the connection unanswered if its
		// answer is still waiting then. An answer done by then goes out, and
		// node ends the connection after it.
		if (err && err.code === 'HPE_CLOSED_CONNECTION' && socket.writable && closeAfterLastTurn(socket)) return;
		const inFlight = /** @type {any} */ (socket)._httpMessage;
		if (!socket.writable || (err && err.code === 'ECONNRESET') || (inFlight && inFlight._headerSent)) {
			socket.destroy(err);
			return;
		}
		// The request line first, as on the native tier: an HTTP/1.0 TRACK or
		// bad target is a 505.
		const refusedAt = refusedFirstLine(err, socket);
		if (refusedAt !== -1) {
			answerAndClose(socket, err.rawPacket.toString('latin1', refusedAt, refusedAt + 5) === 'HEAD ' ? VERSION_505_HEAD_RAW : VERSION_505_RAW);
			return;
		}
		if (err && err.code === 'HPE_INVALID_METHOD' && Buffer.isBuffer(err.rawPacket)) {
			const at = firstLineAt(err.rawPacket);
			const line = err.rawPacket.subarray(at, at + 8).toString('latin1');
			const method = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' ')).toUpperCase();
			if (FORBIDDEN_METHODS.has(method)) {
				answerAndClose(socket, FORBIDDEN_405_RAW);
				return;
			}
		}
		const code = err && err.code;
		if (code === 'HPE_INVALID_URL') {
			const headOnly = Buffer.isBuffer(err.rawPacket) && err.rawPacket.subarray(firstLineAt(err.rawPacket)).subarray(0, 5).toString('latin1') === 'HEAD ';
			answerAndClose(socket, headOnly ? BAD_TARGET_400_HEAD_RAW : BAD_TARGET_400_RAW);
			return;
		}
		const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
			: code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout'
				: code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW' ? '413 Content Too Large'
					: '400 Bad Request';
		answerAndClose(socket, 'HTTP/1.1 ' + status + '\r\nconnection: close\r\n\r\n');
	});
}

/**
 * Whether a request is the WebSocket route's, and so the 'upgrade' listener's:
 * an HTTP/1.1 GET on the WebSocket path as spelled, whose first
 * Sec-WebSocket-Key line is 24 bytes long. That is what the family's native
 * tier routes to its handshake. Everything else asking to upgrade is an
 * ordinary request for the HTTP routes, which answer it as they would without
 * the upgrade headers: an upgrade to another protocol, a handshake on another
 * path, with another method or in another version, which gets the 505, and an
 * attempt with a key of any other length, which the GET answer on the
 * WebSocket path refuses 400. A handshake behind a request still waiting in
 * its connection's line, or behind an answer that ends the connection, is not
 * taken: it goes through the line like any request, see servePipelined.
 *
 * node asks this only of a request that names `Connection: upgrade` and
 * carries an Upgrade header.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} wsPath
 */
export function takesWebSocketRoute(req, wsPath) {
	if (req.method !== 'GET' || !acceptsRequestLine(req) || behindClosingAnswer(req)) return false;
	const url = req.url || '/';
	const q = url.indexOf('?');
	return (q === -1 ? url : url.slice(0, q)) === wsPath &&
		firstHeaderValue(req.rawHeaders, 'sec-websocket-key').length === 24;
}

/**
 * Route upgrades by `shouldUpgradeCallback` on a node that ignores the option
 * (before 22.21 and 24.9). Such a node takes every request that names
 * `Connection: upgrade` and carries an Upgrade header as an upgrade while an
 * 'upgrade' listener is attached, so the listener got a declined request on
 * any path and with any method, its body unread; with no listener it never
 * asks the callback, so nothing resumes past a declined request. node decides
 * in the parser's `onIncoming`, which it binds per connection, so each
 * connection's is wrapped to ask the callback first: a declined request is
 * parsed as an ordinary one, as a newer node parses it. A request the callback
 * takes is left to node's own check, which both callers pass by attaching an
 * 'upgrade' listener whenever theirs can take one. A server that took the
 * option is left alone.
 *
 * @param {import('node:http').Server | import('node:https').Server} server
 * @param {(req: import('node:http').IncomingMessage) => boolean} shouldUpgradeCallback
 */
export function applyShouldUpgradeCallback(server, shouldUpgradeCallback) {
	if (/** @type {any} */ (server).shouldUpgradeCallback === shouldUpgradeCallback) return;
	// After node's own listener, which the server attached when it was built:
	// an https server is no http.Server, and listens on 'secureConnection'.
	server.on(server instanceof HttpServer ? 'connection' : 'secureConnection', (/** @type {any} */ socket) => {
		const parser = socket.parser;
		const onIncoming = parser?.onIncoming;
		if (typeof onIncoming !== 'function') return;
		// `upgrade` is node's own field on the request, which its types leave out.
		parser.onIncoming = (/** @type {any} */ req, /** @type {boolean} */ keepAlive) => {
			if (req.upgrade && req.method !== 'CONNECT' && !shouldUpgradeCallback(req)) req.upgrade = false;
			return onIncoming(req, keepAlive);
		};
	});
}

// node's HTTP parser binding, for resumeAfterDeclinedUpgrade. Where a node
// does not have it in this shape the function does nothing.
const HTTPParser = (() => {
	try {
		return createRequire(import.meta.url)('_http_common').HTTPParser;
	} catch {
		return undefined;
	}
})();
const kOnExecute = typeof HTTPParser?.kOnExecute === 'number' ? HTTPParser.kOnExecute : -1;
const nodeExecute = HTTPParser?.prototype?.execute;
// On the socket, which node never pools. Registered, so that every copy of
// this module in a process reads the same slot.
const DECLINED = Symbol.for('svelte-adapter-ws.declinedUpgrade');
const noop = () => {};
/** @this {any} */
function restartReads() {
	if (this._handle && !this._handle.reading) {
		this._handle.reading = true;
		this._handle.readStart();
	}
}

/**
 * Keep parsing past a request whose upgrade shouldUpgradeCallback declined.
 * node's parser stops a read at the end of a request that names an upgrade -
 * the end of its body, which can arrive in a later read than its headers - and
 * hands the rest of that read on only when the request was upgraded. So a
 * request pipelined behind a declined one was dropped, never answered, and the
 * connection idled until it timed out. The family's native tier answers it.
 * Call this from shouldUpgradeCallback when it declines.
 *
 * Both servers read on node's consumed path, where a read never reaches JS: a
 * hook on the parser waits for the read in which the declined request ends,
 * moves the connection to node's JS read path and unshifts the rest of that
 * read onto the socket, so every later byte queues behind it. Over TLS one
 * read can carry several records, and on the consumed path node hands each to
 * the parser even while it has paused the connection; on the JS read path
 * they wait in the socket. There `parser.execute` resumes after each further
 * declined request in place. A connection that never declines an upgrade is
 * not touched.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function resumeAfterDeclinedUpgrade(req) {
	const socket = /** @type {any} */ (req.socket);
	const parser = socket?.parser;
	if (!parser || kOnExecute < 0 || typeof nodeExecute !== 'function') return;
	socket[DECLINED] = req;
	if (!parser._consumed) {
		// On the JS read path the wrapper resumes in place. Where something
		// else moved the connection there, this read is still in node's own
		// execute and the wrapper takes over from the next one.
		wrapExecute(socket, parser);
		return;
	}
	const onExecute = parser[kOnExecute];
	if (typeof onExecute !== 'function') return;
	const hook = (/** @type {unknown} */ ret) => {
		const declined = socket[DECLINED];
		// Its body is still arriving: node stops at its end in a later read.
		if (declined && !declined.complete) return onExecute(ret);
		parser[kOnExecute] = onExecute;
		socket[DECLINED] = undefined;
		// A read that ended on an upgrade node took is node's to hand on.
		if (declined && typeof ret === 'number' && !parser.incoming?.upgrade) {
			const read = parser.getCurrentBuffer();
			if (ret < read.length) {
				// A 'data' listener is node's own switch to the JS read path. It
				// drops the 'resume' listener that restarts a consumed
				// connection's reads, which node stops while it pauses one, so
				// a paused connection restarts them here when node resumes it.
				socket.on('data', noop);
				socket.removeListener('data', noop);
				if (!socket._handle?.reading) socket.once('resume', restartReads);
				wrapExecute(socket, parser);
				socket.unshift(read.subarray(ret));
			}
		}
		return onExecute(ret);
	};
	parser[kOnExecute] = hook;
}

/**
 * node's execute on the JS read path, resuming where a declined request ends.
 * It reads its state from the parser's socket, so it is right for whichever
 * connection holds the parser.
 *
 * @this {any}
 * @param {Buffer} data
 */
function executeAfterDeclines(data) {
	const socket = this.socket;
	let offset = 0;
	/** @type {unknown} */
	let result;
	for (;;) {
		const before = socket?.[DECLINED];
		const pending = before !== undefined && !before.complete;
		const ret = nodeExecute.call(this, offset === 0 ? data : data.subarray(offset));
		if (typeof ret !== 'number') { result = ret; break; }
		offset += ret;
		result = offset;
		// Only a declined request that ended in this pass stopped it early.
		const declined = socket?.[DECLINED];
		if (!declined?.complete || (declined === before && !pending)) break;
		socket[DECLINED] = undefined;
		if (offset >= data.length) break;
	}
	// node frees a parser that took an upgrade into its pool right after this.
	if (this.incoming?.upgrade) delete this.execute;
	return result;
}

/**
 * @param {any} socket
 * @param {any} parser
 */
function wrapExecute(socket, parser) {
	if (Object.hasOwn(parser, 'execute')) return;
	parser.execute = executeAfterDeclines;
	// node pools its parsers; this one goes back without the wrapper unless
	// another connection already holds it.
	socket.once('close', () => {
		if (!parser.socket || parser.socket === socket) delete parser.execute;
	});
}
