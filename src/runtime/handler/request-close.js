const REGISTER_RESPONSE = Symbol('svelte-adapter-ws.request-close');
const COMMIT_RESPONSE = Symbol('svelte-adapter-ws.commit-close');

/** A completed response outside the read cork closes before later dispatch. */
export function commitClosingResponse(res) {
	if (res.writableEnded) res[COMMIT_RESPONSE]?.();
}

/** Register the response before a request handler can finish it. */
export function registerClosingResponse(req, res) {
	req[REGISTER_RESPONSE]?.(req, res);
}

/** A complete request replaces the close policy of the request ahead of it. */
export function createRequestCloseController(socket) {
	let request = null;
	let response = null;
	let reading = false;
	let committed = false;
	const finish = () => {
		if (reading && !committed || response === null || !response.writableFinished || socket.destroyed) return;
		clear();
		socket.pause();
		socket.end(() => socket.destroy());
	};
	const clear = () => {
		response?.removeListener('finish', finish);
		request = null;
		response = null;
	};
	const register = (req, res) => {
		if (request !== req) return;
		response = res;
		res[COMMIT_RESPONSE] = () => {
			if (response !== res) return;
			committed = true;
			res._last = true;
			socket.pause();
			finish();
		};
		res.once('finish', finish);
	};
	return {
		beginRead() { reading = true; },
		endRead(failed) { reading = false; if (failed && !committed) clear(); else finish(); },
		get pending() { return request !== null; },
		get closed() { return committed; },
		clear,
		select(req, close) {
			if (committed) return;
			clear();
			if (!close) return;
			request = req;
			req[REGISTER_RESPONSE] = register;
		}
	};
}
