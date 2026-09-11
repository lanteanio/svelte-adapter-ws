// Environment-driven runtime configuration, read once at module load.
// process.env access crosses the V8-to-OS boundary per read, so nothing in
// here may be re-read inside a request handler.

// Substituted by the adapter's build step; a free identifier until then.
/* global WS_OPTIONS */

import { env } from '../env.js';
import { parse_as_bytes, parse_origin } from '../utils/parse.js';
import { createTrustedProxyMatcher, createClientIpResolver } from '../utils/trusted-proxies.js';

// Whether the app wired a `close` hook - the only place per-connection close
// accounting surfaces. A live binding armed by realtime.js at init (this
// module stays free of the ws-handler bridge, so it loads outside a built
// payload); the bump helpers in pressure-metrics read it per call and
// early-return at near-zero cost when no hook is registered.
export let closeHookRegistered = false;
/** @param {unknown} registered */
export function armCloseHookAccounting(registered) {
	closeHookRegistered = !!registered;
}

export const ssl_cert = env('SSL_CERT', '');

export const ssl_key = env('SSL_KEY', '');

export const is_tls = !!(ssl_cert && ssl_key);

/**
 * TLS certificate hot-reload. When TLS is configured the server watches the
 * cert directory and, on a renewed cert (certbot / cert-manager), registers
 * the fresh cert under its SNI names in place so it is served WITHOUT
 * re-binding the listen socket or dropping live connections. Default ON when
 * TLS is set (zero-config renewal "just works"); SSL_WATCH=0 opts out. A
 * non-SNI / unmatched-SNI client keeps the boot-time cert until a restart
 * (the default context is not hot-swapped).
 */
export const ssl_watch = is_tls && env('SSL_WATCH', '1') !== '0';

/** Debounce window (ms) coalescing a burst of cert-file writes into one reload. */
const _ssl_debounce_raw = parseInt(env('SSL_RELOAD_DEBOUNCE_MS', '500'), 10);
export const ssl_reload_debounce_ms = Number.isFinite(_ssl_debounce_raw) && _ssl_debounce_raw >= 0
	? _ssl_debounce_raw
	: 500;

/** Optional comma-separated SNI host override; empty = auto-discover from each cert SAN. */
export const ssl_sni_hosts = env('SSL_SNI_HOSTS', '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export const origin = parse_origin(env('ORIGIN', undefined));

export const xff_depth = parseInt(env('XFF_DEPTH', '1'), 10);

export const address_header = env('ADDRESS_HEADER', '').toLowerCase();

export const protocol_header = env('PROTOCOL_HEADER', '').toLowerCase();

export const host_header = env('HOST_HEADER', '').toLowerCase();

export const port_header = env('PORT_HEADER', '').toLowerCase();

export const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));

/**
 * Trusted-proxy allowlist (comma-separated IPs / CIDR ranges, IPv4 + IPv6).
 * When set, ADDRESS_HEADER is honored ONLY when the direct socket peer is in
 * this set; a claim from any other peer is ignored (the socket address is
 * used) with a one-shot warning. Unset keeps the trust-verbatim behavior.
 */
export const trusted_proxies = createTrustedProxyMatcher(env('TRUSTED_PROXIES', ''));

/**
 * Whether the PROXY protocol v2 preamble is parsed off the raw socket. Always
 * false here: the refusal below makes `1` fatal at module eval, so a module
 * that finished evaluating never carries any other value. It is exported all
 * the same, because the resolved value is part of the config surface every
 * other eval-time knob exposes, and a reader that cannot see this one cannot
 * tell an adapter that declines the flag from one that ignores it.
 */
export const proxy_protocol = env('PROXY_PROTOCOL', '') === '1';

// Parsing the preamble means reading it off the socket before the HTTP parser
// sees the stream, which this adapter does not do. A deployment that sets the
// flag must not silently run with spoofable client addresses, so the
// misconfiguration is fatal at boot rather than quietly ignored.
if (proxy_protocol) {
	throw new Error(
		'[svelte-adapter-ws] PROXY_PROTOCOL=1 is not supported by this adapter. ' +
		'Terminate the PROXY protocol at the fronting load balancer and forward the ' +
		'client address via ADDRESS_HEADER (gated by TRUSTED_PROXIES) instead.'
	);
}

/**
 * Graceful-shutdown reconnect dispersal window in ms. When > 0, the drain
 * advises every connected client to reconnect on a jittered schedule in
 * [0, RECONNECT_DISPERSAL_MS) before closing it, so a draining node's clients
 * scatter instead of all reconnecting in one backoff window and stampeding
 * the replacement. Default 5000 (zero-config gets the good behavior); 0
 * restores the plain close-only drain.
 */
