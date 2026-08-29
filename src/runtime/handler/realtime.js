// The realtime engine: WebSocket upgrade admission, connection lifecycle,
// the JSON control-frame demux, and the authenticate preflight endpoint.
// Semantics mirror the family's native tier; the transport is the `ws`
// library over the node HTTP server.

// Substituted by the adapter's build step; free identifiers until then.
/* global WS_OPTIONS */
/* global WS_PATH */
/* global WS_AUTH_PATH */
import { WebSocketServer } from 'ws';
import {
	WS_ATTRIBUTION, WS_CAPS, WS_LEASE, WS_PENDING_REQUESTS, WS_PLATFORM,
	WS_PUBLISH_GRANT, WS_SESSION_ID, WS_STATS, WS_SUBSCRIPTIONS,
	beginPendingSubscribe, pendingSubscribeTotal, settlePendingSubscribe,
	settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership,
	tombstonePendingSubscribe, isPendingSubscribeCancelled,
	releaseDerivedSubscriptions
} from '../utils/ws-symbols.js';
import { MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../utils/caps.js';
import {
	deniesWireSystemTopicSubscribe, deniesWireSubscribePreHook,
	deniesWireSubscribeLanding, wantsRecover, recoverIsRevoked,
	exceedsSubscriptionCap, exceedsPendingSubscribeCap, deniesUngrantedObserve
} from '../utils/subscribe-policy.js';
import { isValidWireTopic } from '../utils/topic.js';
import { assert } from '../utils/assertions.js';
import { isOriginAllowed, isAuthOriginAccepted, describeUnsafeSameOriginConfig } from '../utils/origin.js';
import { installAttribution } from '../utils/attribution.js';
import { snapshotUpgradeHeaders } from '../utils/upgrade-headers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { createSlidingWindowLimiter } from '../utils/rate-limiter.js';
import { activeTraceContext, extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { resolveRequestId } from '../utils/request-id.js';
import {
	createMessageAdmission, runAdmittedMessageHook, runAdmittedMessageWork, messageOverloadedFrame
} from '../utils/message-admission.js';
import { parseCookies, createCookies } from '../cookies.js';
import {
	createLeaseState, leaseGrantFrame, leaseReportedSaturation,
	controlFrameTooLargeFrame, DEFAULT_GRANT
} from '../wire.js';
import { now, monotonicNow, randomUuid, wallEpoch, setTimer, setIntervalTimer, clearIntervalTimer, clearTimer } from '../runtime.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorMessage } from '../error-registry.js';
import { wsModule } from '../ws-handler-bridge.js';
import { capCounts, counters, subscribeAuth, wsConnections, wsWrappers } from './state.js';
import { detachWireStates } from './wire-state.js';
import { startPressureSampler } from './pressure.js';
import { configureEgress } from './egress-budget.js';
import { leaseGrantSize } from '../wire.js';
import { recordBackpressureDrop } from '../utils/backpressure.js';
import { accountClosedLogicalSubscriptions, addLogicalSubscription, removeLogicalSubscription, setSubscriptionAccountingHook } from '../utils/ws-symbols.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './ingress.js';
import { registerGameIngress, gameLaneClusterSafe } from './game-ingress.js';
import { registerSocket, unregisterSocket } from './topic-registry.js';
import { wrapWebSocket } from './ws-facade.js';
import { platform, flushCoalescedFor, hasUserSubscribeHook, runUserSubscribeGate, ALLOW_NON_ASCII_TOPICS } from './platform.js';
import { beginResumeCapture, discardResumeCapture, flushResumeTopic } from './resume-capture.js';
import { bumpIn, bumpOut, setStatsEnabled } from './conn-stats.js';
import { origin as pinnedOrigin, host_header, protocol_header, port_header, is_tls, resolveClientIp, armCloseHookAccounting } from './config.js';
import { isDraining } from './lifecycle.js';

const OPEN = 1;

const wsOptions = WS_OPTIONS || {};
const MAX_PAYLOAD_LENGTH = wsOptions.maxPayloadLength ?? 1024 * 1024;
const MAX_BACKPRESSURE = wsOptions.maxBackpressure ?? 1024 * 1024;
const CLOSE_ON_BACKPRESSURE_LIMIT = wsOptions.closeOnBackpressureLimit === true;
const IDLE_TIMEOUT_S = wsOptions.idleTimeout ?? 120;
const SEND_PINGS = wsOptions.sendPingsAutomatically !== false;
const COMPRESSION = wsOptions.compression ?? false;
const ALLOWED_ORIGINS = wsOptions.allowedOrigins ?? 'same-origin';
const UPGRADE_TIMEOUT_S = wsOptions.upgradeTimeout ?? 10;
const AUTH_PATH_REQUIRE_ORIGIN = wsOptions.authPathRequireOrigin !== false;
const ALLOW_SYSTEM_TOPIC_SUBSCRIBE = wsOptions.allowSystemTopicSubscribe === true;

// Wire-subscribe authorization arming, seeded from the build. subscribeAuth
// lives in state.js so platform.authorizeWireSubscribe can arm it at runtime.
subscribeAuth.enabled = wsOptions.authorizeWireSubscribe === true || wsOptions.authorizeWireSubscribe === 'strict';
subscribeAuth.strict = wsOptions.authorizeWireSubscribe === 'strict';

// Refuse to start when the same-origin policy has no fronting trust to pin
// against: the check would compare two attacker-controlled headers and pass
// for any non-browser client.
const _unsafeOriginErr = describeUnsafeSameOriginConfig({
	allowedOrigins: ALLOWED_ORIGINS,
	hasOriginEnv: !!pinnedOrigin,
	hasHostHeader: !!host_header,
	isTls: is_tls,
	hasUpgradeHook: !!wsModule.upgrade,
	optOut: wsOptions.unsafeSameOriginWithoutHostPin === true
});
if (_unsafeOriginErr) throw new Error(_unsafeOriginErr);

// Warn about unrecognized handler exports - catches typos like "mesage".
const knownWsExports = new Set([
	'init', 'shutdown',
	'open', 'message', 'upgrade', 'close', 'drain',
	'subscribe', 'subscribeBatch', 'unsubscribe',
	'authenticate', 'resume', 'admin', 'attribution', 'egressTenantOf'
]);
for (const name of Object.keys(wsModule)) {
	if (!knownWsExports.has(name)) {
		console.warn(
			`[svelte-adapter-ws] Warning: WebSocket handler exports unknown "${name}". ` +
			`Did you mean one of: ${[...knownWsExports].join(', ')}?\n` +
			'  See: https://svti.me/ws-hooks'
		);
	}
}
armCloseHookAccounting(wsModule.close);
// The egress gate arms from the serialized option section; the tenant
// resolver comes from the handler module - the one carrier that reaches the
// runtime as a function. A defined non-function export refuses at startup
// rather than silently standing every tenant ceiling down.
configureEgress(wsOptions.egress, wsModule.egressTenantOf);
if (wsModule.admin) {
	console.warn(
		'[svelte-adapter-ws] The admin() export is not auto-mounted by this adapter yet. ' +
		'Mount it yourself via a +server.js route until the admin lane ships.'
	);
}

setStatsEnabled(!!wsModule.close);

// The client-relay binary twin: a `wire.ingress:1` connection can bind an id
// to kind `game:1` and publish game frames as `0x03`.
registerGameIngress();

// The 1 Hz pressure sampler and the live logical-subscription counter it
// reads. The hook fires from the shared add/remove primitives, so every
// lane - platform, wire, plugin trackedSubscribe - lands on one counter.
startPressureSampler(wsOptions.pressure);
setSubscriptionAccountingHook((delta) => { counters.totalSubscriptions += delta; });

const messageAdmission = createMessageAdmission(wsOptions.messageAdmission);

// Rate limiters for the two doors, sharing one implementation so a
// correction can never land on only one of them. Bounds match the family:
// 10k tracked identities, 16-entry eviction sample, 128-char keys.
const MAX_RATE_ENTRIES = 10000;
const RATE_MAP_EVICTION_SAMPLE = 16;
const MAX_RATE_KEY_LEN = 128;
const upgradeRateLimiter = createSlidingWindowLimiter({
	maxPerWindow: wsOptions.upgradeRateLimit ?? 10,
	windowMs: (wsOptions.upgradeRateLimitWindow ?? 10) * 1000,
	maxEntries: MAX_RATE_ENTRIES,
	evictionSample: RATE_MAP_EVICTION_SAMPLE,
	maxKeyLen: MAX_RATE_KEY_LEN
});
const authPathRateLimiter = createSlidingWindowLimiter({
	maxPerWindow: wsOptions.authPathRateLimit ?? 30,
	windowMs: (wsOptions.authPathRateLimitWindow ?? 10) * 1000,
	maxEntries: MAX_RATE_ENTRIES,
	evictionSample: RATE_MAP_EVICTION_SAMPLE,
	maxKeyLen: MAX_RATE_KEY_LEN
});
// The periodic sweep keeps stale identities from pinning the maps.
const _rateSweepTimer = setIntervalTimer(() => {
	const t = now();
	upgradeRateLimiter.sweep(t);
	authPathRateLimiter.sweep(t);
}, 60_000);
if (typeof _rateSweepTimer?.unref === 'function') _rateSweepTimer.unref();

export const wss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_PAYLOAD_LENGTH,
	perMessageDeflate: COMPRESSION ? true : false,
	// Echo the client's offered subprotocol: the native tier passes
	// Sec-WebSocket-Protocol through, and a client that offered one
	// hard-fails its handshake when the echo is missing.
	handleProtocols: (protocols) => {
		const first = protocols.values().next().value;
		return first === undefined ? false : first;
	}
});

