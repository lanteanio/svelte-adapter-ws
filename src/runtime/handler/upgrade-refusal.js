// An unsuccessful WebSocket handshake returns to HTTP on the same socket.
// Node detached its parser before emitting upgrade; only that parser and its
// adapter hooks are reinstalled, without announcing another TCP connection.
import { createRequire } from 'node:module';
import { setImmediateTimer } from '../runtime.js';

const { _connectionListener } = createRequire(import.meta.url)('_http_server');
const PARSER_READY = Symbol.for('svelte-adapter-ws.httpParserReady');
const refusals = new WeakMap();

/**
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {() => void} onError
 */
export function prepareUpgradeRefusal(socket, head, onError) {
	const state = { head, onError };
	refusals.set(socket, state);
	return (nextHead) => { state.head = nextHead; };
}

/** @param {import('node:net').Socket} socket */
export function forgetUpgradeRefusal(socket) {
	refusals.delete(socket);
}

/**
 * @param {any} socket node's HTTP socket, including its owning server
 * @param {string} response
 * @param {boolean} closeConnection
 */
export function finishUpgradeRefusal(socket, response, closeConnection) {
	const state = refusals.get(socket);
	refusals.delete(socket);
	if (socket.destroyed) return;
	if (closeConnection || !state || !socket.server || socket.server.listening === false) {
		try { socket.end(response, () => socket.destroy()); } catch { socket.destroy(); }
		return;
	}
	// Keep unread bytes queued while the refusal drains. HTTP begins again
	// only after this response, so its parser cannot overtake the handshake.
	socket.pause();
	try {
		socket.write(response, (error) => {
			if (error || socket.destroyed || socket.server.listening === false) { socket.destroy(); return; }
			try {
				socket.removeListener('error', state.onError);
				_connectionListener.call(socket.server, socket);
				socket.server.emit(PARSER_READY, socket);
				if (state.head.length) socket.unshift(state.head);
				socket.resume();
			} catch { socket.destroy(); }
		});
	} catch { socket.destroy(); }
}

// The native HTTP turn permits a microtask to finish admission, but closes
// when the next request reaches a hook that is still awaiting application
// work. Retain at most the first read while making that decision.
/**
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
export function watchPendingUpgrade(socket, head) {
	let scheduled = false;
	let pending = true;
	let nextHead = head;
	const check = () => {
		scheduled = true;
		setImmediateTimer(() => { if (pending) socket.destroy(); });
	};
	const onData = (chunk) => {
		socket.pause();
		nextHead = nextHead.length ? Buffer.concat([nextHead, chunk]) : chunk;
		if (!scheduled) check();
	};
	if (head.length) check();
	socket.once('data', onData);
	socket.resume();
	return () => {
		socket.pause();
		socket.removeListener('data', onData);
		pending = false;
		return nextHead;
	};
}
