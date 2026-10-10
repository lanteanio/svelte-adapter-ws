// In-process TLS through node:https: the cert/key pair for the default
// context and a certificate hot-reload
// that registers a renewed certificate under the SNI names it carries without
// re-binding the listen socket, so a certbot renewal never drops a live
// connection. The server's own context is static: it serves the boot
// certificate for the process lifetime, so a client that sends no servername,
// or one the renewal does not name, keeps the boot certificate until a
// restart. The renewed certificate reaches SNI-matched handshakes only.

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
import { applyServerNames } from '../utils/tls-reload.js';
import {
	markTlsFailed, markTlsSwapped, markTlsWatchStopped, markTlsWatching,
	recordBootCertExpiry, stopTlsReload, tlsReloadState, tlsWatchDegraded
} from './tls-state.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

// Why the reload path is degraded once a directory watch is gone. Two reasons,
// because the two deaths differ in what the operator can still expect: a watch
// that never armed gets one arm-time catch-up read, a watch that died after
// arming gets nothing further at all.
const TLS_WATCH_DEAD = 'the certificate directory watch failed to start, so no renewal will be seen';
const TLS_WATCH_LOST = 'the certificate directory watch stopped, so no further renewal will be seen';

/**
 * Build the https server and arm the hot-reload watch.
 *
 * @param {import('node:http').RequestListener} handleRequest
 * @param {(req: import('node:http').IncomingMessage) => boolean} shouldUpgradeCallback
 * @returns {import('node:https').Server}
 */
export function createTlsServer(handleRequest, shouldUpgradeCallback) {

	// SNI contexts live in a Map consulted by ONE SNICallback: node's own
	// addContext appends to a list whose FIRST regex match wins, so a
	// hot-reloaded per-name cert appended behind the boot-time one would
	// never be selected (and the list would grow per reload).
	/** @type {Map<string, import('node:tls').SecureContext>} */
	const sniContexts = new Map();

	/** @type {import('node:tls').TlsOptions} */
	const baseOptions = { cert: fs.readFileSync(ssl_cert), key: fs.readFileSync(ssl_key) };

	const server = https.createServer({
		...baseOptions,
		shouldUpgradeCallback,
		// The listener refuses a request without a Host itself, in its turn.
		requireHostHeader: false,
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

	if (ssl_watch) {
		// The expiry of what is being served right now, so a reload failure can
		// be reported with the number that says how urgent it is. Only notAfter
		// is taken from it, so no host list is passed.
		recordBootCertExpiry(ssl_cert);
		const reload = buildReloader(sniContexts);
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
		if (isMainThread) armWatch = () => armHotReload(server, reload);
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
 * message here and this worker registers the renewal under its SNI names -
 * the identical fingerprint-gated reload the single-process watch drives. No-op when the
 * server is not TLS or SSL_WATCH=0 (every thread reads the same env, so an
 * opted-out worker ignores the broadcast the way an opted-out single-process
 * server never watches).
 */
export function reloadTls() {
	if (reloadNow !== null) reloadNow();
}

/**
 * Build a fingerprint-gated renewal action. Validate and construct the new
 * context before replacing the SNI map; a torn write keeps the served context.
 * The server's default context always retains the boot certificate.
 *
 * @param {Map<string, import('node:tls').SecureContext>} sniContexts
 * @returns {() => void}
 */
function buildReloader(sniContexts) {
	/** @type {{ hosts: string[], fingerprint: string | null }} */
	let defaultState = { hosts: [], fingerprint: null };
	try {
		defaultState.fingerprint = new X509Certificate(fs.readFileSync(ssl_cert)).fingerprint256;
	} catch {
		defaultState.fingerprint = null;
	}

	const reload = () => {
		try {
			/** @type {import('node:tls').SecureContext | null} */
			let context = null;
			const registry = {
				/** @param {string} _host @param {any} options */
				addServerName(_host, options) {
					// Each host of the renewal uses the same certificate bytes.
					if (context === null) {
						context = tls.createSecureContext({
							cert: fs.readFileSync(options.cert_file_name),
							key: fs.readFileSync(options.key_file_name)
						});
					}
				},
				removeServerName() {}
			};
			const applied = applyServerNames(
				registry,
				{ certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts },
				defaultState
			);
			if (!applied.changed) return;
			sniContexts.clear();
			if (context !== null) {
				for (const host of applied.hosts) sniContexts.set(host.toLowerCase(), context);
			}
			defaultState = { hosts: applied.hosts, fingerprint: applied.fingerprint };
			markTlsSwapped(ssl_cert);
			const health = tlsReloadState();
			console.log(
				`[tls] renewed certificate now served (SNI: ${applied.hosts.join(', ')}; expires ${health.notAfterText ?? 'unknown'}; generation ${health.generation})`
			);
		} catch (err) {
			if (err && /** @type {any} */ (err).tlsAppTouched) {
				// The apply step threw after validation had passed: a pair
				// rewritten between its validation read and the registry's
				// read. The staging is discarded, so the served set is exactly
				// what it was; the default pair's fingerprint is cleared so the
				// next watcher event or broadcast bypasses the gate and re-runs
				// the full reconcile instead of no-opping until the next
				// genuine renewal months away.
				defaultState = { hosts: defaultState.hosts, fingerprint: null };
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
			// A renewal mid-write can present a torn pair. The next watcher
			// event or reload broadcast retries; the served context is intact.
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
 * Watch the certificate directory and drive `reload` on a debounced
 * change. Main-thread only: in a cluster the primary owns the one watch and
 * fans the change out by message.
 *
 * @param {import('node:https').Server} server
 * @param {() => void} reload
 */
function armHotReload(server, reload) {
	// Watch the certificate's directory: certbot and cert-manager renew by
	// replacing directory entries or symlinks rather than the watched inode.
	// The key may live elsewhere; its directory does not trigger reloads.
	const watchedDirs = [path.dirname(ssl_cert)];

	/** @type {any} */
	let debounce = null;
	const fire = () => {
		debounce = null;
		reload();
	};

	/** @type {import('node:fs').FSWatcher[]} */
	const watchers = [];
	// A failed watch stays degraded: no later successful reload can
	// resurrect it, so future certificate renewals would still be missed.
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
