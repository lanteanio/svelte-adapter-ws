// Fixed-shape error responses over node:http. Each guards on headersSent so a
// late failure can never write a second response into an exchange whose first
// byte already left; the caller owns deciding whether that situation is fatal.

import { STATUS_CODES, Server as HttpServer, validateHeaderName, validateHeaderValue } from 'node:http';
import { createRequire } from 'node:module';
import { isNativeError } from 'node:util/types';
import { webSocketKeyByteLength } from './header-values.js';
import { registerClosingResponse } from './request-close.js';
import { clearTimer, setImmediateTimer, setTimer } from '../runtime.js';
import { httpReadHeld, releaseHttpReadIfFull, endParserRefusal, httpCallbackCheckpoint } from './read-turn.js';

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
	releaseHttpReadIfFull(res);
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
 * A network-error Response has status 0, which cannot be written as an HTTP
 * final response. Validate before any application headers or cookies escape.
 *
 * @param {number} status
 */
export function assertResponseStatus(status) {
	if (!(Number.isInteger(status) && status >= 200 && status <= 999)) {
		throw new RangeError('Response has no valid final HTTP status: ' + status);
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
		return Number.isSafeInteger(length) && length >= 0 ? length : null;
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
	endParserRefusal(res.socket, VERSION_505_RAW);
}

/**
 * Refuse invalid Host framing, replacing responses held in the current read.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function sendHost400(req, res) {
	// The parser owns both the closing bytes and the terminal read state.
	// Its refusal replaces only answers still held in this read's cork.
	endParserRefusal(req.socket, PARSER_400_RAW);
}

/**
 * Whether an HTTP/1.1 request lacks exactly one Host field.
 * @param {import('node:http').IncomingMessage} req
 */
export function missesHost(req) {
	if (req.httpVersion !== '1.1') return false;
	const raw = req.rawHeaders;
	if (raw === undefined) return req.headers.host === undefined;
	let seen = false;
	for (let i = 0; i < raw.length; i += 2) {
		if (raw[i].length !== 4 || raw[i].toLowerCase() !== 'host') continue;
		if (seen) return true;
		seen = true;
	}
	return !seen;
}

// The requests of one connection in the order it carried them, on the socket,
// and on each response handed out, the line it belongs to.
const LINE = Symbol('svelte-adapter-ws.pipeline');

// On a socket whose forbidden method is answered once its head has ended:
// the reader of the bytes node's parser reports after it gave up.
const PENDING_HEAD = Symbol('svelte-adapter-ws.pending-head');

// What a line keeps of an answer once it has finished, in place of the
// response, so an idle connection holds no response alive.
const FINISHED = Object.freeze({ writableEnded: true, _last: false });
const FINISHED_CLOSING = Object.freeze({ writableEnded: true, _last: true });

// On a response, true while the request it answers is in its own turn: the
// handler and the ticks and microtasks it queued, see servePipelined.
const TURN = Symbol('svelte-adapter-ws.turn');

// What the native tier's cork holds before it hands the turn's writes to the
// socket and corks nothing more of that turn. node's socket buffer reports
// backpressure at the same size, so a write refused under the hold is the
// hold itself.
const TURN_CORK_BYTES = 16384;

// Every response whose turn is open: the socket its writes are held on, and
// for a request handed out from the line, the timer that ends the turn.
/** @type {Map<any, { socket: import('node:net').Socket | null, timer: any }>} */
const openTurns = new Map();

/**
 * @typedef {{ req: import('node:http').IncomingMessage | null, res: import('node:http').ServerResponse | null, serve: (req: any, res: any) => void, synchronous?: boolean }} Waiting
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
 * ahead still open is decided after a microtask checkpoint, before another
 * I/O or timer callback; an answer already ended is served at once.
 *
 * A request held here or dropped is not handed to `serve`, so nothing counts
 * it: node never ends a response it queued when the connection goes.
 *
 * The turn a request is handed out in is the native tier's cork: what a
 * handler writes in it is held until the turn ends, and a connection closed
 * in it drops those bytes. The socket is corked for the turn and uncorked
 * when the turn ends; inOwnTurn tells a writer which case it is in. The turn
 * ends when the next request or WebSocket message is handed to the
 * application on any connection, which on the native tier is that handler's
 * own turn, or at the `setImmediate` that follows the hand-out. A request
 * handed out from the line follows the same callback boundary. The hold also
 * ends once the bytes it keeps pass
 * the native tier's cork buffer, see releaseTurnIfFull. node flushes a
 * response that ends in its turn at once, as a complete answer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} serve
 * @param {boolean} [synchronous] a built-in answer that finishes before returning
 */
export function servePipelined(req, res, serve, synchronous = false) {
	registerClosingResponse(req, res);
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
		if (synchronous) serveSynchronous(line, req, res, serve);
		else { handOut(line, res); serve(req, res); }
		return;
	}
	line.waiting.push({ req, res, serve: line.serve, synchronous });
	if (!line.scheduled) nextInLine(socket, line);
}

