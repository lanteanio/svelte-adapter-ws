// The uWS-shaped socket facade over a `ws` WebSocket.
//
// The `ws` library never throws on a closed socket and its send() returns
// nothing, so the two halves of the family socket contract are synthesized
// here: the TRI-STATE send result (0 = enqueued behind backpressure, 1 = sent
// clean, 2 = dropped past maxBackpressure) from `bufferedAmount` and the
// backpressure ceiling, and the THROW-ON-CLOSED behavior for the accessors -
// sibling packages reap dead sockets by catching exactly that throw, so a
// facade that answered 0 instead would silently break their liveness sweeps.
// Platform methods that must be closed-socket safe catch the throw themselves
// and bump `closedWsAborts`.

import { subscribeSocket, unsubscribeSocket, socketHolds, socketTopicList, subscribersOf } from './topic-registry.js';

const OPEN = 1;

const CLOSED_MESSAGE = 'Invalid access of closed WebSocket';

/** @returns {never} */
function throwClosed() {
	throw new Error(CLOSED_MESSAGE);
}

/**
 * @typedef {{
 *   maxBackpressure: number,
 *   closeOnBackpressureLimit: boolean,
 *   compressionEnabled: boolean,
 *   onDrop?: (byteLength: number) => void,
 *   onDrain?: (facade: object) => void
 * }} FacadeOptions
 */

/**
 * Wrap a ws WebSocket in the uWS-shaped surface the family contract names.
 * One wrapper per connection for its whole life; `getUserData()` returns the
 * same object identity throughout.
 *
 * @param {import('ws').WebSocket} rawWs
 * @param {object} userData
 * @param {FacadeOptions} opts
 */
export function wrapWebSocket(rawWs, userData, opts) {
	// Drain synthesis: when a send leaves bytes buffered, the send callback
	// (which ws fires as data flushes toward the peer) checks whether the
	// buffer emptied and fires the drain hook once per pressure episode.
	let pressured = false;
	const onFlushed = () => {
		// Never on a dead socket: node invokes pending write callbacks when a
		// socket is destroyed, and a drain against a closed connection would
		// run the app hook on a corpse.
		if (pressured && rawWs.readyState === OPEN && rawWs.bufferedAmount === 0) {
			pressured = false;
			opts.onDrain?.(facade);
		}
	};

	const facade = {
		/**
		 * @param {string | ArrayBuffer | Uint8Array | Buffer} message
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 * @returns {number} 0 | 1 | 2
		 */
		send(message, isBinary = false, compress = false) {
			if (rawWs.readyState !== OPEN) throwClosed();
			const bufferedBefore = rawWs.bufferedAmount;
			if (bufferedBefore >= opts.maxBackpressure) {
				// Past the ceiling: the frame is shed, exactly as the native
				// tier sheds it. `closeOnBackpressureLimit` trades the shed for
				// a bounded-recovery close of the chronically slow consumer.
				const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
				opts.onDrop?.(size);
				if (opts.closeOnBackpressureLimit) {
					// Abrupt close, matching the native tier's forcible close of
					// a consumer pinned over the limit.
					rawWs.terminate();
				}
				return 2;
			}
			const payload = typeof message === 'string' ? message : Buffer.from(/** @type {ArrayBuffer} */ (message));
			if (opts.compressionEnabled) {
				rawWs.send(payload, { binary: isBinary, compress: compress === true }, onFlushed);
			} else {
				rawWs.send(payload, { binary: isBinary }, onFlushed);
			}
			if (rawWs.bufferedAmount > 0) {
				pressured = true;
				return 0;
			}
			return 1;
		},

		close() {
			try { rawWs.terminate(); } catch { /* already gone */ }
		},

		/**
		 * @param {number} [code]
		 * @param {string | ArrayBuffer} [message]
		 */
		end(code, message) {
			try {
				rawWs.close(code, typeof message === 'string' ? message : message ? Buffer.from(message).toString() : undefined);
			} catch { /* already gone */ }
		},

		/** @param {string} topic */
		subscribe(topic) {
			if (rawWs.readyState !== OPEN) throwClosed();
			subscribeSocket(rawWs, topic);
			return true;
		},

		/** @param {string} topic */
		unsubscribe(topic) {
			if (rawWs.readyState !== OPEN) throwClosed();
			unsubscribeSocket(rawWs, topic);
			return true;
		},

		/**
		 * Fan a frame out to the topic's subscribers, excluding this socket -
		 * the uWS socket-level publish contract.
		 * @param {string} topic
		 * @param {string | ArrayBuffer | Uint8Array} message
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 */
		publish(topic, message, isBinary = false, compress = false) {
			if (rawWs.readyState !== OPEN) throwClosed();
			const subscribers = subscribersOf(topic);
			if (!subscribers) return false;
			let sent = false;
			for (const peer of subscribers) {
				if (peer === rawWs || peer.readyState !== OPEN) continue;
				// Through the peer FACADE, never the raw socket: the ceiling,
				// the shed accounting and closeOnBackpressureLimit must apply
				// to socket-level publishes exactly as to platform sends.
				const peerFacade = opts.peerFacadeOf?.(peer);
				try {
					if (peerFacade) {
						if (peerFacade.send(message, isBinary, compress) !== 2) sent = true;
					} else {
						const payload = typeof message === 'string' ? message : Buffer.from(/** @type {ArrayBuffer} */ (message));
						peer.send(payload, { binary: isBinary });
						sent = true;
					}
				} catch { /* peer closed mid-walk */ }
			}
			return sent;
		},

		/** @param {string} topic */
		isSubscribed(topic) {
			return socketHolds(rawWs, topic);
		},

		getTopics() {
			return socketTopicList(rawWs);
		},

		getUserData() {
			if (rawWs.readyState !== OPEN) throwClosed();
			return userData;
		},

		getBufferedAmount() {
			if (rawWs.readyState !== OPEN) throwClosed();
			return rawWs.bufferedAmount || 0;
		},

		getRemoteAddress() {
			// Raw address bytes: 4 for IPv4, 16 for IPv6, as the native tier
			// returns them.
			const ip = /** @type {any} */ (rawWs)._socket?.remoteAddress || '127.0.0.1';
			const v4 = ip.replace(/^::ffff:/, '');
			const parts = v4.split('.');
			if (parts.length === 4) return new Uint8Array(parts.map(Number)).buffer;
			const halves = v4.split('::');
			const left = halves[0] ? halves[0].split(':') : [];
			const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
			const pad = Array(8 - left.length - right.length).fill('0');
			const groups = [...left, ...pad, ...right].map((g) => parseInt(g, 16));
			const buf = new Uint8Array(16);
			for (let i = 0; i < 8; i++) {
				buf[i * 2] = (groups[i] >> 8) & 0xff;
				buf[i * 2 + 1] = groups[i] & 0xff;
			}
			return buf.buffer;
		},

		getRemoteAddressAsText() {
			return new TextEncoder().encode(/** @type {any} */ (rawWs)._socket?.remoteAddress || '127.0.0.1').buffer;
		},

		/**
		 * uWS batches syscalls under cork; node's socket layer batches on its
		 * own, so a synchronous passthrough is the conforming implementation.
		 * @param {() => void} fn
		 */
		cork(fn) { fn(); },

		/** Drain-edge backstop for callback-less writes (ping/pong/close). */
		_checkDrain: onFlushed,

		/** The raw ws socket, for runtime-internal delivery walks. */
		_raw: rawWs
	};

	return facade;
}

export { CLOSED_MESSAGE };
