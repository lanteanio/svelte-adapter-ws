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
	resolveEntrySeq, resolveSendSeq, assertStampableSeq, topicEpochValue, mintTopicEpoch, overrideTopicEpoch, wrapBatchEnvelope
} from '../utils/epoch.js';
import { parentPort } from 'node:worker_threads';
import { collapseByCoalesceKey, drainCoalesced } from '../utils/backpressure.js';
import { readAssertionCounts, assert, fatal } from '../utils/assertions.js';
import { now, monotonicNow, processMonotonicNow, randomFloat, randomU32, randomUuid, randomBytes, setTimer, clearTimer } from '../runtime.js';
import { trace, activeTraceContext } from '../tracing.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorMessage } from '../error-registry.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { wsModule } from '../ws-handler-bridge.js';
import { metricsRegistry } from '../metrics-bridge.js';
import { metricsSnapshot } from './metrics-snapshot.js';
import { buildBinaryFrame } from '../wire.js';
import { capCounts, counters, divergenceDiagnostics, maxSeenSeq, originStreams, pressureListeners, pressureSnapshot, publishRateListeners, recordOriginStream, recordSeen, recordStampedSeen, relayAttach, sharedTopics, streamTracking, subscribeAuth, topicSeqs, wsConnections, wsWrappers } from './state.js';
import { cohortTopics, joinSharedCohort, leaveSharedCohort } from './cohort.js';
import { getSharedWireId, sharedWireIdRefs } from './shared-wire-id.js';
import { seqBound } from './seq-bound.js';
import { egressGate, resolvePublishTenant, admitPublishEgress, admitTopicEgress, admitTenantEgress, chargePublishEgress, chargeDirectEgress, excludedRecipient, binaryFrameChargeBytes, envelopeWireBytes, markAdmitted, admittedByBatch } from './egress-budget.js';
import { ensureWireId, ensureWireState, wireStatePoisoned, poisonWireState } from './wire-state.js';
import { deliverStatelessWireFanout, deliverStatefulWireBatch, encodeStatelessWirePayload } from './wire-fanout.js';
import { registerWireCodec, getWireCodec } from './codec-registry.js';
import { batchRelay, relayBatched } from './relay.js';
import {
	assertClusterSequenceAuthority, assertClusterSequenceAuthorityValues,
	assertBatchSequenceAuthority, assertBatchEntrySequenceAuthority
} from './cluster-sequence-policy.js';

// The relay receive half's token, passed as an argument to publishWire and
// compared by identity. Module-private on purpose: it is never exported, never
// placed on any object a caller can reach, and never used as a property key,
// so there is nothing to name and nothing to answer. What it gates is every
// origin-side guard at once - the cluster sequence-authority rule, the seq
// value check, the egress decision, the publish counter, the stamp and the
// relay decision - because a sibling worker already did all of them for this
// frame.
const RELAY_RECEIVE = Symbol('adapter-ws.relay-receive');
import { GAME_FANOUT_CAP, GAME_FANOUT_SCHEMA_VERSION, encodeGameFanoutPayload, assertGameLaneClusterSafe } from './game-ingress.js';
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
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.subscribe',
				event: 'subscribe.batch-hook-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The subscribeBatch hook threw; every topic in the batch was denied INTERNAL_ERROR.',
				attributes: { error: diagnosticError(err) }
			});
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
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.subscribe',
				event: 'subscribe.batch-result-read-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'Reading the subscribeBatch result threw; every topic in the batch was denied INTERNAL_ERROR.',
				attributes: { error: diagnosticError(err) }
			});
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
		// Fail closed: a hook that throws (or rejects) denies access rather
		// than falling through to allow. Surfaces as a canonical
		// 'INTERNAL_ERROR' reason on the wire so the client can distinguish it
		// from 'FORBIDDEN' / 'UNAUTHENTICATED' / etc.
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.subscribe',
			event: 'subscribe.hook-failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The subscribe hook threw; the subscribe was denied INTERNAL_ERROR.',
			attributes: { error: diagnosticError(err) }
		});
		return 'INTERNAL_ERROR';
	}
}

/**
 * Deliver one prepared frame to every open member of a cohort topic. The
 * cohort walk sends the same bytes to every member: the shared id makes
 * the binary frame identical, and the envelope was identical already.
 * @param {string} cohort
 * @param {string | Uint8Array} frame
 * @param {boolean} binary
 * @param {boolean} compress
 * @returns {boolean} whether anyone received it
 */
function fanOutCohort(cohort, frame, binary, compress) {
	const subscribers = subscribersOf(cohort);
	if (!subscribers) return false;
	let sent = false;
	for (const rawWs of subscribers) {
		if (rawWs.readyState !== 1) continue;
		const facade = wsWrappers.get(rawWs);
		if (!facade) continue;
		try {
			if (/** @type {any} */ (facade).send(frame, binary, compress) !== 2) {
				sent = true;
				bumpOut(/** @type {any} */ (facade).getUserData(), frame);
			}
		} catch {
			counters.closedWsAborts++;
		}
	}
	return sent;
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
			if (result !== 2) {
				sent = true;
				bumpOut(/** @type {any} */ (facade).getUserData(), envelope);
			}
		} catch {
			counters.closedWsAborts++;
		}
	}
	return sent;
}

/**
 * Deliver one wire event to one connection: the binary frame when its caps
 * and codec state allow, the JSON envelope otherwise. Returns the tri-state
 * send result, or 3 when the socket was closed (the caller decides whether a
 * thrown send counts as delivery).
 *
 * @param {object} facade
 * @param {string} topic
 * @param {string} event
 * @param {unknown} data
 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: object } | null} wire
 * @param {string} jsonEnvelope
 * @param {number} seq
 * @param {boolean} compress
 * @returns {number}
 */
function deliverWireToOne(facade, topic, event, data, wire, jsonEnvelope, seq, compress) {
	let ud;
	try {
		ud = /** @type {any} */ (facade).getUserData();
	} catch {
		counters.closedWsAborts++;
		return 3;
	}
	const sendJson = () => {
		try {
			const r = /** @type {any} */ (facade).send(jsonEnvelope, false, compress);
			bumpOut(ud, jsonEnvelope);
			return r;
		} catch {
			counters.closedWsAborts++;
			return 3;
		}
	};
	const caps = ud[WS_CAPS];
	if (!wire || typeof wire.capability !== 'string' || !caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability)) {
		return sendJson();
	}
	const state = wire.state ? ensureWireState(facade, ud, wire) : null;
	if (wire.state && state === null) return sendJson();
	let payload = null;
	try {
		payload = wire.encode(event, data, state ?? undefined);
	} catch {
		payload = null;
	}
	if (payload == null) return sendJson();
	const id = ensureWireId(facade, ud, topic);
	if (id === -1) {
		poisonWireState(facade, ud, wire.capability);
		return sendJson();
	}
	const schemaVersion = state && typeof (/** @type {any} */ (state).schemaVersion) === 'number'
		? /** @type {any} */ (state).schemaVersion
		: wire.schemaVersion;
	let result;
	try {
		result = /** @type {any} */ (facade).send(buildBinaryFrame(schemaVersion, id, seq, payload), true, compress);
		bumpOut(ud, payload);
	} catch {
		counters.closedWsAborts++;
		return 3;
	}
	// A dropped STATEFUL frame desyncs the decoder forever; JSON is the
	// recovery tier. A dropped stateless frame advances no state and is not
	// poisoned.
	if (result === 2 && wire.state) poisonWireState(facade, ud, wire.capability);
	return result;
}

/**
 * Publish one event to a topic's local subscribers, stamping the topic seq.
 *
 * @param {string} topic
 * @param {string} event
 * @param {unknown} [data]
 * @param {{ relay?: boolean, seq?: boolean | number, compress?: boolean, jitterMs?: number } | undefined} [options]
 * @returns {boolean}
 */
/**
 * Wire bytes for one text envelope across `recipients`, or 0 while the byte
 * dimension is unarmed so the hot path never pays the UTF-8 length walk when
 * the account only counts messages rather than bytes. See `envelopeWireBytes`.
 *
 * @param {string} envelope
 * @param {number} recipients
 * @returns {number}
 */
function chargeableBytes(envelope, recipients) {
	return envelopeWireBytes(envelope, recipients, egressGate.bytesArmed);
}

/**
 * The whole-batch egress decision, taken before any entry is stamped or sent.
 *
 * Every topic in the batch admits its own share, and every tenant admits ONCE
 * against the pooled weight of the topics it owns here - asking per topic
 * against a window nothing has charged yet would let a batch spanning N topics
 * of one tenant pass N times against the same allowance. One refusal refuses
 * the whole batch: a batch that delivered a prefix and refused the tail would
 * be the mid-batch shedding this budget forbids.
 *
 * `sharedRecipients` is the recipient count every entry shares (the all-see-all
 * fast path dispatches on one topic); pass null to read each topic's own count.
 *
 * @param {Array<{ topic: string }>} messages
 * @param {number | null} sharedRecipients
 * @returns {boolean}
 */
function admitBatchEgress(messages, sharedRecipients) {
	/** @type {Map<string, number>} */
	const perTopic = new Map();
	for (let i = 0; i < messages.length; i++) {
		perTopic.set(messages[i].topic, (perTopic.get(messages[i].topic) || 0) + 1);
	}
	/** @type {Map<string, { m: number, d: number, topic: string }> | null} */
	const perTenant = egressGate.tenantArmed ? new Map() : null;
	for (const [t, c] of perTopic) {
		const recipients = sharedRecipients === null ? numSubscribers(t) : sharedRecipients;
		const deliveries = c * recipients;
		if (!admitTopicEgress(t, c, deliveries)) return false;
		if (perTenant === null) continue;
		const ten = resolvePublishTenant(t);
		if (ten === null) continue;
		const agg = perTenant.get(ten);
		if (agg === undefined) perTenant.set(ten, { m: c, d: deliveries, topic: t });
		else { agg.m += c; agg.d += deliveries; }
	}
	if (perTenant !== null) {
		for (const [ten, agg] of perTenant) {
			if (!admitTenantEgress(ten, agg.topic, agg.m, agg.d)) return false;
		}
	}
	return true;
}

