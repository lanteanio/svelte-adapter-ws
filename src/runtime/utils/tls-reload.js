// Cluster-primary TLS certificate hot-reload: the watch-and-broadcast half.
//
// In cluster mode the PRIMARY owns the cert-directory watch and broadcasts
// `{ type: 'tls-reload' }` so every worker swaps its OWN secure context in
// place (handler/tls.js `reloadTls` is the worker half; a single-process
// server arms its own watch there instead). The primary terminates no TLS -
// reuseport workers own their listen sockets outright - so its whole job is
// the broadcast plus an observability record of the disk cert's identity and
// expiry.
//
// Pure/injectable by construction: parseSniHosts, readCertIdentity and
// certExpiryAlert are pure over their inputs, and createCertWatcher takes its
// clock (setTimer/clearTimer) and fs (watchFs) as injected dependencies,
// defaulting to the runtime seam so the debounce stays deterministic under a
// seeded harness (check-determinism).

import { X509Certificate } from 'node:crypto';
import { readFileSync, watch as fsWatch } from 'node:fs';
import { dirname } from 'node:path';
import { setTimer as seamSetTimer, clearTimer as seamClearTimer } from '../runtime.js';

/**
 * Discover the hostnames a certificate serves. Prefers the SAN DNS entries and
 * falls back to the subject CN for legacy single-name certs. Wildcards
 * (`*.api.example.com`) are kept verbatim. Pure: PEM text in, a sorted
 * de-duplicated lower-case host list out.
 *
 * @param {string} certPem
 * @returns {string[]}
 */
export function parseSniHosts(certPem) {
	const cert = new X509Certificate(certPem);
	const hosts = new Set();
	// subjectAltName looks like: "DNS:a.example.com, DNS:*.api.example.com, IP Address:10.0.0.1"
	const san = cert.subjectAltName;
	if (san) {
		for (const entry of san.split(',')) {
			const trimmed = entry.trim();
			if (trimmed.startsWith('DNS:')) {
				const host = trimmed.slice(4).trim().toLowerCase();
				if (host) hosts.add(host);
			}
		}
	}
	// CN fallback only when the cert carries no SAN DNS names. node:crypto prints
	// the subject as newline-separated RDNs, so match CN only at an RDN boundary (a
	// line beginning with `CN=`); a literal "CN=" inside an earlier RDN value must
	// not be mistaken for the Common Name.
	if (hosts.size === 0 && cert.subject) {
		for (const line of cert.subject.split('\n')) {
			if (line.startsWith('CN=')) {
				const host = line.slice(3).trim().toLowerCase();
				if (host) hosts.add(host);
			}
		}
	}
	return [...hosts].sort();
}

/**
 * Read the identity of the certificate on disk without touching any server:
 * its fingerprint256 (the change-detection key), the host list it serves, and
 * when it expires. Throws on an unreadable / unparseable cert, so callers can
 * disable hot-reload loudly at boot instead of failing on the first renewal.
 *
 * The expiry is carried in both forms on purpose: `notAfterText` is the
 * certificate's own rendering (what an operator sees from `openssl x509`) and
 * goes into log lines verbatim, while `notAfter` is the epoch form the
 * remaining-validity arithmetic needs, and is null for a certificate whose
 * date this platform cannot parse.
 *
 * @param {string} certPath
 * @param {string[]} [overrideHosts] overrides SAN auto-discovery (SSL_SNI_HOSTS)
 * @returns {{ fingerprint: string, hosts: string[], notAfter: number | null, notAfterText: string }}
 */
export function readCertIdentity(certPath, overrideHosts) {
	const certPem = readFileSync(certPath, 'utf8');
	const cert = new X509Certificate(certPem);
	const hosts = (overrideHosts && overrideHosts.length > 0) ? overrideHosts : parseSniHosts(certPem);
	const notAfter = Date.parse(cert.validTo);
	return {
		fingerprint: cert.fingerprint256,
		hosts,
		notAfter: Number.isNaN(notAfter) ? null : notAfter,
		notAfterText: cert.validTo
	};
}

/**
 * How close to expiry a certificate has to be before a broken reload path is
 * worth waking someone over. Two weeks: longer than every automated renewal
 * cadence in use (certbot renews at 30 days, cert-manager at a third of the
 * lifetime), so reaching this window means renewal has already failed several
 * times over, and short enough that the line is not permanent background noise.
 */
const CERT_EXPIRY_ALERT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Remaining validity in the form an operator reads at 3am.
 * @param {number} ms
 * @returns {string}
 */
function formatRemaining(ms) {
	if (ms <= 0) return 'ALREADY EXPIRED';
	const days = Math.floor(ms / 86400000);
	const hours = Math.floor((ms % 86400000) / 3600000);
	if (days > 0) return `${days}d ${hours}h left`;
	const minutes = Math.floor((ms % 3600000) / 60000);
	return `${hours}h ${minutes}m left`;
}

