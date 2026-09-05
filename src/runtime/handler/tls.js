// In-process TLS through node:https: the cert/key pair (or PKCS#12 bundle)
// for the default context, additional pairs served per SNI name, OCSP
// stapling from an externally-maintained response file, and a certificate
// hot-reload that swaps the secure context in place - node applies
// setSecureContext to NEW connections without re-binding the listen socket,
// so a certbot renewal never drops a live connection.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { isMainThread } from 'node:worker_threads';
import { X509Certificate } from 'node:crypto';
import {
	ssl_cert, ssl_key, ssl_pfx, ssl_pfx_passphrase, ssl_watch,
	ssl_reload_debounce_ms, ssl_sni_hosts, ssl_ocsp_file
} from './config.js';
import { setTimer, clearTimer, monotonicNow } from '../runtime.js';
import { applyServerNames } from '../utils/tls-reload.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

// How long stapling keeps serving the last good OCSP response after the
// response file stops being readable. OCSP responses carry a validity window
// of about a week; stapling bytes older than that is worse than stapling
// nothing, because a must-staple client hard-fails on an expired staple where
// it would have fallen back to its own responder query on an absent one.
const OCSP_FALLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Comma-separated path lists, paired position-wise: the first pair is the
 * default context, every further pair serves the SNI names its cert carries
 * (or the SSL_SNI_HOSTS override, consumed in cert order).
 * @returns {{ cert: string, key: string }[]}
 */
function certPairs() {
	if (ssl_pfx && (ssl_cert || ssl_key)) {
		throw new Error(
			'[svelte-adapter-ws] SSL_PFX and SSL_CERT/SSL_KEY are mutually exclusive - ' +
			'configure the PKCS#12 bundle or the PEM pair, not both.'
		);
	}
	if (ssl_pfx) return [];
	const certs = ssl_cert.split(',').map((s) => s.trim()).filter(Boolean);
	const keys = ssl_key.split(',').map((s) => s.trim()).filter(Boolean);
	if (certs.length !== keys.length) {
		throw new Error(
			`[svelte-adapter-ws] SSL_CERT lists ${certs.length} certificate(s) but SSL_KEY lists ` +
			`${keys.length} key(s); the two lists pair position-wise and must be the same length.`
		);
	}
	return certs.map((cert, i) => ({ cert, key: keys[i] }));
}

/**
 * DNS names a certificate serves, from its subjectAltName (DNS entries only).
 * @param {Buffer} certPem
 * @returns {string[]}
 */
function certHosts(certPem) {
	try {
		const san = new X509Certificate(certPem).subjectAltName || '';
		return san.split(',')
			.map((part) => part.trim())
			.filter((part) => part.startsWith('DNS:'))
			.map((part) => part.slice(4).toLowerCase());
	} catch {
		return [];
	}
}

/** @param {string} file @returns {Buffer | null} */
function readOptional(file) {
	try {
		return fs.readFileSync(file);
	} catch {
		return null;
	}
}

/**
 * Build the https server and arm the hot-reload watch.
 *
 * @param {import('node:http').RequestListener} handleRequest
 * @returns {import('node:https').Server}
 */
