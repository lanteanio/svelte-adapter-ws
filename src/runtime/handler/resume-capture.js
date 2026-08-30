// Resume-cutover live-frame barrier.
//
// A resume hook replays a topic's missed history while the connection is not
// yet subscribed to live traffic, so a frame published DURING the hook await
// would fall between replay and cutover and be lost. The barrier buffers the
// topic's live frames for the awaiting connection and flushes them, in order,
// the moment the subscription lands - after the replay, before the ack.
// Delivery is at-least-once across the replay/live boundary: every stamped
// frame carries its seq, and the client's per-topic monotonic-seq dedup is
// the documented consumer of duplicates.

/** @type {Map<string, Set<{ frames: string[], overflow: boolean }>>} */
const resumeBuffers = new Map();

const MAX_RESUME_BUFFERED_FRAMES = 4096;

/** Whether any capture barrier is currently open (publish's cheap gate). */
export function resumeCaptureActive() {
	return resumeBuffers.size > 0;
}

/**
 * Whether a topic has an open resume barrier - a consumer mid-cutover holds
 * frames for it, so registry eviction must pass it over.
 * @param {string} topic
 */
export function resumeTopicHeld(topic) {
	return resumeBuffers.size > 0 && resumeBuffers.has(topic);
}

/**
 * @param {string} topic
 * @param {string} envelope
 */
export function captureResumeFrame(topic, envelope) {
	const set = resumeBuffers.get(topic);
	if (set === undefined) return;
	for (const buffer of set) {
		if (buffer.frames.length >= MAX_RESUME_BUFFERED_FRAMES) {
			buffer.overflow = true;
			continue;
		}
		buffer.frames.push(envelope);
	}
}

/**
 * Open a barrier for `topics` on behalf of one awaiting connection.
 *
 * @param {string[]} topics
 * @param {object} facade - the connection's socket facade
 * @returns {{ facade: object, entries: Array<{ topic: string, buffer: { frames: string[], overflow: boolean } }> }}
 */
export function beginResumeCapture(topics, facade) {
	const entries = [];
	for (const topic of topics) {
		const buffer = { frames: [], overflow: false };
		let set = resumeBuffers.get(topic);
		if (set === undefined) {
			set = new Set();
			resumeBuffers.set(topic, set);
		}
		set.add(buffer);
		entries.push({ topic, buffer });
	}
	return { facade, entries };
}

/** @param {{ topic: string, buffer: object }} entry */
function unregister(entry) {
	const set = resumeBuffers.get(entry.topic);
	if (set === undefined) return;
	set.delete(/** @type {any} */ (entry.buffer));
	if (set.size === 0) resumeBuffers.delete(entry.topic);
}

/** @param {ReturnType<typeof beginResumeCapture>} handle */
export function discardResumeCapture(handle) {
	for (const entry of handle.entries) unregister(entry);
	handle.entries.length = 0;
}

/**
 * Flush one topic's captured frames to the connection and retire its entry.
 *
 * @param {ReturnType<typeof beginResumeCapture>} handle
 * @param {string} topic
 * @param {(payload: string) => number} deliver - tri-state send (2 = dropped)
 */
export function flushResumeTopic(handle, topic, deliver) {
	const index = handle.entries.findIndex((e) => e.topic === topic);
	if (index === -1) return;
	const entry = handle.entries[index];
	const truncatedMarker = () =>
		deliver('{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}');
	let failed = false;
	if (entry.buffer.overflow) {
		// Overflow: signal truncation FIRST so the resync marker is not lost
		// behind the partial flush.
		if (truncatedMarker() === 2) failed = true;
	}
	if (!failed) {
		for (const envelope of entry.buffer.frames) {
			if (deliver(envelope) === 2) {
				// A shed frame is a hole the client cannot detect by itself;
				// the resync marker says so. A marker that is itself shed means
				// the connection cannot be told - the caller closes it.
				failed = truncatedMarker() === 2;
				break;
			}
		}
	}
	unregister(entry);
	handle.entries.splice(index, 1);
	if (failed && typeof handle.facade?.end === 'function') {
		handle.facade.end(1013, 'resume flush overflow');
	}
}