// Custom 101 headers (the upgradeResponse contract): ws emits a 'headers'
// event before writing the handshake; a per-request map carries the app's
// validated headers into it.
/** @type {WeakMap<import('node:http').IncomingMessage, Record<string, string>>} */
const upgradeExtraHeaders = new WeakMap();
wss.on('headers', (headers, req) => {
	const extra = upgradeExtraHeaders.get(req);
	if (!extra) return;
	for (const [name, value] of Object.entries(extra)) {
		// An array value (several Set-Cookie lines) writes one header LINE per
		// element - joining them would corrupt every cookie after the first.
		if (Array.isArray(value)) {
			for (const item of value) headers.push(`${name}: ${item}`);
		} else {
			headers.push(`${name}: ${value}`);
		}
	}
});

/**
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} text
 * @param {string} [extraHeader]
 */
/**
 * One span per REJECTED admission, so a trace shows why a socket never
 * opened. Fires only with a provider armed; accepted upgrades get their span
 * around the upgrade itself.
 * @param {Record<string, string> | null} headers
 * @param {string} reason
 */
function traceUpgradeRejection(headers, reason) {
	if (!tracingEnabled) return;
	traceOperation('adapter.websocket.admission', {
		kind: 'server',
		parent: headers === null ? null : extractTraceContext(headers),
		attributes: {
			'network.protocol.name': 'websocket',
			'admission.outcome': 'rejected',
			'admission.reason': reason
		}
	}, () => undefined);
}

function refuseUpgrade(socket, status, text, extraHeader) {
	const line = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable', 504: 'Gateway Timeout' }[status] || 'Error';
	try {
		socket.write(
			`HTTP/1.1 ${status} ${line}\r\nContent-Type: text/plain\r\nConnection: close\r\n` +
			(extraHeader ? extraHeader + '\r\n' : '') +
			`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` + text
		);
	} catch { /* peer already gone */ }
	socket.destroy();
}

/**
 * The node 'upgrade' listener. Wire this on the HTTP server.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 */