function publish(topic, event, data, options) {
	// Read each option exactly once into a local before any validation - a
	// stateful accessor must not answer validation with one value and the
	// stamp with another.
	const seqOption = options != null ? options.seq : undefined;
	const relayOption = options != null ? options.relay : undefined;
	const compressOption = options != null ? options.compress : undefined;
	const jitterOption = options != null ? options.jitterMs : undefined;
	assertClusterSequenceAuthorityValues(seqOption, relayOption);
	// The VALUE, ahead of the ceiling below. Stamping is the last step on this
	// lane, so a seq the wire cannot carry used to be answered with a plain
	// `false` while the budget was armed - indistinguishable from the ordinary
	// shed - and with the TypeError only once load dropped. A programming error
	// must not surface on a schedule set by traffic.
	assertStampableSeq(seqOption);

	// Egress recipients are the topic's local subscribers, read once per
	// logical publish; the ceiling decision runs BEFORE the sequence is
	// stamped, so a refused publish leaves no client-visible seq gap and
	// nothing reaches the fan-out or the relay. Sender exclusion is a wire-lane
	// option (publishWire, publishWireBatch); this lane reads none.
	const recipients = numSubscribers(topic);
	let egressTenant = null;
	if (egressGate.armed) {
		egressTenant = resolvePublishTenant(topic);
		// The admitted marker names an event whose batch already decided for
		// the whole call (publishBatched's slow path). It still charges below -
		// every event is its own logical publish in the ledger - but
		// re-deciding here would deliver a prefix of an atomic batch.
		if (!admittedByBatch(options) &&
			!admitPublishEgress(topic, egressTenant, 1, recipients)) return false;
	}

	const seq = stampSeqValue(seqOption, topicSeqs, topic, seqBound);
	// Track the highest observed seq for this topic. An explicit numeric
	// authority takes the monotone-max guard, because several workers can
	// issue those and they arrive here in any order; the in-memory counter
	// skips the compare and keeps the membership report. Skipped when
	// stamping is off, so a { seq: false }-only topic never enters the
	// convergence comparison at all.
	if (seq !== null) {
		if (typeof seqOption === 'number' || typeof seqOption === 'bigint') recordSeen(maxSeenSeq, topic, seq, seqBound);
		else recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
	}
	// `{ jitterMs }` de-herd window: stamp it on the frame so each client rolls its
	// own delay before dispatching (spreads N receivers' follow-up actions across
	// the window). The window is carried verbatim - NOT a server-rolled offset,
	// which would defer every subscriber of this one frame identically.
	const jitterMs = typeof jitterOption === 'number' && jitterOption > 0 ? jitterOption : null;
	const envelope = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, jitterMs);
	fatal(envelope.length > 0, 'envelope.empty', null);
	// The one egress charge for this logical publish: per-topic runaway
	// stats, worker window counters, and the ceiling account. Wire bytes are
	// the envelope's UTF-8 encoding times the local recipients.
	counters.publishCountWindow++;
	counters.publishOutcomeHook?.(recipients > 0);
	chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));

	if (resumeCaptureActive()) captureResumeFrame(topic, envelope);

	const compress = WS_COMPRESSION_ON && compressOption !== false;
	const sent = fanOut(topic, envelope, null, compress);
	// Relay to sibling workers via the primary; a no-op in single-process
	// mode (no parentPort). `{ relay: false }` is for a message that arrives
	// through an external pub/sub source (Redis, Postgres) that already fans
	// out to every process - relaying it again would deliver duplicates.
	const relayed = !!(parentPort && relayOption !== false);
	if (relayed) {
		// The stamped seq rides as explicit relay-frame metadata so the
		// receiving worker never re-parses the envelope string.
		batchRelay(topic, envelope, compress, seq);
	}
	// In clustered mode subscribers may live on other workers, and a caller
	// cannot query cross-worker subscriber counts - so a fired relay counts
	// as delivery even when this worker has no local subscriber.
	return sent || relayed;
}

/**
 * Send one envelope to one connection, optionally carrying an explicit
 * replay `seq`.
 *
 * The seq is a REPLAY AUTHORITY'S value - the channel a resume hook gap-fills
 * history through - so it is stamped and nothing else happens: no counter
 * advance, no max-seen record, no resume capture. That invariant is
 * load-bearing rather than incidental, because gap-fill replays history that
 * is ALREADY accounted, and a second accounting would move the very
 * watermarks the replay is reconstructing. Number and bigint only; `false`,
 * `null` and absent mean no seq and emit today's frame byte-identically.
 * `true` throws instead of drawing the in-memory counter, because this lane
 * has none to draw.
 *
 * @param {object} facade
 * @param {string} topic
 * @param {string} event
 * @param {unknown} [data]
 * @param {{ seq?: number | bigint | false | null, compress?: boolean } | undefined} [options]
 * @returns {number} 0 | 1 | 2
 */
function send(facade, topic, event, data, options) {
	// Resolved BEFORE the try below, so an invalid spelling throws to the
	// caller regardless of socket state rather than being collapsed into the
	// DROPPED sentinel by the catch.
	const seq = resolveSendSeq(options != null ? options.seq : undefined);
	const payload = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, null);
	assert(payload.length > 0, 'envelope.send-empty', null);
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

/**
 * Deliver a batch of pre-built per-event envelopes to this worker's local
 * subscribers: the shared batch frame to 'batch'-capable connections, the
 * per-event envelopes (filtered to each connection's subscriptions in the
 * multi-topic shape) to everyone else. The fast/slow detection is the
 * caller's; this is the one walk the local fast path and the cross-worker
 * receive path share, so the two cannot drift in what a subscriber sees.
 *
 * @param {Array<{ topic: string, env: string }>} events
 * @param {boolean} allSameTopic
 * @param {string} firstTopic
 * @param {Set<string> | null} batchTopics - the distinct topics when not allSameTopic
 * @param {boolean} compress
 */
