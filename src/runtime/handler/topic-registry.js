// The JS topic registry: the pub/sub fan-out surface the native tier gets
// from uWS's topic tree. Two indexes kept in lockstep - per-socket topic sets
// for membership queries and close-time cleanup, and a per-topic socket set
// so a publish walks exactly the subscribers of that topic rather than every
// connection on the server.

/** @type {Map<import('ws').WebSocket, Set<string>>} */
const socketTopics = new Map();

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const topicSockets = new Map();

const OPEN = 1;

/** @param {import('ws').WebSocket} rawWs */
export function registerSocket(rawWs) {
	socketTopics.set(rawWs, new Set());
}

/**
 * Remove a socket from both indexes. Returns the topics it held so close
 * accounting can walk them.
 * @param {import('ws').WebSocket} rawWs
 * @returns {Set<string>}
 */
export function unregisterSocket(rawWs) {
	const topics = socketTopics.get(rawWs) ?? new Set();
	for (const topic of topics) {
		const set = topicSockets.get(topic);
		if (set) {
			set.delete(rawWs);
			if (set.size === 0) topicSockets.delete(topic);
		}
	}
	socketTopics.delete(rawWs);
	return topics;
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {string} topic
 * @returns {boolean} false when the socket is not registered (already closed)
 */
export function subscribeSocket(rawWs, topic) {
	const topics = socketTopics.get(rawWs);
	if (!topics) return false;
	topics.add(topic);
	let set = topicSockets.get(topic);
	if (!set) {
		set = new Set();
		topicSockets.set(topic, set);
	}
	set.add(rawWs);
	return true;
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {string} topic
 * @returns {boolean}
 */
export function unsubscribeSocket(rawWs, topic) {
	const topics = socketTopics.get(rawWs);
	if (!topics || !topics.delete(topic)) return false;
	const set = topicSockets.get(topic);
	if (set) {
		set.delete(rawWs);
		if (set.size === 0) topicSockets.delete(topic);
	}
	return true;
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {string} topic
 * @returns {boolean}
 */
export function socketHolds(rawWs, topic) {
	return socketTopics.get(rawWs)?.has(topic) ?? false;
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @returns {string[]}
 */
export function socketTopicList(rawWs) {
	return [...(socketTopics.get(rawWs) ?? [])];
}

/**
 * Live subscriber count for one topic (open sockets only).
 * @param {string} topic
 * @returns {number}
 */
export function numSubscribers(topic) {
	const set = topicSockets.get(topic);
	if (!set) return 0;
	let n = 0;
	for (const ws of set) if (ws.readyState === OPEN) n++;
	return n;
}

/**
 * The subscriber set of one topic, or null. Callers must not mutate it.
 * @param {string} topic
 * @returns {Set<import('ws').WebSocket> | null}
 */
export function subscribersOf(topic) {
	return topicSockets.get(topic) ?? null;
}

/**
 * All sockets currently registered. Callers must not mutate.
 * @returns {Map<import('ws').WebSocket, Set<string>>}
 */
export function allSockets() {
	return socketTopics;
}