/**
 * @param {Line} line
 * @param {import('node:http').ServerResponse} res
 */
function handOut(line, res) {
	line.ahead = res;
	/** @type {any} */ (res)[LINE] = line;
	res.on('finish', aheadFinished);
	endOpenTurns();
	/** @type {any} */ (res)[TURN] = true;
	// A response queued behind one node is still writing has no socket yet;
	// node holds its output itself until the one ahead has finished.
	const socket = res.socket;
	if (socket !== null) socket.cork();
	openTurns.set(res, { socket, timer: null });
	setImmediateTimer(endTurn, res);
}

// Built-in probes call no application handler and end before returning. The
// read hold already protects their bytes from a later pipelined refusal.
/**
 * @param {Line} line
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Waiting['serve']} serve
 */
function serveSynchronous(line, req, res, serve) {
	endOpenTurns();
	line.ahead = res;
	/** @type {any} */ (res)[TURN] = true;
	try { serve(req, res); }
	finally {
		/** @type {any} */ (res)[TURN] = false;
		if (res.writableEnded) {
			releaseHttpReadIfFull(res);
			if (line.ahead === res) line.ahead = /** @type {any} */ (res)._last ? FINISHED_CLOSING : FINISHED;
		} else handOut(line, res);
	}
}

/**
 * Another handler's turn begins: every open one is over. For the sites that
 * hand work to the application outside the line, a WebSocket message or a
 * handshake.
 */
export function endOpenTurns() {
	if (openTurns.size === 0) return;
	for (const open of openTurns.keys()) endTurn(open);
}

/** @param {any} res */
function endTurn(res) {
	if (res[TURN] !== true) return;
	res[TURN] = false;
	const open = openTurns.get(res);
	openTurns.delete(res);
	if (open === undefined) return;
	if (open.timer !== null) clearTimer(open.timer);
	const socket = open.socket;
	if (socket != null && !socket.destroyed && !httpReadHeld(socket)) {
		while (socket.writableCorked > 0) socket.uncork();
	}
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

/**
 * For a writer, after each write in the request's own turn: once the bytes
 * held for the turn reach the native tier's cork buffer, the hold ends - the
 * native tier hands its cork to the socket then and corks nothing more of
 * that turn, so a close after that leaves the client everything written.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function releaseTurnIfFull(res) {
	releaseHttpReadIfFull(res);
	if (/** @type {any} */ (res)[TURN] !== true) return;
	const socket = openTurns.get(res)?.socket;
	if (socket != null && socket.writableLength >= TURN_CORK_BYTES) endTurn(res);
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
	// uWS drains the preceding handler's ticks and promise jobs before reading
	// the next pipelined request. A check-phase callback runs too late: an
	// application setImmediate or another poll callback can finish the answer
	// first. Node's own checkpoint gives promises their turn without admitting
	// another I/O or timer callback. A nested application callback must not
	// recursively enter that checkpoint.
	httpCallbackCheckpoint();

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
	if (next.res !== null && next.synchronous) serveSynchronous(line, next.req, next.res, next.serve);
	else {
		if (next.res !== null) handOut(line, next.res);
		next.serve(next.req, next.res);
	}
	if (line.waiting.length > 0) nextInLine(socket, line);
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
	const refusal = !acceptsRequestLine(req)
		? VERSION_505_RAW
		: missesHost(req) ? PARSER_400_RAW : null;
	if (refusal === null || !socket.writable) {
		socket.destroy();
		return;
	}
	endParserRefusal(socket, refusal);
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

// Native parser refusals are delimited by the connection close, including HEAD.
export const PARSER_400_RAW = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>';
export const VERSION_505_RAW = 'HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n<h1>HTTP Version Not Supported</h1><p>This server does not support HTTP/1.0.</p><hr><i>uWebSockets/20 Server</i>';

