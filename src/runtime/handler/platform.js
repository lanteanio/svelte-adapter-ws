// The base `platform` object exposed to SvelteKit as `event.platform` and to
// every WebSocket hook. Same surface as the family's native tier; JSON is the
// delivery tier here, with the binary wire lanes delegating to it until the
// 0x03 path lands. Per-request and per-connection platforms are created with
// `Object.create(platform)` so getters stay live and keys installed by
// sibling packages reach every clone through the prototype chain.

// Substituted by the adapter's build step; free identifiers until then.
/* global WS_OPTIONS */
import {
	WS_ATTRIBUTION, WS_CAPS, WS_COALESCED, WS_PENDING_REQUESTS, WS_PLATFORM,
	WS_PUBLISH_GRANT, WS_REVOKED_UNSUBSCRIBE, WS_SESSION_ID, WS_SUBSCRIPTIONS,
	beginPendingSubscribe, pendingSubscribeTotal, settlePendingSubscribe,
	settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership,
	tombstonePendingSubscribe, releaseDerivedSubscriptions,
	addLogicalSubscription, removeLogicalSubscription, isAuthorizationHook
} from '../utils/ws-symbols.js';
import {
	MAX_COALESCED_KEYS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION,
	MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_SUBSCRIPTIONS_PER_CONNECTION
} from '../utils/caps.js';
import {
	deniesUngrantedObserve, exceedsPendingSubscribeCap, exceedsSubscriptionCap
} from '../utils/subscribe-policy.js';
import { esc, isValidWireTopic, createTopicHelperCache } from '../utils/topic.js';
import {
	completeEnvelope, completeGameEnvelope, createHlc, stampSeqValue,
	throwInvalidSeq, topicEpochValue, wrapBatchEnvelope
} from '../utils/epoch.js';
import { collapseByCoalesceKey, drainCoalesced } from '../utils/backpressure.js';
import { readAssertionCounts, fatal } from '../utils/assertions.js';
import { now, monotonicNow, randomFloat, randomU32, randomUuid, randomBytes, setTimer, clearTimer } from '../runtime.js';
import { trace, activeTraceContext } from '../tracing.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorMessage } from '../error-registry.js';
import { wsModule } from '../ws-handler-bridge.js';
import { counters, subscribeAuth, topicSeqs, wsConnections, wsWrappers } from './state.js';
import { allSockets, numSubscribers, socketHolds, subscribersOf } from './topic-registry.js';
import { captureResumeFrame, resumeCaptureActive } from './resume-capture.js';
import { bumpOut } from './conn-stats.js';
import { isWarmupRequest } from './warmup-registry.js';

const OPEN = 1;

// Whether a permessage-deflate compressor is configured; when false every
// send stays uncompressed and the per-message flag costs nothing.
const WS_COMPRESSION_ON = Boolean(WS_OPTIONS && WS_OPTIONS.compression);

const ALLOW_NON_ASCII_TOPICS = Boolean(WS_OPTIONS && WS_OPTIONS.allowNonAsciiTopics);

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

let sendToAsyncWarned = false;

/**
 * Whether the app ships its own subscribe authorization (a side-effect-only
 * plugin hook does not count).
 */
function hasUserSubscribeHook() {
	return isAuthorizationHook(wsModule.subscribe) || isAuthorizationHook(wsModule.subscribeBatch);
}

/**
 * Run the user's subscribe-hook chain for one topic: subscribeBatch wins when
 * exported, else subscribe.
 * @param {object} facade
 * @param {string} topic
 * @returns {Promise<string | null>}
 */
async function runUserSubscribeGate(facade, topic) {
	if (wsModule.subscribeBatch) {
		let result;
		try {
			result = await wsModule.subscribeBatch(facade, [topic], { platform: facade.getUserData()[WS_PLATFORM] });
		} catch (err) {
			console.error('[adapter-ws] subscribeBatch hook threw:', err);
			return 'INTERNAL_ERROR';
		}
		try {
			if (result && typeof result === 'object') {
				const val = /** @type {Record<string, unknown>} */ (result)[topic];
				if (val === false) return 'FORBIDDEN';
				if (typeof val === 'string') return val;
			}
			return null;
		} catch (err) {
			console.error('[adapter-ws] subscribeBatch result read threw:', err);
			return 'INTERNAL_ERROR';
		}
	}
	if (!wsModule.subscribe) return null;
	try {
		const result = await wsModule.subscribe(facade, topic, { platform: facade.getUserData()[WS_PLATFORM] });
		if (result === false) return 'FORBIDDEN';
		if (typeof result === 'string') return result;
		return null;
	} catch (err) {
		console.error('[adapter-ws] subscribe hook threw:', err);
		return 'INTERNAL_ERROR';
	}
}

