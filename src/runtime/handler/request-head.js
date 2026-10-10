import { METHODS } from 'node:http';
import { endParserRefusal } from './read-turn.js';
import { normalizeHeaderEdges } from './header-edges.js';
import { decodeRequestHeaders } from './header-values.js';
import { executeAfterDeclines, executePlainHttp } from './http-helpers.js';
import { setTimer, clearTimer } from '../runtime.js';

const METHODS_SET = new Set(METHODS.filter(method => method !== 'CONNECT'));
const VERSION = Buffer.from(' HTTP/1.1\r\n');
const LIMIT = 4096;
const FAST_HEADS = /^(?:(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS|TRACE) \/[!-~]* HTTP\/1\.1\r\n(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t -~]*\r\n)*\r\n)+$/;
const FRAMED = /\r\n(?:content-length|transfer-encoding|upgrade):/i;
const WAIT = 0;
const REFUSE = 1;

// Inspect bytes before node normalizes separators or rejects an unknown method.
function requestLine(data, trailingBytes) {
	let at = 0;
	while (at < data.length && data[at] > 32 && data[at] < 128) at++;
	if (at === data.length || data[at] === 13) return WAIT;
	if (data[at] !== 32) return REFUSE;
	const methodEnd = at++;
	if (at === data.length) return WAIT;
	if (data[at] !== 47) return REFUSE;
	const targetStart = at;
	while (at < data.length && data[at] > 32) at++;
	if (at === data.length) return WAIT;
	if (data[at] === 13) {
		// A short suffix is already an impossible version. With more bytes
		// behind the CR, the native parser keeps the line buffered.
		return data.length + trailingBytes - at <= VERSION.length ? REFUSE : WAIT;
	}
	for (let i = 0; i < VERSION.length; i++) {
		if (at + i === data.length) return WAIT;
		if (data[at + i] !== VERSION[i]) return REFUSE;
	}
	return { method: data.toString('latin1', 0, methodEnd).toUpperCase(), target: data.toString('latin1', targetStart, at), end: at + VERSION.length };
}

