// Consume connection metadata at HTTP request boundaries. HTTP framing stays
// with node's parser, including chunked bodies and WebSocket upgrade tails.
import { Server as HttpServer } from 'node:http';
import { clearTimer, setTimer } from '../runtime.js';
import { createRequestHeadExecutor, HEADER_TOO_LARGE } from './request-head.js';
import { beginHttpRead, endHttpRead, endParserRefusal, clearHttpRead } from './read-turn.js';

const SIGNATURE = Buffer.from([13, 10, 13, 10, 0, 13, 10, 81, 85, 73, 84, 10]);
const PREFIX = SIGNATURE.subarray(0, 4);
const MAX_PAYLOAD = 36;
const MAX_HEADER_BYTES = 4096;
const PREAMBLE_TIMEOUT_MS = 10_000;
/** @type {WeakMap<import('node:net').Socket, string>} */
const addresses = new WeakMap();

/** @param {import('node:net').Socket} socket */
export function proxiedAddress(socket) {
	return addresses.get(socket) || '';
}

/** @param {Buffer} frame */
function sourceAddress(frame) {
	const family = frame[13];
	if (family === 0) return '';
	// The address storage is zero-filled when the declared payload is shorter.
	const bytes = Buffer.alloc(16);
	frame.copy(bytes, 0, 16, Math.min(frame.length, 32));
	if ((family >> 4) === 1) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
	const hex = bytes.toString('hex');
	return hex.match(/.{4}/g).join(':');
}

/**
 * Install after the server's HTTP connection listeners. TLS metadata is read
 * from the decrypted stream, before the first HTTP byte, just like plain TCP.
 * @param {import('node:http').Server | import('node:https').Server} server
 */
export function installProxyProtocol(server) {
	server.on(server instanceof HttpServer ? 'connection' : 'secureConnection', installProxyProtocolSocket);
	server.on(Symbol.for('svelte-adapter-ws.httpParserReady'), installProxyProtocolSocket);
}

/** @param {import('node:net').Socket} socket */
export function installProxyProtocolSocket(socket) {
	const parser = socket.parser;
	if (!parser) return;
	const heads = createRequestHeadExecutor(parser, socket);
	if (!heads) return;
	let boundary = true;
	/** @type {Buffer | null} */
	let pending = null;
	let filled = 0;
	let target = 16;
	let timer = null;
	let refusedBytes = 0;

	const originalExecute = Object.getOwnPropertyDescriptor(parser, 'execute');
	const clearPending = () => {
		if (timer !== null) clearTimer(timer);
		timer = null;
		pending = null;
		filled = 0;
		target = 16;
	};
	const restore = () => {
		if (socket.destroyed) clearHttpRead(socket);
		heads.restore();
		clearPending();
		socket.removeListener('close', restore);
		if (parser.socket && parser.socket !== socket) return;

		if (originalExecute) Object.defineProperty(parser, 'execute', originalExecute);
		else delete parser.execute;
	};
	parser.execute = function (data) {
		const firstHead = data.indexOf(PREFIX);
		const held = !heads.boundary || firstHead >= 0 && firstHead + 4 < data.length;
		if (held) beginHttpRead(socket);
		let parserFailed = false;
		try {
			// A complete bodyless ASCII batch cannot carry connection metadata.
			// Let the head reader consume it together instead of splitting every
			// HTTP terminator while searching for a PROXY prefix.
			if (pending === null && boundary && refusedBytes === 0) {
				const fast = heads.tryFast(data);
				if (fast !== null) {
					parserFailed = typeof fast !== 'number' && fast?.code !== 'HPE_CLOSED_CONNECTION';
					boundary = heads.boundary;
					if (this.incoming?.upgrade) restore();
					return fast;
				}
			}
			let offset = 0;
			const refuse = (bytes) => {
				refusedBytes += bytes;
				if (refusedBytes >= MAX_HEADER_BYTES) {
					clearPending();
					endParserRefusal(socket, HEADER_TOO_LARGE);
				}
				return data.length;
			};
			if (refusedBytes > 0) return refuse(data.length);
			while (offset < data.length) {
				if (pending !== null) {
					const take = Math.min(target - filled, data.length - offset);
					data.copy(pending, filled, offset, offset + take);
					filled += take;
					offset += take;
					if (!pending.subarray(0, Math.min(filled, 12)).equals(SIGNATURE.subarray(0, Math.min(filled, 12)))) {
						return refuse(filled + data.length - offset);
					}
					if (filled < target) continue;
					if (target === 16) {
						const length = pending.readUInt16BE(14);
						if ((pending[12] >> 4) !== 2 || length > MAX_PAYLOAD) {
							return refuse(filled + data.length - offset);
						}
						target += length;
						if (filled < target) continue;
					}
					if (!addresses.has(socket)) addresses.set(socket, sourceAddress(pending.subarray(0, target)));
					clearPending();
					// Only one frame may precede each request. Later requests may
					// carry another frame, but cannot replace the first claim.
					boundary = false;
					continue;
				}

				let next = data.indexOf(PREFIX, offset);
				if (next < 0) {
					// A signature may straddle reads. Split off a matching tail,
					// then ask the HTTP parser whether it starts a new request.
					next = data.length;
					for (let n = Math.min(3, data.length - offset); n > 0; n--) {
						if (data[data.length - 1] === PREFIX[n - 1] && data.subarray(data.length - n).equals(PREFIX.subarray(0, n))) {
							next -= n;
							break;
						}
					}
				}
				if (next === offset && boundary) {
					pending = Buffer.alloc(16 + MAX_PAYLOAD);
					timer = setTimer(() => { clearPending(); socket.destroy(); }, PREAMBLE_TIMEOUT_MS);
					timer?.unref?.();
					continue;
				}
				// A signature in a body belongs to HTTP, not to the connection.
				const end = next === offset || boundary
					? Math.min(data.length, next + PREFIX.length)
					: next;
				const length = end - offset;
				boundary = false;
				const result = heads.execute(offset === 0 && end === data.length ? data : data.subarray(offset, end), data.length - end);
				boundary = heads.boundary;
				if (typeof result !== 'number') {
					parserFailed = result?.code !== 'HPE_CLOSED_CONNECTION';
					if (typeof result?.bytesParsed === 'number') result.bytesParsed += offset;
					return result;
				}
				offset += result;
				if (this.incoming?.upgrade) { restore(); return offset; }
				if (result < length) return offset;
			}
			return offset;
		} finally { if (held && !parserFailed) endHttpRead(socket); }
	};
	// Adding a reader switches node from its native consumed path to the
	// JS execute path, so no read can bypass the preamble filter.
	const noop = () => {};
	socket.on('data', noop);
	socket.removeListener('data', noop);
	socket.once('close', restore);
}
