// Hold the small writes made while a pipelined read is being dispatched.
// Node may uncork from ServerResponse.end(); that cannot commit an earlier
// answer before a later request in the same read has passed its turn checks.
import { commitClosingResponse } from './request-close.js';

const reads = new WeakMap();
const LIMIT = 16 * 1024;
let checkpointActive = false;

export function httpCallbackCheckpoint() {
	if (checkpointActive) return;
	checkpointActive = true;
	try { process._tickCallback(); } finally { checkpointActive = false; }
}

export function beginHttpRead(socket) {
	let state = reads.get(socket);
	if (!state) {
		const uncork = socket.uncork;
		state = { uncork, holding: false, terminal: false, queued: new Map(), queuedBytes: 0, shortStatus: new Set() };
		state.wrappedUncork = function() {
			if (state.holding && this.writableCorked <= 1) return;
			return uncork.call(this);
		};
		reads.set(socket, state);
	}
	if (state.terminal) return;
	state.holding = true;
	state.terminal = false;
	state.queued.clear();
	state.shortStatus.clear();
	state.queuedBytes = 0;
	socket.uncork = state.wrappedUncork;
	socket.cork();
}

export function clearHttpRead(socket) {
	const state = reads.get(socket);
	if (!state) return;
	socket.uncork = state.uncork;
	state.queued.clear();
	state.shortStatus.clear();
	reads.delete(socket);
}

export function httpReadHeld(socket) {
	return reads.get(socket)?.holding === true;
}

export function endHttpRead(socket) {
	const state = reads.get(socket);
	if (!state || state.terminal) return;
	state.holding = false;
	socket.uncork = state.uncork;
	state.queued.clear();
	state.shortStatus.clear();
	state.queuedBytes = 0;
	if (!socket.destroyed) while (socket.writableCorked > 0) state.uncork.call(socket);
}

// The native writer uses a numeric status for application Response objects.
export function markShortHttpStatus(res) {
	const state = reads.get(res.socket || res.req?.socket);
	if (state?.holding) state.shortStatus.add(res);
}

function headerAdjustment(res, shortStatus) {
	const header = res?._header;
	if (!header) return 0;
	// Node's automatic keep-alive fields do not enter the native cork. The
	// native writer always adds its server field and date, even if the
	// application already supplied either header.
	let delta = 'uWebSockets: 20\r\n'.length;
	if (res.hasHeader('date') || res.sendDate === false) delta += 37;
	for (const name of ['connection', 'keep-alive']) {
		if (res.hasHeader(name)) continue;
		const line = header.match(name === 'connection' ? /\r\nConnection:[^\r]*\r\n/i : /\r\nKeep-Alive:[^\r]*\r\n/i);
		if (line) delta -= line[0].length - 2;
	}
	if (shortStatus) delta -= header.indexOf('\r\n') - 'HTTP/1.1 '.length - String(res.statusCode).length;
	return delta;
}

export function releaseHttpReadIfFull(res) {
	const socket = res.socket || res.req?.socket;
	const state = reads.get(socket);
	if (!state?.holding) { commitClosingResponse(res); return false; }
	if (res.socket === null) {
		const previous = state.queued.get(res) || 0;
		const bytes = res.outputData.reduce((sum, entry) => sum + (typeof entry.data === 'string' ? Buffer.byteLength(entry.data, entry.encoding) : entry.data.length), 0);
		state.queuedBytes += bytes - previous;
		state.queued.set(res, bytes);
	}
	let bytes = socket.writableLength + state.queuedBytes;
	// Header differences can add at most the automatic date and server
	// fields. Most reads never approach the limit, so inspect serialized
	// headers only when their exact spelling can change the decision.
	if (bytes + (state.queued.size + 1) * 54 <= LIMIT) return false;
	const first = socket._httpMessage;
	if (first) bytes += headerAdjustment(first, state.shortStatus.has(first));
	for (const queued of state.queued.keys()) {
		if (queued !== first) bytes += headerAdjustment(queued, state.shortStatus.has(queued));
	}
	if (bytes <= LIMIT) return false;
	endHttpRead(socket);
	commitClosingResponse(res);
	return true;
}

export function endParserRefusal(socket, raw) {
	httpCallbackCheckpoint();
	const state = reads.get(socket);
	if (state?.terminal) return;
	if (!state?.holding) {
		if (state) state.terminal = true;
		// Releasing a large read starts the first response's write. TLS may
		// finish it later, before node assigns its socket to the queued answer.
		// Put the terminal bytes after every answer already completed by JS.
		const finish = () => {
			if (socket.destroyed) return;
			const response = socket._httpMessage;
			if (response?.writableEnded && !response.writableFinished) response.once('finish', finish);
			else socket.end(raw, () => socket.destroy());
		};
		finish();
		return;
	}
	state.terminal = true;
	// Bypass only the pending corked responses. Node owns their callbacks and
	// discards them when the terminal refusal has drained and the socket ends.
	const writeRefusal = () => {
		if (socket.destroyed) return;
		const writable = socket._writableState;
		if (writable?.writing) {
			// A previous read can still own a TLS write. Keep this read corked
			// while it completes, then check again after its callback has run.
			const callback = writable.writecb;
			if (typeof callback !== 'function') { socket.destroy(); return; }
			writable.writecb = function(...args) {
				try { callback.apply(this, args); }
				finally { if (args[0]) socket.destroy(args[0]); else writeRefusal(); }
			};
			return;
		}
		try { socket._write(raw, 'utf8', () => socket.destroy()); }
		catch { socket.destroy(); }
	};
	writeRefusal();
}