/**
 * Where node's parser refused a request whose line the native tier answers
 * 505 whatever else is wrong with it, see refusedRequestLine: the offset of
 * that line in the refused packet, or -1. The line is read only in the
 * connection's first read, which starts with the connection's first request
 * line; a later read can begin inside a request, and node's answer stands. A request refused behind
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
	return refusedRequestLine(packet, 0) ? 0 : -1;
}

/**
 * Where the request line node's parser gave up on starts in the refused
 * packet: the line that holds the byte it stopped at, past the CR and LF
 * bytes it reads over. For the answers given on node's own parse of a line,
 * the method's 405 and a HEAD's bodyless 400, whichever request of the read
 * they are for.
 *
 * @param {any} err
 */
function failingLineAt(err) {
	/** @type {Buffer} */
	const packet = err.rawPacket;
	const parsed = typeof err.bytesParsed === 'number' ? Math.min(err.bytesParsed, packet.length) : 0;
	let at = parsed > 0 ? packet.lastIndexOf(10, parsed - 1) + 1 : 0;
	while (at < packet.length && (packet[at] === 13 || packet[at] === 10)) at++;
	return at;
}

/**
 * The answer to a forbidden method once its head has ended, read as the
 * native tier reads a head: a bare LF or a header name that is not a token
 * is refused 400 at once, a head past node's header limit is 431, and an
 * ended head is 405 with a Host line and 400 without. Null while the head
 * has not ended.
 *
 * @param {Buffer} head
 * @param {number} limit
 */
function forbiddenHeadAnswer(head, limit) {
	for (let i = head.indexOf(10); i !== -1; i = head.indexOf(10, i + 1)) {
		if (i === 0 || head[i - 1] !== 13) return PARSER_400_RAW;
	}
	if (head.length > limit) return 'HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\n\r\n';
	const end = head.indexOf('\r\n\r\n');
	if (end === -1) return null;
	let host = false;
	for (const line of head.subarray(0, end).toString('latin1').split('\r\n').slice(1)) {
		const colon = line.indexOf(':');
		if (colon <= 0 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(line.slice(0, colon))) return PARSER_400_RAW;
		if (line.slice(0, colon).toLowerCase() === 'host') {
			if (host) return PARSER_400_RAW;
			host = true;
		}
	}
	return host ? FORBIDDEN_405_RAW : PARSER_400_RAW;
}

/**
 * Whether the request line at `at` is one the native tier refuses 505, as
 * far as its bytes go. The native tier ends the method at the first byte that
 * is a space, a control character below it or outside ASCII, and the target at
 * the first space or control character below it; it then needs a target
 * starting with `/`, a space, and exactly `HTTP/1.1` and CRLF, and refuses as
 * soon as the bytes so far cannot become that: `GET / HTTP/1.0` is refused
 * before its line has ended, and so is a tab inside the method or the target,
 * a bare LF in front of the line, or a space in front of the method unless the
 * target follows it at once. A CR anywhere before the version is a line it
 * reads no answer from: it waits for more, and here node's answer stands -
 * except a target ended by a CR where the head ends right after it, which
 * it refuses at once.
 *
 * @param {Buffer} packet
 * @param {number} at
 */
function refusedRequestLine(packet, at) {
	const length = packet.length;
	let i = at;
	while (i < length && packet[i] > 32 && packet[i] < 128) i++;
	if (i === length) return false;
	if (packet[i] === 13) return false;
	if (packet[i] !== 32) return true;
	i++;
	if (i === length) return false;
	if (packet[i] !== 47) return true;
	while (i < length && packet[i] > 32) i++;
	if (i === length) return false;
	if (packet[i] === 13) return length === i + 4 && packet[i + 1] === 10 && packet[i + 2] === 13 && packet[i + 3] === 10;
	if (packet[i] !== 32) return true;
	const end = packet.indexOf(10, i);
	const version = packet.toString('latin1', i + 1, end === -1 ? length : end + 1);
	return end === -1 ? !'HTTP/1.1\r\n'.startsWith(version) : version !== 'HTTP/1.1\r\n';
}