export function createTlsServer(handleRequest) {
	const pairs = certPairs();
	if (!ssl_pfx && pairs.length === 0) {
		throw new Error(
			'[svelte-adapter-ws] SSL_CERT/SSL_KEY are set but name no usable file paths.'
		);
	}

	// SNI contexts live in a Map consulted by ONE SNICallback: node's own
	// addContext appends to a list whose FIRST regex match wins, so a
	// hot-reloaded per-name cert appended behind the boot-time one would
	// never be selected (and the list would grow per reload).
	/** @type {Map<string, import('node:tls').SecureContext>} */
	const sniContexts = new Map();

	/** @type {import('node:tls').TlsOptions} */
	const baseOptions = ssl_pfx
		? { pfx: fs.readFileSync(ssl_pfx), passphrase: ssl_pfx_passphrase || undefined }
		: { cert: fs.readFileSync(pairs[0].cert), key: fs.readFileSync(pairs[0].key) };

	const server = https.createServer({
		...baseOptions,
		SNICallback: (servername, callback) => {
			const name = servername.toLowerCase();
			let context = sniContexts.get(name);
			if (context === undefined) {
				// Wildcard SAN: a cert for *.example.test sits under the literal
				// key '*.example.test', which no servername ever equals. One
				// left-most-label substitution covers the RFC 6125 wildcard
				// shape; deeper labels correctly stay unmatched.
				const dot = name.indexOf('.');
				if (dot !== -1) context = sniContexts.get('*' + name.slice(dot));
			}
			callback(null, context);
		}
	}, handleRequest);

	// Additional certificates: each pair beyond the first serves the SNI
	// names its cert carries, or the next names from the SSL_SNI_HOSTS
	// override list.
	// SSL_SNI_HOSTS partitions per extra certificate with semicolon groups
	// ('a.example,www.a.example;b.example'); group i overrides cert i+1's
	// SANs. A cert beyond the named groups falls back to its own SANs.
	const overrideGroups = ssl_sni_hosts.length > 0
		? ssl_sni_hosts.join(',').split(';').map((group) => group.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
		: [];
	/** @type {Array<{ pair: { cert: string, key: string }, hosts: string[] }>} */
	const sniPairs = [];
	for (let i = 1; i < pairs.length; i++) {
		const certPem = fs.readFileSync(pairs[i].cert);
		const override = overrideGroups[i - 1];
		const hosts = override && override.length > 0 ? override : certHosts(certPem);
		if (hosts.length === 0) {
			throw new Error(
				`[svelte-adapter-ws] certificate ${pairs[i].cert} carries no DNS subjectAltName and ` +
				'SSL_SNI_HOSTS names no group for it, so no SNI name would ever select it.'
			);
		}
		sniPairs.push({ pair: pairs[i], hosts });
		const context = tls.createSecureContext({ cert: certPem, key: fs.readFileSync(pairs[i].key) });
		for (const host of hosts) sniContexts.set(host, context);
	}

	// OCSP stapling: the externally-maintained DER response is read per
	// handshake that asks (handshakes are rare, the read is cheap), with the
	// last good bytes as fallback - so a refreshed response staples without a
	// restart even when the certificate watch is disabled. The fallback is
	// age-bounded: once the file has been unreadable longer than an OCSP
	// validity window, the handshake staples nothing rather than expired bytes.
	let lastGoodOcsp = ssl_ocsp_file ? readOptional(ssl_ocsp_file) : null;
	let lastGoodOcspAt = monotonicNow();
	let warnedStaleOcsp = false;
	if (ssl_ocsp_file) {
		server.on('OCSPRequest', (_cert, _issuer, callback) => {
			const fresh = readOptional(ssl_ocsp_file);
			if (fresh !== null) {
				lastGoodOcsp = fresh;
				lastGoodOcspAt = monotonicNow();
				warnedStaleOcsp = false;
			} else if (lastGoodOcsp !== null && monotonicNow() - lastGoodOcspAt > OCSP_FALLBACK_MAX_AGE_MS) {
				lastGoodOcsp = null;
				if (!warnedStaleOcsp) {
					warnedStaleOcsp = true;
					console.warn(
						`[svelte-adapter-ws] [tls] ${ssl_ocsp_file} has been unreadable for over ` +
						'7 days; OCSP stapling is off until the file is refreshed.'
					);
				}
			}
			callback(null, lastGoodOcsp);
		});
	}

	if (ssl_watch) {
		const reload = buildReloader(server, pairs, sniPairs, overrideGroups, sniContexts);
		reloadNow = reload;
		server.once('close', () => {
			if (reloadNow === reload) reloadNow = null;
		});
		// In a worker thread the cluster PRIMARY owns the cert-directory watch
		// and broadcasts a reload message the runtime routes into reloadTls();
		// arming a second watch per worker would fire N debounced reloads for
		// one renewal. The single-process server watches here.
		if (isMainThread) armHotReload(server, pairs, reload);
	}

	return server;
}

/**
 * The reload action for the CURRENT TLS server, or null when no TLS server
 * with hot-reload is up. A holder rather than a per-call lookup so the
 * message entry point below stays a two-line branch.
 * @type {(() => void) | null}
 */
let reloadNow = null;

/**
 * Message-driven certificate reload: the worker half of the cluster's
 * hot-reload broadcast. The primary watches the cert directory (it already
 * debounced the change burst) and posts `tls-reload`; the runtime routes that
 * message here and this worker swaps its own secure context - the identical
 * fingerprint-gated swap the single-process watch drives. No-op when the
 * server is not TLS or SSL_WATCH=0 (every thread reads the same env, so an
 * opted-out worker ignores the broadcast the way an opted-out single-process
 * server never watches).
 */
export function reloadTls() {
	if (reloadNow !== null) reloadNow();
}

/**
 * Build the context-swap action for a debounced change or a primary reload
 * broadcast. The change gate is the certificate fingerprint, baselined at
 * boot: an event that did not actually change the served cert (an atomic
 * rename storm, a touch, an unchanged-cert broadcast) swaps nothing.
 *
 * @param {import('node:https').Server} server
 * @param {{ cert: string, key: string }[]} pairs
 * @param {Array<{ pair: { cert: string, key: string }, hosts: string[] }>} sniPairs
 * @param {string[][]} overrideGroups - SSL_SNI_HOSTS groups, indexed like sniPairs
 * @param {Map<string, import('node:tls').SecureContext>} sniContexts
 * @returns {() => void}
 */
function buildReloader(server, pairs, sniPairs, overrideGroups, sniContexts) {
	/** @type {string | null} */
	let servedFingerprint = null;
	if (!ssl_pfx) {
		try {
			servedFingerprint = new X509Certificate(fs.readFileSync(pairs[0].cert)).fingerprint256;
		} catch {
			servedFingerprint = null;
		}
	}

	// What each extra pair currently serves, so a reload reconciles against it
	// rather than rebuilding blind. Baselined from the boot registration, whose
	// hosts are already in sniContexts; a cert that would not parse at boot
	// never got here, so a null fingerprint simply means the first reload is
	// treated as a genuine change.
	/** @type {Array<{ hosts: string[], fingerprint: string | null }>} */
	let sniState = sniPairs.map(({ pair, hosts }) => {
		try {
			return { hosts, fingerprint: new X509Certificate(fs.readFileSync(pair.cert)).fingerprint256 };
		} catch {
			return { hosts, fingerprint: null };
		}
	});

	return () => {
		try {
			if (ssl_pfx) {
				server.setSecureContext({ pfx: fs.readFileSync(ssl_pfx), passphrase: ssl_pfx_passphrase || undefined });
			} else {
				const certPem = fs.readFileSync(pairs[0].cert);
				const fingerprint = (() => {
					try { return new X509Certificate(certPem).fingerprint256; } catch { return null; }
				})();
				if (fingerprint !== null && fingerprint === servedFingerprint) {
					// The default cert did not change; SNI pairs and the OCSP
					// response may still have.
				} else {
					server.setSecureContext({ cert: certPem, key: fs.readFileSync(pairs[0].key) });
					servedFingerprint = fingerprint;
				}
				// SNI names are re-derived from the RELOADED certs, not replayed
				// from the boot-time lists: a renewal that adds, drops or changes
				// SANs must serve under the new name set, and a name the renewal
				// dropped must stop matching. The reconciliation order is
				// applyServerNames'; what a registration MEANS is this
				// transport's, so the registry below writes into a staging copy
				// and the live map is replaced only once every pair has applied.
				// A throw part-way therefore discards the staging map instead of
				// leaving the callback on a half-applied certificate set.
				/** @type {Map<string, import('node:tls').SecureContext>} */
				const nextContexts = new Map(sniContexts);
				/** @type {object | null} */
				let memoOptions = null;
				/** @type {import('node:tls').SecureContext | null} */
				let memoContext = null;
				const registry = {
					/** @param {string} host @param {any} options */
					addServerName(host, options) {
						// applyServerNames builds ONE options literal per call and
						// hands the same reference to every host of that
						// certificate, so keying the context on its identity gives
						// one read and one OpenSSL context per pair - and
						// guarantees every host of a renewal shares the same bytes
						// even if the file is rewritten mid-loop.
						if (options !== memoOptions) {
							memoContext = tls.createSecureContext({
								cert: fs.readFileSync(options.cert_file_name),
								key: fs.readFileSync(options.key_file_name)
							});
							memoOptions = options;
						}
						nextContexts.set(host.toLowerCase(), /** @type {any} */ (memoContext));
					},
					/** @param {string} host */
					removeServerName(host) {
						nextContexts.delete(host.toLowerCase());
					}
				};
				// Hosts stay this file's discovery (certHosts, SAN-only) rather
				// than applyServerNames' SAN-or-CN fallback: passing them keeps a
				// CN-only extra certificate refused the way boot refuses it.
				const nextState = [];
				for (let i = 0; i < sniPairs.length; i++) {
					const { pair } = sniPairs[i];
					const override = overrideGroups[i];
					const hosts = override && override.length > 0 ? override : certHosts(fs.readFileSync(pair.cert));
					if (hosts.length === 0) {
						throw new Error(
							`certificate ${pair.cert} carries no DNS subjectAltName after reload and ` +
							'SSL_SNI_HOSTS names no group for it'
						);
					}
					nextState.push(applyServerNames(
						registry,
						{ certPath: pair.cert, keyPath: pair.key, hosts },
						sniState[i]
					));
				}
				sniContexts.clear();
				for (const [host, context] of nextContexts) sniContexts.set(host, context);
				sniState = nextState;
			}
			console.log('[svelte-adapter-ws] [tls] certificate context reloaded');
		} catch (err) {
			// A renewal mid-write can present a torn pair; the next watcher
			// event (or reload broadcast) retries. The served context stays on
			// the previous cert.
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_RELOAD_SKIPPED), err);
		}
	};
}