export async function handleUpgrade(req, socket, head) {
	// Own the socket's 'error' event for the whole admission window. Until
	// wss.handleUpgrade hands the socket to ws, nothing is listening: a client
	// that resets the TCP connection while the admission hook is parked makes
	// node emit 'error' on an ownerless emitter, and one unauthenticated RST
	// becomes an uncaught exception that takes the worker down. The listener
	// is detached the moment ws takes ownership and installs its own.
	const onSocketError = () => socket.destroy();
	socket.on('error', onSocketError);

	const url = req.url || '/';
	const q = url.indexOf('?');
	const pathname = q === -1 ? url : url.slice(0, q);
	if (pathname !== WS_PATH) {
		refuseUpgrade(socket, 404, 'Not Found');
		return;
	}
	if (isDraining()) {
		refuseUpgrade(socket, 503, 'Service Unavailable');
		return;
	}

	// Full header policy: repeated singletons refuse the handshake the same
	// way they refuse a request.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		traceUpgradeRejection(null, 'duplicate_header');
		refuseUpgrade(socket, 400, 'Bad Request');
		return;
	}
	const wsTraceParent = extractTraceContext(headers);

	const direct = req.socket?.remoteAddress || '';
	const clientIp = resolveClientIp(direct, headers, direct);

	if (upgradeRateLimiter.exceeded(clientIp, now())) {
		traceUpgradeRejection(headers, 'ip_rate_limit');
		refuseUpgrade(socket, 429, 'Too Many Requests');
		return;
	}

	if (!isOriginAllowed(headers['origin'], headers, {
		allowedOrigins: ALLOWED_ORIGINS,
		pinnedOrigin,
		// The proxy headers the deployment trusts: without them the check
		// falls back to the client-controlled Host and the direct scheme,
		// which behind a TLS-terminating proxy 403s every real browser and
		// behind no proxy compares two attacker-controlled headers.
		hostHeader: host_header,
		protocolHeader: protocol_header,
		portHeader: port_header,
		isTls: is_tls,
		hasUpgradeHook: !!wsModule.upgrade
	})) {
		traceUpgradeRejection(headers, 'bad_origin');
		refuseUpgrade(socket, 403, 'Origin not allowed');
		return;
	}

	const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();

	// The connection inherits the upgrade request's trace context; a span
	// started around the upgrade hook below refines it to the hook's own.
	let connectionTraceContext = wsTraceParent;

	let userData = {};
	if (wsModule.upgrade) {
		// The admission hook is awaited under the upgrade deadline: an
		// admission source that hangs must answer 504, not park the socket.
		let timedOut = false;
		let timer = null;
		try {
			const callUpgradeHook = () => {
				connectionTraceContext = activeTraceContext() ?? wsTraceParent;
				return wsModule.upgrade({
					headers,
					cookies: parseCookies(headers['cookie']),
					url,
					remoteAddress: clientIp,
					requestId: wsRequestId,
					traceContext: connectionTraceContext
				});
			};
			const hookRun = Promise.resolve(tracingEnabled
				? traceOperation('adapter.websocket.upgrade', {
					kind: 'server',
					parent: wsTraceParent,
					attributes: { 'network.protocol.name': 'websocket' }
				}, callUpgradeHook)
				: callUpgradeHook());
			const TIMEOUT = Symbol('timeout');
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => { timedOut = true; resolve(TIMEOUT); }, UPGRADE_TIMEOUT_S * 1000); // determinism-allow: admission deadline over a real socket, outside the replayable engine
				if (typeof timer?.unref === 'function') timer.unref();
			});
			const result = await Promise.race([hookRun, deadline]);
			if (timer) clearTimeout(timer); // determinism-allow: pairs with the admission deadline above
			if (result === TIMEOUT) {
				traceUpgradeRejection(headers, 'auth_timeout');
				refuseUpgrade(socket, 504, 'Upgrade timed out');
				return;
			}
			if (result === false) {
				traceUpgradeRejection(headers, 'auth_rejected');
				refuseUpgrade(socket, 401, 'Unauthorized');
				return;
			}
			if (result && /** @type {any} */ (result).__upgradeResponse === true) {
				userData = /** @type {any} */ (result).userData || {};
				const responseHeaders = snapshotUpgradeHeaders(/** @type {any} */ (result).headers);
				if (responseHeaders && Object.keys(responseHeaders).length > 0) {
					upgradeExtraHeaders.set(req, responseHeaders);
				}
			} else {
				userData = result || {};
			}
		} catch (err) {
			if (timer) clearTimeout(timer); // determinism-allow: pairs with the admission deadline above
			if (!timedOut) {
				emitOperationalEvent({
					source: 'svelte-adapter-ws',
					component: 'runtime.websocket-upgrade',
					event: 'runtime.websocket-upgrade.failed',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'The WebSocket upgrade hook failed.',
					attributes: { requestId: wsRequestId, error: diagnosticError(err) }
				});
				traceUpgradeRejection(headers, 'hook_error');
				refuseUpgrade(socket, 500, 'Internal Server Error', 'X-Request-ID: ' + wsRequestId);
			}
			return;
		}
	}

	// A peer that vanished during admission has nothing left to accept or
	// refuse; ws would notice on its own, but skipping the accept avoids
	// tearing down a connection that never opened.
	if (socket.destroyed) return;

	wss.handleUpgrade(req, socket, head, (ws) => {
		// ws owns the socket's error handling from here on.
		socket.removeListener('error', onSocketError);
		const remoteAddress = /** @type {any} */ (userData).remoteAddress || clientIp;
		const merged = { remoteAddress, .../** @type {any} */ (userData) };
		try {
			openConnection(ws, merged, wsRequestId, connectionTraceContext);
		} catch (err) {
			// A failure between accept and full registration must tear the
			// socket down completely - a half-registered connection would sit
			// in the walks forever with no close listener to reap it.
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.websocket-open',
				event: 'runtime.websocket-open.failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'Connection setup failed after the upgrade completed.',
				attributes: { requestId: wsRequestId, error: diagnosticError(err) }
			});
			const facade = wsWrappers.get(ws);
			unregisterSocket(ws);
			wsWrappers.delete(ws);
			if (facade) wsConnections.delete(facade);
			try { ws.terminate(); } catch { /* already gone */ }
		}
	});
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} userData
 * @param {string} requestId
 */
function openConnection(rawWs, userData, requestId, connectionTraceContext = null) {
	// The error listener attaches before anything can close the socket - a
	// peer RST during setup must never become an uncaught emitter throw.
	rawWs.on('error', (err) => {
		if (/** @type {any} */ (err)?.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
			console.error('[svelte-adapter-ws] connection error:', err);
		}
	});
	registerSocket(rawWs);
	userData[WS_SUBSCRIPTIONS] = new Set();

	const wsPlatform = Object.create(platform);
	wsPlatform.requestId = requestId;
	// The platform's traceContext getter falls back to this when no operation
	// span is active, so message hooks parent onto the connection's context.
	Object.defineProperty(wsPlatform, 'connectionTraceContext', { value: connectionTraceContext });
	userData[WS_PLATFORM] = wsPlatform;

	const facade = wrapWebSocket(rawWs, userData, {
		maxBackpressure: MAX_BACKPRESSURE,
		closeOnBackpressureLimit: CLOSE_ON_BACKPRESSURE_LIMIT,
		compressionEnabled: !!COMPRESSION,
		onDrop: (byteLength) => {
			counters.droppedFrames++;
			counters.droppedBytes += byteLength;
			recordBackpressureDrop(counters, { byteLength });
		},
		onDrain: (f) => {
			flushCoalescedFor(f);
			// The drain callback rides a node write callback, not a native
			// boundary - an app throw here would otherwise be uncaught.
			try {
				wsModule.drain?.(f, { platform: userData[WS_PLATFORM] });
			} catch (err) {
				console.error('[adapter-ws] drain hook threw:', err);
			}
		},
		peerFacadeOf: (peer) => wsWrappers.get(peer)
	});

	// Attribution: resolved once, before the app open hook, fail-closed.
	try {
		installAttribution(wsModule.attribution, userData);
	} catch (err) {
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.websocket-attribution',
			event: 'runtime.websocket-attribution.failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The WebSocket attribution hook failed; the connection was refused at open.',
			attributes: { requestId, error: diagnosticError(err) }
		});
		unregisterSocket(rawWs);
		try { rawWs.close(1008, 'Attribution failed'); } catch { /* already gone */ }
		return;
	}

	const sessionId = randomUuid();
	userData[WS_SESSION_ID] = sessionId;
	userData[WS_STATS] = {
		openedAt: monotonicNow(),
		messagesIn: 0,
		messagesOut: 0,
		bytesIn: 0,
		bytesOut: 0
	};

	wsWrappers.set(rawWs, facade);
	wsConnections.add(facade);

	// Idle reaping: ws has no built-in idle timeout, so a JS timer plus
	// ping/pong stands in. A live peer answers the half-interval ping and the
	// deadline never fires; a vanished peer is terminated at the timeout.
	let lastActivity = monotonicNow();
	/** @type {any} */
	let idleTimer = null;
	if (IDLE_TIMEOUT_S > 0) {
		const halfMs = (IDLE_TIMEOUT_S * 1000) / 2;
		idleTimer = setIntervalTimer(() => {
			const idleFor = monotonicNow() - lastActivity;
			// The idle tick doubles as the drain-edge backstop: a pressure
			// episode whose last flush callback rode a callback-less write
			// (ping, pong, close frame) is caught here within a half-interval.
			/** @type {any} */ (facade)._checkDrain?.();
			if (idleFor >= IDLE_TIMEOUT_S * 1000) {
				rawWs.terminate();
			} else if (SEND_PINGS && idleFor >= halfMs && rawWs.readyState === OPEN) {
				try { rawWs.ping(); } catch { /* closing */ }
			}
		}, halfMs);
		if (typeof idleTimer?.unref === 'function') idleTimer.unref();
	}
	rawWs.on('pong', () => { lastActivity = monotonicNow(); });

	const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
	try { rawWs.send(welcome); } catch { /* closing */ }
	bumpOut(userData, welcome);

	rawWs.on('message', (raw, isBinary) => {
		lastActivity = monotonicNow();
		void handleMessage(rawWs, facade, userData, /** @type {Buffer} */ (raw), !!isBinary).catch((err) => {
			console.error('[svelte-adapter-ws] message handling failed:', err);
		});
	});

	rawWs.on('close', (code, reason) => {
		if (idleTimer !== null) clearIntervalTimer(idleTimer);
		closeConnection(rawWs, facade, userData, code, reason);
	});

	// The app open hook runs LAST, with every listener armed: a throw here is
	// contained and the connection keeps its close path.
	try {
		wsModule.open?.(facade, { platform: userData[WS_PLATFORM] });
	} catch (err) {
		console.error('[adapter-ws] open hook threw:', err);
	}
}

