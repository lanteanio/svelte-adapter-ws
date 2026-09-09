// In-process TLS through node:https: the cert/key pair for the default
// context, additional pairs served per SNI name, and a certificate hot-reload
// that swaps the secure context in place - node applies setSecureContext to
// NEW connections without re-binding the listen socket, so a certbot renewal
// never drops a live connection.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { isMainThread } from 'node:worker_threads';
import { X509Certificate } from 'node:crypto';
import {
	ssl_cert, ssl_key, ssl_watch, ssl_reload_debounce_ms, ssl_sni_hosts
} from './config.js';
import { setTimer, clearTimer } from '../runtime.js';
import { applyServerNames, parseSniHosts } from '../utils/tls-reload.js';
import {
	markTlsFailed, markTlsSwapped, markTlsWatchStopped, markTlsWatching,
	recordBootCertExpiry, stopTlsReload, tlsWatchDegraded
} from './tls-state.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

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
 * Build the https server and arm the hot-reload watch.
 *
 * @param {import('node:http').RequestListener} handleRequest
 * @returns {import('node:https').Server}
 */
export function createTlsServer(handleRequest) {
	const pairs = certPairs();
	if (pairs.length === 0) {
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
	const baseOptions = { cert: fs.readFileSync(pairs[0].cert), key: fs.readFileSync(pairs[0].key) };

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
		// The one host discovery the family has: SAN DNS names, then the subject
		// CN for a legacy single-name certificate (parseSniHosts). A certificate
		// that does not parse throws here rather than reading as one with no
		// names, which at boot is the refusal it deserves.
		const hosts = override && override.length > 0 ? override : parseSniHosts(certPem.toString('utf8'));
		if (hosts.length === 0) {
			throw new Error(
				`[svelte-adapter-ws] certificate ${pairs[i].cert} carries no DNS subjectAltName, no subject CN, and ` +
				'SSL_SNI_HOSTS names no group for it, so no SNI name would ever select it.'
			);
		}
		const context = tls.createSecureContext({ cert: certPem, key: fs.readFileSync(pairs[i].key) });
		sniPairs.push({ pair: pairs[i], hosts, context });
		// A host two certificates both carry is served by the LATER one: the
		// map is written in pair order, and the reloader below keeps that rule.
		for (const host of hosts) sniContexts.set(host, context);
	}

	if (ssl_watch) {
		// The expiry of what is being served right now, so a reload failure can
		// be reported with the number that says how urgent it is. Only notAfter
		// is taken from it, so no host list is passed: SSL_SNI_HOSTS groups
		// belong to the EXTRA certificates here, never to pairs[0].
		recordBootCertExpiry(pairs[0].cert);
		const reload = buildReloader(server, pairs, sniPairs, overrideGroups, sniContexts);
		reloadNow = reload;
		server.once('close', () => {
			if (reloadNow === reload) reloadNow = null;
			// A retry armed by a failed swap must not fire into a closed server,
			// nor into the next one from this closure.
			if (tlsRetryTimer !== null) {
				clearTimer(tlsRetryTimer);
				tlsRetryTimer = null;
			}
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
 * The one-shot retry a failed swap armed, or null. Module-level so the
 * server's close handler can clear it.
 * @type {any}
 */
let tlsRetryTimer = null;

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
	// The change gate is the default certificate's fingerprint, baselined
	// here at module eval: a reload of an unchanged file is no swap, and the
	// arm-time catch-up read counts nothing.
	/** @type {string | null} */
	let servedFingerprint = null;
	try {
		servedFingerprint = new X509Certificate(fs.readFileSync(pairs[0].cert)).fingerprint256;
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

	const reload = () => {
		// Whether this pass genuinely put different bytes in front of a client.
		// Only what actually changed counts, which is what makes a fleet's
		// generation numbers comparable.
		let swapped = false;
		try {
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
			// Hosts come from the same discovery boot used (parseSniHosts: SAN
			// DNS names, then the subject CN), so a reload selects a renewed
			// certificate by exactly the names boot would have.
			const nextState = [];
			for (let i = 0; i < sniPairs.length; i++) {
				current = i;
				const { pair } = sniPairs[i];
				const override = overrideGroups[i];
				const hosts = override && override.length > 0 ? override : parseSniHosts(fs.readFileSync(pair.cert, 'utf8'));
				if (hosts.length === 0) {
					throw new Error(
						`certificate ${pair.cert} carries no DNS subjectAltName and no subject CN after reload and ` +
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
				try {
					server.setSecureContext(nextDefault);
				} catch (err) {
					// The server was touched: "kept the previous cert" would
					// be a lie from here, and the catch below must say so.
					/** @type {any} */ (err).tlsAppTouched = true;
					throw err;
				}
				servedFingerprint = fingerprint;
				swapped = true;
			}
			sniContexts.clear();
			for (let i = 0; i < nextState.length; i++) {
				for (const host of nextState[i].hosts) sniContexts.set(host.toLowerCase(), nextPairContexts[i]);
			}
			sniState = nextState;
			pairContexts = nextPairContexts;
			if (swapped) {
				markTlsSwapped(pairs[0].cert);
				console.log('[svelte-adapter-ws] [tls] certificate context reloaded');
			}
		} catch (err) {
			if (err && /** @type {any} */ (err).tlsAppTouched) {
				// The apply step threw after validation had passed: an extra pair
				// rewritten between its validation read and the registry's read,
				// or the default context refused by the server. The staging is
				// discarded, so the served set is exactly what it was; the
				// fingerprint is cleared so the next watcher event or broadcast
				// bypasses the gate and re-runs the full reconcile instead of
				// no-opping until the next genuine renewal months away.
				servedFingerprint = null;
				emitOperationalEvent({
					source: 'svelte-adapter-ws',
					component: 'runtime.tls',
					event: 'tls.swap-failed',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.',
					attributes: { error: diagnosticError(err) }
				});
				markTlsFailed(err, 'a certificate swap failed mid-apply');
				// One-shot retry from the failure itself: the throw may have
				// consumed the last fs event of the renewal burst, and the next
				// one could be months away. Re-armed only from its own failure,
				// so a persistent fault retries at this cadence instead of
				// spinning; guarded on reloadNow so a closed or replaced server
				// never receives it.
				if (tlsRetryTimer === null) {
					tlsRetryTimer = setTimer(() => {
						tlsRetryTimer = null;
						if (reloadNow === reload) reload();
					}, ssl_reload_debounce_ms > 0 ? ssl_reload_debounce_ms : 500);
					if (typeof tlsRetryTimer?.unref === 'function') tlsRetryTimer.unref();
				}
				return;
			}
			// A renewal mid-write can present a torn pair; the next watcher
			// event (or reload broadcast) retries. The served context stays on
			// the previous certificate set, default included - nothing was
			// swapped before every pair validated - so there is no partial swap
			// to report.
			emitOperationalEvent({
				source: 'svelte-adapter-ws',
				component: 'runtime.tls',
				event: 'tls.reload-skipped',
				severity: 'warn',
				dataClass: 'pseudonymous',
				message: 'A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.',
				attributes: { error: diagnosticError(err) }
			});
			// Degraded rather than benign: the renewal on disk is NOT being
			// served, and every probe stays green while the certificate that IS
			// being served runs down. Cleared by the next reload that succeeds.
			markTlsFailed(err, 'the certificate on disk did not validate, so the previous one is still being served');
		}
	};
	return reload;
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
	const watchedFiles = pairs.flatMap((p) => [p.cert, p.key]);
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
