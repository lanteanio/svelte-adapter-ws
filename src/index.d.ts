import type { Adapter } from '@sveltejs/kit';

/** Path-scoped Cache-Control rule for static assets. */
export interface StaticCacheControlRule {
	/** Absolute asset path; a trailing slash selects the directory tree. */
	pattern: string;
	cacheControl: string;
}

export interface PressureThresholds {
	memoryHeapUsedRatio?: number | false;
	publishRatePerSec?: number | false;
	subscriberRatio?: number | false;
	sampleIntervalMs?: number;
	topicPublishRatePerSec?: number | false;
	topicPublishBytesPerSec?: number | false;
	psiCpuSome?: number | false;
	psiMemoryFull?: number | false;
	psiIoFull?: number | false;
	cpuThrottledRatio?: number | false;
}

export interface MessageAdmissionOptions {
	perConnectionRate?: number;
	globalRate?: number;
	perConnectionBytesRate?: number;
	globalBytesRate?: number;
	rateWindowMs?: number;
	perConnectionConcurrent?: number;
	globalConcurrent?: number;
	maxQueue?: number;
}

interface WaitingRoomOptions {
	/** Holding-page route the adapter serves (default '/__waiting-room'). */
	path?: string;
	/** Poll endpoint the page hits (default '/__admit-check'). */
	admitCheckPath?: string;
	/** Base seconds for the jittered Retry-After (default derived from pollIntervalMs). */
	retryAfterSeconds?: number;
	/** Page poll cadence in ms (default 2000). */
	pollIntervalMs?: number;
	/** Application name shown above the capacity message and in the title. */
	appName?: string;
	/** Service-status link: relative, or http, https, mailto, tel. */
	statusUrl?: string;
	/** Help link: relative, or http, https, mailto, tel. */
	supportUrl?: string;
	/** Incident reference shown as escaped text. */
	incidentId?: string;
	/**
	 * Module path whose default (or named `renderWaitingRoom`) export renders
	 * the page per request from a safe request facade, returning a full HTML
	 * document plus BCP 47 `lang` and `dir`. A build-serializable module path,
	 * not a live function; mutually exclusive with `template`.
	 */
	renderer?: string;
	/**
	 * Full HTML document replacing the built-in page, validated at
	 * construction against the accessible-document contract. `{{queueDepth}}`,
	 * `{{estimatedSeconds}}`, `{{pollIntervalMs}}`, `{{retryAfterSeconds}}`,
	 * `{{admitCheckPath}}`, `{{appName}}`, `{{statusUrl}}`, `{{supportUrl}}`
	 * and `{{incidentId}}` substitute the live escaped values.
	 */
	template?: string;
}

interface UpgradeAdmissionOptions {
	/** Ceiling on upgrades in flight at once; crossed requests get 503. 0 or omitted disables. */
	maxConcurrent?: number;
	/** Ceiling on reserved upgrades plus live connections, held until close. 0 or omitted disables. */
	maxConnections?: number;
	/** Ceiling on handshakes completed per event-loop tick; the overflow defers. 0 or omitted disables. */
	perTickBudget?: number;
	/** Ceiling on callbacks waiting behind perTickBudget (default 1024 while pacing is on). */
	maxDeferred?: number;
	/** Reserve a fraction of maxConcurrent for the deprioritised cursor-only upgrade lane. */
	cursorLane?: { fraction?: number };
	/**
	 * Content-negotiated refusal at capacity, on by default whenever a ceiling
	 * is set: a browser navigation gets a self-polling holding page, every
	 * other client keeps the 503 with a jittered Retry-After. `false` drops the
	 * polling page; an HTML navigation then gets a minimal accessible 503.
	 */
	waitingRoom?: false | WaitingRoomOptions;
}