/** @param {object} facade @param {any} rejection */
function rejectApplicationMessage(facade, rejection) {
	const frame = messageOverloadedFrame(rejection);
	try {
		/** @type {any} */ (facade).send(frame, false, false);
		bumpOut(/** @type {any} */ (facade).getUserData(), frame);
	} catch { /* closed */ }
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {Buffer} raw
 * @param {boolean} isBinary
 */
async function handleMessage(rawWs, facade, userData, raw, isBinary) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
	bumpIn(userData, buf);

	// Binary ingress (client-to-server 0x03): an ingress-capable connection's
	// id-addressed binary frames decode and route ahead of the JSON control
	// block and the app hook. Only an actual 0x03 frame pays the cap lookup.
	if (isBinary && buf[0] === 0x03) {
		const icaps = userData[WS_CAPS];
		if (icaps !== undefined && icaps.has(WIRE_INGRESS_CAP)) {
			await runAdmittedMessageWork(messageAdmission, facade, { data: buf, platform: userData[WS_PLATFORM] }, runIngressWork, rejectApplicationMessage);
			return;
		}
	}

	// Oversized control-shaped frame: reject explicitly instead of a silent
	// fall-through.
	if (!isBinary && buf.byteLength >= 8192 && buf[3] === 0x79 /* 'y' in {"type" */) {
		const rejectFrame = controlFrameTooLargeFrame(buf.byteLength);
		try { rawWs.send(rejectFrame); } catch { /* closed */ }
		bumpOut(userData, rejectFrame);
		return;
	}

	/** @type {any} */
	let msg;
	if (!isBinary && buf.byteLength < 8192 && buf[3] === 0x79) {
		try {
			msg = JSON.parse(buf.toString());
			if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) msg = undefined;
		} catch {
			msg = undefined;
		}
	}

	// Control dispatch runs OUTSIDE the parse guard: a throw inside a control
	// handler surfaces to the message-loop catch instead of being swallowed
	// and the frame re-delivered to the app hook as raw bytes.
	if (msg !== undefined) {

			if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
				await handleSubscribe(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
				tombstonePendingSubscribe(userData, msg.topic);
				{ const subsSet = userData[WS_SUBSCRIPTIONS]; if (subsSet instanceof Set) removeLogicalSubscription(subsSet, msg.topic); }
				try { facade.unsubscribe(msg.topic); } catch { /* closed */ }
				if (userData[WS_PUBLISH_GRANT] === msg.topic) userData[WS_PUBLISH_GRANT] = undefined;
				releaseDerivedSubscriptions(facade, msg.topic);
				wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
				return;
			}
			if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
				await handleSubscribeBatch(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'hello' && Array.isArray(msg.caps)) {
				const caps = new Set();
				for (let i = 0; i < msg.caps.length; i++) {
					if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
				}
				// A re-sent hello REPLACES the cap set; the live per-capability
				// counts follow the diff.
				capCounts.adjust(userData[WS_CAPS], caps);
				userData[WS_CAPS] = caps;
				// Opt-in confirm for binary ingress (mirror of lease-ok).
				if (caps.has(WIRE_INGRESS_CAP)) {
					const okFrame = ingressOkFrame();
					try { rawWs.send(okFrame); } catch { /* closed */ }
					bumpOut(userData, okFrame);
				}
				// Only the first hello allocates the lease slot and emits the
				// first window, so a re-sent hello does not reset the gate.
				if (caps.has('lease') && !userData[WS_LEASE]) {
					const grantCount = leaseGrantSize({
						heapRatio: counters.lastHeapUsedRatio,
						subscriberRatio: wsConnections.size > 0 ? counters.totalSubscriptions / wsConnections.size : 0
					});
					const gate = createLeaseState({ requestCount: grantCount, ttlMs: DEFAULT_GRANT.ttlMs });
					gate.grant();
					userData[WS_LEASE] = { gate, saturation: 0 };
					try { rawWs.send('{"type":"lease-ok"}'); } catch { /* closed */ }
					bumpOut(userData, '{"type":"lease-ok"}');
					const frame = leaseGrantFrame(grantCount, DEFAULT_GRANT.ttlMs);
					try { rawWs.send(frame); } catch { /* closed */ }
					bumpOut(userData, frame);
				}
				return;
			}
			if (msg.type === 'reply' && (typeof msg.ref === 'number' || typeof msg.ref === 'string')) {
				const pending = userData[WS_PENDING_REQUESTS];
				const entry = pending?.get(msg.ref);
				if (entry) {
					pending.delete(msg.ref);
					clearTimer(entry.timer);
					if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
					else entry.resolve(msg.data);
				}
				return;
			}
			if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
				msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
				await handleWholeSessionResume(rawWs, facade, userData, msg);
				return;
			}
			if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
				// Client binds a client-allocated ingress id to a decode+route
				// destination. Unknown kind: no bind, no ack, JSON fallback.
				if (bindIngress(userData, facade, msg.id, msg.kind, msg.target)) {
					const boundFrame = ingressBoundFrame(msg.id);
					try { rawWs.send(boundFrame); } catch { /* closed */ }
					bumpOut(userData, boundFrame);
				}
				return;
			}
			if (msg.type === 'request-n') {
				const slot = userData[WS_LEASE];
				if (slot) {
					slot.saturation = leaseReportedSaturation(msg.queued);
					if (slot.saturation > counters.leaseSaturationPeak) counters.leaseSaturationPeak = slot.saturation;
					const regrant = leaseGrantSize({
						heapRatio: counters.lastHeapUsedRatio,
						subscriberRatio: wsConnections.size > 0 ? counters.totalSubscriptions / wsConnections.size : 0
					});
					slot.gate.requestN(regrant, DEFAULT_GRANT.ttlMs);
					const frame = leaseGrantFrame(regrant, DEFAULT_GRANT.ttlMs);
					try { rawWs.send(frame); } catch { /* closed */ }
					bumpOut(userData, frame);
				}
				return;
			}
			if (msg.type === 'game') {
				await runAdmittedMessageWork(messageAdmission, facade, { msg, platform: userData[WS_PLATFORM], data: raw }, runGameWork, rejectApplicationMessage);
				return;
			}
	}

	const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	await runAdmittedMessageHook(messageAdmission, wsModule.message, facade, { data: arrayBuffer, isBinary, msg, platform: userData[WS_PLATFORM] }, rejectApplicationMessage);
}

