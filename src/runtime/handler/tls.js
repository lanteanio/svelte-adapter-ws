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
import { X509Certificate, createHash } from 'node:crypto';
import {
	ssl_cert, ssl_key, ssl_pfx, ssl_pfx_passphrase, ssl_watch,
	ssl_reload_debounce_ms, ssl_sni_hosts, ssl_ocsp_file
} from './config.js';
import { setTimer, clearTimer, monotonicNow } from '../runtime.js';
import { applyServerNames } from '../utils/tls-reload.js';
import {
	markTlsFailed, markTlsSwapped, markTlsWatchStopped, markTlsWatching,
	recordBootCertExpiry, stopTlsReload, tlsWatchDegraded
} from './tls-state.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

// How long stapling keeps serving the last good OCSP response after the
// response file stops being readable. OCSP responses carry a validity window
// of about a week; stapling bytes older than that is worse than stapling
// nothing, because a must-staple client hard-fails on an expired staple where
// it would have fallen back to its own responder query on an absent one.
const OCSP_FALLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Why the reload path is degraded once a directory watch is gone. Two reasons,
// because the two deaths differ in what the operator can still expect: a watch
// that never armed gets one arm-time catch-up read, a watch that died after
// arming gets nothing further at all.
const TLS_WATCH_DEAD = 'the certificate directory watch failed to start, so no renewal will be seen';
const TLS_WATCH_LOST = 'the certificate directory watch stopped, so no further renewal will be seen';

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
	// A certificate that does not parse throws here rather than reading as one
	// with no names: at boot that is the refusal it deserves, and on a reload a
	// half-written file is then reported as the torn read it is instead of as a
	// certificate missing its subjectAltName.
	const san = new X509Certificate(certPem).subjectAltName || '';
	return san.split(',')
		.map((part) => part.trim())
		.filter((part) => part.startsWith('DNS:'))
		.map((part) => part.slice(4).toLowerCase());
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
	/** @type {Array<{ pair: { cert: string, key: string }, hosts: string[], context: import('node:tls').SecureContext }>} */
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
		const context = tls.createSecureContext({ cert: certPem, key: fs.readFileSync(pairs[i].key) });
		sniPairs.push({ pair: pairs[i], hosts, context });
		// A host two certificates both carry is served by the LATER one: the
		// map is written in pair order, and the reloader below keeps that rule.
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
		// The expiry of what is being served right now, so a reload failure can
		// be reported with the number that says how urgent it is. A PKCS#12
		// bundle carries no PEM identity to read, and simply keeps no record.
		// Only notAfter is taken from it, so no host list is passed: SSL_SNI_HOSTS
		// groups belong to the EXTRA certificates here, never to pairs[0].
		if (!ssl_pfx) recordBootCertExpiry(pairs[0].cert);
		const reload = buildReloader(server, pairs, sniPairs, overrideGroups, sniContexts);
		reloadNow = reload;
		server.once('close', () => {
			if (reloadNow === reload) reloadNow = null;
		});
		// In a worker thread the cluster PRIMARY owns the cert-directory watch
		// and broadcasts a reload message the runtime routes into reloadTls();
		// arming a second watch per worker would fire N debounced reloads for
		// one renewal. The single-process server watches here.
		//
		// Held as a thunk rather than armed now: this module is evaluated while
		// the process is still building, and a watch armed then would report
		// itself healthy before the listen socket exists. start() arms it after
		// the bind, so a directory that disappeared in between is seen as the
		// dead watch it is.
		if (isMainThread) armWatch = () => armHotReload(server, pairs, reload);
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
 * Arms the certificate-directory watch for the CURRENT TLS server, or null when
 * there is nothing to watch (no TLS server, SSL_WATCH=0, or a cluster worker
 * whose primary owns the watch).
 * @type {(() => void) | null}
 */
let armWatch = null;

/** Whether the watch is currently armed, so a restart re-arms and a repeated
 * start() does not stack a second set of watchers on one directory. */
let watchArmed = false;

/**
 * Arm the certificate-directory watch. Called from start() once the listen
 * socket is bound: arming at module-evaluation time would report a live watch
 * for a directory the process had not yet committed to serving from.
 */