export interface WebSocketOptions {
	/** Module path of the WebSocket handler (default: auto-discovered src/hooks.ws.{js,ts,mjs}). */
	handler?: string;
	/** WebSocket route (default '/ws'). */
	path?: string;
	/** Authenticate preflight route (default '/__ws/auth'). */
	authPath?: string;
	/** Max inbound frame bytes (default 1 MiB). */
	maxPayloadLength?: number;
	/** Idle reap timeout in seconds; 0 disables (default 120). */
	idleTimeout?: number;
	/** Outbound queue ceiling in bytes past which frames shed (default 1 MiB). */
	maxBackpressure?: number;
	/** Terminate a consumer pinned over the ceiling instead of shedding (default false). */
	closeOnBackpressureLimit?: boolean;
	/** Keep idle peers alive with pings (default true). */
	sendPingsAutomatically?: boolean;
	/** permessage-deflate (default false). */
	compression?: boolean;
	/** Origin policy: 'same-origin' (default), '*', or an explicit list. */
	allowedOrigins?: '*' | 'same-origin' | string[];
	/** Seconds the upgrade admission hook may run before 504 (default 10). */
	upgradeTimeout?: number;
	/** Upgrades admitted per IP per window; 0 disables (default 10). */
	upgradeRateLimit?: number;
	/** Upgrade limiter window in seconds (default 10). */
	upgradeRateLimitWindow?: number;
	/** Authenticate-door requests per IP per window; 0 disables (default 30). */
	authPathRateLimit?: number;
	authPathRateLimitWindow?: number;
	upgradeAdmission?: UpgradeAdmissionOptions;
	messageAdmission?: MessageAdmissionOptions;
	pressure?: PressureThresholds;
	/** Allow wire-level subscribes to '__'-prefixed system topics (default false). */
	allowSystemTopicSubscribe?: boolean;
	/** Honor client subscribes only for server-granted topics; 'strict' ignores app hooks. */
	authorizeWireSubscribe?: boolean | 'strict';
	/** Allow non-ASCII wire topic names (default false). */
	allowNonAsciiTopics?: boolean;
	/** Require CSRF signals on the authenticate door (default true). */
	authPathRequireOrigin?: boolean;
	/** Compress credentialed SSR responses despite BREACH exposure (default false). */
	compressCredentialedResponses?: boolean;
	/** Run 'same-origin' without a host pin (audited apps only; default false). */
	unsafeSameOriginWithoutHostPin?: boolean;
	/**
	 * Module path whose default (or named `primaryInit`) export runs ONCE in
	 * the cluster primary before any worker spawns; its return value is
	 * replayed as `workerData.app` to every worker and respawn
	 * (SharedArrayBuffers ride by reference). Only consulted when
	 * CLUSTER_WORKERS is set at runtime.
	 */
	primaryInit?: string;
	/** Cluster worker roles: how many of the CLUSTER_WORKERS total are compute workers (no listen socket). */
	workers?: { compute?: number };
}

export interface AdapterOptions {
	/** Output directory (default 'build'). */
	out?: string;
	/** Emit .br/.gz siblings for static assets (default true). */
	precompress?: boolean;
	/** Environment variable prefix (default ''). */
	envPrefix?: string;
	/** Liveness probe path or false (default '/healthz'). */
	healthCheckPath?: string | false;
	/** Readiness probe path or false (default '/readyz'). */
	readinessCheckPath?: string | false;
	/** Readiness-gated SSR warmup: true (default, warms '/'), false, or { paths }. */
	warmup?: boolean | { paths: string[] };
	/** Extra response headers for static/prerendered assets (reserved keys stripped). */
	staticHeaders?: Record<string, string>;
	/** Path-scoped Cache-Control rules for static assets. */
	staticCacheControl?: StaticCacheControlRule[];
	/** Serve dot-segment static paths (default false; .well-known stays served). */
	staticDotfiles?: boolean;
	/** Realtime lane: true, options object, or false/omitted for HTTP-only. */
	websocket?: boolean | WebSocketOptions;
}

