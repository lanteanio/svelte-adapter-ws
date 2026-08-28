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

export default function adapter(options?: AdapterOptions): Adapter;