export function armTlsWatch() {
	if (!watchArmed && armWatch !== null) {
		watchArmed = true;
		armWatch();
	}
	// The catch-up read, on EVERY thread that serves TLS: a renewal that landed
	// between the boot read and the listen bind would otherwise sit on disk
	// until the next event in its directory - or, on a cluster worker, until
	// the primary's next broadcast. Fingerprint-gated, so on the ordinary boot
	// it is one read and no swap. Run even when the watch failed to arm - that
	// is the one read the failure's entry promises - and never able to clear a
	// dead watch, which the ledger keeps.
	if (reloadNow !== null) reloadNow();
}

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
 * EVERYTHING IS VALIDATED BEFORE ANYTHING IS SWAPPED. The default pair and
 * every extra pair are read and built into secure contexts first; only once
 * all of them held does the server take the new default and the live SNI map
 * get replaced. A renewal caught mid-write - a rewritten certificate whose key
 * is still being written, an extra pair that no longer parses - therefore
 * leaves the served set exactly as it was, default included, and the failure
 * line can say so truthfully.
 *
 * The SNI map is DERIVED, not edited: after every pair has reconciled, it is
 * rebuilt from each pair's final host list in pair order, the same rule boot
 * applied. Reconciling pair by pair over one shared map is what deleted a host
 * an earlier pair still carried when a later pair dropped it.
 *
 * @param {import('node:https').Server} server
 * @param {{ cert: string, key: string }[]} pairs
 * @param {Array<{ pair: { cert: string, key: string }, hosts: string[], context: import('node:tls').SecureContext }>} sniPairs
 * @param {string[][]} overrideGroups - SSL_SNI_HOSTS groups, indexed like sniPairs
 * @param {Map<string, import('node:tls').SecureContext>} sniContexts
 * @returns {() => void}
 */