export interface PressureSnapshot {
	/** Wall-clock ms of the last completed sample; null before the first tick. */
	sampledAt: number | null;
	active: boolean;
	/** 0..1 worker saturation (worst-of threshold distances plus lease backlog). */
	value: number;
	subscriberRatio: number;
	publishRate: number;
	memoryMB: number;
	reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
	psi: { cpuSome10: number; memoryFull10: number; ioFull10: number } | null;
	cpuThrottle: { throttledRatio: number; nrThrottledDelta: number } | null;
	maxBufferedBytes: number;
	backpressuredConnections: number;
	droppedFrames: number;
	droppedBytes: number;
	egress: { deliveries: number; bytes: number; refusedTopic: number; refusedTenant: number };
	topPublishers: Array<{ topic: string; messagesPerSec: number; bytesPerSec: number; deliveriesPerSec: number }>;
}

/**
 * The realtime platform surface exposed as `event.platform` and to every
 * WebSocket hook. The full per-method contracts follow the family
 * documentation in svelte-adapter-uws; the shapes here type the core surface.
 */
export interface Platform {
	publish(topic: string, event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number; excludeWs?: object }): boolean;
	publishBatched(messages: Array<{ topic: string; event: string; data?: unknown; options?: object }>, options?: { compress?: boolean }): void;
	batch(messages: Array<{ topic: string; event: string; data?: unknown; options?: object }>): boolean[];
	send(ws: object, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;
	sendTo(filter: (userData: any) => boolean, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;
	sendCoalesced(ws: object, message: { key?: string; topic: string; event: string; data?: unknown }): void;
	publishWire(topic: string, event: string, data: unknown, wire: object, options?: object): boolean;
	publishWireBatch(topic: string, event: string, entries: Array<{ data: unknown; excludeWs?: object; seq?: number }>, wire: object, options?: object): boolean;
	sendWire(ws: object, topic: string, event: string, data: unknown, wire: object, options?: object): number;
	sendWireBatch(ws: object, topic: string, event: string, entries: Array<{ data: unknown; seq?: number }>, wire: object): number;
	registerWireCodec(wire: object): void;
	request(ws: object, event: string, data?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
	requestTopic(topic: string, event: string, data?: unknown, options?: { timeoutMs?: number }): Promise<Array<{ ok: boolean; reply?: unknown; error?: string }>>;
	subscribe(ws: object, topic: string): Promise<string | null>;
	checkSubscribe(ws: object, topic: string, options?: { requireGrant?: boolean }): Promise<string | null>;
	unsubscribe(ws: object, topic: string): boolean;
	authorizeWireSubscribe(mode?: 'legacy' | 'strict'): 'legacy' | 'strict';
	grantPublish(ws: object, topic: string): boolean;
	revokePublish(ws: object): boolean;
	publishGrant(ws: object): string | null;
	publishGame(senderWs: object, topic: string, event: string, data: unknown, id?: number | string): { seq: number | null; delivered: number };
	adviseReconnect(options?: { windowMs?: number; afterMs?: number; close?: boolean; compress?: boolean; filter?: (userData: any) => boolean }): number;
	subscribers(topic: string): number;
	forEachSubscriber(topic: string, fn: (ws: object, userData: object) => void): void;
	bufferedAmount(ws: object): number;
	isWarmupRequest(request: Request): boolean;
	introspect(): object;
	diagnostic(diagnosticId: string): unknown;
	topic(name: string): object;
	topicEpoch(name: string): number;
	onPressure(cb: (snapshot: PressureSnapshot) => void): () => void;
	onPublishRate(cb: (top: PressureSnapshot['topPublishers']) => void): () => void;
	now(): number;
	monotonic(): number;
	random: { float(): number; u32(): number; uuid(): string; bytes(n: number): Uint8Array };
	hlc(): { wall: number; logical: number; nodeId: string };
	readonly connections: number;
	readonly pressure: PressureSnapshot;
	readonly protection: 'normal' | 'elevated' | 'siege';
	readonly metrics: unknown;
	readonly assertions: Map<string, number>;
	readonly closedWsAborts: number;
	readonly maxPayloadLength: number;
	readonly traceContext: unknown;
	requestId?: string;
}

/**
 * Server-resolved connection attribution, returned by the handler module's
 * `attribution(user)` export and read back through the `./connection`
 * subpath's {@link import('./connection.js').attribution} helper.
 */
export interface Attribution {
	/** The tenant (organization, workspace) this connection belongs to. */
	readonly tenantId?: string;
	/** The principal (user, service identity) inside that tenant. */
	readonly principalId?: string;
	/** An application-defined entitlement label (a billing or quota class). */
	readonly entitlement?: string;
}

/**
 * Build-time option validation helpers. Exported so build tooling and tests
 * can validate an options object the way `adapter()` will; not part of the
 * documented app-facing API.
 * @internal
 */
export const KNOWN_ADAPTER_OPTION_KEYS: Set<string>;
/** @internal */
export const KNOWN_WEBSOCKET_OPTION_KEYS: Set<string>;
/** @internal */
export function unknownAdapterOptionKeys(opts: Record<string, unknown> | null | undefined): string[];
/** @internal */
export function serializeWsOptions(websocket: Record<string, unknown>): Record<string, unknown>;
/** @internal */
export function renderRefusedDotfileWarning(refused: string[]): string;

export default function adapter(options?: AdapterOptions): Adapter;

/**
 * Live context passed to a custom `waitingRoom.template`. All numeric fields
 * are UX estimates surfaced for the holding page, never an admission input.
 */
export interface WaitingRoomContext {
	/** Polls seen in the last poll interval (a UX estimate, not an admission input). */
	queueDepth: number;
	/** Rolling drain-rate estimate in seconds (a UX estimate). */
	estimatedSeconds: number;
	/** Configured page poll cadence in ms. */
	pollIntervalMs: number;
	/** Configured base for the jittered Retry-After in seconds. */
	retryAfterSeconds: number;
	/** The poll endpoint path the page should fetch. */
	admitCheckPath: string;
	/** Configured application name, or an empty string when omitted. */
	appName: string;
	/** Configured service-status URL, or an empty string when omitted. */
	statusUrl: string;
	/** Configured support URL, or an empty string when omitted. */
	supportUrl: string;
	/** Configured incident reference, or an empty string when omitted. */
	incidentId: string;
}

/** Synchronous request facade passed to a waiting-room renderer module. */
export interface WaitingRoomRequestContext {
	/** Uppercase request method. */
	readonly method: string;
	/** Path plus query string for the holding-page request. */
	readonly url: string;
	/** Case-insensitive request-header lookup; absent headers return `null`. */
	readonly headers: {
		get(name: string): string | null;
	};
}

/** Per-request context passed to a locale-aware waiting-room renderer. */
export interface WaitingRoomRendererContext extends WaitingRoomContext {
	readonly request: WaitingRoomRequestContext;
}

/**
 * One accessible document baseline for every custom waiting path.
 *
 * At runtime `body` is parsed and validated for a doctype; valid
 * `html[lang]` and `html[dir]`; non-empty title and body; exposed main
 * landmark and non-empty status live region; and an exposed enabled named recovery
 * control or non-empty safe link. Comments and hidden, inert, template, script,
 * and style subtrees cannot satisfy the contract. Renderer `lang` and
 * `dir` are authoritative and are applied before that validation.
 */
export interface AccessibleWaitingDocument {
	/**
	 * A full HTML document containing an `<html>` element. This is trusted
	 * application HTML; escape every request/configuration value you interpolate.
	 */
	body: string;
	/** Valid BCP 47 language tag; emitted as `Content-Language` and `html[lang]`. */
	lang: string;
	/** Document direction; emitted as `html[dir]`. */
	dir: 'ltr' | 'rtl' | 'auto';
	/**
	 * Optional extra response headers. Adapter-owned framing, cache, language,
	 * and variation headers cannot be overridden.
	 */
	headers?: Record<string, string>;
}

/** Compatibility name for the document returned by a waiting-room renderer. */
export interface WaitingRoomRendererResult extends AccessibleWaitingDocument {}

/** Synchronous build-bundled renderer for a localized waiting-room document. */
export type WaitingRoomRenderer = (
	context: WaitingRoomRendererContext
) => AccessibleWaitingDocument;
