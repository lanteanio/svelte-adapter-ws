// In-process TLS through node:https: the cert/key pair (or PKCS#12 bundle)
// for the default context, additional pairs served per SNI name, OCSP
// stapling from an externally-maintained response file, and a certificate
// hot-reload that swaps the secure context in place - node applies
// setSecureContext to NEW connections without re-binding the listen socket,
// so a certbot renewal never drops a live connection.

import https from 'node:https';
import fs from 'node:fs';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import {
	ssl_cert, ssl_key, ssl_pfx, ssl_pfx_passphrase, ssl_watch,
	ssl_reload_debounce_ms, ssl_sni_hosts, ssl_ocsp_file
} from './config.js';
import { setTimer, clearTimer } from '../runtime.js';

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

	/** @type {import('node:tls').TlsOptions} */
	const baseOptions = ssl_pfx
		? { pfx: fs.readFileSync(ssl_pfx), passphrase: ssl_pfx_passphrase || undefined }
		: { cert: fs.readFileSync(pairs[0].cert), key: fs.readFileSync(pairs[0].key) };

	const server = https.createServer(baseOptions, handleRequest);

	// Additional certificates: each pair beyond the first serves the SNI
	// names its cert carries, or the next names from the SSL_SNI_HOSTS
	// override list.
	/** @type {Array<{ pair: { cert: string, key: string }, hosts: string[] }>} */
	const sniPairs = [];
	let overrideCursor = 0;
	for (let i = 1; i < pairs.length; i++) {
		const certPem = fs.readFileSync(pairs[i].cert);
		let hosts;
		if (ssl_sni_hosts.length > 0) {
			hosts = ssl_sni_hosts.slice(overrideCursor);
			overrideCursor = ssl_sni_hosts.length;
		} else {
			hosts = certHosts(certPem);
		}
		if (hosts.length === 0) {
			throw new Error(
				`[svelte-adapter-ws] certificate ${pairs[i].cert} carries no DNS subjectAltName and ` +
				'SSL_SNI_HOSTS names none for it, so no SNI name would ever select it.'
			);
		}
		sniPairs.push({ pair: pairs[i], hosts });
		const context = tls.createSecureContext({ cert: certPem, key: fs.readFileSync(pairs[i].key) });
		for (const host of hosts) server.addContext(host, context);
	}

	// OCSP stapling: hand the externally-maintained DER response to every
	// handshake that asks. Re-read under the same debounce as the certs so a
	// refreshed response staples without a restart.
	let ocspResponse = ssl_ocsp_file ? readOptional(ssl_ocsp_file) : null;
	if (ssl_ocsp_file) {
		server.on('OCSPRequest', (_cert, _issuer, callback) => {
			callback(null, ocspResponse);
		});
	}

	if (ssl_watch) {
		armHotReload(server, pairs, sniPairs, () => {
			if (ssl_ocsp_file) ocspResponse = readOptional(ssl_ocsp_file);
		});
	}

	return server;
}

/**
 * Watch every certificate-bearing file and swap contexts on a debounced
 * change. The change gate is the certificate fingerprint, baselined at boot:
 * a watcher event that did not actually change the served cert (an atomic
 * rename storm, a touch) swaps nothing.
 *
 * @param {import('node:https').Server} server
 * @param {{ cert: string, key: string }[]} pairs
 * @param {Array<{ pair: { cert: string, key: string }, hosts: string[] }>} sniPairs
 * @param {() => void} onReload
 */
function armHotReload(server, pairs, sniPairs, onReload) {
	const watchedFiles = ssl_pfx
		? [ssl_pfx]
		: pairs.flatMap((p) => [p.cert, p.key]);
	if (ssl_ocsp_file) watchedFiles.push(ssl_ocsp_file);

	/** @type {string | null} */
	let servedFingerprint = null;
	if (!ssl_pfx) {
		try {
			servedFingerprint = new X509Certificate(fs.readFileSync(pairs[0].cert)).fingerprint256;
		} catch {
			servedFingerprint = null;
		}
	}

	/** @type {any} */
	let debounce = null;
	const reload = () => {
		debounce = null;
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
				for (const { pair, hosts } of sniPairs) {
					const context = tls.createSecureContext({
						cert: fs.readFileSync(pair.cert),
						key: fs.readFileSync(pair.key)
					});
					for (const host of hosts) server.addContext(host, context);
				}
			}
			onReload();
			console.log('[svelte-adapter-ws] [tls] certificate context reloaded');
		} catch (err) {
			// A renewal mid-write can present a torn pair; the next watcher
			// event retries. The served context stays on the previous cert.
			console.error('[svelte-adapter-ws] [tls] certificate reload failed (serving the previous cert):', err);
		}
	};

	/** @type {import('node:fs').FSWatcher[]} */
	const watchers = [];
	for (const file of watchedFiles) {
		try {
			const watcher = fs.watch(file, { persistent: false }, () => {
				if (debounce !== null) clearTimer(debounce);
				debounce = setTimer(reload, ssl_reload_debounce_ms);
				if (typeof debounce?.unref === 'function') debounce.unref();
			});
			// A watcher can error after arming (the watched file's directory
			// removed, an EPERM on teardown); an unhandled watcher error would
			// take the process down over a lost WATCH, not a lost cert.
			watcher.on('error', () => {
				try { watcher.close(); } catch { /* already closed */ }
			});
			watchers.push(watcher);
		} catch {
			// A file that cannot be watched (removed between boot and arm)
			// still serves its boot-time content; the operator's next deploy
			// restarts the process anyway.
		}
	}
	server.once('close', () => {
		if (debounce !== null) clearTimer(debounce);
		for (const watcher of watchers) {
			try { watcher.close(); } catch { /* already closed */ }
		}
	});
}
