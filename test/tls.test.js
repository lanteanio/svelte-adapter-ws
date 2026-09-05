// In-process TLS end to end: cert/key and PFX boots, WebSocket upgrades over
// TLS, SNI selecting the right certificate, OCSP stapling, and the hot
// reload swapping the served certificate without a restart.

import https from 'node:https';
import tls from 'node:tls';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/**
 * @param {string} prefix
 * @param {Record<string, string>} envVars
 */
async function bootTls(prefix, envVars) {
	for (const [k, v] of Object.entries(envVars)) process.env[prefix + k] = v;
	const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
	const rt = await bootRuntime(payload);
	cleanups.push(async () => {
		await rt.handler.shutdown({ timeoutMs: 1000 });
		for (const k of Object.keys(envVars)) delete process.env[prefix + k];
		payload.cleanup();
	});
	return rt;
}

/**
 * One TLS request without certificate verification, returning body + peer cert.
 * @param {number} port
 * @param {string} reqPath
 * @param {string} [servername]
 */
function tlsGet(port, reqPath, servername) {
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: '127.0.0.1',
			port,
			path: reqPath,
			rejectUnauthorized: false,
			// Fresh socket per probe: a kept-alive or session-resumed socket
			// would keep answering with the pre-renewal certificate.
			agent: false,
			servername
		}, (res) => {
			// Capture the peer certificate while the socket is still attached;
			// node detaches res.socket by the time 'end' fires.
			const peerCert = /** @type {import('node:tls').TLSSocket} */ (res.socket).getPeerCertificate();
			/** @type {Buffer[]} */
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({
				status: res.statusCode,
				body: Buffer.concat(chunks).toString(),
				peerCert
			}));
		});
		req.on('error', reject);
		req.end();
	});
}