/**
 * The line an operator needs when certificate hot-reload is broken AND the
 * certificate still being served is running out - or null when there is
 * nothing to say.
 *
 * This is the reporting half of "a failed reload keeps the previous cert".
 * That choice protects availability, and it also hides the failure: every
 * probe stays green, the renewed certificate on disk is never served, and the
 * first symptom is every handshake failing at once. Nothing else in the
 * process knows both halves - that renewal is dead, and how long the served
 * leaf has left - so nothing else can raise this.
 *
 * Deliberately NOT wired to readiness: taking a fleet out of rotation because
 * its certificate is near expiry removes a service that is still serving fine,
 * at the exact moment it can least afford it. Report loudly, keep serving.
 *
 * Pure, so the rule (only while degraded, only inside the window) is testable
 * without a clock, a watcher or a certificate.
 *
 * @param {{ degraded?: string | null, notAfter?: number | null, notAfterText?: string | null }} state
 * @param {number} now wall-clock epoch ms
 * @param {number} [withinMs] alert window before expiry
 * @returns {string | null}
 */
export function certExpiryAlert(state, now, withinMs = CERT_EXPIRY_ALERT_MS) {
	if (!state || !state.degraded) return null;
	if (typeof state.notAfter !== 'number' || !Number.isFinite(state.notAfter)) return null;
	const remaining = state.notAfter - now;
	if (remaining > withinMs) return null;
	// The varying tail only: the invariant head lives in the error registry
	// (TLS_DEGRADED_EXPIRY) and callers print through adapterConsoleLine, so
	// the emitted line is searchable by its indexed prefix.
	return (
		`${state.degraded}) and the certificate being served expires ` +
		`${state.notAfterText || state.notAfter} (${formatRemaining(remaining)}). A failed reload keeps the PREVIOUS ` +
		'certificate, so a renewal landing on disk will not fix this by itself: check the certificate files and restart this instance.'
	);
}

/**
 * Watch the DIRECTORY containing the certificate and fire a debounced
 * `onChange`. Directory-watch (not file-watch) survives the atomic rename /
 * symlink swap certbot and cert-manager use, which a file-watch misses. Time
 * and fs access are injected (defaulting to the runtime seam + node:fs) so the
 * debounce is deterministic under test and routed through the injectable
 * timer.
 *
 * @param {{ certPath: string, onChange: () => void, dir?: string, debounceMs?: number, watchFs?: typeof import('node:fs').watch, setTimer?: Function, clearTimer?: Function }} config
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createCertWatcher(config) {
	const dir = config.dir || dirname(config.certPath);
	const debounceMs = typeof config.debounceMs === 'number' && config.debounceMs >= 0 ? config.debounceMs : 500;
	const watchFs = config.watchFs || fsWatch;
	const setTimer = config.setTimer || seamSetTimer;
	const clearTimer = config.clearTimer || seamClearTimer;
	let watcher = null;
	let timer = null;

	function schedule() {
		if (timer) clearTimer(timer);
		// Coalesce a burst of fs events (a multi-file cert+key write, an editor's
		// write-then-rename) into a single reload after the quiet window.
		timer = setTimer(() => { timer = null; config.onChange(); }, debounceMs);
	}

	return {
		start() {
			if (watcher) return;
			// persistent:false so the watcher never holds the event loop open.
			watcher = watchFs(dir, { persistent: false }, () => schedule());
		},
		stop() {
			if (timer) { clearTimer(timer); timer = null; }
			if (watcher) {
				try { watcher.close(); } catch { /* already closed */ }
				watcher = null;
			}
		}
	};
}

/**
 * The cluster-primary TLS reload action, fired by the primary's cert-directory
 * watcher on a renewed cert. Post `{ type: 'tls-reload' }` to every worker so
 * each swaps its OWN secure context. The broadcast is UNCONDITIONAL - each
 * worker fingerprint-gates its own apply, so an unchanged cert costs each
 * worker one file read and a no-op.
 *
 * The primary also refreshes its own view of the cert's identity (fingerprint
 * + hosts + expiry) for observability; a cert that fails to parse is reported
 * via `onError` and the previous state is kept (workers validate independently
 * and keep serving the previous cert). The per-worker post is best-effort (a
 * worker mid-exit may throw).
 *
 * Pure over its inputs apart from the postMessage side effects and the cert
 * read, so a unit test drives it with mock workers.
 *
 * @param {{
 *   workers: Iterable<{ postMessage: (msg: any) => void }>,
 *   source?: { certPath: string, hosts?: string[] },
 *   state?: { hosts: string[], fingerprint: string | null, notAfter?: number | null, notAfterText?: string | null },
 *   onError?: (err: any) => void
 * }} args
 * @returns {{ hosts: string[], fingerprint: string | null, notAfter?: number | null, notAfterText?: string | null }}
 *   the refreshed cert identity, expiry included (the input `state` unchanged
 *   when there is no source or the read threw)
 */
export function reloadClusterTls({ workers, source, state, onError }) {
	let next = state || { hosts: [], fingerprint: null, notAfter: null, notAfterText: null };
	if (source) {
		try {
			next = readCertIdentity(source.certPath, source.hosts);
		} catch (err) {
			if (onError) onError(err);
		}
	}
	for (const worker of workers) {
		try { worker.postMessage({ type: 'tls-reload' }); } catch { /* worker exiting */ }
	}
	return next;
}
