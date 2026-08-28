// The runtime aggregator the process entry imports. Module evaluation order
// here is the boot sequence: the SvelteKit Server initializes first (_init.js
// populates the $env proxies before anything app-authored evaluates), then
// configuration is validated, the static index is built, and the node server
// is constructed around the request handler.

// Substituted by the adapter's build step; free identifiers until then.
/* global ENV_PREFIX */
/* global STATIC_HEADERS */
/* global STATIC_CACHE_CONTROL */
/* global WARMUP_PATHS */
/* global WS_ENABLED */
import './_init.js';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { env } from './env.js';
import { monotonicNow } from './runtime.js';
import { base } from 'MANIFEST';
import {
	ssl_cert, ssl_key, is_tls, origin, xff_depth, body_size_limit,
	protocol_header, host_header, port_header, address_header
} from './handler/config.js';
import { declareSingleValuedProxyHeaders } from './utils/request-headers.js';
import { cacheDir, clientDir, prerenderedDir, _t_static } from './handler/static-assets.js';
import { staticCache } from './handler/state.js';
import { handleRequest, installRealtimeRoutes } from './handler/request.js';
import { start as lifecycleStart, shutdown as lifecycleShutdown, beginDrain, lifecycleState, isDraining } from './handler/lifecycle.js';
import { platform } from './handler/platform.js';
import { reconnect_dispersal_ms } from './handler/config.js';

export { beginDrain, lifecycleState, isDraining, platform };

/**
 * Graceful shutdown, realtime included: readiness flips, live WebSockets are
 * advised and closed within the budget, then the HTTP drain runs.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function shutdown(opts = {}) {
	beginDrain();
	if (realtime) {
		const budget = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
		await realtime.drainSockets({
			dispersalMs: reconnect_dispersal_ms,
			deadlineMs: budget
		});
	}
	return lifecycleShutdown(opts);
}

// - Configuration validation -------------------------------------------------

if ((ssl_cert || ssl_key) && !is_tls) {
	throw new Error(
		'Incomplete TLS config: both SSL_CERT and SSL_KEY must be set.\n' +
		`  SSL_CERT: ${ssl_cert ? 'set' : 'missing'}\n` +
		`  SSL_KEY: ${ssl_key ? 'set' : 'missing'}`
	);
}

if (isNaN(xff_depth) || xff_depth < 1) {
	throw new Error(
		`Invalid XFF_DEPTH: '${env('XFF_DEPTH', '1')}'. Must be a positive integer.`
	);
}

if (isNaN(body_size_limit)) {
	throw new Error(
		`Invalid BODY_SIZE_LIMIT: '${env('BODY_SIZE_LIMIT')}'. Please provide a numeric value.`
	);
}

if (!origin && !host_header && !protocol_header && !is_tls) {
	console.warn(
		'[svelte-adapter-ws] Warning: No ORIGIN, HOST_HEADER, or PROTOCOL_HEADER configured. ' +
		'The server will use http:// with the request Host header. ' +
		'For production, either:\n' +
		'  SSL_CERT + SSL_KEY for native TLS (no proxy needed)\n' +
		'  ORIGIN=https://example.com (behind a TLS proxy)\n' +
		'  PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)\n' +
		'  See: https://svti.me/adapter-origin'
	);
}

// Tell the shared header collector which names THIS deployment reads as a
// single value, before anything listens. Repeated lines of a header the
// collector does not know about are comma-joined, which is right for a chain
// and wrong for these: `get_origin` throws on a joined protocol or builds an
// unparseable URL from a joined host, and the client-IP resolver takes a
// joined address header's LEADING bytes, which are the client's rather than
// the proxy's. The names are operator-chosen, so only this layer knows them.
declareSingleValuedProxyHeaders([protocol_header, host_header, port_header, address_header]);

// - In-memory static file cache ----------------------------------------------

cacheDir(path.join(clientDir, base), base, true, STATIC_HEADERS, STATIC_CACHE_CONTROL);
cacheDir(path.join(prerenderedDir, base), base, false, STATIC_HEADERS, STATIC_CACHE_CONTROL);
console.log(`[svelte-adapter-ws] Static files indexed in ${(monotonicNow() - _t_static).toFixed(1)}ms (${staticCache.size} entries)`);

// - Server construction ------------------------------------------------------

export const server = is_tls
	? https.createServer({ cert: readFileSync(ssl_cert), key: readFileSync(ssl_key) }, handleRequest)
	: http.createServer(handleRequest);

// - Realtime lane ------------------------------------------------------------

/** @type {typeof import('./handler/realtime.js') | null} */
let realtime = null;
if (WS_ENABLED) {
	// Dynamic so a JSON-only (websocket-less) build never evaluates the ws
	// import graph. The await rides module top-level await like _init.js.
	realtime = await import('./handler/realtime.js');
	server.on('upgrade', (req, socket, head) => {
		void realtime?.handleUpgrade(req, socket, head).catch(() => {
			try { socket.destroy(); } catch { /* already gone */ }
		});
	});
	installRealtimeRoutes({
		wsPath: realtime.wsPath(),
		tryAuthenticateRoute: realtime.tryAuthenticateRoute
	});
}

export { realtime };

/**
 * Bind and boot: listen, run the app's init hook, warm the SSR path, commit
 * readiness.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
export async function start(host, port) {
	return lifecycleStart(server, host, port, {
		warmupPaths: WARMUP_PATHS,
		beforeReady: realtime ? () => /** @type {NonNullable<typeof realtime>} */ (realtime).fireInitOnce() : undefined
	});
}

/** Run the app's shutdown hook; the entry awaits this inside its budget. */
export async function runAppShutdownHook() {
	if (realtime) await realtime.fireShutdownOnce();
}
