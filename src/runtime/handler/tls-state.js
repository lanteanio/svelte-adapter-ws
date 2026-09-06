// The certificate-reload path's operator-visible record, and the policy for
// which degradations a successful reload is allowed to clear.
//
// This lives apart from handler/tls.js because that module is imported only
// when the server is TLS (`handler.js`: `is_tls ? await import(...) : null`).
// tlsReloadState() has to answer on a plain-HTTP build too - a diagnostics
// route that throws on half the deployments is worse than one that reports a
// zeroed record - so the record is here, where every build can reach it, and
// handler/tls.js writes into it when it is loaded.
//
// Counts and reasons only: no key material and no certificate bytes.

import { certExpiryAlert, createTlsDegradedLedger, readCertIdentity } from '../utils/tls-reload.js';
import { setIntervalTimer, clearIntervalTimer, wallEpoch } from '../runtime.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

const tlsHealth = {
	/** This process watches the cert directory itself (single-process only). */
	watching: false,
	/** null while renewals would be picked up, else WHY they would not be. */
	degraded: null,
	/** Successful in-place swaps on this worker, so a fleet can be compared. */
	generation: 0,
	failures: 0,
	/** Wall-clock epoch ms, so an operator can read them against a cert's dates. */
	lastReloadAt: null,
	lastFailureAt: null,
	lastFailure: null,
	/** Expiry of the certificate currently being served. */
	notAfter: null,
	notAfterText: null
};

// How often the degraded sentinel re-checks the served leaf. Hourly: the alert
// window is days wide and a broken renewal is fixed by a human, not by a retry,
// so a tighter cadence would only add log noise.
const TLS_DEGRADED_CHECK_MS = 3600000;
let tlsExpirySentinel = null;

/**
 * Snapshot of this worker's certificate-reload path, for diagnostics: whether
 * the watcher is live, whether renewals are being picked up at all, how many
 * swaps this worker has done (a fleet-wide generation skew means one worker
 * missed a renewal), and when the certificate it is serving expires.
 * @returns {{ watching: boolean, degraded: string | null, generation: number, failures: number, lastReloadAt: number | null, lastFailureAt: number | null, lastFailure: string | null, notAfter: number | null, notAfterText: string | null }}
 */
export function tlsReloadState() {
	return { ...tlsHealth };
}

/** Print the expiry alert immediately if the served cert is inside the window. */
function printTlsExpiryAlert() {
	const alert = certExpiryAlert(tlsHealth, wallEpoch());
	if (alert !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, alert));
}

function armTlsExpirySentinel() {
	if (tlsExpirySentinel !== null) return;
	tlsExpirySentinel = setIntervalTimer(() => {
		const line = certExpiryAlert(tlsHealth, wallEpoch());
		if (line !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, line));
	}, TLS_DEGRADED_CHECK_MS);
	if (tlsExpirySentinel && tlsExpirySentinel.unref) tlsExpirySentinel.unref();
}

function disarmTlsExpirySentinel() {
	if (tlsExpirySentinel !== null) {
		clearIntervalTimer(tlsExpirySentinel);
		tlsExpirySentinel = null;
	}
}

// Which degradations a successful reload can clear is policy, not wiring: a
// swap or validation failure is superseded by the next success, while a dead
// directory watch cannot be - the ledger keeps that reason (and the armed
// sentinel) through any later success, so the process never reports healthy
// while it is blind to the next renewal.
const tlsLedger = createTlsDegradedLedger({
	health: tlsHealth,
	onRecovered: (was, still) => {
		if (still === null) console.log(`[svelte-adapter-ws] [tls] certificate reload recovered (was: ${was})`);
		else console.log(`[svelte-adapter-ws] [tls] certificate reload recovered (was: ${was}); still degraded: ${still}`);
	},
	armSentinel: armTlsExpirySentinel,
	disarmSentinel: disarmTlsExpirySentinel
});

/**
 * Mark the reload path as unable to pick up a renewal, and arm the sentinel
 * that re-reports it as the served certificate's expiry approaches. The
 * immediate failure line is the caller's; this adds what the caller cannot
 * know - how long the certificate it kept serving is still valid for.
 * @param {string} reason
 */
export function tlsDegraded(reason) {
	tlsLedger.failed(reason);
	printTlsExpiryAlert();
}

/**
 * The watch-death variant: sticky, surviving every later reload success.
 * @param {string} reason
 */
export function tlsWatchDegraded(reason) {
	tlsLedger.watchFailed(reason);
	printTlsExpiryAlert();
}

/** This process armed its own certificate-directory watch. */
export function markTlsWatching() {
	tlsHealth.watching = true;
}

/** The watch is gone for the process lifetime; renewals will not be seen. */
export function markTlsWatchStopped() {
	tlsHealth.watching = false;
}

/**
 * The server is closing: nothing watches any more, and the expiry sentinel
 * has nobody left to warn. A degraded process that kept its hourly line going
 * after its server was gone would be reporting on a certificate it no longer
 * serves.
 */
export function stopTlsReload() {
	tlsHealth.watching = false;
	disarmTlsExpirySentinel();
}

/**
 * Record a genuine in-place swap. `certPath` is re-read for the served leaf's
 * expiry: one extra read of a file the process already opens, taken only after
 * a real swap, and it is the expiry that makes a broken renewal path
 * reportable at all.
 * @param {string | null} certPath
 * @param {string[]} [overrideHosts]
 */
export function markTlsSwapped(certPath, overrideHosts) {
	tlsHealth.generation++;
	tlsHealth.lastReloadAt = wallEpoch();
	if (certPath) {
		try {
			const identity = readCertIdentity(certPath, overrideHosts);
			tlsHealth.notAfter = identity.notAfter;
			tlsHealth.notAfterText = identity.notAfterText;
		} catch {
			// Unreadable right after a successful swap is a race with the next
			// write: keep the previous value rather than blanking the only expiry
			// we have.
		}
	}
	tlsLedger.recovered();
}

/**
 * Record a reload that failed. The served certificate is whatever it was.
 * @param {unknown} err
 * @param {string} reason
 */
export function markTlsFailed(err, reason) {
	tlsHealth.failures++;
	tlsHealth.lastFailureAt = wallEpoch();
	tlsHealth.lastFailure = String(err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err);
	tlsDegraded(reason);
}

/** Record the boot certificate's expiry, so a later failure reports urgency. */
export function recordBootCertExpiry(certPath, overrideHosts) {
	try {
		const identity = readCertIdentity(certPath, overrideHosts);
		tlsHealth.notAfter = identity.notAfter;
		tlsHealth.notAfterText = identity.notAfterText;
	} catch {
		// Only primary-side observability is lost; the reload path gates on its
		// own reads.
	}
}