/** @param {any} facade @param {any} context */
function runIngressWork(facade, context) {
	return dispatchIngressFrame(facade, facade.getUserData(), context.data, context.platform);
}

/** @param {any} facade @param {any} context */
function runGameWork(facade, context) {
	const msg = context.msg;
	const gud = facade.getUserData();
	const grantTopic = gud?.[WS_PUBLISH_GRANT];
	// The game lane's room sequencer is worker-local, so a topology where
	// sockets can land on more than one I/O worker denies the frame rather
	// than forking a room's sequence across workers - the same rule
	// grantPublish enforces at authorization time.
	const clusterSafe = gameLaneClusterSafe();
	if (!clusterSafe || !grantTopic || typeof msg.event !== 'string') {
		const reason = clusterSafe && grantTopic ? 'INVALID' : 'FORBIDDEN';
		const denied = msg.id === undefined
			? JSON.stringify({ type: 'game-denied', reason })
			: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
		try { facade.send(denied, false, false); } catch { /* closed */ }
		bumpOut(gud, denied);
		return;
	}
	context.platform.publishGame(facade, grantTopic, msg.event, msg.data, msg.id);
}

/** @param {import('ws').WebSocket} rawWs @param {string} topic @param {number | string | null} ref @param {any} userData */
function sendSubscribed(rawWs, topic, ref, userData) {
	if (ref === null) return;
	// Carry the topic's current generation on the ack so a later resume can
	// detect a reset seq space.
	const payload = JSON.stringify({ type: 'subscribed', topic, ref, epoch: platform.topicEpoch(topic) });
	try { rawWs.send(payload); } catch { /* closed */ }
	bumpOut(userData, payload);
}

/** @param {import('ws').WebSocket} rawWs @param {string} topic @param {number | string | null} ref @param {string} reason @param {any} userData */
function sendDenied(rawWs, topic, ref, reason, userData) {
	if (ref === null) return;
	const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
	try { rawWs.send(payload); } catch { /* closed */ }
	bumpOut(userData, payload);
}

