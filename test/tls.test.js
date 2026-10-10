// In-process TLS end to end: cert/key boots, WebSocket upgrades over TLS,
// SNI selecting the right certificate, and the hot reload serving a renewed
// certificate to SNI-matched handshakes without a restart while a client that
// sends no servername keeps the boot certificate.

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
const tlsSource = readFileSync(new URL('../src/runtime/handler/tls.js', import.meta.url), 'utf8');

// CN-only renewal coverage generates a legacy certificate with openssl.
function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(path.join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
	}
	for (const bin of candidates) {
		try {
			execFileSync(bin, ['version'], { stdio: 'ignore' });
			return bin;
		} catch {}
	}
	return null;
}
const openssl = findOpenssl();
const itOpenssl = openssl !== null ? it : it.skip;

/** @param {string} dir @param {string} name @param {string} cn @param {string} san */
function genCert(dir, name, cn, san) {
	const key = path.join(dir, name + '.key');
	const crt = path.join(dir, name + '.crt');
	execFileSync(/** @type {string} */ (openssl), [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', '/CN=' + cn, '-addext', 'subjectAltName=' + san
	], { stdio: 'ignore' });
	return { key, crt };
}

/** A legacy single-name certificate: subject CN only, no subjectAltName.
 * @param {string} dir @param {string} name @param {string} cn */
function genCertCnOnly(dir, name, cn) {
	const key = path.join(dir, name + '.key');
	const crt = path.join(dir, name + '.crt');
	execFileSync(/** @type {string} */ (openssl), [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', '/CN=' + cn
	], { stdio: 'ignore' });
	return { key, crt };
}

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
 * The console.log lines a synchronous call printed.
 * @param {() => void} fn
 */
