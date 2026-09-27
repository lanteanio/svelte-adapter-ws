/**
 * Whether an SSR response may be buffered whole for cross-waiter dedup.
 *
 * The one response that must never be buffered is a Server-Sent-Events stream
 * (`text/event-stream`): it never ends, so `arrayBuffer()` on it would await
 * forever - parking the leader and every concurrent anonymous waiter on the
 * same in-flight promise until the connection drops. Those must stream.
 *
 * Everything else is a finite render we buffer and share. Note we deliberately
 * do NOT require a `content-length`: SvelteKit's dynamically-rendered pages
 * carry none, so gating on that header would silently disable dedup for the
 * exact thundering-herd workload it exists to protect. The never-ending
 * content-type is the only reliable signal, and the response writer already
 * chunk-streams the excluded case without buffering it.
 *
 * Kept in its own dependency-free module so it is unit-testable without
 * pulling in the build-time runtime init chain that `ssr.js` depends on.
 *
 * @param {Response} response
 * @returns {boolean}
 */
export function isDedupBufferable(response) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	return !contentType.startsWith('text/event-stream');
}

/**
 * Whether a response's declared length already rules sharing out, so the
 * leader can go straight to streaming without reading a byte. `false` means
 * the length is unknown or within the cap and the body has to be read to
 * decide.
 *
 * @param {Response} response
 * @param {number} cap
 * @returns {boolean}
 */
export function declaresBodyPastCap(response, cap) {
	const declared = response.headers.get('content-length');
	if (declared === null) return false;
	const length = Number(declared);
	return Number.isFinite(length) && length > cap;
}

/**
 * A body chunk as bytes. A Response built on a stream the app wrote hands back
 * whatever was enqueued, and the family's native tier writes a string or an
 * ArrayBuffer as readily as a view, so both are taken here; anything else is
 * a body that cannot go on the wire, and the throw reaches the failure path
 * like a source that errored. Both readers of a response body take their
 * chunks through this: the writer, and the dedup leader below, which would
 * otherwise copy an ArrayBuffer or a string into its buffer as zeros.
 *
 * @param {unknown} chunk
 * @returns {Uint8Array}
 */
export function chunkBytes(chunk) {
	if (chunk instanceof Uint8Array) return chunk;
	if (typeof chunk === 'string') return Buffer.from(chunk);
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	throw new TypeError('A response body chunk must be a string, an ArrayBuffer or a typed array');
}

/**
 * Read a body until it ends or its bytes pass `cap`, whichever comes first.
 *
 * The cap is a ceiling on what is HELD, not a check made after the whole
 * body has been materialised: a leader that reads a response to its end and
 * only then asks whether it was small enough has already spent the memory
 * the cap exists to bound - once per concurrent request, for as large a body
 * as the route serves. So the read stops the moment the bytes read pass the
 * cap, and what was read is handed back as a stream that replays those
 * chunks and then continues from the reader, so the leader streams the body
 * it decided not to share without re-rendering or losing a byte.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {number} cap
 * @returns {Promise<{ complete: true, bytes: Uint8Array } | { complete: false, stream: ReadableStream<Uint8Array> }>}
 */
export async function readBodyUpTo(body, cap) {
	const reader = body.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			reader.releaseLock();
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			return { complete: true, bytes };
		}
		let bytes;
		try {
			bytes = chunkBytes(value);
		} catch (err) {
			reader.cancel(err).catch(() => {});
			throw err;
		}
		chunks.push(bytes);
		total += bytes.byteLength;
		if (total > cap) break;
	}
	// Past the cap: replay what is held, then continue from the source. The
	// held chunks are released as they are replayed, so the prefix is not
	// kept for the life of the stream.
	let replay = 0;
	const stream = new ReadableStream({
		async pull(controller) {
			if (replay < chunks.length) {
				const chunk = chunks[replay];
				chunks[replay] = /** @type {any} */ (null);
				replay += 1;
				controller.enqueue(chunk);
				return;
			}
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { complete: false, stream };
}