/** @param {unknown} ref @returns {ref is number | string} */
function hasRefValue(ref) {
	return typeof ref === 'number' || typeof ref === 'string';
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleSubscribe(rawWs, facade, userData, msg) {
	const ref = hasRefValue(msg.ref) ? msg.ref : null;
	if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS)) {
		sendDenied(rawWs, msg.topic, ref, 'INVALID_TOPIC', userData);
		return;
	}
	if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic: msg.topic })) {
		sendDenied(rawWs, msg.topic, ref, 'INVALID_TOPIC', userData);
		return;
	}
	const subs = userData[WS_SUBSCRIPTIONS];
	assert(subs instanceof Set, 'subs.shape', null);
	const isNew = !subs.has(msg.topic);
	if (exceedsSubscriptionCap({ held: !isNew, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
		sendDenied(rawWs, msg.topic, ref, 'RATE_LIMITED', userData);
		return;
	}
	if (deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: !isNew, topic: msg.topic })) {
		sendDenied(rawWs, msg.topic, ref, 'FORBIDDEN', userData);
		return;
	}
	if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(userData), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) {
		sendDenied(rawWs, msg.topic, ref, 'RATE_LIMITED', userData);
		return;
	}
	// Enrol before the await so a revocation landing while the hook is parked
	// can see this subscribe and cancel it.
	const token = beginPendingSubscribe(userData, msg.topic, subs.has(msg.topic));
	const denial = await runUserSubscribeGate(facade, msg.topic);
	if (denial !== null) {
		if (settleDeniedSubscribe(userData, msg.topic, token, subs.has(msg.topic)) === 'deny-unwind') {
			unwindRevokedMembership(facade, msg.topic);
			wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
		}
		sendDenied(rawWs, msg.topic, ref, denial, userData);
		return;
	}
	// Post-await held re-check - except when a gap-fill was requested: live
	// membership arriving during the await carries no history.
	const _wantsRecover = wantsRecover({ hasResumeHook: wsModule.resume, recover: msg.recover });
	if (subs.has(msg.topic) && !_wantsRecover) {
		const heldVerdict = settleHeldSubscribe(userData, msg.topic, token);
		if (heldVerdict === 'ack') {
			sendSubscribed(rawWs, msg.topic, ref, userData);
			return;
		}
		if (heldVerdict === 'deny-unwind') {
			unwindRevokedMembership(facade, msg.topic);
			wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
		}
		sendDenied(rawWs, msg.topic, ref, 'FORBIDDEN', userData);
		return;
	}
	// Landing re-check: the pre-gate stands aside for a plugin-owned topic so
	// the plugin's hook can run; the landing confirms the hook actually
	// admitted this socket.
	if (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: subs.has(msg.topic), topic: msg.topic })) {
		settlePendingSubscribe(userData, msg.topic, token);
		sendDenied(rawWs, msg.topic, ref, 'FORBIDDEN', userData);
		return;
	}
	if (exceedsSubscriptionCap({ held: subs.has(msg.topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
		settlePendingSubscribe(userData, msg.topic, token);
		sendDenied(rawWs, msg.topic, ref, 'RATE_LIMITED', userData);
		return;
	}
	// Resume-on-subscribe: gap-fill via the resume hook before subscribing to
	// live, so __replay frames precede the first live frame.
	let capture = null;
	const _recoverRevoked = recoverIsRevoked({
		held: subs instanceof Set && subs.has(msg.topic),
		wireAuthz: subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()),
		cancelled: isPendingSubscribeCancelled(userData, msg.topic, token),
		topic: msg.topic
	});
	if (!_recoverRevoked && _wantsRecover) {
		const epochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
		capture = beginResumeCapture([msg.topic], facade);
		try {
			await wsModule.resume(facade, {
				sessionId: userData[WS_SESSION_ID],
				lastSeenSeqs: { [msg.topic]: msg.recover.offset },
				lastSeenEpochs: epochs,
				platform: userData[WS_PLATFORM]
			});
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err);
		}
		if (subs.has(msg.topic)) {
			const heldVerdict = settleHeldSubscribe(userData, msg.topic, token);
			if (heldVerdict === 'ack') {
				discardResumeCapture(capture);
				sendSubscribed(rawWs, msg.topic, ref, userData);
				return;
			}
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(facade, msg.topic);
				wsModule.unsubscribe?.(facade, msg.topic, { platform: userData[WS_PLATFORM] });
			}
			discardResumeCapture(capture);
			sendDenied(rawWs, msg.topic, ref, 'FORBIDDEN', userData);
			return;
		}
	}
	// Landing settle: a revocation that bumped this subscribe's epoch while
	// the hook was parked means the grant is discarded, not installed.
	if (!settlePendingSubscribe(userData, msg.topic, token, true)) {
		if (capture) discardResumeCapture(capture);
		sendDenied(rawWs, msg.topic, ref, 'FORBIDDEN', userData);
		return;
	}
	try {
		facade.subscribe(msg.topic);
	} catch {
		if (capture) discardResumeCapture(capture);
		counters.closedWsAborts++;
		return;
	}
	addLogicalSubscription(subs, msg.topic);
	if (capture) {
		flushResumeTopic(capture, msg.topic, (payload) => {
			try {
				const result = facade.send(payload, false, false);
				if (result !== 2) bumpOut(userData, payload);
				return result;
			} catch { return 2; }
		});
	}
	sendSubscribed(rawWs, msg.topic, ref, userData);
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleSubscribeBatch(rawWs, facade, userData, msg) {
	const ref = hasRefValue(msg.ref) ? msg.ref : null;
	const topics = msg.topics.slice(0, 256);
	// Topics past the 256 cap are denied loudly, never silently dropped.
	for (let i = 256; i < msg.topics.length; i++) {
		if (typeof msg.topics[i] === 'string') {
			sendDenied(rawWs, msg.topics[i], ref, 'BATCH_OVERFLOW', userData);
		}
	}
	const valid = [];
	for (const topic of topics) {
		if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS)) {
			sendDenied(rawWs, topic, ref, 'INVALID_TOPIC', userData);
			continue;
		}
		if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic })) {
			sendDenied(rawWs, topic, ref, 'INVALID_TOPIC', userData);
			continue;
		}
		valid.push(topic);
	}
	// One reading of the app's hooks per frame - the reload path reassigns
	// them, and a per-topic read could split one frame across two versions.
	const _hasUserHook = hasUserSubscribeHook();
	const _wireAuthz = subscribeAuth.enabled && (subscribeAuth.strict || !_hasUserHook);
	const _authzSubs = userData[WS_SUBSCRIPTIONS];
	const authzDenied = _wireAuthz
		? valid.map((t) => deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held: _authzSubs instanceof Set && _authzSubs.has(t), topic: t }))
		: null;
	// In-flight authorization capacity: topics beyond the pending budget take
	// no further part in the frame.
	const headroom = MAX_PENDING_SUBSCRIBES_PER_CONNECTION - pendingSubscribeTotal(userData);
	if (headroom < valid.length) {
		for (let i = Math.max(headroom, 0); i < valid.length; i++) {
			sendDenied(rawWs, valid[i], ref, authzDenied?.[i] ? 'FORBIDDEN' : 'RATE_LIMITED', userData);
		}
		valid.length = Math.max(headroom, 0);
	}
	// A topic the grant gate already denied must not reach the hook.
	const hookTopics = authzDenied === null
		? valid.slice()
		: valid.filter((_t, i) => !authzDenied[i]);
	// Enrol every topic in the batch before the hook awaits.
	const batchTokens = valid.map((t) => beginPendingSubscribe(userData, t, _authzSubs instanceof Set && _authzSubs.has(t)));

	/** @type {Record<string, string> | null} */
	let batchDenials = null;
	/** @type {Array<string | null> | null} */
	let perTopicDenials = null;
	if (wsModule.subscribeBatch && hookTopics.length > 0) {
		try {
			const result = await wsModule.subscribeBatch(facade, hookTopics, { platform: userData[WS_PLATFORM] });
			batchDenials = Object.create(null);
			if (result && typeof result === 'object') {
				try {
					for (const [topic, val] of Object.entries(result)) {
						if (val === false) batchDenials[topic] = 'FORBIDDEN';
						else if (typeof val === 'string') batchDenials[topic] = val;
					}
				} catch (err) {
					console.error('[adapter-ws] subscribeBatch result read threw:', err);
					batchDenials = Object.create(null);
					for (const t of hookTopics) batchDenials[t] = 'INTERNAL_ERROR';
				}
			}
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_HOOK), err);
			batchDenials = Object.create(null);
			for (const t of hookTopics) batchDenials[t] = 'INTERNAL_ERROR';
		}
	} else if (wsModule.subscribe) {
		perTopicDenials = await Promise.all(valid.map((t, i) =>
			(authzDenied !== null && authzDenied[i]) ? Promise.resolve(null) : runUserSubscribeGate(facade, t)));
	}

	const udSubs = userData[WS_SUBSCRIPTIONS];
	assert(udSubs instanceof Set, 'subs.shape-batch', null);

	// Resume-on-subscribe (batch): gap-fill every recover-tagged topic that
	// passed the gates in one resume-hook call, before the subscribe loop.
	/** @type {Record<string, number> | null} */
	let recoverSeqs = null;
	/** @type {Record<string, number> | null} */
	let recoverEpochs = null;
	let batchCapture = null;
	if (msg.recover && typeof msg.recover === 'object') {
		for (let i = 0; i < valid.length; i++) {
			const t = valid[i];
			const held = udSubs instanceof Set && udSubs.has(t);
			const denial = (authzDenied !== null && authzDenied[i] ? 'FORBIDDEN' : null)
				?? (recoverIsRevoked({ held, wireAuthz: _wireAuthz, cancelled: isPendingSubscribeCancelled(userData, t, batchTokens[i]), topic: t }) ? 'FORBIDDEN' : null)
				?? (batchDenials !== null ? (batchDenials[t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
			if (denial !== null) continue;
			const rec = msg.recover[t];
			if (wantsRecover({ hasResumeHook: wsModule.resume, recover: rec })) {
				if (recoverSeqs === null) recoverSeqs = {};
				recoverSeqs[t] = rec.offset;
				if (Number.isInteger(rec.epoch)) {
					if (recoverEpochs === null) recoverEpochs = {};
					recoverEpochs[t] = rec.epoch;
				}
			}
		}
		if (recoverSeqs !== null && wsModule.resume) {
			batchCapture = beginResumeCapture(Object.keys(recoverSeqs), facade);
			try {
				await wsModule.resume(facade, {
					sessionId: userData[WS_SESSION_ID],
					lastSeenSeqs: recoverSeqs,
					lastSeenEpochs: recoverEpochs || undefined,
					platform: userData[WS_PLATFORM]
				});
			} catch (err) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err);
			}
		}
	}

	for (let i = 0; i < valid.length; i++) {
		const topic = valid[i];
		const held = udSubs.has(topic);
		const denial = (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held, topic }) ? 'FORBIDDEN' : null)
			?? (batchDenials !== null
				? (batchDenials[topic] ?? null)
				: (perTopicDenials !== null ? perTopicDenials[i] : null));
		if (denial !== null) {
			if (settleDeniedSubscribe(userData, topic, batchTokens[i], held) === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: userData[WS_PLATFORM] });
			}
			sendDenied(rawWs, topic, ref, denial, userData);
			continue;
		}
		if (held) {
			const heldVerdict = settleHeldSubscribe(userData, topic, batchTokens[i]);
			if (heldVerdict === 'ack') {
				sendSubscribed(rawWs, topic, ref, userData);
				continue;
			}
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(facade, topic);
				wsModule.unsubscribe?.(facade, topic, { platform: userData[WS_PLATFORM] });
			}
			sendDenied(rawWs, topic, ref, 'FORBIDDEN', userData);
			continue;
		}
		if (exceedsSubscriptionCap({ held, size: udSubs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
			settlePendingSubscribe(userData, topic, batchTokens[i]);
			sendDenied(rawWs, topic, ref, 'RATE_LIMITED', userData);
			continue;
		}
		if (!settlePendingSubscribe(userData, topic, batchTokens[i], true)) {
			sendDenied(rawWs, topic, ref, 'FORBIDDEN', userData);
			continue;
		}
		try {
			facade.subscribe(topic);
		} catch {
			counters.closedWsAborts++;
			continue;
		}
		addLogicalSubscription(udSubs, topic);
		if (batchCapture) {
			flushResumeTopic(batchCapture, topic, (payload) => {
				try {
					const result = facade.send(payload, false, false);
					if (result !== 2) bumpOut(userData, payload);
					return result;
				} catch { return 2; }
				});
		}
		sendSubscribed(rawWs, topic, ref, userData);
	}
	if (batchCapture) discardResumeCapture(batchCapture);
}