function deliverBatchedEnvelopes(events, allSameTopic, firstTopic, batchTopics, compress) {
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
				/** @type {any} */ (facade).send(sharedBatchEnv, false, compress);
				bumpOut(userData, sharedBatchEnv);
			} else {
				for (let i = 0; i < events.length; i++) {
					if (!allSameTopic && !topics.has(events[i].topic)) continue;
					/** @type {any} */ (facade).send(events[i].env, false, compress);
					bumpOut(userData, events[i].env);
				}
			}
		} catch {
			counters.closedWsAborts++;
		}
	}
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
	 * @param {{ compress?: boolean } | undefined} [options]
	 */
	publishBatched(messages, options) {
		// One compression decision for the whole batch, applied identically on
		// the shared-frame and per-event paths - the delivered shape must not
		// decide whether a frame deflates. Opt-in, like every wire lane.
		const compressOptIn = WS_COMPRESSION_ON && Boolean(options && options.compress === true);
		if (!Array.isArray(messages) || messages.length === 0) return;
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;
		// Validate the WHOLE batch before one event can mutate counters or
		// reach a subscriber - a mixed safe/unsafe batch fails atomically
		// rather than publishing its prefix. One read per field, snapshotted:
		// the value judged here is the value the stamp and the relay decision
		// use below, so a stateful accessor cannot pass the atomic pre-pass
		// and then hand the fast path an authoritative number it would relay.
		const msgSeqs = new Array(messages.length);
		const msgRelays = new Array(messages.length);
		const msgJitters = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const o = /** @type {any} */ (messages[i].options);
			const seqOption = o != null ? o.seq : undefined;
			const relayOption = o != null ? o.relay : undefined;
			msgJitters[i] = o != null ? o.jitterMs : undefined;
			assertClusterSequenceAuthorityValues(seqOption, relayOption);
			// And the VALUE, here rather than in the stamping loop below. This
			// path loses no frame either way - its send sits after the loop -
			// but the entries ahead of an unstampable one have already drawn
			// the topic counter and written max-seen, so the counter skips a
			// number no client ever saw. A client watermark can then sit above
			// a value that was never sent, and republishing that seq once the
			// payload is fixed reads as already-seen. Nothing on the wire
			// marks it.
			assertStampableSeq(seqOption);
			msgSeqs[i] = seqOption;
			msgRelays[i] = relayOption;
		}
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
			// The batch is atomic on this path too: admitting per event would
			// deliver a prefix and refuse the tail, which is the mid-batch
			// shedding the budget forbids. Each topic carries its own
			// recipient count here (the paths differ only in dispatch), and a
			// tenant decides once on everything it owns in the batch.
			if (egressGate.armed && !admitBatchEgress(messages, null)) return;
			// Slow-path fallback: per-event publish() so small / disjoint batch
			// shapes pay no shared-frame machinery. The snapshot, not a spread
			// of the live options object: publish() consumes exactly the
			// fields the atomic pre-pass above already judged.
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				publish(m.topic, m.event, m.data, /** @type {any} */ (markAdmitted({
					seq: msgSeqs[i], relay: msgRelays[i], jitterMs: msgJitters[i],
					compress: compressOptIn
				})));
			}
			return;
		}
		// Egress admission for the whole fast-path batch, before anything is
		// stamped. In all-see-all every interested subscriber holds every batch
		// topic, so the dispatch topic's count IS the recipient set for every
		// topic in the batch; a mixed-topic batch admits each distinct topic's
		// own share and pools each tenant's, and one refusal refuses the whole
		// batch (its atomicity contract).
		const recipients = numSubscribers(messages[0].topic);
		const gateArmed = egressGate.armed;
		let egressTenant = null;
		if (gateArmed) {
			if (allSameTopic) {
				egressTenant = resolvePublishTenant(firstTopic);
				if (!admitPublishEgress(firstTopic, egressTenant, messages.length, messages.length * recipients)) return;
			} else if (!admitBatchEgress(messages, recipients)) return;
		}
		// Fast path: build per-event envelopes (each stamped with its topic's
		// seq) and a shared batch frame for cap-able subscribers.
		/** @type {Array<{ topic: string, env: string, seq: number | null }>} */
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			counters.publishCountWindow++;
			counters.publishOutcomeHook?.(recipients > 0);
			const seq = stampSeqValue(msgSeqs[i], topicSeqs, m.topic, seqBound);
			// See publish(): the compare-free record for the monotonic in-memory
			// counter, the monotone-max guard for an explicit numeric seq.
			if (seq !== null) {
				if (typeof msgSeqs[i] === 'number' || typeof msgSeqs[i] === 'bigint') recordSeen(maxSeenSeq, m.topic, seq, seqBound);
				else recordStampedSeen(maxSeenSeq, m.topic, seq, seqBound);
			}
			events[i] = {
				topic: m.topic,
				env: completeEnvelope('{"topic":' + esc(m.topic) + ',"event":' + esc(m.event) + ',"data":', m.data, seq, null),
				seq
			};
			// One egress charge per logical publish: each batched event is one,
			// priced at its own envelope's UTF-8 bytes times the shared
			// recipient set. The batch frame's wrapper bytes are uncharged
			// overhead, so a tenant pays the same for N events whether the
			// runtime batches them or not.
			chargePublishEgress(m.topic,
				gateArmed ? (allSameTopic ? egressTenant : resolvePublishTenant(m.topic)) : null,
				1, recipients, events[i].env.length, chargeableBytes(events[i].env, recipients));
		}
		// Cross-worker relay: one frame carrying the pre-built per-event
		// envelopes. The receiving worker re-runs the fast/slow detection
		// against ITS OWN subscriber set and dispatches accordingly, so the
		// wire-batching win survives worker boundaries instead of degrading
		// to per-event relays. Each event's stamped seq rides along.
		if (parentPort) {
			/** @type {Array<import('./relay.js').RelayBatchedEntry>} */
			const relayed = [];
			for (let i = 0; i < messages.length; i++) {
				if (msgRelays[i] !== false) {
					relayed.push({ topic: events[i].topic, env: events[i].env, seq: events[i].seq });
				}
			}
			if (relayed.length > 0) relayBatched(relayed, compressOptIn);
		}
		if (resumeCaptureActive()) {
			for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].env);
		}
		deliverBatchedEnvelopes(events, allSameTopic, firstTopic, batchTopics, compressOptIn);
	},

	/**
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: object }>} messages
	 * @returns {boolean[]}
	 */
	batch(messages) {
		// Snapshot every message's option fields once and vet each snapshot
		// BEFORE the first publish: a mixed safe/unsafe batch fails atomically
		// instead of delivering a prefix, and the snapshot handed to publish()
		// is the same read the check judged - a stateful accessor cannot pass
		// the pre-pass and stamp under different values.
		const snapshots = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const o = /** @type {any} */ (messages[i].options);
			const snap = o == null
				? o
				: { seq: o.seq, relay: o.relay, compress: o.compress, jitterMs: o.jitterMs };
			assertClusterSequenceAuthority(snap);
			// And the VALUE, on the same snapshot the authority check just
			// read. The authority question is answered for the whole batch up
			// here, but the value question used to happen inside each
			// per-message publish() below - so a batch whose third entry
			// carried an unstampable seq delivered its first two and then
			// threw. Independent of topology, which is the point:
			// clusterSequenceValuesAccepted returns accepted without reading
			// the value whenever the runtime is not multi-worker, so on the
			// default deployment the pre-pass vetted nothing the caller wrote.
			assertStampableSeq(snap?.seq);
			snapshots[i] = snap;
		}
		const results = [];
		for (let i = 0; i < messages.length; i++) {
			const { topic, event, data } = messages[i];
			results.push(publish(topic, event, data, snapshots[i]));
		}
		return results;
	},

	/**
	 * Publish one event with a binary codec: subscribers that advertised the
	 * codec's capability receive the `0x03` frame, everyone else the JSON
	 * envelope. Compression is OFF by default on the wire lanes.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: object }} wire
	 * @param {{ seq?: boolean | number, relay?: boolean, compress?: boolean, excludeWs?: object } | undefined} [options]
	 * @param {symbol} [relayToken] INTERNAL. The relay receive half's token,
	 *   held by this module and passed by `relayPublishWire` only. Not part of
	 *   the declared surface, and nothing an options object can answer: it is
	 *   never a property key, so no accessor or proxy trap is ever asked for
	 *   it. A value that is not the token leaves the call on the ordinary
	 *   origin path. Code that has replaced this method on the platform object
	 *   sees it when the relay dispatches, which is a caller that already owns
	 *   the lane it would be forging.
	 * @param {number | null} [relaySeq] INTERNAL. The origin worker's stamped
	 *   seq, carried verbatim. Read only when the token matches.
	 * @returns {boolean}
	 */
	publishWire(topic, event, data, wire, options, relayToken, relaySeq) {
		// One read per option field (see publish). Locals, no capture object.
		const seqOption = options != null ? options.seq : undefined;
		const relayOption = options != null ? options.relay : undefined;
		const compressOption = options != null ? options.compress : undefined;
		const excludeOption = options != null ? options.excludeWs : undefined;
		// The relay marker is an ARGUMENT, not a key on the options object, and
		// it is compared by identity against a token this module never hands
		// out. A marker read as a property is unspellable but not unforgeable:
		// a caller does not have to name the key, only to pass an object that
		// answers for every key - `new Proxy({}, { get: () => null })`, or a
		// getter on a prototype - and it would then take the arm that skips the
		// authority check, the value check, the egress decision and the publish
		// counter. There is no property lookup here for such an object to
		// answer, and the origin path pays one comparison rather than a read.
		const isRelay = relayToken === RELAY_RECEIVE;
		if (!isRelay) assertClusterSequenceAuthorityValues(seqOption, relayOption);
		// And the value, before the admission below (see publish()). A relayed
		// frame carries its origin's seq, not this option, and that origin
		// already validated it.
		if (!isRelay) assertStampableSeq(seqOption);
		// Egress recipients and admission, origin-side only: a relayed frame
		// was charged once on the worker that published it, and refusing it
		// here would fork the cluster's delivery. The decision runs before the
		// stamp, exactly as in publish(); an excluded socket that holds the
		// topic is not a recipient.
		let recipients = 0;
		let egressTenant = null;
		if (!isRelay) {
			recipients = numSubscribers(topic);
			if (excludeOption !== undefined && excludeOption !== null && excludedRecipient(excludeOption, topic)) recipients--;
			if (egressGate.armed) {
				egressTenant = resolvePublishTenant(topic);
				if (!admittedByBatch(options) &&
					!admitPublishEgress(topic, egressTenant, 1, recipients)) return false;
			}
		}
		// A relayed frame carries the origin worker's stamp verbatim: the
		// origin already stamped and counted this publish once, and stamping
		// again here would fork the topic's sequence per worker.
		// The coercion stays on the READ side: it is what decides the number
		// that reaches the wire, whatever the caller of the relay path passed.
		// Without it a value that is neither number nor null is stamped into
		// the envelope verbatim.
		const seq = isRelay
			? (typeof relaySeq === 'number' ? relaySeq : null)
			: stampSeqValue(seqOption, topicSeqs, topic, seqBound);
		// Track the highest observed seq for this topic. An explicit numeric
		// authority takes the monotone-max guard, because several workers can
		// issue those and they arrive here in any order; the in-memory counter
		// skips the compare and keeps the membership report. Skipped when
		// stamping is off, so a { seq: false }-only topic never enters the
		// convergence comparison at all.
		// Skipped on the relay path: relayPublish already recorded the carried
		// seq through the guard the reorder-prone receive path needs.
		if (!isRelay && seq !== null) {
			if (typeof seqOption === 'number' || typeof seqOption === 'bigint') recordSeen(maxSeenSeq, topic, seq, seqBound);
			else recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
		}
		const envelope = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, null);
		if (!isRelay) {
			counters.publishCountWindow++;
			counters.publishOutcomeHook?.(recipients > 0);
		}
		if (resumeCaptureActive()) captureResumeFrame(topic, envelope);
		const compressIntent = compressOption === true;
		const compress = WS_COMPRESSION_ON && compressIntent;
		const excludeWs = excludeOption || null;

		// Cross-worker relay decision, taken once for every exit below. A codec
		// registered in the wire-codec registry relays its capability + raw
		// payload so a receiving worker with binary subscribers re-encodes
		// binary locally (relayPublishWire) instead of delivering JSON; an
		// unregistered codec relays the JSON envelope only - the registry IS
		// the opt-in. The compress INTENT (not the locally-gated value) rides
		// along so the receiver re-gates by its own compressor. Exclusion
		// stays local: the excluded socket cannot be on another worker.
		// The marker forces the decision off by itself, so a relayed frame
		// cannot be relayed onward whatever else the options say. Two settings
		// that have to agree are one that can be forgotten.
		const relayed = !isRelay && !!(parentPort && relayOption !== false);
		const relayCap = relayed && wire && typeof wire.capability === 'string' && getWireCodec(wire.capability)
			? wire.capability
			: undefined;
		const relayEvent = relayCap !== undefined ? event : undefined;
		const relayData = relayCap !== undefined ? data : undefined;

		// JSON fast path: nobody on this worker advertised the capability.
		// Cross-worker subscribers that did still re-encode binary on their
		// own worker, so the codec carry rides the relay regardless.
		if (!wire || typeof wire.capability !== 'string' || !capCounts.has(wire.capability)) {
			// Every local recipient gets the JSON envelope on this exit, so the
			// charge is the envelope's UTF-8 bytes times the recipient set.
			if (!isRelay) chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
			const sent = fanOut(topic, envelope, excludeWs, compress);
			if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			return sent || relayed;
		}

		if (!wire.state) {
			const payload = encodeStatelessWirePayload(wire, event, data);
			// Shared binary fan-out: a stateless codec marked `shared: true` fans
			// out by cohort - the byte-identical 0x03 frame to every member of
			// `topic\0bin`, the JSON envelope to every member of `topic\0json`.
			// Both cohorts are walks here (there is no native publish to hand
			// them to), so what the branch buys is the cohort bookkeeping, the
			// server-wide id announced at cohort join, and the split charge.
			// Eligible only with no sender exclusion and a payload the codec
			// accepted; an excluding or declined shared publish takes the
			// per-connection walk below. The frame is identical for every
			// binary subscriber because the topic-id is the shared id.
			if (wire.shared && excludeWs === null && payload != null) {
				// Lazy migration: the FIRST shared publish to a topic cohorts its
				// current subscribers (a one-time walk, paid once per topic), then
				// marks the topic shared so a later joiner is cohorted at
				// subscribe time instead.
				if (!sharedTopics.has(topic)) {
					for (const ws of wsConnections) {
						let ud;
						try { ud = /** @type {any} */ (ws).getUserData(); } catch { continue; }
						const subs = ud[WS_SUBSCRIPTIONS];
						if (!subs || !subs.has(topic)) continue;
						joinSharedCohort(ws, ud, topic, wire.capability);
					}
					sharedTopics.set(topic, wire.capability);
				}
				const { bin, json } = cohortTopics(topic);
				// The one egress charge for this logical publish, split by
				// cohort: the binary cohort is charged its 0x03 frame, everyone
				// else the envelope. The binary-cohort size is the shared wire-id
				// refcount (one reference per cohorted socket), so the split is
				// exact without a walk.
				if (!isRelay) {
					const binCount = Math.min(sharedWireIdRefs(topic), recipients);
					chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length,
						binaryFrameChargeBytes(payload.length, seq ?? 0) * binCount + chargeableBytes(envelope, recipients - binCount));
				}
				// The binary cohort exists only if a capable client joined it (its
				// announce succeeded); otherwise this shared topic currently has
				// only JSON subscribers and skips the binary fan-out entirely.
				// The outcome of this logical publish was reported once above,
				// like every other publishWire exit; the cohort walks do not
				// report again, so the outcome family keeps summing to the
				// publish family.
				const id = getSharedWireId(topic);
				if (id !== undefined) fanOutCohort(bin, buildBinaryFrame(wire.schemaVersion, id, seq ?? 0, payload), true, compress);
				fanOutCohort(json, envelope, false, compress);
				// Cross-worker subscribers: each receiving worker re-derives the
				// shared codec from its registry (relayPublishWire) and runs ITS
				// OWN cohort split with its own server-wide id, so the
				// single-instance path needs no cross-worker id sharing.
				if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
				return true;
			}
			// The one egress charge for this logical publish. With a capable
			// connection live and a payload the codec accepted, the walk's
			// encoded form is the binary frame and the charge reflects it for
			// every recipient (a mixed room's JSON-degraded members ride at the
			// same charged size - the documented approximation that keeps the
			// charge O(1)); a declined frame delivers the envelope everywhere.
			if (!isRelay) {
				const wireBytes = payload != null
					? binaryFrameChargeBytes(payload.length, seq ?? 0) * recipients
					: chargeableBytes(envelope, recipients);
				chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, wireBytes);
			}
			if (relayed) {
				// A declined frame (null payload) declines identically on every
				// worker, so the codec carry would be dead IPC weight: relay the
				// envelope alone and let the receivers take their JSON path.
				if (payload == null) batchRelay(topic, envelope, compressIntent, seq);
				else batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			}
			const subscribers = subscribersOf(topic);
			if (!subscribers) return relayed;
			const targets = [];
			for (const rawWs of subscribers) {
				if (rawWs.readyState !== 1) continue;
				const facade = wsWrappers.get(rawWs);
				if (facade && facade !== excludeWs && rawWs !== excludeWs) targets.push(facade);
			}
			const delivered = deliverStatelessWireFanout(wire, payload, {
				topic,
				envelope,
				seq: seq ?? 0,
				excludeWs: undefined,
				connections: targets,
				ensureId: ensureWireId,
				isPoisoned: wireStatePoisoned,
				poison: poisonWireState,
				compress,
				counters
			});
			return delivered || relayed;
		}

		// Stateful: encode per connection against its own codec state. The
		// charge prices the envelope across recipients - per-connection binary
		// sizes vary with codec state, and the envelope is both the JSON
		// degrade form and the stable upper-bound approximation.
		if (!isRelay) chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
		if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
		const subscribers = subscribersOf(topic);
		if (!subscribers) return relayed;
		let delivered = false;
		for (const rawWs of subscribers) {
			if (rawWs.readyState !== 1) continue;
			const facade = wsWrappers.get(rawWs);
			if (!facade || facade === excludeWs || rawWs === excludeWs) continue;
			const result = deliverWireToOne(facade, topic, event, data, wire, envelope, seq ?? 0, compress);
			if (result !== 3) delivered = true;
		}
		return delivered || relayed;
	},

	/**
	 * The binary counterpart of {@link send}, carrying the same explicit
	 * replay `seq` under the same side-effect-free rule.
	 *
	 * The seq rides the binary frame's own slot and the JSON fallback's
	 * envelope field identically, so a client keys ONE watermark whichever
	 * form its connection negotiated - a capable subscriber and a degraded one
	 * must not disagree about where the replay resumed.
	 *
	 * @param {object} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: object }} wire
	 * @param {{ seq?: number | bigint | false | null, compress?: boolean } | undefined} [options]
	 * @returns {number} 0 | 1 | 2
	 */
	sendWire(ws, topic, event, data, wire, options) {
		const seq = resolveSendSeq(options != null ? options.seq : undefined);
		const compress = WS_COMPRESSION_ON && Boolean(options && options.compress === true);
		const payload = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, null);
		// The frame slot carries 0 for "no seq", which is the wire's own
		// spelling for absent - not a stamped zero.
		const result = deliverWireToOne(ws, topic, event, data, wire, payload, seq == null ? 0 : seq, compress);
		return result === 3 ? 2 : result;
	},

	/**
	 * @param {string} topic
	 * @param {string} event
	 * @param {Array<{ data: unknown, excludeWs?: object, seq?: number }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: object }} wire
	 * @param {{ seq?: boolean | number, relay?: boolean, compress?: boolean, excludeWs?: object } | undefined} [options]
	 * @returns {boolean}
	 */
	publishWireBatch(topic, event, entries, wire, options) {
		// The contract is checked before the data is: an invalid seq is
		// invalid whether or not this call happens to carry entries, so an
		// empty batch cannot silently accept options a full one refuses.
		// Field reads rather than a spread - a spread copies own enumerable
		// properties only, so a numeric seq carried on a prototype or by an
		// inherited accessor would vanish from the copy and slip past a
		// refusal every other read of the same object would have thrown on.
		// Each field is read once, here; the value refused and the value used
		// are the same read.
		const opts = options == null
			? options
			: { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs };
		assertBatchSequenceAuthority(opts);
		if (!Array.isArray(entries) || entries.length === 0) return false;
		const count = entries.length;
		// A stateless codec gains nothing from a batched walk (encode-once
		// already amortizes it) - route through the per-entry path unchanged.
		if (!wire || !wire.state) {
			// Read every entry before publishing any of them: the first publish
			// runs application toJSON, and the reads for entry i+1 come after it.
			// Per-entry seqs are validated here too - a refusal must land before
			// the first publish fans out, or a mid-loop throw leaves earlier
			// entries already delivered for a batch that never went out whole.
			const datas = new Array(count);
			const excludes = new Array(count);
			let entrySeqs = null;
			let sawExplicitEntrySeq = false;
			for (let i = 0; i < count; i++) {
				const entry = entries[i];
				datas[i] = entry.data;
				excludes[i] = entry.excludeWs;
				// The entry lane speaks the same table as the options lane -
				// resolveEntrySeq is the ONE spelling of it for every surface:
				// number and bigint are the explicit authority, true is the
				// counter, false and null are no-seq - each an OVERRIDE of the
				// shared options for this entry - undefined inherits, and
				// anything else refuses the whole batch here, before the first
				// publish fans out.
				const resolved = resolveEntrySeq(entry.seq, i);
				if (resolved !== undefined) {
					if (typeof resolved === 'number') {
						if (!sawExplicitEntrySeq) {
							assertBatchEntrySequenceAuthority(opts);
							sawExplicitEntrySeq = true;
						}
					} else if (resolved === true) {
						// An entry drawing the per-worker counter takes the cluster's
						// counter refusal up front, whole-batch-or-nothing - the same
						// rule the shared options' counter form takes at the call gate.
						assertClusterSequenceAuthorityValues(true, opts != null ? opts.relay : undefined);
					}
					if (entrySeqs === null) entrySeqs = new Array(count);
					entrySeqs[i] = resolved;
				}
			}
			// One admission for the whole batch, before the first entry goes
			// out. Delegating per entry would let each admit on its own and
			// deliver a prefix of the batch under a ceiling, which is both the
			// mid-batch shedding this budget forbids and a partial delivery
			// reported to the caller as success. Recipients are read once here
			// for the decision; each delegated entry still CHARGES itself, so
			// the ledger sees one logical publish per entry either way.
			let admitOpts = opts;
			if (egressGate.armed) {
				const batchRecipients = numSubscribers(topic);
				// Deliveries counted per RESOLVED entry - the same own-or-default
				// resolution delivery performs. A one-shot estimate discounting
				// the call-level exclusion for every entry would UNDER-estimate
				// where an entry overrides it to a socket without the topic,
				// which is the direction that admits past the ceiling.
				let deliveries = count * batchRecipients;
				if (batchRecipients > 0) {
					const shared = opts != null && opts.excludeWs !== undefined && opts.excludeWs !== null
						? opts.excludeWs : null;
					const sharedHolds = shared !== null && excludedRecipient(shared, topic);
					for (let i = 0; i < count; i++) {
						const own = excludes[i];
						if (own != null) { if (excludedRecipient(own, topic)) deliveries--; }
						else if (sharedHolds) deliveries--;
					}
				}
				if (!admitPublishEgress(topic, resolvePublishTenant(topic), count, deliveries)) return false;
				// The entries inherit the decision rather than re-taking it.
				admitOpts = markAdmitted({ ...(opts || {}) });
			}
			let ok = false;
			for (let i = 0; i < count; i++) {
				const entrySeq = entrySeqs === null ? undefined : entrySeqs[i];
				let per = admitOpts;
				// An entry's own exclusion overrides the call-level one the
				// delegated options already carry; a null entry exclusion is
				// ABSENT (it inherits), matching the stateful lane.
				if (excludes[i] != null || entrySeq !== undefined) {
					per = { ...(admitOpts || {}) };
					if (excludes[i] != null) per.excludeWs = excludes[i];
					if (entrySeq !== undefined) per.seq = entrySeq;
				}
				ok = this.publishWire(topic, event, datas[i], wire, per) || ok;
			}
			return ok;
		}
		const compressIntent = Boolean(opts && opts.compress === true);
		const compress = WS_COMPRESSION_ON && compressIntent;
		const sharedExclude = (opts && opts.excludeWs) || null;
		// Read and validate EVERY entry before anything is stamped: a numeric
		// per-entry seq must pass the value check and the clustered authority
		// rule while the batch is still whole, or a mid-loop refusal would
		// leave earlier entries already stamped for a batch that never went
		// out. One read per application-owned field: the JSON envelopes and
		// the codec must see the same values under one seq.
		const datas = new Array(count);
		const excludes = new Array(count);
		const entrySeqs = new Array(count);
		let sawEntrySeq = false;
		for (let i = 0; i < count; i++) {
			const entry = entries[i];
			datas[i] = entry.data;
			excludes[i] = entry.excludeWs;
			// The entry lane speaks the same table as the options lane, and
			// resolveEntrySeq is the ONE spelling of it for every surface:
			// number and bigint are the explicit authority, true is the
			// counter, false and null are no-seq - each an OVERRIDE of the
			// shared options for this entry - undefined inherits, and anything
			// else refuses the whole batch HERE, in the pre-pass, before the
			// egress ceiling has answered and before a single entry is stamped.
			// Hand-rolling the number arm here is what let an over-range value
			// through this pass and into the stamping loop, where the throw
			// landed after earlier entries had already been stamped.
			const resolved = resolveEntrySeq(entry.seq, i);
			if (resolved !== undefined) {
				if (typeof resolved === 'number') {
					// An explicit entry seq is the per-entry twin of
					// publishWire({ seq: N }) and takes the same clustered rule:
					// the external allocator must also be the fan-out, proven by
					// relay: false. Checked once per batch, on the first number.
					if (!sawEntrySeq) {
						assertBatchEntrySequenceAuthority(opts);
						sawEntrySeq = true;
					}
				} else if (resolved === true) {
					// An entry drawing the per-worker counter takes the cluster's
					// counter refusal up front, whole-batch-or-nothing, the same
					// rule the shared options' counter form takes at the gate.
					assertClusterSequenceAuthorityValues(true, opts != null ? opts.relay : undefined);
				}
				entrySeqs[i] = resolved;
			}
		}
		// Egress admission for the whole batch, before anything is stamped.
		// Deliveries are counted per RESOLVED entry - the same own-or-default
		// exclusion resolution delivery performs - so a mid-batch refusal
		// cannot leave a prefix delivered, and the caller sees one decision.
		const recipients = numSubscribers(topic);
		let deliveries = count * recipients;
		/** @type {number[] | null} */
		let exDeduct = null;
		if (recipients > 0) {
			exDeduct = new Array(count).fill(0);
			const sharedHolds = sharedExclude !== null && excludedRecipient(sharedExclude, topic);
			for (let i = 0; i < count; i++) {
				const own = excludes[i];
				if (own != null) {
					if (excludedRecipient(own, topic)) { exDeduct[i] = 1; deliveries--; }
				} else if (sharedHolds) {
					exDeduct[i] = 1; deliveries--;
				}
			}
		}
		let egressTenant = null;
		if (egressGate.armed) {
			egressTenant = resolvePublishTenant(topic);
			if (!admitPublishEgress(topic, egressTenant, count, deliveries)) return false;
		}
		const seqs = new Array(count);
		const envelopes = new Array(count);
		let batchBytes = 0;
		let batchWireBytes = 0;
		// The batch records ONE watermark when every entry drew the counter -
		// they are monotone, so the highest is the only one that moves it - and
		// falls back to a per-entry pass when an explicit authority is mixed in.
		let highestSeq = null;
		for (let i = 0; i < count; i++) {
			// An explicit entry seq is authoritative for its entry; every other
			// entry draws from the batch options, so `{ seq: false }` - the one
			// spelling a clustered batch may carry - really stamps nothing
			// instead of quietly advancing the per-worker counter it renounced
			// and relaying the forked number cluster-wide.
			// A resolved entry seq overrides the shared options for this entry:
			// an explicit value (already validated in the pre-pass) is stamped
			// verbatim and does NOT advance the counter - the explicit
			// authority and the local counter are two tracks, exactly as they
			// are through publishWire - `true` draws this entry its own counter
			// value, and `false` (the resolution of both false and null) leaves
			// the entry seq-less under a batch that opts in.
			const resolvedEntry = entrySeqs[i];
			const seq = resolvedEntry === undefined
				? stampSeqValue(opts != null ? opts.seq : undefined, topicSeqs, topic, seqBound)
				: resolvedEntry === false
					? null
					: resolvedEntry === true
						? stampSeqValue(true, topicSeqs, topic, seqBound)
						: resolvedEntry;
			seqs[i] = seq == null ? 0 : seq;
			envelopes[i] = completeEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', datas[i], seqs[i] || null, null);
			if (seqs[i] !== 0 && (highestSeq === null || seqs[i] > highestSeq)) highestSeq = seqs[i];
			batchBytes += envelopes[i].length;
			// Per-entry wire bytes: the envelope's UTF-8 encoding times the
			// recipients this entry actually reaches (its exclusion deducted).
			// Charged at the envelope size because the binary batch frame is
			// recipient-specific, the same rule as publishWire's stateful walk.
			batchWireBytes += chargeableBytes(envelopes[i], recipients - (exDeduct === null ? 0 : exDeduct[i]));
		}
		// An explicit per-entry authority can interleave with a sibling
		// worker's numbers, so those entries go through the monotone-max
		// guard in entry order, as N separate calls would have. A batch
		// whose entries all drew the counter moves the watermark once.
		if (sawEntrySeq) {
			for (let i = 0; i < count; i++) {
				if (seqs[i] === 0) continue;
				if (typeof entrySeqs[i] === 'number') recordSeen(maxSeenSeq, topic, seqs[i], seqBound);
				else recordStampedSeen(maxSeenSeq, topic, seqs[i], seqBound);
			}
		} else if (highestSeq !== null) {
			recordStampedSeen(maxSeenSeq, topic, highestSeq, seqBound);
		}
		// One charge for the whole batch - N logical publishes under one
		// admission decision - taken only after every entry has stamped and
		// serialised, so an aborted batch never creates the topic's stats.
		chargePublishEgress(topic, egressTenant, count, deliveries, batchBytes, batchWireBytes);
		counters.publishCountWindow += count;
		// One outcome per LOGICAL publish, so the outcome family always sums to
		// the publish family. Every entry shares this topic's subscriber set,
		// but not its exclusion: exDeduct already holds whether THIS entry's
		// excluded socket was one of them, and reading the bare count instead
		// would report an entry that reached nobody as delivered.
		if (counters.publishOutcomeHook !== null) {
			for (let i = 0; i < count; i++) {
				counters.publishOutcomeHook(recipients - (exDeduct === null ? 0 : exDeduct[i]) > 0);
			}
		}
		// Cross-worker relay: one relay envelope per entry, exactly as N
		// publishWire calls would send - the receive path re-encodes each
		// entry through publishWire on its own worker, so batching stays a
		// local egress optimization. The codec carry follows publishWire's
		// registry gate.
		const relayed = !!(parentPort && !(opts && opts.relay === false));
		if (relayed) {
			const relayCap = wire && typeof wire.capability === 'string' && getWireCodec(wire.capability)
				? wire.capability
				: undefined;
			for (let i = 0; i < count; i++) {
				batchRelay(topic, envelopes[i], compressIntent, seqs[i] === 0 ? null : seqs[i], relayCap,
					relayCap !== undefined ? event : undefined,
					relayCap !== undefined ? datas[i] : undefined);
			}
		}
		if (resumeCaptureActive()) {
			for (let i = 0; i < count; i++) captureResumeFrame(topic, envelopes[i]);
		}
		const subscribers = subscribersOf(topic);
		if (!subscribers) return relayed;
		const capable = capCounts.has(wire?.capability);
		let delivered = false;
		for (const rawWs of subscribers) {
			if (rawWs.readyState !== 1) continue;
			const facade = wsWrappers.get(rawWs);
			if (!facade) continue;
			// Per-entry exclusion: the call-level socket is the DEFAULT for
			// every entry and an entry carrying its own overrides it, so a
			// connection excluded from some entries gets its own filtered
			// batch. A null entry value is absent, not an override to nothing.
			/** @type {number[] | null} */
			let keep = null;
			for (let i = 0; i < count; i++) {
				const ex = excludes[i] != null ? excludes[i] : sharedExclude;
				if (ex !== null && (ex === facade || ex === rawWs)) {
					if (keep === null) {
						keep = [];
						for (let j = 0; j < i; j++) keep.push(j);
					}
				} else if (keep !== null) {
					keep.push(i);
				}
			}
			const idx = keep === null ? null : keep;
			const connDatas = idx === null ? datas : idx.map((i) => datas[i]);
			if (connDatas.length === 0) continue;
			const connSeqs = idx === null ? seqs : idx.map((i) => seqs[i]);
			const connEnvelopes = idx === null ? envelopes : idx.map((i) => envelopes[i]);
			let ud = null;
			try { ud = /** @type {any} */ (facade).getUserData(); } catch { counters.closedWsAborts++; continue; }
			const caps = ud[WS_CAPS];
			if (!capable || !caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability)) {
				let ok = false;
				try {
					for (const env of connEnvelopes) {
						if (/** @type {any} */ (facade).send(env, false, compress) !== 2) ok = true;
						bumpOut(ud, env);
					}
				} catch { counters.closedWsAborts++; continue; }
				if (ok) delivered = true;
				continue;
			}
			const state = ensureWireState(facade, ud, wire);
			const result = deliverStatefulWireBatch({
				wire,
				event,
				datas: connDatas,
				envelopes: connEnvelopes,
				seqs: connSeqs,
				state: state ?? {},
				ws: facade,
				ud,
				topic,
				ensureId: ensureWireId,
				poison: poisonWireState,
				compress,
				counters
			});
			if (result !== 3) delivered = true;
		}
		return delivered || relayed;
	},

	/**
	 * @param {object} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {Array<{ data: unknown, seq?: number }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: object }} wire
	 * @returns {number}
	 */
	sendWireBatch(ws, topic, event, entries, wire) {
		if (!Array.isArray(entries) || entries.length === 0) return 1;
		let ud = null;
		try { ud = /** @type {any} */ (ws).getUserData(); } catch { counters.closedWsAborts++; return 2; }
		const count = entries.length;
		const datas = new Array(count);
		const seqs = new Array(count);
		const envelopes = new Array(count);
		for (let i = 0; i < count; i++) {
			datas[i] = entries[i].data;
			seqs[i] = typeof entries[i].seq === 'number' ? entries[i].seq : 0;
			envelopes[i] = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(datas[i] ?? null) + '}';
		}
		const caps = ud[WS_CAPS];
		if (!wire || !caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability)) {
			let result = 1;
			try {
				for (const env of envelopes) {
					result = /** @type {any} */ (ws).send(env, false, false);
					bumpOut(ud, env);
				}
			} catch { counters.closedWsAborts++; return 2; }
			return result;
		}
		const state = ensureWireState(ws, ud, wire);
		const result = deliverStatefulWireBatch({
			wire,
			event,
			datas,
			envelopes,
			seqs,
			state: state ?? {},
			ws,
			ud,
			topic,
			ensureId: ensureWireId,
			poison: poisonWireState,
			counters
		});
		return result === 3 ? 2 : result;
	},

	registerWireCodec,

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
		// The egress decision is pre-hoc over the WHOLE recipient set (there
		// is no mid-walk shedding), and only the filter can name that set.
		let egressTenant = null;
		if (egressGate.armed) {
			egressTenant = resolvePublishTenant(topic);
			// Refused: nothing is sent and the count says so.
			if (!admitPublishEgress(topic, egressTenant, 1, targets.length)) return 0;
		}
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
		// One egress charge for the delivered set. This lane never feeds the
		// per-topic runaway stats - those keep meaning publish-family calls -
		// but its frames are egress like any other.
		if (count > 0) chargeDirectEgress(topic, egressTenant, count, chargeableBytes(envelope, count));
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
		const compress = WS_COMPRESSION_ON && Boolean(options && /** @type {any} */ (options).compress === true);
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
				/** @type {any} */ (facade).send(frame, false, compress);
				bumpOut(userData, frame);
				if (doClose) /** @type {any} */ (facade).end(1001, 'Server draining');
				count++;
			} catch {
				counters.closedWsAborts++;
			}
		}
		// The advisory is operator-lane egress: it carries no topic and no
		// tenant, so it lands in the worker egress window but sits outside
		// every ceiling - a drain command must not be refusable by a budget.
		if (count > 0) chargeDirectEgress(null, null, count, chargeableBytes(frame, count));
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

	/**
	 * Resolve one bounded state-divergence record by opaque id. Topic names are
	 * never present; affected streams are per-primary-lifetime HMAC ids. Do not
	 * expose this method on a public route.
	 *
	 * @param {string} diagnosticId
	 * @returns {any | null}
	 */
	diagnostic(diagnosticId) {
		return divergenceDiagnostics.get(diagnosticId);
	},

	get pressure() {
		// The LIVE snapshot object, mutated in place by the 1 Hz sampler.
		// Consumers must not mutate it; sampledAt null means never sampled.
		return pressureSnapshot;
	},

	get protection() {
		// The live level, or 'normal' for a deployment that never configured a
		// posture (where no machine is built at all). introspect() reads this
		// same getter, so both surfaces move together.
		return counters.activePosture !== null ? counters.activePosture.level : 'normal';
	},

	/**
	 * The registry the build resolved from `websocket.metrics`, or null when
	 * the option is unset. The operator's own object, not the mirroring
	 * wrapper the runtime registers through, so an app's scrape route reads
	 * exactly what it configured.
	 */
	get metrics() { return metricsRegistry; },

	/**
	 * The merged cluster metrics document as Prometheus text, or null when no
	 * registry is configured. Single-process deployments take the same merge
	 * minus the round trip, so the shape a scrape route parses does not depend
	 * on the deployment mode.
	 * @param {{ timeoutMs?: number }} [options]
	 */
	metricsSnapshot(options) { return metricsSnapshot(options); },

	/**
	 * Register a callback fired when the pressure `reason` TRANSITIONS -
	 * at most once per sample tick. Returns the unsubscriber.
	 * @param {(snapshot: object) => void} cb
	 */
	onPressure(cb) {
		if (typeof cb !== 'function') return () => {};
		pressureListeners.add(cb);
		return () => { pressureListeners.delete(cb); };
	},

	/**
	 * Register a callback handed the window's top publishers once per sample
	 * window. Returns the unsubscriber.
	 * @param {(top: Array<object>) => void} cb
	 */
	onPublishRate(cb) {
		if (typeof cb !== 'function') return () => {};
		publishRateListeners.add(cb);
		return () => { publishRateListeners.delete(cb); };
	},

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
		const subs = ud[WS_SUBSCRIPTIONS];
		// The subscription slot is assigned a Set once at open and never reassigned;
		// a non-Set here is unrecoverable heap/dispatch corruption. One instanceof
		// guard, identical in cost to the assert it replaces. A freed handle is
		// caught above and returns early, so this only runs on a live connection.
		fatal(subs instanceof Set, 'subs.shape', null);
		const held = subs.has(topic);
		if (held) return null;
		if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
		if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(ud), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) return 'RATE_LIMITED';
		// Track the in-flight subscribe so a revocation landing during the
		// hook await can cancel it: platform.unsubscribe tombstones the topic
		// in the pending set and the landing below discards the grant instead
		// of subscribing.
		const pendingToken = beginPendingSubscribe(ud, topic, held);
		const denial = await runUserSubscribeGate(facade, topic);
		if (denial !== null) {
			if (settleDeniedSubscribe(ud, topic, pendingToken, subs.has(topic)) === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
			}
			return denial;
		}
		// Re-check after the await: a concurrent subscribe may have raced
		// through while the hook ran. The membership's provenance decides
		// whether this attempt acks it or unwinds it.
		const heldAfter = subs.has(topic);
		if (heldAfter) {
			const heldVerdict = settleHeldSubscribe(ud, topic, pendingToken);
			if (heldVerdict === 'ack') return null;
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
			}
			return 'FORBIDDEN';
		}
		if (exceedsSubscriptionCap({ held: heldAfter, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
			settlePendingSubscribe(ud, topic, pendingToken);
			return 'RATE_LIMITED';
		}
		if (!settlePendingSubscribe(ud, topic, pendingToken, true)) return 'FORBIDDEN';
		try {
			/** @type {any} */ (facade).subscribe(topic);
		} catch {
			counters.closedWsAborts++;
			return null;
		}
		addLogicalSubscription(subs, topic);
		// Programmatic join of an already-shared topic cohorts the socket too.
		if (sharedTopics.has(topic)) joinSharedCohort(facade, /** @type {any} */ (facade).getUserData(), topic, sharedTopics.get(topic));
		return null;
	},

	/**
	 * Pure gate: consult the hook chain without subscribing.
	 * @param {object} facade
	 * @param {string} topic
	 * @param {{ requireGrant?: boolean } | undefined} [options]
	 * @returns {Promise<string | null>}
	 */
	async checkSubscribe(facade, topic, options) {
		if (!isValidWireTopic(topic, options && options.requireGrant ? ALLOW_NON_ASCII_TOPICS : true)) {
			return 'INVALID_TOPIC';
		}
		const requireGrant = Boolean(options && options.requireGrant);
		let observerHasUserHook = false;
		if (requireGrant) {
			observerHasUserHook = hasUserSubscribeHook();
			let granted;
			try { granted = /** @type {any} */ (facade).getUserData()[WS_SUBSCRIPTIONS]; }
			catch { counters.closedWsAborts++; return 'FORBIDDEN'; }
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
			catch { counters.closedWsAborts++; return 'FORBIDDEN'; }
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
		const subs = ud[WS_SUBSCRIPTIONS];
		assert(subs instanceof Set, 'subs.shape-unsubscribe', null);
		// Cancel any subscribe still parked in its authorization hook - a
		// revoke must not be re-installed by a parked attempt landing later.
		const cancelledPending = tombstonePendingSubscribe(ud, topic);
		// Revoking read access revokes WRITE access with it.
		if (ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
		// And the observer taps a plugin registered on this topic.
		releaseDerivedSubscriptions(facade, topic);
		if (!subs.has(topic)) return cancelledPending;
		try {
			/** @type {any} */ (facade).unsubscribe(topic);
		} catch {
			counters.closedWsAborts++;
			return false;
		}
		removeLogicalSubscription(subs, topic);
		if (sharedTopics.has(topic)) leaveSharedCohort(facade, /** @type {any} */ (facade).getUserData(), topic);
		wsModule.unsubscribe?.(facade, topic, { platform: ud[WS_PLATFORM] });
		return true;
	},

	// Client-publish authorization (the `game` lane). A connection is bound
	// to exactly one topic it may publish to via a topicless `game` frame.
	grantPublish(facade, topic) {
		// The per-room seq and sender-excluding walk are worker-local. Refuse
		// the first grant in a multi-I/O-worker topology instead of
		// authorizing a lane that would silently omit remote participants and
		// fork its sequence.
		assertGameLaneClusterSafe();
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
		// Same topology gate as grantPublish: the game lane's room sequencer
		// is authoritative only on the single socket-owning I/O worker.
		assertGameLaneClusterSafe();
		// Egress: the sender is excluded by this lane's contract, so it is
		// deducted from the recipient set when it holds the topic. Compact
		// binary recipients are charged the envelope size too: the 0x03 form
		// is per-capability and encoded lazily inside the walk, and forcing
		// the encode on every publish just to price it would tax the 60 Hz
		// lane. The game lane is the one publish with a socket in hand - its
		// tenant is the SENDER's frozen attribution, never the topic resolver:
		// the client relaying through this lane is the party whose budget the
		// fan-out spends.
		const recipients = excludedRecipient(/** @type {any} */ (senderWs), topic)
			? Math.max(0, numSubscribers(topic) - 1)
			: numSubscribers(topic);
		let egressTenant = null;
		if (egressGate.armed) {
			if (egressGate.account !== null && egressGate.account.tenantEnabled) {
				let att = null;
				try { att = /** @type {any} */ (senderWs).getUserData()[WS_ATTRIBUTION] ?? null; } catch { att = null; }
				egressTenant = att !== null && typeof att.tenantId === 'string' ? att.tenantId : null;
			}
			// { seq: null, delivered: 0 } is this lane's refusal shape.
			if (!admitPublishEgress(topic, egressTenant, 1, recipients)) return { seq: null, delivered: 0 };
		}
		counters.publishCountWindow++;
		counters.publishOutcomeHook?.(recipients > 0);
		const seq = stampSeqValue(undefined, topicSeqs, topic, seqBound);
		if (seq !== null) recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
		const env = completeGameEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, id);
		chargePublishEgress(topic, egressTenant, 1, recipients, env.length, chargeableBytes(env, recipients));
		if (resumeCaptureActive()) captureResumeFrame(topic, env);
		const subscribers = subscribersOf(topic);
		let delivered = 0;
		// The compact fan-out payload is shared by every capable recipient;
		// built lazily so a JSON-only room pays nothing for it.
		/** @type {Uint8Array | null} */
		let fanoutPayload = null;
		const anyCapable = capCounts.has(GAME_FANOUT_CAP);
		if (subscribers) {
			for (const rawWs of subscribers) {
				const facade = wsWrappers.get(rawWs);
				if (rawWs === senderWs || facade === senderWs) continue;
				if (rawWs.readyState !== OPEN || !facade) continue;
				try {
					const ud = /** @type {any} */ (facade).getUserData();
					const caps = ud[WS_CAPS];
					if (anyCapable && caps && caps.has(GAME_FANOUT_CAP) && !wireStatePoisoned(ud, GAME_FANOUT_CAP)) {
						if (fanoutPayload === null) fanoutPayload = encodeGameFanoutPayload(event, data, id);
						const wid = ensureWireId(facade, ud, topic);
						if (wid !== -1) {
							/** @type {any} */ (facade).send(buildBinaryFrame(GAME_FANOUT_SCHEMA_VERSION, wid, seq ?? 0, fanoutPayload), true, false);
							bumpOut(ud, fanoutPayload);
							delivered++;
							continue;
						}
						poisonWireState(facade, ud, GAME_FANOUT_CAP);
					}
					/** @type {any} */ (facade).send(env, false, false);
					bumpOut(ud, env);
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

	/**
	 * Mint this topic a fresh seq-space generation on THIS worker, so every
	 * offset a client recorded under the previous epoch mismatches at its next
	 * resume and cold-rehydrates instead of gap-filling. The escape hatch for
	 * changing a topic's seq AUTHORITY: the explicit lane is single-authority
	 * per topic, and moving a topic between authorities - counter to external
	 * allocator, one partition to another, a reset store - leaves client
	 * offsets pointing into a seq space that no longer continues them.
	 * Worker-local: call it on each worker where the authority change lands
	 * (app code runs on every worker), and the equality-only epoch repudiates
	 * old offsets everywhere identically. The subscribe ack and every resume
	 * compare pick the new value up through `topicEpoch` above.
	 *
	 * @param {string} name
	 * @returns {number} the minted epoch, as topicEpoch(name) now answers
	 */
	bumpTopicEpoch(name) {
		return mintTopicEpoch(name);
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

// - Cross-worker relay receive -----------------------------------------------

/**
 * Codec-aware relay receive: a sibling worker relayed a wire publish carrying
 * the codec's `capability` and `{ event, data }` alongside the JSON envelope.
 * When this worker has the codec registered AND a local connection advertises
 * the capability, re-encode binary locally by re-entering publishWire with the
 * origin's seq (no re-stamp), the relay marker that forces the re-relay
 * decision off by itself, and the
 * origin's compress intent (re-gated by this worker's own compressor).
 *
 * Returns false - the caller (relayPublish) then takes the plain JSON fan-out -
 * when no codec is registered for the capability or no local connection
 * advertises it, so the no-binary-subscriber worker stays on the cheaper
 * envelope path instead of entering the per-subscriber walk to hand everyone
 * JSON.
 *
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {string} capability
 * @param {number | null} seq - The origin worker's stamped per-topic seq, carried verbatim.
 * @param {boolean} [compress] - The origin's compress intent (re-gated locally).
 * @returns {boolean}
 */
export function relayPublishWire(topic, event, data, capability, seq, compress) {
	const codec = getWireCodec(capability);
	if (!codec) return false;
	if (!capCounts.has(capability)) return false;
	// The token rides beside the options object, not inside it, and the seq
	// beside the token. `relay: false` is gone because the token forces that
	// decision off on its own: two settings that must agree are one that can
	// be forgotten, and forgetting this one sends the frame back around the
	// workers.
	platform.publishWire(topic, event, data, codec, { compress }, RELAY_RECEIVE, seq);
	return true;
}

/**
 * The capability a client advertises to say it can act on a gap marker: drop
 * the resume offset that has already stepped past a hole, and re-snapshot.
 * The bundled client always advertises it (src/client.js), so this is a
 * negotiation with older or third-party clients, not with ours.
 */
export const RELAY_RESYNC_CAP = 'relay.resync:1';

/**
 * Tell the affected subscribers that this worker lost frames they were owed.
 *
 * The operator hears through the diagnostic event; this is the CLIENTS
 * hearing. A subscriber whose resume offset has already stepped past the hole
 * would otherwise gap-fill straight over it and never know, so each gapped
 * topic gets two things: the marker, pushed to every opted-in subscriber, and
 * a freshly minted topic generation installed HERE - the only worker whose
 * current answer a pre-loss offset can still match - so a client that was not
 * reachable now cold-rehydrates at its next resume instead.
 *
 * Reserved lanes (a `__`-prefixed topic) and topics outside the sequence
 * registry are skipped: they carry no resume offset to poison.
 *
 * @param {Array<{ topic: string, count: number }>} gaps
 * @returns {Map<string, { signalled: number, closed: number, epoch: number }>}
 */
export function signalRelayGaps(gaps) {
	/** @type {Map<string, { lost: number, marker: string, signalled: number, closed: number, epoch: number }>} */
	const byTopic = new Map();
	for (const gap of gaps) {
		if (gap.topic.charCodeAt(0) === 95 && gap.topic.charCodeAt(1) === 95) continue;
		if (!maxSeenSeq.has(gap.topic)) continue;
		const entry = byTopic.get(gap.topic);
		if (entry === undefined) byTopic.set(gap.topic, { lost: gap.count, marker: '', signalled: 0, closed: 0, epoch: 0 });
		else entry.lost += gap.count;
	}
	if (byTopic.size === 0) return byTopic;
	for (const [topic, entry] of byTopic) {
		// De-herd the re-snapshot the marker provokes: a busy topic asks its
		// subscribers to spread their follow-up over a window rather than
		// arriving together.
		const jitterMs = Math.min(2000, numSubscribers(topic));
		entry.marker =
			'{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"gap","data":{"lost":' + entry.lost + '}' +
			(jitterMs > 0 ? ',"j":' + jitterMs : '') + '}';
		// The durable half: mint the topic's new generation and install it on
		// THIS worker - the only worker whose current answer a pre-loss offset
		// can still match. The mint precedes the walk so a subscriber
		// signalled below and one that resumes a moment later read one
		// consistent epoch.
		entry.epoch = randomU32();
		overrideTopicEpoch(topic, entry.epoch);
	}
	for (const facade of wsConnections) {
		let ud;
		try { ud = /** @type {any} */ (facade).getUserData(); } catch { counters.closedWsAborts++; continue; }
		const caps = ud[WS_CAPS];
		if (caps === undefined || !caps.has(RELAY_RESYNC_CAP)) continue;
		const subs = ud[WS_SUBSCRIPTIONS];
		if (!subs || subs.size === 0) continue;
		let gone = false;
		for (const [topic, entry] of byTopic) {
			if (gone || !subs.has(topic)) continue;
			let result;
			try { result = /** @type {any} */ (facade).send(entry.marker, false, false); }
			catch { counters.closedWsAborts++; gone = true; continue; }
			if (result === 2) {
				// The socket cannot even take the marker, so it cannot be told.
				// Closing it is what forces the reconnect that repairs it.
				try { /** @type {any} */ (facade).end(1013, 'Resync required'); entry.closed++; }
				catch { counters.closedWsAborts++; }
				gone = true;
				continue;
			}
			bumpOut(ud, entry.marker);
			entry.signalled++;
		}
	}
	/** @type {Map<string, { signalled: number, closed: number, epoch: number }>} */
	const outcomes = new Map();
	for (const [topic, entry] of byTopic) outcomes.set(topic, { signalled: entry.signalled, closed: entry.closed, epoch: entry.epoch });
	return outcomes;
}

/**
 * Deliver a publish relayed from a sibling worker to this worker's local
 * subscribers. The frame arrives pre-stamped and pre-serialized: the carried
 * seq is metadata, never re-stamped, and nothing here re-relays (the primary
 * already forwarded the frame to every other worker).
 *
 * @param {string} topic
 * @param {string} envelope - Pre-serialized JSON envelope.
 * @param {boolean} [compress] - Per-frame compress intent carried across the
 *   worker boundary; re-gated by this worker's compressor.
 * @param {number | null} [seq] - The originator's stamped per-topic seq,
 *   carried as explicit metadata so a receiver never re-parses the envelope.
 * @param {string} [capability] - A registered wire codec's capability token;
 *   its presence is the sole signal that a binary re-encode was intended.
 * @param {string} [event] - The publish event name, for the codec re-encode.
 * @param {any} [data] - The raw publish payload, for the codec re-encode.
 * @param {number} [origin] - The sending worker's thread id.
 * @param {number} [ord] - That worker's per-topic relay ordinal for this frame.
 * @param {number} [birth] - When that worker opened this topic's relay stream.
 *   origin/ord/birth are the frame's stream identity: they travel on the wire
 *   for the receiver-side contiguity check the relay format reserves them for,
 *   and delivery never depends on them.
 */
export function relayPublish(topic, envelope, compress, seq, capability, event, data, origin, ord, birth) {
	// Hard tier: a non-string topic or an empty/non-string envelope arriving
	// from a sibling worker (trusted, same codebase) means the cross-worker
	// relay serialization is structurally broken - publishing it would
	// misroute or send garbage to every local subscriber and, transitively,
	// cluster-wide. That is not recoverable by dropping one frame, so it
	// escalates to a deferred worker restart rather than a soft log.
	fatal(typeof topic === 'string', 'relay.topic-type', { topic: typeof topic });
	fatal(typeof envelope === 'string' && envelope.length > 0, 'relay.envelope-type', {
		envelopeType: typeof envelope,
		envelopeLen: typeof envelope === 'string' ? envelope.length : null
	});
	// Production fatal defers the exit past this frame, so without this return
	// the dying frame would still hand the garbage to every local subscriber -
	// the one outcome the escalation exists to prevent.
	if (typeof topic !== 'string' || typeof envelope !== 'string' || envelope.length === 0) return;
	// The carried seq advances this worker's observed watermark whether or
	// not it has a local subscriber, so every worker that receives the frame
	// converges. recordSeen ignores a non-number seq, which is how a
	// { seq: false } topic stays out of the comparison.
	recordSeen(maxSeenSeq, topic, seq, seqBound);
	// A maximum only ever reveals a lost TAIL. The per-origin relay ordinal
	// is dense by construction, so a hole in it is a dropped frame and this
	// worker can decide that alone.
	if (streamTracking.enabled) {
		recordOriginStream(originStreams, topic, origin, ord, birth, relayAttach.at, processMonotonicNow);
	}
	// Codec-aware relay: a set `capability` always travels with its payload
	// and only for a codec the origin found in its registry; the gate keys on
	// `capability` alone, not on `data`, because a codec may legitimately
	// encode an undefined payload (an event-only or tick frame). The local
	// re-encode carries the relay marker, so it never re-relays and cannot loop.
	if (capability !== undefined &&
		relayPublishWire(topic, event, data, capability, seq ?? null, compress)) {
		return;
	}
	// Resume cutover in flight on this worker: hold the JSON envelope a
	// resuming subscriber would receive from this cross-worker frame. The
	// codec re-encode path above captures inside publishWire.
	if (resumeCaptureActive()) captureResumeFrame(topic, envelope);
	fanOut(topic, envelope, null, WS_COMPRESSION_ON && compress === true);
}

/**
 * Re-dispatch a relayed publishBatched call from another worker. The
 * fast/slow detection (all-see-all + everyone batch-capable) is re-run
 * against THIS worker's local subscriber set: a worker with a different cap
 * profile or different subscription overlap may take the slow path even when
 * the originating worker took the fast path. Seqs were stamped by the
 * originator and ride along in each per-event envelope; nothing here
 * re-stamps and nothing re-relays.
 *
 * @param {Array<import('./relay.js').RelayBatchedEntry>} events
 *   The batched-lane entry contract, declared at the sender boundary
 *   (relay.js) and asserted below: the envelope travels under `env`, NOT
 *   `envelope` (the single-publish lane's field name).
 * @param {boolean} [compress] - Batch-level compress intent from the
 *   originating worker; re-gated by this worker's compressor.
 */
export function relayPublishBatched(events, compress) {
	if (!Array.isArray(events) || events.length === 0) return;
	// Hard tier, same trust class as relayPublish above: a malformed entry
	// from a sibling worker means the batched-lane serialization itself is
	// broken, and one systematic fault can corrupt any entry, not just the
	// first - so every entry is vetted before any of them fans out. The
	// return matters in production, where fatal defers the exit past this
	// frame: the batch is the fault unit and none of it may be delivered.
	for (let i = 0; i < events.length; i++) {
		const entry = events[i];
		// A lost element (null/undefined entry) is the most plausible
		// serialization fault of all and must reach the same hard tier, not
		// throw a raw TypeError out of the message handler.
		const entryOk = entry !== null && typeof entry === 'object';
		const topicOk = entryOk && typeof entry.topic === 'string';
		const envOk = entryOk && typeof entry.env === 'string' && entry.env.length > 0;
		fatal(topicOk, 'relay.batched-topic-type', {
			index: i, topic: entryOk ? typeof entry.topic : String(entry)
		});
		fatal(envOk, 'relay.batched-env-type', {
			index: i,
			envType: entryOk ? typeof entry.env : String(entry),
			envLen: envOk ? entry.env.length : null
		});
		if (!topicOk || !envOk) return;
	}
	// The batch arrived as ONE frame but carries a publish per event, so each
	// event advances its own topic's watermark and its own origin stream -
	// ungated by the fan-out decision below and by whether this worker holds
	// a local subscriber.
	for (let i = 0; i < events.length; i++) {
		recordSeen(maxSeenSeq, events[i].topic, events[i].seq, seqBound);
		if (streamTracking.enabled) {
			recordOriginStream(originStreams, events[i].topic, events[i].origin, events[i].ord, events[i].birth,
				relayAttach.at, processMonotonicNow);
		}
	}

	const compressGated = WS_COMPRESSION_ON && compress === true;

	const firstTopic = events[0].topic;
	let allSameTopic = true;
	for (let i = 1; i < events.length; i++) {
		if (events[i].topic !== firstTopic) { allSameTopic = false; break; }
	}
	let allSeeAll = allSameTopic;
	/** @type {Set<string> | null} */
	let batchTopics = null;
	if (!allSameTopic) {
		batchTopics = new Set();
		for (let i = 0; i < events.length; i++) batchTopics.add(events[i].topic);
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
	// A resuming connection receives these events as per-event JSON on either
	// path, so hold each per-event envelope - never the wrapped batch frame.
	if (resumeCaptureActive()) {
		for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].env);
	}
	if (!allSameTopic && !allSeeAll) {
		// Slow path: per-event fan-out, mirroring the local fallback and the
		// receive-side shape cap-less subscribers on this worker would have
		// seen if the originator had taken its slow path too.
		for (let i = 0; i < events.length; i++) {
			fanOut(events[i].topic, events[i].env, null, compressGated);
		}
		return;
	}
	// Fast path: the same shared-frame walk the local fast path takes.
	deliverBatchedEnvelopes(events, allSameTopic, firstTopic, batchTopics, compressGated);
}

export { hasUserSubscribeHook, runUserSubscribeGate, WS_COMPRESSION_ON, ALLOW_NON_ASCII_TOPICS };