/**
 * Deliver one text envelope to every live subscriber of `topic`, excluding at
 * most one connection (matched as facade or raw socket). Returns whether any
 * delivery happened. Sheds per-socket past the backpressure ceiling exactly
 * like a direct send.
 *
 * @param {string} topic
 * @param {string} envelope
 * @param {object | null} excludeWs
 * @param {boolean} compress
 * @returns {boolean}
 */
function fanOut(topic, envelope, excludeWs, compress) {
	const subscribers = subscribersOf(topic);
	if (!subscribers) return false;
	let sent = false;
	for (const rawWs of subscribers) {
		if (rawWs.readyState !== OPEN) continue;
		const facade = wsWrappers.get(rawWs);
		if (excludeWs !== null && (rawWs === excludeWs || facade === excludeWs)) continue;
		if (!facade) continue;
		try {
			const result = /** @type {any} */ (facade).send(envelope, false, compress);
			if (result !== 2) sent = true;
			bumpOut(/** @type {any} */ (facade).getUserData(), envelope);
		} catch {
			counters.closedWsAborts++;
		}
	}
	return sent;
}

/**
 * Publish one event to a topic's local subscribers, stamping the topic seq.
 *
 * @param {string} topic
 * @param {string} event
 * @param {unknown} [data]
 * @param {{ relay?: boolean, seq?: boolean | number, compress?: boolean, jitterMs?: number, excludeWs?: object } | undefined} [options]
 * @returns {boolean}
 */
function publish(topic, event, data, options) {
	// Read each option exactly once into a local before any validation - a
	// stateful accessor must not answer validation with one value and the
	// stamp with another.
	const seqOption = options != null ? options.seq : undefined;
	const compressOption = options != null ? options.compress : undefined;
	const jitterOption = options != null ? options.jitterMs : undefined;
	const excludeWs = (options && options.excludeWs) || null;

	const seq = stampSeqValue(seqOption, topicSeqs, topic);
	const jitterMs = typeof jitterOption === 'number' && jitterOption > 0 ? jitterOption : null;
	const envelope = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, jitterMs);
	fatal(envelope.length > 0, 'envelope.empty', null);

	if (resumeCaptureActive()) captureResumeFrame(topic, envelope);

	const compress = WS_COMPRESSION_ON && compressOption !== false;
	return fanOut(topic, envelope, excludeWs, compress);
}

/**
 * @param {object} facade
 * @param {string} topic
 * @param {string} event
 * @param {unknown} [data]
 * @param {{ compress?: boolean } | undefined} [options]
 * @returns {number} 0 | 1 | 2
 */
function send(facade, topic, event, data, options) {
	const payload = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
	const compress = WS_COMPRESSION_ON && (!options || options.compress !== false);
	try {
		const result = /** @type {any} */ (facade).send(payload, false, compress);
		bumpOut(/** @type {any} */ (facade).getUserData(), payload);
		return result;
	} catch {
		// The documented tri-state collapse: a freed handle reports DROPPED so
		// callers can pattern-match without distinguishing closed from
		// backpressure-dropped.
		counters.closedWsAborts++;
		return 2;
	}
}

/**
 * @param {object} facade
 * @param {string} event
 * @param {unknown} [data]
 * @param {{ timeoutMs?: number } | undefined} [options]
 * @returns {Promise<unknown>}
 */
function request(facade, event, data, options) {
	let userData;
	try {
		userData = /** @type {any} */ (facade).getUserData();
	} catch {
		counters.closedWsAborts++;
		return Promise.reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED, REQUEST_CLOSED_DETAIL.NEVER_SENT)));
	}
	let pending = userData[WS_PENDING_REQUESTS];
	if (!pending) {
		pending = new Map();
		userData[WS_PENDING_REQUESTS] = pending;
	}
	if (pending.size >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
		return Promise.reject(new Error(
			'pending requests exceeded ' + MAX_PENDING_REQUESTS_PER_CONNECTION + ' on this connection'
		));
	}
	const ref = counters.nextRequestRef++;
	const timeoutMs = (options && options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const timer = setTimer(() => {
			if (pending.delete(ref)) reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT)));
		}, timeoutMs);
		const entry = { resolve, reject, timer, sent: false };
		pending.set(ref, entry);
		const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
		// A `2` result means the frame never reached the transport - the close
		// sweep reads this to say which side of transmission the close landed on.
		let result = 2;
		try {
			result = /** @type {any} */ (facade).send(payload, false, false);
		} catch {
			counters.closedWsAborts++;
		}
		entry.sent = result !== 2;
		bumpOut(userData, payload);
	});
}