const _reconnect_dispersal_raw = parseInt(env('RECONNECT_DISPERSAL_MS', '5000'), 10);
export const reconnect_dispersal_ms = Number.isFinite(_reconnect_dispersal_raw) && _reconnect_dispersal_raw >= 0
	? _reconnect_dispersal_raw
	: 5000;

// WS_DEBUG=1 enables per-event logging for the wire lanes. Read once at
// module load so it is never sampled inside a hot callback.
export const wsDebug = env('WS_DEBUG', '') === '1';

let warnedUntrustedClaim = false;
/**
 * One-shot warning for an address claim arriving from an untrusted peer.
 * @param {string} directIp
 * @param {string} kind
 */
export function warnUntrustedClaim(directIp, kind) {
	if (warnedUntrustedClaim) return;
	warnedUntrustedClaim = true;
	console.warn(
		`[svelte-adapter-ws] Ignored a ${kind} client-address claim from untrusted peer ${directIp}: ` +
		'the peer is not in TRUSTED_PROXIES, so the socket address was used instead. ' +
		'If this peer is a legitimate proxy, add its address (or CIDR range) to TRUSTED_PROXIES.'
	);
}

/**
 * Resolve the real client IP from a raw socket address, applying the
 * configured proxy header when present - gated on TRUSTED_PROXIES when that
 * is set. Returns the raw IP on any error so rate limiting and connection
 * tagging always get a usable string.
 * @type {(rawIp: string, headers: Record<string, string>, directIp?: string) => string}
 */
export const resolveClientIp = createClientIpResolver({
	addressHeader: address_header,
	xffDepth: xff_depth,
	matcher: trusted_proxies,
	onUntrusted: (directIp) => warnUntrustedClaim(directIp, `${address_header} header`)
});

/**
 * Construct the origin from request headers.
 *
 * WARNING: PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER are trusted as-is.
 * Only use these behind a trusted reverse proxy that overwrites the headers.
 * Never expose them when the adapter is directly internet-facing.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {string}
 */
export function get_origin(headers) {
	// Default protocol matches the server type: 'https' with native TLS.
	const default_protocol = is_tls ? 'https' : 'http';
	const protocol = protocol_header
		? decodeURIComponent(/** @type {string} */ (headers[protocol_header]) || default_protocol)
		: default_protocol;

	if (protocol !== 'http' && protocol !== 'https') {
		throw new Error(
			`The ${protocol_header} header specified '${protocol}' which is not a valid protocol. Only 'http' and 'https' are supported.`
		);
	}

	const host = (host_header && /** @type {string} */ (headers[host_header])) || /** @type {string} */ (headers['host']);
	if (!host) {
		throw new Error('Could not determine host. The request must have a host header.');
	}

	const port = port_header ? /** @type {string} */ (headers[port_header]) : undefined;
	if (port && isNaN(+port)) {
		throw new Error(
			`The ${port_header} header specified ${port} which is an invalid port.`
		);
	}

	// Strip existing port from host before appending PORT_HEADER value
	// (the Host header often includes the port, e.g. "example.com:3000")
	const hostWithoutPort = port ? host.replace(/:\d+$/, '') : host;

	return port ? `${protocol}://${hostWithoutPort}:${port}` : `${protocol}://${host}`;
}

// Whether a WebSocket permessage-deflate compressor is configured (any non-DISABLED
// `websocket.compression`). Used by the platform publish/send methods to resolve
// the per-message `compress` flag: when this is false (the default), every send
// stays uncompressed exactly as before. Per-message compression is only ever
// requested when a compressor actually exists, because passing `compress: true`
// on a connection with no compressor is not free.
export const WS_COMPRESSION_ON = Boolean(WS_OPTIONS && WS_OPTIONS.compression);

// The observer lanes (`checkSubscribe(..., { requireGrant: true })`) are fed
// client-named topics even though the check itself lives on the server-side
// Platform API. Keep their alphabet identical to the wire subscribe boundary.
// Exported from the shared config module so platform.js reads the same
// build-substituted WS_OPTIONS value as the wire handler.
export const ALLOW_NON_ASCII_TOPICS = Boolean(WS_OPTIONS && WS_OPTIONS.allowNonAsciiTopics);

// The reserved admin prefix, or `false` when the auto-mount is off. Derived
// here rather than at the route registration because the admin handler needs it
// too: it is what the handler checks the request's own pathname against, and
// two derivations of one prefix is one drift away from a check that passes for
// a route it does not describe.
export const ADMIN_PATH = (WS_OPTIONS && WS_OPTIONS.adminPath !== undefined) ? WS_OPTIONS.adminPath : '/__realtime';