/** Keep request heads intact across reads; node remains responsible for validation. */
export function createRequestHeadExecutor(parser, socket) {
	let mode = 'head';
	let remaining = 0;
	let pending = null;
	let timer = null;
	let current = null;
	let stopped = false;
	let chunkSize = 0;
	let chunkDigitsEnded = false;
	let trailerBytes = 0;
	const originalIncoming = parser.onIncoming;
	parser.onIncoming = function(req, keepAlive) {
		if (current) {
			decodeRequestHeaders(req);
			req.method = current.method;
			req.url = current.target;
			if (req.headers['transfer-encoding']) mode = 'chunk-line';
			else {
				const declared = req.headers['content-length'] || '0';
				remaining = Number(declared);
				if (remaining > Number.MAX_SAFE_INTEGER) remaining = BigInt(declared);
				mode = remaining ? 'body' : 'head';
			}
		}
		return originalIncoming.call(this, req, keepAlive);
	};
	const clearPending = () => { pending = null; if (timer !== null) clearTimer(timer); timer = null; };
	const hold = data => {
		pending = Buffer.from(data);
		if (timer === null) { timer = setTimer(() => socket.destroy(), 10_000); timer?.unref?.(); }
	};
	const refuse = (status, headOnly = false) => {
		clearPending(); stopped = true;
		const phrase = status === 505 ? 'HTTP Version Not Supported' : status === 400 ? 'Bad Request' : 'Request Header Fields Too Large';
		endParserRefusal(socket, 'HTTP/1.1 ' + status + ' ' + phrase + '\r\ncontent-type: text/plain\r\ncontent-length: ' + phrase.length + '\r\nconnection: close\r\n\r\n' + (headOnly ? '' : phrase));
	};
	const tryFast = (data) => {
		if (stopped) return data.length;
		if (mode !== 'head' || pending !== null || data.length > LIMIT) return null;
		const text = data.toString('latin1');
		if (FRAMED.test(text) || !FAST_HEADS.test(text)) return null;
		current = null;
		return executePlainHttp.call(parser, data);
	};
	return {
		tryFast,
		get boundary() { return mode === 'head' && pending === null; },
		restore() { clearPending(); if (parser.socket === socket) parser.onIncoming = originalIncoming; },
		execute(data, trailingBytes = 0) {
			if (stopped) return data.length;
			const fast = tryFast(data);
			if (fast !== null) return fast;
			let at = 0;
			while (at < data.length) {
				let part, consumed;
				if (mode === 'body' || mode === 'chunk-data') {
					consumed = typeof remaining === 'bigint'
						? Number(remaining < BigInt(data.length - at) ? remaining : BigInt(data.length - at))
						: Math.min(remaining, data.length - at);
					part = data.subarray(at, at + consumed);
					remaining -= typeof remaining === 'bigint' ? BigInt(consumed) : consumed;
					if (!remaining) mode = mode === 'body' ? 'head' : 'chunk-line';
				} else if (mode === 'chunk-line' || mode === 'trailers') {
					const end = data.indexOf(10, at);
					consumed = end < 0 ? data.length - at : end - at + 1;
					part = data.subarray(at, at + consumed);
					if (mode === 'chunk-line') {
						if (!chunkDigitsEnded) {
							for (const byte of part) {
								if (byte === 59 || byte === 13 || byte === 10) { chunkDigitsEnded = true; break; }
								const digit = byte >= 48 && byte <= 57 ? byte - 48 : (byte | 32) >= 97 && (byte | 32) <= 102 ? (byte | 32) - 87 : -1;
								if (digit < 0) continue; // node rejects this byte below
								if (typeof chunkSize === 'bigint') {
									if (chunkSize <= 0xffffffffffffffffn) chunkSize = chunkSize * 16n + BigInt(digit);
								}
								else if (chunkSize > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 16)) chunkSize = BigInt(chunkSize) * 16n + BigInt(digit);
								else chunkSize = chunkSize * 16 + digit;
							}
						}
						if (end >= 0) {
							const size = chunkSize;
							chunkSize = 0;
							chunkDigitsEnded = false;
							remaining = typeof size === 'bigint' ? size + 2n : size + 2;
							mode = size === 0 ? 'trailers' : 'chunk-data';
						}
					} else {
						trailerBytes += consumed;
						if (end >= 0) { if (trailerBytes === 2) mode = 'head'; trailerBytes = 0; }
					}
				} else {
					const prefix = pending?.length || 0;
					const available = pending === null ? data.subarray(at) : Buffer.concat([pending, data.subarray(at)]);
					if (mode === 'head') {
						const line = requestLine(available, trailingBytes);
						if (line === REFUSE) { refuse(505, available.toString('latin1', 0, 5) === 'HEAD '); return data.length; }
						const end = line === WAIT ? -1 : available.indexOf('\r\n\r\n', line.end - 2);
						if (end === -1) {
							if (line !== WAIT && /(?:^|[^\r])\n/.test(available.toString('latin1', line.end))) { refuse(400); return data.length; }
							if (available.length >= LIMIT) refuse(431); else hold(available);
							return data.length;
						}
						const length = end + 4;
						if (length > LIMIT) { refuse(431); return data.length; }
						current = line;
						consumed = length - prefix;
						part = normalizeHeaderEdges(available.subarray(0, length));
						const safeMethod = METHODS_SET.has(line.method) ? line.method : 'GET';
						const safeTarget = line.target.replace(/[^\x21-\x7e]/g, '_');
						if (safeMethod !== available.toString('latin1', 0, available.indexOf(32)) || safeTarget !== line.target) {
							part = Buffer.concat([Buffer.from(safeMethod + ' ' + safeTarget + ' HTTP/1.1\r\n', 'latin1'), part.subarray(line.end)]);
						}
					}
					clearPending();
				}
				const result = executeAfterDeclines.call(parser, part);
				if (typeof result !== 'number') { if (result) { result.rawPacket = part; } return result; }
				at += consumed;
				if (parser.incoming?.upgrade) return at;
				if (socket.destroyed || stopped) return data.length;
			}
			return at;
		}
	};
}