/**
 * Answer forbidden methods when optional request-head normalization is absent.
 * The normal reader gives node safe methods and restores them before routing;
 * this fallback handles the unmodified native parser's errors instead.
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
 * unless its target is in origin form and its version HTTP/1.1. The native
 * tier reads the line, then the Host, then the method, so a CONNECT and a
 * method node's parser refuses get the 400 for a missing Host ahead of their
 * 405: node gives up on such a method before any header, so the head is read
 * on to its end here and answered then, as the native tier answers it. A
 * CONNECT reads like any request in its connection's line: behind an answer that
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
		endParserRefusal(socket, raw);
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
			if (!socket.writable) socket.destroy();
			else answerAndClose(socket, !acceptsRequestLine(req) ? VERSION_505_RAW : missesHost(req) ? PARSER_400_RAW : FORBIDDEN_405_RAW);
		};
		const turn = upgradeTurn(req, socket);
		if (turn === null) answer();
		else turn.then((ok) => { if (ok) answer(); else socket.destroy(); });
	});
	/**
	 * The 405 for a forbidden method, or the 400 for a missing Host ahead of
	 * it, once the request's head has ended and been read as the native tier
	 * reads it (forbiddenHeadAnswer): node's parser stopped at the method, and
	 * reports every later read on the socket as the same error, so the rest of
	 * the head is gathered from those reports here, bounded by node's header
	 * size and timeout. The answer waits its turn in the connection's line
	 * like a CONNECT's: nothing is written behind an answer still waiting, and
	 * it follows the answers ahead of it.
	 *
	 * @param {any} socket
	 * @param {Buffer} head
	 * @param {number} timeoutMs
	 */
	const answerAfterHead = (socket, head, timeoutMs) => {
		const limit = /** @type {any} */ (server).maxHeaderSize ?? 16384;
		/** @type {string | null} */
		let raw = null;
		let allowed = false;
		const cleanup = () => { clearTimer(timer); socket[PENDING_HEAD] = undefined; };
		const finish = () => {
			if (raw === null || !allowed) return;
			cleanup();
			if (socket.writable) answerAndClose(socket, raw);
			else socket.destroy();
		};
		const decide = () => {
			if (raw !== null) return;
			raw = forbiddenHeadAnswer(head, limit);
			finish();
		};
		// What the line asks of a request: its line was read, a Host is what
		// the head has shown so far.
		const standIn = { socket, httpVersion: '1.1', url: '/', method: 'TRACK', headers: { get host() { return (head.toString('latin1').match(/^host:/igm)?.length ?? 0) === 1 ? 'x' : undefined; } } };
		const timer = setTimer(() => { cleanup(); socket.destroy(); }, timeoutMs);
		socket.once('close', cleanup);
		socket[PENDING_HEAD] = (/** @type {Buffer} */ chunk) => {
			head = Buffer.concat([head, chunk]);
			decide();
		};
		decide();
		const turn = upgradeTurn(/** @type {any} */ (standIn), socket);
		if (turn === null) {
			allowed = true;
			finish();
		} else {
			turn.then((ok) => {
				if (ok) { allowed = true; finish(); } else cleanup();
			});
		}
	};
	server.on('clientError', (/** @type {any} */ err, /** @type {import('node:net').Socket} */ socket) => {
		// More of a head whose forbidden method is waiting for its end.
		const pending = /** @type {any} */ (socket)[PENDING_HEAD];
		if (pending !== undefined) {
			if (Buffer.isBuffer(err?.rawPacket)) pending(err.rawPacket);
			else socket.destroy();
			return;
		}
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
		if (!socket.writable || (err && err.code === 'ECONNRESET') || (inFlight && inFlight._headerSent && !inFlight.writableEnded)) {
			socket.destroy(err);
			return;
		}
		// The request line first, as on the native tier: an HTTP/1.0 TRACK or
		// bad target is a 505.
		const refusedAt = refusedFirstLine(err, socket);
		if (refusedAt !== -1) {
			answerAndClose(socket, VERSION_505_RAW);
			return;
		}
		if (err && err.code === 'HPE_INVALID_METHOD' && Buffer.isBuffer(err.rawPacket)) {
			const at = failingLineAt(err);
			const line = err.rawPacket.subarray(at, at + 8).toString('latin1');
			const method = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' ')).toUpperCase();
			if (FORBIDDEN_METHODS.has(method)) {
				answerAfterHead(socket, err.rawPacket.subarray(at), server.headersTimeout || 60000);
				return;
			}
		}
		const code = err && err.code;
		if (code === 'HPE_INVALID_URL') {
			answerAndClose(socket, PARSER_400_RAW);
			return;
		}
		const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
			: code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout'
				: code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW' ? '413 Content Too Large'
					: '400 Bad Request';
		answerAndClose(socket, status === '400 Bad Request' ? PARSER_400_RAW : 'HTTP/1.1 ' + status + '\r\nconnection: close\r\n\r\n');
	});
}

/** @type {WeakMap<import('node:net').Socket, { pending: Set<() => void>, close: () => void }>} */
const queuedExchangeClosures = new WeakMap();

/**
 * Run `fn` once when an exchange is over: on the response's 'close', or on
 * the connection's close while the response never had a socket. node hands
 * the socket to the first response queued behind an answer as that answer
 * tears down, so that one closes on its own; a response further back is
 * never assigned and never closes, and nothing counted on it would settle.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {() => void} fn
 */