describe('native TLS', () => {
	it('serves HTTPS from a PEM pair and upgrades WebSockets over it', async () => {
		const rt = await bootTls('SAW_T1_', {
			SSL_CERT: path.join(fixtures, 'localhost.crt'),
			SSL_KEY: path.join(fixtures, 'localhost.key'),
			SSL_WATCH: '0'
		});
		const res = await tlsGet(rt.port, '/healthz');
		expect(res.status).toBe(200);
		expect(res.body).toBe('OK');
		expect(res.peerCert.subject.CN).toBe('localhost');

		// WebSocket over TLS: the payload boots with WS off by default, so a
		// wss dial must at least complete the TLS handshake and then be
		// refused at the HTTP layer (404), never a TLS failure.
		const failure = await new Promise((resolve) => {
			const ws = new WebSocket(`wss://127.0.0.1:${rt.port}/ws`, { rejectUnauthorized: false });
			ws.once('error', (err) => resolve(String(err.message)));
			ws.once('open', () => resolve('open'));
		});
		expect(failure).toMatch(/404|Unexpected server response/);
	});

	it('upgrades a realtime WebSocket over TLS end to end', async () => {
		process.env.SAW_T2_SSL_CERT = path.join(fixtures, 'localhost.crt');
		process.env.SAW_T2_SSL_KEY = path.join(fixtures, 'localhost.key');
		process.env.SAW_T2_SSL_WATCH = '0';
		const payload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify('SAW_T2_'),
				WS_ENABLED: JSON.stringify(true),
				WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0, authPathRateLimit: 0 })
			},
			wsHandlerSource: 'export function close() {}\n'
		});
		const rt = await bootRuntime(payload);
		cleanups.push(async () => {
			await rt.handler.shutdown({ timeoutMs: 1000 });
			delete process.env.SAW_T2_SSL_CERT;
			delete process.env.SAW_T2_SSL_KEY;
			delete process.env.SAW_T2_SSL_WATCH;
			payload.cleanup();
		});
		const welcome = await new Promise((resolve, reject) => {
			const ws = new WebSocket(`wss://127.0.0.1:${rt.port}/ws`, { rejectUnauthorized: false });
			ws.once('message', (raw) => { resolve(JSON.parse(raw.toString())); ws.close(); });
			ws.once('error', reject);
		});
		expect(welcome.type).toBe('welcome');
	});

	it('boots from a PKCS#12 bundle', async () => {
		const rt = await bootTls('SAW_T3_', {
			SSL_PFX: path.join(fixtures, 'bundle.pfx'),
			SSL_PFX_PASSPHRASE: 'testpass',
			SSL_WATCH: '0'
		});
		const res = await tlsGet(rt.port, '/healthz');
		expect(res.status).toBe(200);
		expect(res.peerCert.subject.CN).toBe('localhost');
	});

	it('selects the SNI certificate for its host and the default otherwise', async () => {
		const rt = await bootTls('SAW_T4_', {
			SSL_CERT: `${path.join(fixtures, 'localhost.crt')},${path.join(fixtures, 'sni.crt')}`,
			SSL_KEY: `${path.join(fixtures, 'localhost.key')},${path.join(fixtures, 'sni.key')}`,
			SSL_WATCH: '0'
		});
		const sni = await tlsGet(rt.port, '/healthz', 'sni.example');
		expect(sni.peerCert.subject.CN).toBe('sni.example');
		const fallback = await tlsGet(rt.port, '/healthz', 'localhost');
		expect(fallback.peerCert.subject.CN).toBe('localhost');
	});

	it('staples the configured OCSP response to a handshake that asks', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-ocsp-'));
		const ocspBytes = Buffer.from('fake-der-ocsp-response');
		const ocspFile = path.join(dir, 'ocsp.der');
		writeFileSync(ocspFile, ocspBytes);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T5_', {
			SSL_CERT: path.join(fixtures, 'localhost.crt'),
			SSL_KEY: path.join(fixtures, 'localhost.key'),
			SSL_OCSP_FILE: ocspFile,
			SSL_WATCH: '0'
		});
		const stapled = await new Promise((resolve, reject) => {
			const socket = tls.connect({
				host: '127.0.0.1',
				port: rt.port,
				rejectUnauthorized: false,
				requestOCSP: true
			});
			socket.on('OCSPResponse', (response) => { resolve(response); socket.destroy(); });
			socket.on('error', reject);
			socket.on('secureConnect', () => {
				// No response event by handshake end means nothing was stapled.
				setTimeout(() => { resolve(null); socket.destroy(); }, 200);
			});
		});
		expect(stapled && Buffer.from(/** @type {Buffer} */ (stapled)).equals(ocspBytes)).toBe(true);
	});

	it('hot-reloads a renewed certificate without a restart', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlsreload-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T6_', {
			SSL_CERT: certPath,
			SSL_KEY: keyPath,
			SSL_RELOAD_DEBOUNCE_MS: '50'
		});
		const before = await tlsGet(rt.port, '/healthz');
		expect(before.peerCert.subject.CN).toBe('localhost');

		// The renewal: a different certificate lands on the same paths.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));

		let renewed = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 5000) {
			await new Promise((r) => setTimeout(r, 150));
			const probe = await tlsGet(rt.port, '/healthz');
			if (probe.peerCert.subject.CN === 'sni.example') { renewed = probe; break; }
		}
		expect(renewed?.peerCert.subject.CN).toBe('sni.example');
	}, 15000);

	it('swaps the renewed certificate on reloadTls() without a watcher event', async () => {
		// The cluster shape: the primary owns the directory watch and posts
		// tls-reload; the worker's runtime routes that message into
		// handler.reloadTls(). Driving the export directly proves the swap
		// works with no fs watcher involved on this thread.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlsmsg-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T10_', {
			SSL_CERT: certPath,
			SSL_KEY: keyPath
		});
		const before = await tlsGet(rt.port, '/healthz');
		expect(before.peerCert.subject.CN).toBe('localhost');

		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));
		rt.handler.reloadTls();

		const after = await tlsGet(rt.port, '/healthz');
		expect(after.peerCert.subject.CN).toBe('sni.example');
	});

	it('reports a zeroed reload record on a plain-HTTP build, as a snapshot', async () => {
		// Why the record does not live in handler/tls.js: that module is
		// imported only when the server is TLS, so a plain-HTTP build could not
		// answer at all. A diagnostics reader that throws on half the
		// deployments is worse than one reporting a record of zeroes.
		const payload = buildRuntime({});
		const rt = await bootRuntime(payload);
		cleanups.push(async () => {
			await rt.handler.shutdown({ timeoutMs: 1000 });
			payload.cleanup();
		});

		const state = rt.handler.tlsReloadState();
		expect(state.watching).toBe(false);
		expect(state.degraded).toBeNull();
		expect(state.generation).toBe(0);
		expect(state.failures).toBe(0);
		expect(state.notAfter).toBeNull();

		// A snapshot, not the live record: a caller that mutates what it was
		// handed must not be able to rewrite the adapter's own health.
		state.generation = 99;
		state.degraded = 'tampered';
		expect(rt.handler.tlsReloadState().generation).toBe(0);
		expect(rt.handler.tlsReloadState().degraded).toBeNull();
	});

	it('degrades on a reload that does not validate, and clears it on the next success', async () => {
		// The contrast to a dead watch: THIS degradation is one a later success
		// is allowed to clear. Without it, making every degradation sticky
		// would leave the watch-failure behaviour looking correct.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlsdegr-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T14_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		expect(rt.handler.tlsReloadState().degraded).toBeNull();

		// A renewal caught mid-write: the certificate is the new one, the key
		// is still the old one, so the pair does not validate.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		rt.handler.reloadTls();

		const failed = rt.handler.tlsReloadState();
		expect(failed.failures).toBe(1);
		expect(failed.generation, 'nothing was swapped').toBe(0);
		expect(failed.degraded).toBe(
			'the certificate on disk did not validate, so the previous one is still being served'
		);
		// The previous certificate is still the one being served.
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');

		// The write completes; the next reload succeeds and clears it.
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));
		rt.handler.reloadTls();

		const recovered = rt.handler.tlsReloadState();
		expect(recovered.generation).toBe(1);
		expect(recovered.degraded, 'a validation failure is cleared by a success').toBeNull();
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('sni.example');
	});

	it('selects a wildcard SAN certificate for names under it, one label deep', async () => {
		const rt = await bootTls('SAW_T8_', {
			SSL_CERT: `${path.join(fixtures, 'localhost.crt')},${path.join(fixtures, 'wild.crt')}`,
			SSL_KEY: `${path.join(fixtures, 'localhost.key')},${path.join(fixtures, 'wild.key')}`,
			SSL_WATCH: '0'
		});
		// The dominant multi-host shape: the cert says *.wild.example and the
		// client says app.wild.example - an exact-match-only lookup would hand
		// back the default cert and every browser would hard-fail the handshake.
		const wild = await tlsGet(rt.port, '/healthz', 'app.wild.example');
		expect(wild.peerCert.subject.CN).toBe('wild.example');

		// RFC 6125: the wildcard covers exactly one left-most label, and the
		// bare base name is not under it either - both fall to the default.
		const deep = await tlsGet(rt.port, '/healthz', 'a.b.wild.example');
		expect(deep.peerCert.subject.CN).toBe('localhost');
		const bare = await tlsGet(rt.port, '/healthz', 'wild.example');
		expect(bare.peerCert.subject.CN).toBe('localhost');
	});

	it('remaps SNI names from the reloaded certificate, dropping stale ones', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-sniremap-'));
		const certPath = path.join(dir, 'extra.crt');
		const keyPath = path.join(dir, 'extra.key');
		copyFileSync(path.join(fixtures, 'sni.crt'), certPath);
		copyFileSync(path.join(fixtures, 'sni.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T9_', {
			SSL_CERT: `${path.join(fixtures, 'localhost.crt')},${certPath}`,
			SSL_KEY: `${path.join(fixtures, 'localhost.key')},${keyPath}`,
			SSL_RELOAD_DEBOUNCE_MS: '50'
		});
		const before = await tlsGet(rt.port, '/healthz', 'sni.example');
		expect(before.peerCert.subject.CN).toBe('sni.example');

		// The renewal changes the certificate's SAN set entirely: the reloaded
		// names must serve, and the dropped name must stop matching instead of
		// pointing at a certificate that no longer claims it.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'wild.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'wild.key')));

		let remapped = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 5000) {
			await new Promise((r) => setTimeout(r, 150));
			const probe = await tlsGet(rt.port, '/healthz', 'app.wild.example');
			if (probe.peerCert.subject.CN === 'wild.example') { remapped = probe; break; }
		}
		expect(remapped?.peerCert.subject.CN).toBe('wild.example');

		const dropped = await tlsGet(rt.port, '/healthz', 'sni.example');
		expect(dropped.peerCert.subject.CN).toBe('localhost');
	}, 15000);

	it('refuses an ambiguous PFX plus PEM configuration', async () => {
		process.env.SAW_T7_SSL_PFX = path.join(fixtures, 'bundle.pfx');
		process.env.SAW_T7_SSL_CERT = path.join(fixtures, 'localhost.crt');
		process.env.SAW_T7_SSL_KEY = path.join(fixtures, 'localhost.key');
		const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('SAW_T7_') } });
		cleanups.push(() => {
			delete process.env.SAW_T7_SSL_PFX;
			delete process.env.SAW_T7_SSL_CERT;
			delete process.env.SAW_T7_SSL_KEY;
			payload.cleanup();
		});
		await expect(payload.importRuntime()).rejects.toThrow(/mutually exclusive/);
	});
});