export const platform = {
	// The observer lane's deny-unwind (authorizeDerivedSubscribe) runs the
	// app's unsubscribe hook through this slot - the shared primitive has no
	// reference to this runtime's hook container.
	[WS_REVOKED_UNSUBSCRIBE](ws, topic, ud) {
		wsModule.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
	},

	publish,

	/**
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: object }>} messages
	 */
	publishBatched(messages) {
		if (!Array.isArray(messages) || messages.length === 0) return;
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;
		const firstTopic = messages[0].topic;
		let allSameTopic = true;
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
		}
		let allSeeAll = allSameTopic;
		/** @type {Set<string> | null} */
		let batchTopics = null;
		if (!allSameTopic) {
			batchTopics = new Set();
			for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
			allSeeAll = true;
			for (const [rawWs, topics] of allSockets()) {
				if (rawWs.readyState !== OPEN || topics.size === 0) continue;
				let touchesAny = false;
				let touchesAll = true;
				for (const t of batchTopics) {
					if (topics.has(t)) touchesAny = true;
					else touchesAll = false;
				}
				if (touchesAny && !touchesAll) { allSeeAll = false; break; }
			}
		}
		if (!allSameTopic && !allSeeAll) {
			// Slow-path fallback: per-event publish() so small / disjoint batch
			// shapes pay no shared-frame machinery.
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				publish(m.topic, m.event, m.data, /** @type {any} */ (m.options));
			}
			return;
		}
		// Fast path: build per-event envelopes (each stamped with its topic's
		// seq) and a shared batch frame for cap-able subscribers.
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const opts = /** @type {any} */ (m.options);
			const seq = stampSeqValue(opts != null ? opts.seq : undefined, topicSeqs, m.topic);
			events[i] = {
				topic: m.topic,
				env: completeEnvelope('{"topic":' + esc(m.topic) + ',"event":' + esc(m.event) + ',"data":', m.data, seq, null)
			};
		}
		if (resumeCaptureActive()) {
			for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].env);
		}
		const slice = new Array(events.length);
		for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
		const sharedBatchEnv = wrapBatchEnvelope(slice);
		for (const [rawWs, topics] of allSockets()) {
			if (rawWs.readyState !== OPEN) continue;
			let receives = false;
			if (allSameTopic) {
				receives = topics.has(firstTopic);
			} else {
				for (const t of /** @type {Set<string>} */ (batchTopics)) {
					if (topics.has(t)) { receives = true; break; }
				}
			}
			if (!receives) continue;
			const facade = wsWrappers.get(rawWs);
			if (!facade) continue;
			const userData = /** @type {any} */ (facade).getUserData();
			const caps = userData[WS_CAPS];
			try {
				if (caps && caps.has('batch')) {
					/** @type {any} */ (facade).send(sharedBatchEnv, false, false);
					bumpOut(userData, sharedBatchEnv);
				} else {
					for (let i = 0; i < events.length; i++) {
						if (!allSameTopic && !topics.has(events[i].topic)) continue;
						/** @type {any} */ (facade).send(events[i].env, false, false);
						bumpOut(userData, events[i].env);
					}
				}
			} catch {
				counters.closedWsAborts++;
			}
		}
	},

	/**
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: object }>} messages
	 * @returns {boolean[]}
	 */
	batch(messages) {
		const results = [];
		for (let i = 0; i < messages.length; i++) {
			const { topic, event, data, options } = messages[i];
			results.push(publish(topic, event, data, /** @type {any} */ (options)));
		}
		return results;
	},

	// Binary wire delegation tier: a JSON envelope is a documented
	// representation of every wire event (a client must accept it at any
	// time), so until the 0x03 fan-out lands these deliver the JSON form
	// with identical option semantics.
	publishWire(topic, event, data, _wire, options) {
		return publish(topic, event, data, /** @type {any} */ (options));
	},
	sendWire(ws, topic, event, data, _wire) {
		return send(ws, topic, event, data);
	},
	publishWireBatch(topic, event, entries, _wire, options) {
		if (!Array.isArray(entries) || entries.length === 0) return false;
		const opts = options == null
			? options
			: { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs, jitterMs: options.jitterMs };
		// A batch-level numeric seq would stamp every entry identically.
		if (opts && typeof opts.seq === 'number') throwInvalidSeq(opts.seq);
		const count = entries.length;
		const datas = new Array(count);
		const excludes = new Array(count);
		/** @type {Array<number | undefined> | null} */
		let entrySeqs = null;
		for (let i = 0; i < count; i++) {
			const entry = entries[i];
			datas[i] = entry.data;
			excludes[i] = entry.excludeWs;
			const entrySeq = entry.seq;
			if (typeof entrySeq === 'number') {
				if (!Number.isInteger(entrySeq) || entrySeq < 1) throwInvalidSeq(entrySeq);
				if (entrySeqs === null) entrySeqs = new Array(count);
				entrySeqs[i] = entrySeq;
			}
		}
		let ok = false;
		for (let i = 0; i < count; i++) {
			const entrySeq = entrySeqs === null ? undefined : entrySeqs[i];
			let per = opts;
			if (excludes[i] !== undefined || entrySeq !== undefined) {
				per = { ...(opts || {}) };
				if (excludes[i] !== undefined) per.excludeWs = excludes[i];
				if (entrySeq !== undefined) per.seq = entrySeq;
			}
			ok = publish(topic, event, datas[i], /** @type {any} */ (per)) || ok;
		}
		return ok;
	},
	sendWireBatch(ws, topic, event, entries, _wire) {
		let result = 1;
		for (let i = 0; i < entries.length; i++) {
			result = send(ws, topic, event, entries[i].data);
		}
		return result;
	},
	registerWireCodec(_wire) {},

	send,

	/**
	 * @param {(userData: any) => boolean} filter
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @param {{ compress?: boolean } | undefined} [options]
	 * @returns {number}
	 */
	sendTo(filter, topic, event, data, options) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
		const compress = WS_COMPRESSION_ON && Boolean(options && options.compress === true);
		const targets = [];
		for (const facade of wsConnections) {
			let userData;
			try {
				userData = /** @type {any} */ (facade).getUserData();
			} catch {
				counters.closedWsAborts++;
				continue;
			}
			const decision = filter(userData);
			if (decision && typeof (/** @type {any} */ (decision).then) === 'function') {
				// Fail-closed: an async filter cannot gate a synchronous walk.
				if (!sendToAsyncWarned) {
					sendToAsyncWarned = true;
					console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SENDTO_ASYNC_FILTER));
				}
				continue;
			}
			if (decision) targets.push(facade);
		}
		if (targets.length === 0) return 0;
		let count = 0;
		for (const facade of targets) {
			try {
				/** @type {any} */ (facade).send(envelope, false, compress);
				bumpOut(/** @type {any} */ (facade).getUserData(), envelope);
				count++;
			} catch {
				counters.closedWsAborts++;
			}
		}
		return count;
	},

	/**
	 * Latest-value-wins coalescing per (connection, key), flushed immediately
	 * and again on every drain.
	 * @param {object} facade
	 * @param {{ key?: string, topic: string, event: string, data?: unknown }} message
	 */
	sendCoalesced(facade, { key, topic, event, data }) {
		let userData;
		try {
			userData = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return;
		}
		const coalesceKey = key ?? topic + '\0' + event;
		let pending = userData[WS_COALESCED];
		if (!pending) {
			pending = new Map();
			userData[WS_COALESCED] = pending;
		}
		if (pending.size >= MAX_COALESCED_KEYS_PER_CONNECTION && !pending.has(coalesceKey)) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		pending.set(coalesceKey, { topic, event, data });
		flushCoalescedFor(facade, userData);
	},

	/**
	 * @param {{ windowMs?: number, afterMs?: number, close?: boolean, filter?: (userData: any) => boolean } | undefined} [options]
	 * @returns {number}
	 */
	adviseReconnect(options) {
		const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
			? Math.floor(options.windowMs) : 0;
		if (windowMs <= 0) return 0;
		const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
			? Math.floor(options.afterMs) : 0;
		const doClose = !options || options.close !== false;
		const filter = options && typeof options.filter === 'function' ? options.filter : null;
		const frame = afterMs > 0
			? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
			: '{"type":"reconnect","windowMs":' + windowMs + '}';
		let count = 0;
		for (const facade of wsConnections) {
			try {
				const userData = /** @type {any} */ (facade).getUserData();
				if (filter) {
					const decision = filter(userData);
					if (decision && typeof (/** @type {any} */ (decision).then) === 'function') continue;
					if (!decision) continue;
				}
				/** @type {any} */ (facade).send(frame, false, false);
				bumpOut(userData, frame);
				if (doClose) /** @type {any} */ (facade).end(1001, 'Server draining');
				count++;
			} catch {
				counters.closedWsAborts++;
			}
		}
		return count;
	},

	request,

	/**
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @param {{ timeoutMs?: number } | undefined} [options]
	 */
	requestTopic(topic, event, data, options) {
		const timeoutMs = (options && options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
		const subscribers = subscribersOf(topic);
		const targets = [];
		if (subscribers) {
			for (const rawWs of subscribers) {
				const facade = wsWrappers.get(rawWs);
				if (facade) targets.push(facade);
			}
		}
		return Promise.all(targets.map((facade) =>
			request(facade, event, data, { timeoutMs })
				.then((reply) => ({ ok: true, reply }))
				.catch((err) => ({ ok: false, error: (err && err.message) ? err.message : String(err) }))
		));
	},

	get connections() { return wsConnections.size; },

	get traceContext() {
		return activeTraceContext() ?? /** @type {any} */ (this).connectionTraceContext ?? null;
	},

	trace,

	diagnostic(_diagnosticId) { return undefined; },

	get pressure() {
		// The sampler lands with the pressure lane; until then this is the
		// documented "not sampled yet" placeholder every consumer must handle
		// before a first tick anyway. sampledAt null is the discriminator.
		return {
			sampledAt: null,
			active: false,
			value: 0,
			subscriberRatio: 0,
			publishRate: 0,
			memoryMB: 0,
			reason: 'NONE',
			psi: null,
			cpuThrottle: null,
			maxBufferedBytes: 0,
			backpressuredConnections: 0,
			droppedFrames: counters.droppedFrames,
			droppedBytes: counters.droppedBytes,
			egress: { deliveries: 0, bytes: 0, refusedTopic: 0, refusedTenant: 0 },
			topPublishers: []
		};
	},

	get protection() { return 'normal'; },

	get metrics() { return null; },

	metricsSnapshot() { return Promise.resolve(null); },

	onPressure(_cb) { return () => {}; },
	onPublishRate(_cb) { return () => {}; },

	/**
	 * Server-side subscribe with the app's authorization hook. Returns null
	 * on success, the denial reason string on failure.
	 * @param {object} facade
	 * @param {string} topic
	 * @returns {Promise<string | null>}
	 */
	async subscribe(facade, topic) {
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		let ud;
		try {
			ud = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return null;
		}
		const subs = ud?.[WS_SUBSCRIPTIONS];
		fatal(subs instanceof Set, 'subs.shape', null);
		if (!(subs instanceof Set)) return 'INVALID_TOPIC';
		if (subs.has(topic)) return null;
		if (exceedsSubscriptionCap({ held: false, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
		if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(ud), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) return 'RATE_LIMITED';
		const token = beginPendingSubscribe(ud, topic, subs.has(topic));
		const denial = await runUserSubscribeGate(facade, topic);
		if (denial !== null) {
			if (settleDeniedSubscribe(ud, topic, token, subs.has(topic)) === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
			}
			return denial;
		}
		if (subs.has(topic)) {
			const heldVerdict = settleHeldSubscribe(ud, topic, token);
			if (heldVerdict === 'ack') return null;
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
			}
			return 'FORBIDDEN';
		}
		if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
			settlePendingSubscribe(ud, topic, token);
			return 'RATE_LIMITED';
		}
		if (!settlePendingSubscribe(ud, topic, token, true)) return 'FORBIDDEN';
		try {
			/** @type {any} */ (facade).subscribe(topic);
		} catch {
			counters.closedWsAborts++;
			return null;
		}
		addLogicalSubscription(subs, topic);
		return null;
	},

	/**
	 * Pure gate: consult the hook chain without subscribing.
	 * @param {object} facade
	 * @param {string} topic
	 * @param {{ requireGrant?: boolean } | undefined} [opts]
	 * @returns {Promise<string | null>}
	 */
	async checkSubscribe(facade, topic, opts) {
		if (!isValidWireTopic(topic, opts && opts.requireGrant ? ALLOW_NON_ASCII_TOPICS : true)) {
			return 'INVALID_TOPIC';
		}
		const requireGrant = Boolean(opts && opts.requireGrant);
		let observerHasUserHook = false;
		if (requireGrant) {
			observerHasUserHook = hasUserSubscribeHook();
			let granted;
			try { granted = /** @type {any} */ (facade).getUserData()[WS_SUBSCRIPTIONS]; }
			catch { return 'FORBIDDEN'; }
			if (deniesUngrantedObserve(subscribeAuth.enabled, observerHasUserHook && !subscribeAuth.strict, granted, topic)) {
				return 'FORBIDDEN';
			}
		}
		const denial = await runUserSubscribeGate(facade, topic);
		if (denial !== null) return denial;
		if (requireGrant) {
			// Re-read after the async hook: a grant revoked inside that await
			// must not produce an allow answer after it is gone.
			let granted;
			try { granted = /** @type {any} */ (facade).getUserData()[WS_SUBSCRIPTIONS]; }
			catch { return 'FORBIDDEN'; }
			if (deniesUngrantedObserve(subscribeAuth.enabled, observerHasUserHook && !subscribeAuth.strict, granted, topic)) {
				return 'FORBIDDEN';
			}
		}
		return null;
	},

	/**
	 * @param {'legacy' | 'strict'} [mode]
	 */
	authorizeWireSubscribe(mode = 'legacy') {
		if (mode !== 'legacy' && mode !== 'strict') {
			throw new TypeError("authorizeWireSubscribe mode must be 'legacy' or 'strict'");
		}
		subscribeAuth.enabled = true;
		if (mode === 'strict') subscribeAuth.strict = true;
		return subscribeAuth.strict ? 'strict' : 'legacy';
	},

	/**
	 * @param {object} facade
	 * @param {string} topic
	 * @returns {boolean}
	 */
	unsubscribe(facade, topic) {
		let ud;
		try {
			ud = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return false;
		}
		const subs = ud?.[WS_SUBSCRIPTIONS];
		// Cancel any subscribe still parked in its authorization hook - a
		// revoke must not be re-installed by a parked attempt landing later.
		const cancelledPending = ud ? tombstonePendingSubscribe(ud, topic) : false;
		// Revoking read access revokes WRITE access with it.
		if (ud && ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
		// And the observer taps a plugin registered on this topic.
		releaseDerivedSubscriptions(facade, topic);
		if (!(subs instanceof Set) || !subs.has(topic)) return cancelledPending;
		try {
			/** @type {any} */ (facade).unsubscribe(topic);
		} catch {
			counters.closedWsAborts++;
			return false;
		}
		removeLogicalSubscription(subs, topic);
		wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
		return true;
	},

	// Client-publish authorization (the `game` lane). A connection is bound
	// to exactly one topic it may publish to via a topicless `game` frame.
	grantPublish(facade, topic) {
		let ud;
		try {
			ud = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return false;
		}
		if (!ud) return false;
		ud[WS_PUBLISH_GRANT] = topic;
		return true;
	},
	revokePublish(facade) {
		let ud;
		try {
			ud = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return false;
		}
		if (!ud || ud[WS_PUBLISH_GRANT] === undefined) return false;
		ud[WS_PUBLISH_GRANT] = undefined;
		return true;
	},
	publishGrant(facade) {
		try {
			return /** @type {any} */ (facade).getUserData()?.[WS_PUBLISH_GRANT] ?? null;
		} catch {
			counters.closedWsAborts++;
			return null;
		}
	},

	/**
	 * Stamp the room seq and fan the game envelope out excluding the sender.
	 * @param {object} senderWs - facade or raw socket
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {string | number} [id]
	 * @returns {{ seq: number | null, delivered: number }}
	 */
	publishGame(senderWs, topic, event, data, id) {
		const seq = stampSeqValue(undefined, topicSeqs, topic);
		const env = completeGameEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, id);
		if (resumeCaptureActive()) captureResumeFrame(topic, env);
		const subscribers = subscribersOf(topic);
		let delivered = 0;
		if (subscribers) {
			for (const rawWs of subscribers) {
				const facade = wsWrappers.get(rawWs);
				if (rawWs === senderWs || facade === senderWs) continue;
				if (rawWs.readyState !== OPEN || !facade) continue;
				try {
					/** @type {any} */ (facade).send(env, false, false);
					bumpOut(/** @type {any} */ (facade).getUserData(), env);
					delivered++;
				} catch {
					counters.closedWsAborts++;
				}
			}
		}
		return { seq, delivered };
	},

	get assertions() { return readAssertionCounts(); },

	get closedWsAborts() { return counters.closedWsAborts; },

	introspect() {
		const p = /** @type {any} */ (this).pressure;
		return {
			connections: wsConnections.size,
			closedWsAborts: counters.closedWsAborts,
			protection: /** @type {any} */ (this).protection,
			maxPayloadLength: /** @type {any} */ (this).maxPayloadLength,
			pressure: {
				sampledAt: p.sampledAt ?? null,
				active: p.active,
				reason: p.reason,
				value: p.value ?? 0,
				subscriberRatio: p.subscriberRatio,
				publishRate: p.publishRate,
				memoryMB: p.memoryMB,
				maxBufferedBytes: p.maxBufferedBytes ?? 0,
				backpressuredConnections: p.backpressuredConnections ?? 0,
				droppedFrames: p.droppedFrames ?? 0,
				droppedBytes: p.droppedBytes ?? 0,
				egress: {
					deliveries: p.egress?.deliveries ?? 0,
					bytes: p.egress?.bytes ?? 0,
					refusedTopic: p.egress?.refusedTopic ?? 0,
					refusedTenant: p.egress?.refusedTenant ?? 0
				}
			},
			assertions: Object.fromEntries(readAssertionCounts())
		};
	},

	/** @param {string} topic */
	subscribers(topic) {
		return numSubscribers(topic);
	},

	isWarmupRequest,

	/**
	 * @param {string} topic
	 * @param {(ws: object, userData: object) => void} fn
	 */
	forEachSubscriber(topic, fn) {
		for (const [rawWs, topics] of allSockets()) {
			if (!topics.has(topic)) continue;
			const facade = wsWrappers.get(rawWs);
			if (!facade) continue;
			try {
				fn(facade, /** @type {any} */ (facade).getUserData());
			} catch {
				counters.closedWsAborts++;
			}
		}
	},

	get maxPayloadLength() { return (WS_OPTIONS && WS_OPTIONS.maxPayloadLength) || 1024 * 1024; },

	/** @param {object} facade */
	bufferedAmount(facade) {
		try {
			return /** @type {any} */ (facade).getBufferedAmount();
		} catch {
			return 0;
		}
	},

	/** @param {string} name */
	topic(name) {
		if (!_topicHelperCache) _topicHelperCache = createTopicHelperCache(publish);
		return _topicHelperCache(name);
	},

	/** @param {string} name */
	topicEpoch(name) {
		return topicEpochValue(name);
	},

	now,
	monotonic: monotonicNow,
	random: {
		float: randomFloat,
		u32: randomU32,
		uuid: randomUuid,
		bytes: randomBytes
	},
	hlc: createHlc()
};

/** @type {((name: string) => object) | null} */
let _topicHelperCache = null;

/**
 * Flush a connection's coalesced entries through the drain-aware pump.
 * Exported for the facade's drain callback.
 *
 * @param {object} facade
 * @param {any} [userData]
 */
export function flushCoalescedFor(facade, userData) {
	let ud = userData;
	if (ud === undefined) {
		try {
			ud = /** @type {any} */ (facade).getUserData();
		} catch {
			counters.closedWsAborts++;
			return;
		}
	}
	const pending = ud?.[WS_COALESCED];
	if (!pending || pending.size === 0) return;
	drainCoalesced(pending, (value) => {
		const payload = '{"topic":' + esc(value.topic) + ',"event":' + esc(value.event) + ',"data":' + JSON.stringify(value.data ?? null) + '}';
		try {
			const result = /** @type {any} */ (facade).send(payload, false, false);
			bumpOut(ud, payload);
			return result;
		} catch {
			counters.closedWsAborts++;
			return 2;
		}
	});
}

export { hasUserSubscribeHook, runUserSubscribeGate, WS_COMPRESSION_ON, ALLOW_NON_ASCII_TOPICS };