export function onExchangeClosed(req, res, fn) {
	// Node owns closure of a response already assigned to its socket. Only
	// queued responses can lose the connection without receiving close.
	if (res.socket != null) { res.once('close', fn); return; }
	const socket = req.socket;
	let group = queuedExchangeClosures.get(socket);
	if (!group) {
		const pending = new Set();
		const close = () => {
			queuedExchangeClosures.delete(socket);
			try { for (const unassigned of pending) unassigned(); }
			finally { pending.clear(); }
		};
		group = { pending, close };
		queuedExchangeClosures.set(socket, group);
		socket.once('close', close);
	}
	const owner = group;
	let done = false;
	const settle = () => {
		if (done) return;
		done = true;
		res.off('close', settle);
		owner.pending.delete(unassigned);
		if (owner.pending.size === 0) {
			socket.off('close', owner.close);
			if (queuedExchangeClosures.get(socket) === owner) queuedExchangeClosures.delete(socket);
		}
		fn();
	};
	const unassigned = () => { if (res.socket === null) settle(); };
	owner.pending.add(unassigned);
	res.once('close', settle);
}

/**
 * node answers a request's Expect before the listener runs: 100 Continue for
 * `100-continue`, 417 for anything else. The native tier reads the Host
 * first and refuses a request without one before any of that, so a Host-less
 * request goes through `listener`, which refuses it in its turn; one with a
 * Host gets the 100 Continue the native tier sends too, and any other Expect
 * is ignored as the native tier ignores it: the request goes to its route.
 *
 * @param {import('node:http').Server} server
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} listener
 */
export function answerExpectations(server, listener) {
	server.on('checkContinue', (req, res) => {
		if (!missesHost(req)) res.writeContinue();
		listener(req, res);
	});
	server.on('checkExpectation', listener);
}

/**
 * What the connection's line holds as the answer ahead: for tests, which
 * check that a finished answer is not kept alive by it.
 *
 * @param {any} socket
 */
export function lineAhead(socket) {
	return socket[LINE]?.ahead ?? null;
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
	if (req.method !== 'GET' || !acceptsRequestLine(req)) return false;
	const url = req.url || '/';
	const q = url.indexOf('?');
	return (q === -1 ? url : url.slice(0, q)) === wsPath &&
		!missesHost(req) && !behindClosingAnswer(req) && webSocketKeyByteLength(req.rawHeaders) === 24;
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
	const install = (/** @type {any} */ socket) => {
		const parser = socket.parser;
		const onIncoming = parser?.onIncoming;
		if (typeof onIncoming !== 'function') return;
		// `upgrade` is node's own field on the request, which its types leave out.
		parser.onIncoming = (/** @type {any} */ req, /** @type {boolean} */ keepAlive) => {
			if (req.upgrade && req.method !== 'CONNECT' && !shouldUpgradeCallback(req)) req.upgrade = false;
			return onIncoming(req, keepAlive);
		};
	};
	server.on(server instanceof HttpServer ? 'connection' : 'secureConnection', install);
	server.on(Symbol.for('svelte-adapter-ws.httpParserReady'), install);
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
// Node checks parser results against its own Error constructor. Obtain that
// constructor from the binding so callers in another realm work as well.
const ParserError = (() => {
	if (!HTTPParser || typeof nodeExecute !== 'function') return Error;
	const parser = new HTTPParser();
	parser.initialize(HTTPParser.REQUEST, {}, 0, 0);
	try {
		const error = nodeExecute.call(parser, Buffer.from('!'));
		if (!isNativeError(error)) throw new TypeError('HTTP parser error probe did not return a native Error');
		return error.constructor;
	} finally { parser.close(); }
})();
// For a prevalidated batch that cannot request an upgrade, no decline state can change.
export const executePlainHttp = nodeExecute;
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
export function executeAfterDeclines(data) {
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
		if (!declined?.complete || (declined === before && !pending)) {
			// A declined upgrade leaves llhttp's upgrade flag set. Node then
			// returns the consumed prefix instead of its later parse error.
			// Only a real upgrade may stop a read without consuming it here.
			if (offset < data.length && !this.incoming?.upgrade) {
				result = Object.assign(new ParserError('Parse Error'), {
					code: 'HPE_INVALID_MESSAGE', bytesParsed: offset
				});
			}
			break;
		}
		socket[DECLINED] = undefined;
		if (offset >= data.length) break;
	}
	// node frees a parser that took an upgrade into its pool right after this.
	if (this.incoming?.upgrade && this.execute === executeAfterDeclines) delete this.execute;
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