function buildReloader(server, pairs, sniPairs, overrideGroups, sniContexts) {
	// A PKCS#12 bundle has no PEM identity to fingerprint, so its gate is a
	// digest of the bundle's bytes: a reload of an unchanged file is then no
	// swap for it either, and the arm-time catch-up read counts nothing.
	/** @type {string | null} */
	let servedFingerprint = null;
	try {
		servedFingerprint = ssl_pfx
			? createHash('sha256').update(fs.readFileSync(ssl_pfx)).digest('hex')
			: new X509Certificate(fs.readFileSync(pairs[0].cert)).fingerprint256;
	} catch {
		servedFingerprint = null;
	}

	// What each extra pair currently serves, so a reload reconciles against it
	// rather than rebuilding blind. Baselined from the boot registration; a
	// cert that would not parse at boot never got here, so a null fingerprint
	// simply means the first reload is treated as a genuine change.
	/** @type {Array<{ hosts: string[], fingerprint: string | null }>} */
	let sniState = sniPairs.map(({ pair, hosts }) => {
		try {
			return { hosts, fingerprint: new X509Certificate(fs.readFileSync(pair.cert)).fingerprint256 };
		} catch {
			return { hosts, fingerprint: null };
		}
	});
	// The secure context each extra pair currently serves with. A pair the
	// reload finds unchanged keeps its context; a renewed one gets a fresh one.
	/** @type {import('node:tls').SecureContext[]} */
	let pairContexts = sniPairs.map(({ context }) => context);

	return () => {
		// Whether this pass genuinely put different bytes in front of a client.
		// Only what actually changed counts, which is what makes a fleet's
		// generation numbers comparable.
		let swapped = false;
		try {
			if (ssl_pfx) {
				const bundle = fs.readFileSync(ssl_pfx);
				const digest = createHash('sha256').update(bundle).digest('hex');
				if (digest !== servedFingerprint) {
					server.setSecureContext({ pfx: bundle, passphrase: ssl_pfx_passphrase || undefined });
					servedFingerprint = digest;
					swapped = true;
				}
			} else {
				// The default pair: read, fingerprint-gated, and BUILT before it
				// is taken, so a torn key throws here with nothing swapped yet.
				const certPem = fs.readFileSync(pairs[0].cert);
				const fingerprint = (() => {
					try { return new X509Certificate(certPem).fingerprint256; } catch { return null; }
				})();
				/** @type {{ cert: Buffer, key: Buffer } | null} */
				let nextDefault = null;
				if (!(fingerprint !== null && fingerprint === servedFingerprint)) {
					nextDefault = { cert: certPem, key: fs.readFileSync(pairs[0].key) };
					tls.createSecureContext(nextDefault);
				}
				// SNI names are re-derived from the RELOADED certs, not replayed
				// from the boot-time lists: a renewal that adds, drops or changes
				// SANs must serve under the new name set, and a name the renewal
				// dropped must stop matching. The reconciliation order is
				// applyServerNames'; what a registration MEANS is this
				// transport's: the registry below only collects the context a
				// renewed pair now serves with, and the live map is rebuilt from
				// every pair's final host list once all of them applied. A throw
				// part-way therefore discards the staging instead of leaving the
				// callback on a half-applied certificate set.
				const nextPairContexts = pairContexts.slice();
				/** @type {object | null} */
				let memoOptions = null;
				/** @type {import('node:tls').SecureContext | null} */
				let memoContext = null;
				let current = 0;
				const registry = {
					/** @param {string} _host @param {any} options */
					addServerName(_host, options) {
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
						nextPairContexts[current] = /** @type {any} */ (memoContext);
					},
					// Removal is a property of the rebuilt map, not an edit: a host
					// this pair dropped is absent from its final list, and whether
					// another pair still serves it is decided when the map is
					// derived below.
					removeServerName() {}
				};
				// Hosts stay this file's discovery (certHosts, SAN-only) rather
				// than applyServerNames' SAN-or-CN fallback: passing them keeps a
				// CN-only extra certificate refused the way boot refuses it.
				const nextState = [];
				for (let i = 0; i < sniPairs.length; i++) {
					current = i;
					const { pair } = sniPairs[i];
					const override = overrideGroups[i];
					const hosts = override && override.length > 0 ? override : certHosts(fs.readFileSync(pair.cert));
					if (hosts.length === 0) {
						throw new Error(
							`certificate ${pair.cert} carries no DNS subjectAltName after reload and ` +
							'SSL_SNI_HOSTS names no group for it'
						);
					}
					const applied = applyServerNames(
						registry,
						{ certPath: pair.cert, keyPath: pair.key, hosts },
						sniState[i]
					);
					if (applied.changed) swapped = true;
					nextState.push(applied);
				}
				// Everything validated. Commit: the default first, then the map,
				// in pair order so a host two certificates carry keeps going to
				// the later one exactly as it did at boot.
				if (nextDefault !== null) {
					server.setSecureContext(nextDefault);
					servedFingerprint = fingerprint;
					swapped = true;
				}
				sniContexts.clear();
				for (let i = 0; i < nextState.length; i++) {
					for (const host of nextState[i].hosts) sniContexts.set(host.toLowerCase(), nextPairContexts[i]);
				}
				sniState = nextState;
				pairContexts = nextPairContexts;
			}
			if (swapped) {
				markTlsSwapped(ssl_pfx ? null : pairs[0].cert);
				console.log('[svelte-adapter-ws] [tls] certificate context reloaded');
			}
		} catch (err) {
			// A renewal mid-write can present a torn pair; the next watcher
			// event (or reload broadcast) retries. The served context stays on
			// the previous certificate set, default included - nothing was
			// swapped before every pair validated - so there is no partial swap
			// to report and no retry to arm.
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_RELOAD_SKIPPED), err);
			// Degraded rather than benign: the renewal on disk is NOT being
			// served, and every probe stays green while the certificate that IS
			// being served runs down. Cleared by the next reload that succeeds.
			markTlsFailed(err, 'the certificate on disk did not validate, so the previous one is still being served');
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
	// One unarmed directory means renewals landing THERE are never seen, so any
	// failure degrades even when the other directories armed - and it degrades
	// STICKILY, because nothing retries a watch: no later reload, however
	// successful, can resurrect it.
	let watchFailed = false;
	for (const dir of watchedDirs) {
		try {
			const watcher = fs.watch(dir, { persistent: false }, () => {
				if (debounce !== null) clearTimer(debounce);
				debounce = setTimer(fire, ssl_reload_debounce_ms);
				if (typeof debounce?.unref === 'function') debounce.unref();
			});
			// A watch that dies AFTER starting arrives as an event, not a throw,
			// so the catch below never sees it - and an `error` event with no
			// listener is rethrown, which would take the process down over a
			// lost WATCH, not a lost cert. Its own id, because no catch-up read
			// follows this one and the operator's next move differs.
			watcher.on('error', (err) => {
				try { watcher.close(); } catch { /* already closed */ }
				// A pending debounce would fire a reload into a directory the
				// watch just lost; it is dropped rather than fired into that.
				if (debounce !== null) { clearTimer(debounce); debounce = null; }
				markTlsWatchStopped();
				emitOperationalEvent({
					source: 'svelte-adapter-ws',
					component: 'runtime.tls',
					event: 'tls.watch-lost',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'The certificate directory watch stopped after running; hot reload is disabled and no further renewal will be seen.',
					attributes: { error: diagnosticError(err) }
				});
				tlsWatchDegraded(TLS_WATCH_LOST);
			});
			watchers.push(watcher);
		} catch (err) {
			watchFailed = true;
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.tls',
				event: 'tls.watch-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.',
				attributes: { error: diagnosticError(err) }
			});
		}
	}
	if (watchFailed) tlsWatchDegraded(TLS_WATCH_DEAD);
	else if (watchers.length > 0) markTlsWatching();
	server.once('close', () => {
		if (debounce !== null) clearTimer(debounce);
		for (const watcher of watchers) {
			try { watcher.close(); } catch { /* already closed */ }
		}
		// The watchers are gone with the server; a restart arms a fresh set.
		// The expiry sentinel goes with them: it has nobody left to warn.
		watchArmed = false;
		stopTlsReload();
	});
}
