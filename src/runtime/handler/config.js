// Environment-driven runtime configuration, read once at module load.
// process.env access crosses the V8-to-OS boundary per read, so nothing in
// here may be re-read inside a request handler.

import { env } from '../env.js';
import { parse_as_bytes, parse_origin } from '../utils/parse.js';
import { createTrustedProxyMatcher, createClientIpResolver } from '../utils/trusted-proxies.js';

export const ssl_cert = env('SSL_CERT', '');

export const ssl_key = env('SSL_KEY', '');

export const is_tls = !!(ssl_cert && ssl_key);

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

// PROXY protocol v2 requires parsing the preamble off the raw socket, which
// this adapter does not do yet. A deployment that sets the flag must not
// silently run with spoofable client addresses, so the misconfiguration is
// fatal at boot rather than quietly ignored.
if (env('PROXY_PROTOCOL', '') === '1') {
	throw new Error(
		'[svelte-adapter-ws] PROXY_PROTOCOL=1 is not supported by this adapter. ' +
		'Terminate the PROXY protocol at the fronting load balancer and forward the ' +
		'client address via ADDRESS_HEADER (gated by TRUSTED_PROXIES) instead.'
	);
}

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