function captureLog(fn) {
	/** @type {string[]} */
	const lines = [];
	const original = console.log;
	console.log = (...args) => { lines.push(args.map(String).join(' ')); };
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines;
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

	it('treats commas in certificate and key paths as literal filename characters', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlscomma-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const certPath = path.join(dir, 'cert,live.crt');
		const keyPath = path.join(dir, 'key,live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		const rt = await bootTls('SAW_T4_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');
		copyFileSync(path.join(fixtures, 'sni.crt'), certPath);
		copyFileSync(path.join(fixtures, 'sni.key'), keyPath);
		rt.handler.reloadTls();
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('sni.example');
	});

	itOpenssl('serves a CN-only renewal under its subject name', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-cnonly-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const cnOnly = genCertCnOnly(dir, 'cnonly', 'legacy.example');
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		const rt = await bootTls('SAW_TCN_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		copyFileSync(cnOnly.crt, certPath);
		copyFileSync(cnOnly.key, keyPath);
		rt.handler.reloadTls();
		expect((await tlsGet(rt.port, '/healthz', 'legacy.example')).peerCert.subject.CN).toBe('legacy.example');
		expect((await tlsGet(rt.port, '/healthz', 'localhost')).peerCert.subject.CN).toBe('localhost');
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
		// A single-process TLS server watches its own directory, and says so.
		expect(rt.handler.tlsReloadState().watching).toBe(true);

		// The renewal: a different certificate lands on the same paths.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));

		// The renewal is served to handshakes that name it.
		let renewed = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 5000) {
			await new Promise((r) => setTimeout(r, 150));
			const probe = await tlsGet(rt.port, '/healthz', 'sni.example');
			if (probe.peerCert.subject.CN === 'sni.example') { renewed = probe; break; }
		}
		expect(renewed?.peerCert.subject.CN).toBe('sni.example');
		// A client that sends no servername keeps the boot certificate: the
		// server's own context is static for the process lifetime.
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');
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

		const after = await tlsGet(rt.port, '/healthz', 'sni.example');
		expect(after.peerCert.subject.CN).toBe('sni.example');
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');
		// A servername the renewal does not carry is answered by the server's
		// own context, boot certificate included: the renewal replaced the
		// name set, it did not become the fallback.
		expect((await tlsGet(rt.port, '/healthz', 'localhost')).peerCert.subject.CN).toBe('localhost');
		expect((await tlsGet(rt.port, '/healthz', 'unmatched.example')).peerCert.subject.CN).toBe('localhost');
	});

	it('serves a single certificate\'s renewal under the SSL_SNI_HOSTS override, not its own names', async () => {
		// The family's one-certificate shape: the override names what the
		// renewal is served under, in place of SAN discovery.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlsoverride-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T17_', { SSL_CERT: certPath, SSL_KEY: keyPath, SSL_SNI_HOSTS: ' OTHER.example , alias.example ' });
		// Boot registers nothing: the override names reload hosts only.
		expect((await tlsGet(rt.port, '/healthz', 'other.example')).peerCert.subject.CN).toBe('localhost');
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));
		const lines = captureLog(() => rt.handler.reloadTls());
		expect(rt.handler.tlsReloadState().generation).toBe(1);
		// The default certificate changed, so the line carries its expiry.
		expect(lines).toContain(`[tls] renewed certificate now served (SNI: other.example, alias.example; expires ${rt.handler.tlsReloadState().notAfterText}; generation 1)`);

		expect((await tlsGet(rt.port, '/healthz', 'other.example')).peerCert.subject.CN).toBe('sni.example');
		expect((await tlsGet(rt.port, '/healthz', 'alias.example')).peerCert.subject.CN).toBe('sni.example');
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('localhost');
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');
	});

	it('keeps the served set when the apply step fails after validation, and retries on its own', async () => {
		// A certificate file whose leaf validates but whose trailing PEM block
		// is garbage: the identity read and the key check pass, and building
		// the secure context throws inside the registry - after validation,
		// so this is the mid-apply branch, not the skipped-reload one.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlsmidapply-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T19_', { SSL_CERT: certPath, SSL_KEY: keyPath, SSL_RELOAD_DEBOUNCE_MS: '50' });
		const garbage = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt'), 'utf8') + garbage);
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));
		/** @type {string[]} */
		const errors = [];
		const originalError = console.error;
		console.error = (...args) => { errors.push(args.map(String).join(' ')); };
		try {
			rt.handler.reloadTls();
		} finally {
			console.error = originalError;
		}
		expect(errors.some((line) => line.includes('event=tls.swap-failed')), 'the failure is reported as a swap that failed mid-apply').toBe(true);
		const failed = rt.handler.tlsReloadState();
		expect(failed.failures).toBe(1);
		expect(failed.generation, 'nothing reached the served set').toBe(0);
		expect(failed.degraded).toBe('a certificate swap failed mid-apply');
		expect((await tlsGet(rt.port, '/healthz')).peerCert.subject.CN).toBe('localhost');
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('localhost');

		// The failure armed its own retry, re-armed from each failure. The
		// writes above also woke the directory watch, so let that settle; in
		// the quiet window after it nothing touches the directory, and only
		// the retry can keep the failure count climbing.
		await new Promise((r) => setTimeout(r, 400));
		const settled = rt.handler.tlsReloadState().failures;
		await new Promise((r) => setTimeout(r, 400));
		expect(rt.handler.tlsReloadState().failures, 'the retry fired without an fs event').toBeGreaterThan(settled);

		// The file is made whole; the next attempt serves the renewal.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		/** @type {string[]} */
		const logs = [];
		const originalLog = console.log;
		console.log = (...args) => { logs.push(args.map(String).join(' ')); };
		try {
			const t0 = Date.now();
			while (rt.handler.tlsReloadState().generation === 0 && Date.now() - t0 < 3000) {
				await new Promise((r) => setTimeout(r, 25));
			}
		} finally {
			console.log = originalLog;
		}
		const recovered = rt.handler.tlsReloadState();
		expect(recovered.generation).toBe(1);
		expect(recovered.degraded).toBeNull();
		expect(logs).toContain('[tls] certificate reload recovered (was: a certificate swap failed mid-apply)');
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('sni.example');
	});

	itOpenssl('serves a same-name renewal to SNI handshakes and the boot certificate to the rest', async () => {
		// The ordinary renewal: the same names, a fresh key pair. A handshake
		// naming the host gets the renewal; one that sends no servername is
		// answered by the server's own context, which stays on the boot
		// certificate for the process lifetime, and is still served.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlssame-'));
		const boot = genCert(dir, 'boot', 'localhost', 'DNS:localhost');
		const renewal = genCert(dir, 'renewal', 'localhost', 'DNS:localhost');
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(boot.crt, certPath);
		copyFileSync(boot.key, keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const rt = await bootTls('SAW_T16_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		const bootSni = await tlsGet(rt.port, '/healthz', 'localhost');
		const bootPlain = await tlsGet(rt.port, '/healthz');
		expect(bootSni.peerCert.fingerprint256).toBe(bootPlain.peerCert.fingerprint256);

		copyFileSync(renewal.crt, certPath);
		copyFileSync(renewal.key, keyPath);
		rt.handler.reloadTls();
		expect(rt.handler.tlsReloadState().generation).toBe(1);

		const sni = await tlsGet(rt.port, '/healthz', 'localhost');
		expect(sni.status).toBe(200);
		expect(sni.peerCert.fingerprint256).not.toBe(bootSni.peerCert.fingerprint256);
		const plain = await tlsGet(rt.port, '/healthz');
		expect(plain.status).toBe(200);
		expect(plain.peerCert.fingerprint256).toBe(bootPlain.peerCert.fingerprint256);
	}, 30000);

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
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('sni.example');
	});

	it('selects a renewed wildcard SAN for names under it, one label deep', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlswild-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		const rt = await bootTls('SAW_T8_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		copyFileSync(path.join(fixtures, 'wild.crt'), certPath);
		copyFileSync(path.join(fixtures, 'wild.key'), keyPath);
		rt.handler.reloadTls();
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

	it('remaps SNI names across renewals, dropping stale ones', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-sniremap-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const rt = await bootTls('SAW_T9_', { SSL_CERT: certPath, SSL_KEY: keyPath });
		for (const [name, hostname] of [['sni', 'sni.example'], ['wild', 'app.wild.example']]) {
			copyFileSync(path.join(fixtures, name + '.crt'), certPath);
			copyFileSync(path.join(fixtures, name + '.key'), keyPath);
			rt.handler.reloadTls();
			expect((await tlsGet(rt.port, '/healthz', hostname)).peerCert.subject.CN).toBe(name === 'sni' ? 'sni.example' : 'wild.example');
		}
		expect((await tlsGet(rt.port, '/healthz', 'sni.example')).peerCert.subject.CN).toBe('localhost');
		expect(rt.handler.tlsReloadState().generation).toBe(2);
	});

	it('serves a renewal that landed between the boot read and the watch being armed', async () => {
		// The watch is armed once the listen socket is bound, not while the
		// module evaluates. Anything written in between would otherwise sit on
		// disk until the NEXT event in its directory, which for a renewal that
		// already happened may be months away.
		const dir = mkdtempSync(path.join(tmpdir(), 'saw-tlscatchup-'));
		const certPath = path.join(dir, 'live.crt');
		const keyPath = path.join(dir, 'live.key');
		copyFileSync(path.join(fixtures, 'localhost.crt'), certPath);
		copyFileSync(path.join(fixtures, 'localhost.key'), keyPath);
		process.env.SAW_T12_SSL_CERT = certPath;
		process.env.SAW_T12_SSL_KEY = keyPath;
		const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('SAW_T12_') } });
		cleanups.push(() => {
			delete process.env.SAW_T12_SSL_CERT;
			delete process.env.SAW_T12_SSL_KEY;
			payload.cleanup();
			rmSync(dir, { recursive: true, force: true });
		});
		// Module evaluation reads the boot certificate and builds the server.
		const handler = await payload.importRuntime();
		cleanups.push(() => handler.shutdown({ timeoutMs: 1000 }));
		// The renewal lands before start() arms the watch.
		writeFileSync(certPath, readFileSync(path.join(fixtures, 'sni.crt')));
		writeFileSync(keyPath, readFileSync(path.join(fixtures, 'sni.key')));
		await handler.start('127.0.0.1', 0);
		const port = handler.server.address().port;

		// No fs event was ever delivered for it; the arm-time read is what
		// served it, and it counts as the swap it is.
		const probe = await tlsGet(port, '/healthz', 'sni.example');
		expect(probe.peerCert.subject.CN).toBe('sni.example');
		expect(handler.tlsReloadState().generation).toBe(1);
	});

	it('disarms the expiry sentinel with the watchers when the server closes', () => {
		// A degraded process that kept its hourly expiry line going after its
		// server was gone would be reporting on a certificate it no longer
		// serves. Pinned at the source: the sentinel is module state with no
		// readable surface, and what is being held is that the watcher's close
		// handler reaches the one call that drops it, and that the call drops it.
		const arm = tlsSource.slice(tlsSource.indexOf('function armHotReload('));
		const closeHandler = arm.slice(arm.indexOf("server.once('close'"), arm.indexOf('\n\t});', arm.indexOf("server.once('close'")));
		expect(closeHandler, 'the close handler no longer stops the reload path').toContain('stopTlsReload();');
		const stateSource = readFileSync(new URL('../src/runtime/handler/tls-state.js', import.meta.url), 'utf8');
		const stop = stateSource.slice(stateSource.indexOf('export function stopTlsReload()'));
		expect(stop.slice(0, stop.indexOf('\n}')), 'stopTlsReload no longer disarms the sentinel').toContain('disarmTlsExpirySentinel();');
	});

});