/**
 * The whole-session `resume` frame (compat carrier; resume-on-subscribe is
 * the reference mechanism).
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {any} msg
 */
async function handleWholeSessionResume(rawWs, facade, userData, msg) {
	const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
		? msg.lastSeenEpochs
		: undefined;
	// Grant filter: under the pure-grant model, ungranted topics are dropped
	// before the hook sees them.
	let resumeSeqs = msg.lastSeenSeqs;
	if (subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()) && resumeSeqs && typeof resumeSeqs === 'object') {
		const grants = userData[WS_SUBSCRIPTIONS];
		/** @type {Record<string, unknown>} */
		const allowed = Object.create(null);
		let droppedCount = 0;
		for (const t of Object.keys(resumeSeqs)) {
			if (deniesUngrantedObserve(true, false, grants, t)) { droppedCount++; continue; }
			allowed[t] = resumeSeqs[t];
		}
		if (droppedCount > 0) resumeSeqs = allowed;
	}
	if (wsModule.resume) {
		try {
			// Awaited so per-topic replay completes before the `resumed` ack
			// tells the client to switch to live mode.
			await wsModule.resume(facade, {
				sessionId: msg.sessionId,
				lastSeenSeqs: resumeSeqs,
				lastSeenEpochs,
				platform: userData[WS_PLATFORM]
			});
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RESUME_HOOK), err);
		}
	}
	try { rawWs.send('{"type":"resumed"}'); } catch { /* closed */ }
	bumpOut(userData, '{"type":"resumed"}');
}

/**
 * @param {import('ws').WebSocket} rawWs
 * @param {any} facade
 * @param {any} userData
 * @param {number} code
 * @param {Buffer} reason
 */
function closeConnection(rawWs, facade, userData, code, reason) {
	const reasonBuf = reason || Buffer.alloc(0);
	const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
	messageAdmission.close(facade);
	const subs = userData[WS_SUBSCRIPTIONS] || new Set();
	// Reject pending requests, clearing timers first; delete-then-reject so a
	// reply racing the close cannot double-settle.
	const pending = userData[WS_PENDING_REQUESTS];
	if (pending && pending.size > 0) {
		for (const entry of pending.values()) {
			clearTimer(entry.timer);
			try {
				entry.reject(new Error(adapterErrorMessage(
					ADAPTER_ERROR_IDS.REQUEST_CLOSED,
					entry.sent
						? REQUEST_CLOSED_DETAIL.UNANSWERED
						: REQUEST_CLOSED_DETAIL.NEVER_SENT
				)));
			} catch { /* listener threw */ }
		}
		pending.clear();
	}
	const stats = userData[WS_STATS];
	const closePlatform = userData[WS_PLATFORM];
	// The app close hook fires only for a connection whose open completed
	// (an attribution refusal never opened).
	if (userData[WS_SESSION_ID] !== undefined && wsModule.close) {
		const ctx = stats
			? {
				code,
				message: reasonAB,
				platform: closePlatform,
				subscriptions: subs,
				id: userData[WS_SESSION_ID],
				duration: Math.round(monotonicNow() - stats.openedAt),
				messagesIn: stats.messagesIn,
				messagesOut: stats.messagesOut,
				bytesIn: stats.bytesIn,
				bytesOut: stats.bytesOut
			}
			: { code, message: reasonAB, platform: closePlatform, subscriptions: subs };
		try {
			wsModule.close(facade, ctx);
		} catch (err) {
			console.error('[adapter-ws] close hook threw:', err);
		}
	}
	accountClosedLogicalSubscriptions(subs);
	if (userData[WS_LEASE]) userData[WS_LEASE] = undefined;
	capCounts.adjust(userData[WS_CAPS], null);
	userData[WS_CAPS] = undefined;
	detachWireStates(facade, userData);
	unregisterSocket(rawWs);
	wsConnections.delete(facade);
	wsWrappers.delete(rawWs);
}

// - Authenticate preflight endpoint ------------------------------------------

/**
 * Handle the authenticate POST at WS_AUTH_PATH as a normal HTTP exchange so
 * session cookies refresh via a standard Set-Cookie. Returns true when the
 * request was handled here.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean}
 */