/**
 * Watch every certificate-bearing directory and drive `reload` on a debounced
 * change. Main-thread only: in a cluster the primary owns the one watch and
 * fans the change out by message.
 *
 * @param {import('node:https').Server} server
 * @param {{ cert: string, key: string }[]} pairs
 * @param {() => void} reload
 */
function armHotReload(server, pairs, reload) {
	const watchedFiles = ssl_pfx
		? [ssl_pfx]
		: pairs.flatMap((p) => [p.cert, p.key]);
	// Watch the containing DIRECTORIES, deduped: certbot renews by writing
	// into archive/ and re-pointing the live/ symlink, and cert-manager swaps
	// an atomic ..data symlink - neither touches the watched file's inode, so
	// a per-file watch misses the canonical renewal shapes.
	const watchedDirs = [...new Set(watchedFiles.map((file) => path.dirname(file)))];

	/** @type {any} */
	let debounce = null;
	const fire = () => {
		debounce = null;
		reload();
	};

	/** @type {import('node:fs').FSWatcher[]} */
	const watchers = [];
	let warnedWatcherError = false;
	/** @param {unknown} err @param {string} what */
	const warnWatcher = (err, what) => {
		if (warnedWatcherError) return;
		warnedWatcherError = true;
		console.warn(adapterConsoleLine(
			ADAPTER_ERROR_IDS.TLS_WATCH,
			`${what} (` + (/** @type {any} */ (err)?.code || err) +
			'); hot reload is off until restart - the served certificate stays on its current bytes.'
		));
	};
	for (const dir of watchedDirs) {
		try {
			const watcher = fs.watch(dir, { persistent: false }, () => {
				if (debounce !== null) clearTimer(debounce);
				debounce = setTimer(fire, ssl_reload_debounce_ms);
				if (typeof debounce?.unref === 'function') debounce.unref();
			});
			// A watcher can error after arming (directory removed, EPERM on
			// teardown); an unhandled watcher error would take the process
			// down over a lost WATCH, not a lost cert.
			watcher.on('error', (err) => {
				warnWatcher(err, 'stopped');
				try { watcher.close(); } catch { /* already closed */ }
			});
			watchers.push(watcher);
		} catch (err) {
			warnWatcher(err, 'could not arm');
		}
	}
	server.once('close', () => {
		if (debounce !== null) clearTimer(debounce);
		for (const watcher of watchers) {
			try { watcher.close(); } catch { /* already closed */ }
		}
	});
}
