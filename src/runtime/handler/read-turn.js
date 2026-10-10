// Hold the small writes made while a pipelined read is being dispatched.
// Node may uncork from ServerResponse.end(); that cannot commit an earlier
// answer before a later request in the same read has passed its turn checks.
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
		state = { uncork, holding: false, terminal: false, queued: new Map(), queuedBytes: 0 };
		state.wrappedUncork = function() {
			if (state.holding && this.writableCorked <= 1) return;
			return uncork.call(this);
		};
		reads.set(socket, state);
		socket.once('close', () => { socket.uncork = uncork; reads.delete(socket); });
	}
	if (state.terminal) return;
	state.holding = true;
	state.terminal = false;
	state.queued.clear();
	state.queuedBytes = 0;
	socket.uncork = state.wrappedUncork;
	socket.cork();
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
	state.queuedBytes = 0;
	if (!socket.destroyed) while (socket.writableCorked > 0) state.uncork.call(socket);
}

export function releaseHttpReadIfFull(res) {
	const socket = res.socket || res.req?.socket;
	const state = reads.get(socket);
	if (!state?.holding) return false;
	if (res.socket === null) {
		const previous = state.queued.get(res) || 0;
		const bytes = res.outputData.reduce((sum, entry) => sum + (typeof entry.data === 'string' ? Buffer.byteLength(entry.data, entry.encoding) : entry.data.length), 0);
		state.queuedBytes += bytes - previous;
		state.queued.set(res, bytes);
	}
	if (socket.writableLength + state.queuedBytes < LIMIT) return false;
	endHttpRead(socket);
	return true;
}

export function endParserRefusal(socket, raw) {
	httpCallbackCheckpoint();
	const state = reads.get(socket);
	if (!state?.holding) { socket.end(raw, () => socket.destroy()); return; }
	state.terminal = true;
	// Bypass only the pending corked responses. Node owns their callbacks and
	// discards them when the terminal refusal has drained and the socket ends.
	try { socket._write(raw, 'utf8', () => socket.destroy()); }
	catch { socket.destroy(); }
}