export function tryAuthenticateRoute(req, res, pathname) {
	if (pathname !== WS_AUTH_PATH) return false;
	if (!wsModule.authenticate) return false;
	const authenticate = () => runAuthenticateRoute(req, res).catch(() => {
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain' });
			res.end('Internal Server Error');
		}
	});
	if (tracingEnabled) {
		void traceOperation('adapter.http.websocket-authenticate', {
			kind: 'server',
			parent: extractTraceContext({
				traceparent: /** @type {string} */ (req.headers['traceparent']),
				tracestate: /** @type {string} */ (req.headers['tracestate'])
			}),
			attributes: {
				'http.request.method': req.method || 'POST',
				'network.protocol.name': 'http'
			}
		}, authenticate);
	} else {
		void authenticate();
	}
	return true;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function runAuthenticateRoute(req, res) {
	if (req.method !== 'POST') {
		res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' });
		res.end('Method Not Allowed');
		return;
	}

	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguous = collectRequestHeaders(req.rawHeaders, headers);
	if (ambiguous !== null) {
		res.writeHead(400, { 'content-type': 'text/plain' });
		res.end('Bad Request');
		return;
	}

	// CSRF defense FIRST, the limiter after: metering rejected origins would
	// let hostile cross-site traffic behind a shared NAT consume the
	// legitimate clients' whole authentication budget.
	if (AUTH_PATH_REQUIRE_ORIGIN && !isAuthOriginAccepted(headers, {
		allowedOrigins: ALLOWED_ORIGINS,
		pinnedOrigin,
		hostHeader: host_header,
		protocolHeader: protocol_header,
		portHeader: port_header,
		isTls: is_tls,
		hasUpgradeHook: false
	})) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('Origin not allowed');
		return;
	}

	const direct = req.socket?.remoteAddress || '';
	const clientIp = resolveClientIp(direct, headers, direct);
	if (authPathRateLimiter.exceeded(clientIp, now())) {
		res.writeHead(429, { 'content-type': 'text/plain' });
		res.end('Too Many Requests');
		return;
	}

	// Read the body, capped at 64 KB - the hook rarely needs one.
	const AUTH_BODY_LIMIT = 64 * 1024;
	/** @type {Buffer[]} */
	const chunks = [];
	let total = 0;
	let oversized = false;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > AUTH_BODY_LIMIT) { oversized = true; break; }
		chunks.push(chunk);
	}
	if (oversized) {
		res.writeHead(413, { 'content-type': 'text/plain' });
		res.end('Content Too Large');
		return;
	}
	const bodyBuf = Buffer.concat(chunks);

	const requestOrigin = (is_tls ? 'https://' : 'http://') + (headers['host'] || 'localhost');
	const url = req.url || WS_AUTH_PATH;
	const request = new Request(requestOrigin + url, {
		method: 'POST',
		headers,
		body: bodyBuf.length > 0 ? bodyBuf : undefined,
		// @ts-expect-error node accepts half-duplex request bodies
		duplex: 'half'
	});

	const cookies = createCookies(headers['cookie'], request.url);
	const authRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();
	const authPlatform = Object.create(platform);
	authPlatform.requestId = authRequestId;
	const event = {
		request,
		headers,
		cookies,
		url,
		remoteAddress: clientIp,
		getClientAddress: () => clientIp,
		platform: authPlatform
	};

	try {
		const result = await Promise.resolve(wsModule.authenticate(event));

		if (result === false) {
			res.writeHead(401, { 'content-type': 'text/plain' });
			res.end('Unauthorized');
			return;
		}

		if (result instanceof Response) {
			/** @type {Record<string, string | string[]>} */
			const outHeaders = {};
			for (const [hk, hv] of result.headers) {
				if (hk === 'set-cookie' || hk === 'content-length') continue;
				outHeaders[hk] = hv;
			}
			const outCookies = [
				...result.headers.getSetCookie(),
				...cookies._serialize()
			];
			if (outCookies.length > 0) outHeaders['set-cookie'] = outCookies;
			res.writeHead(result.status, outHeaders);
			if (result.body) {
				res.end(Buffer.from(await result.arrayBuffer()));
			} else {
				res.end();
			}
			return;
		}

		const outCookies = cookies._serialize();
		if (outCookies.length > 0) res.writeHead(204, { 'set-cookie': outCookies });
		else res.writeHead(204);
		res.end();
	} catch (err) {
		emitOperationalEvent({
			source: 'svelte-adapter-ws',
			component: 'runtime.authenticate',
			event: 'runtime.authenticate.failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'The WebSocket authentication endpoint failed.',
			attributes: { requestId: authRequestId, error: diagnosticError(err) }
		});
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain', 'x-request-id': authRequestId });
			res.end('Internal Server Error');
		}
	}
}

/**
 * Fire the app's init hook once, awaited, before readiness commits.
 * @param {any} workerData
 */
let initFired = false;
export async function fireInitOnce(workerData = null) {
	if (initFired) return;
	if (typeof wsModule.init === 'function') {
		await wsModule.init({ platform, workerData });
	}
	initFired = true;
}

/** Fire the app's shutdown hook; throws are logged, never propagated. */
export async function fireShutdownOnce() {
	if (typeof wsModule.shutdown === 'function') {
		try {
			await wsModule.shutdown({ platform });
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_THREW), err);
		}
	}
}

/** @returns {string} the configured WebSocket path (for the 426 route) */
export function wsPath() {
	return WS_PATH;
}

/**
 * Managed WebSocket drain: `http.close()` never completes while a socket is
 * open and live sockets keep working after it, so shutdown closes them
 * itself. With a dispersal window the reconnect advisory scatters the herd
 * and closes each socket with 1001; without one every socket is closed
 * directly. Sockets that ignore the close frame past the deadline are
 * terminated.
 *
 * @param {{ dispersalMs: number, deadlineMs: number, pollMs?: number }} opts
 * @returns {Promise<void>}
 */
export async function drainSockets({ dispersalMs, deadlineMs, pollMs = 50 }) {
	if (wsConnections.size === 0) return;
	if (dispersalMs > 0) {
		platform.adviseReconnect({ windowMs: dispersalMs, close: true });
	} else {
		for (const facade of [...wsConnections]) {
			try { /** @type {any} */ (facade).end(1001, 'Server draining'); } catch { /* already gone */ }
		}
	}
	// Wait for the close handshakes to land, bounded by the deadline; then
	// terminate whatever is still holding a socket open.
	const start = monotonicNow();
	while (wsConnections.size > 0 && monotonicNow() - start < deadlineMs) {
		await new Promise((resolve) => {
			const timer = setTimer(resolve, pollMs);
			if (typeof timer?.unref === 'function') timer.unref();
		});
	}
	for (const facade of [...wsConnections]) {
		try { /** @type {any} */ (facade).close(); } catch { /* already gone */ }
	}
}
