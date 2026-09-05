import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSniHosts, readCertIdentity, applyServerNames, createTlsDegradedLedger, createCertWatcher, reloadClusterTls } from '../src/runtime/utils/tls-reload.js';

// Cert parsing / server-name reconciliation needs a real X.509 cert with a SAN.
// We generate a couple at setup with openssl; if none is found, those cases skip
// while the injected-deps watcher test still runs. The binary must be resolved at
// module scope: describe-vs-skip is decided at collection time, so a beforeAll
// discovery would register the cert suites before learning openssl is missing.
// On Windows the shell PATH often lacks openssl, but Git for Windows bundles one.
function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
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
const hasOpenssl = openssl !== null;
let dir;
const certs = {};

function gen(name, cn, san, subj) {
	const key = join(dir, name + '.key');
	const crt = join(dir, name + '.crt');
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', subj || ('/CN=' + cn), '-addext', 'subjectAltName=' + san
	], { stdio: 'ignore' });
	return { key, crt };
}

beforeAll(() => {
	if (!hasOpenssl) return;
	dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
	// A: a.example.com + a wildcard. B: a.example.com + c.example.com (b/wildcard
	// gone, c new, a shared). D: CN only, no SAN DNS.
	certs.A = gen('a', 'a.example.com', 'DNS:a.example.com,DNS:*.api.example.com');
	certs.B = gen('b', 'a.example.com', 'DNS:a.example.com,DNS:c.example.com');
	certs.CN = gen('cn', 'legacy.example.com', 'IP:10.0.0.1'); // no DNS SAN -> CN fallback
	// CN-trap: an earlier RDN value literally contains "CN=", CN is last, no SAN DNS.
	certs.CNTRAP = gen('cntrap', null, 'IP:10.0.0.2', '/O=Foo CN=Corp/CN=host.example.com');
});

function readPem(p) { return readFileSync(p, 'utf8'); }

const describeSsl = () => (hasOpenssl ? describe : describe.skip);

describeSsl()('parseSniHosts', () => {
	it('returns the SAN DNS names (incl. wildcards), sorted + de-duplicated', () => {
		const hosts = parseSniHosts(readPem(certs.A.crt));
		expect(hosts).toEqual(['*.api.example.com', 'a.example.com']);
	});

	it('falls back to the subject CN when the cert has no SAN DNS name', () => {
		const hosts = parseSniHosts(readPem(certs.CN.crt));
		expect(hosts).toEqual(['legacy.example.com']);
	});

	it('anchors the CN fallback at an RDN boundary (ignores a literal CN= inside another RDN)', () => {
		// Subject: O="Foo CN=Corp", CN=host.example.com. An unanchored /CN=.../ would
		// capture 'Corp' from the O value; matching only a line starting with CN= wins.
		const hosts = parseSniHosts(readPem(certs.CNTRAP.crt));
		expect(hosts).toEqual(['host.example.com']);
	});
});

describeSsl()('readCertIdentity', () => {
	it('returns the cert fingerprint and its SAN hosts without touching any app', () => {
		const id = readCertIdentity(certs.A.crt);
		expect(id.hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(id.fingerprint).toMatch(/^([0-9A-F]{2}:)+[0-9A-F]{2}$/);
		// Different cert bytes -> different fingerprint (the change-detection key).
		expect(readCertIdentity(certs.B.crt).fingerprint).not.toBe(id.fingerprint);
	});

	it('honors an explicit host override instead of SAN discovery', () => {
		const id = readCertIdentity(certs.A.crt, ['override.example.com']);
		expect(id.hosts).toEqual(['override.example.com']);
	});

	it('throws on an unreadable cert so boot can disable hot-reload loudly', () => {
		expect(() => readCertIdentity(join(dir, 'nope.crt'))).toThrow();
	});
});

function recordingRegistry(throwOn) {
	const calls = { add: [], remove: [] };
	return {
		calls,
		addServerName(host, options) {
			calls.add.push({ host, options });
			if (throwOn === host) throw new Error('registry refused ' + host);
		},
		removeServerName(host) { calls.remove.push(host); }
	};
}

describeSsl()('applyServerNames', () => {
	it('leaves the registry untouched when the disk cert still matches prev', () => {
		const registry = recordingRegistry();
		const fp = readCertIdentity(certs.A.crt).fingerprint;
		const result = applyServerNames(
			registry,
			{ certPath: certs.A.crt, keyPath: certs.A.key },
			{ hosts: [], fingerprint: fp }
		);
		expect(result).toEqual({ hosts: [], fingerprint: fp, changed: false });
		expect(registry.calls.add).toEqual([]);
		expect(registry.calls.remove).toEqual([]);
	});

	it('reconciles a renewal: drops gone hosts, reloads shared ones, adds new ones', () => {
		const registry = recordingRegistry();
		const prev = readCertIdentity(certs.A.crt);
		const result = applyServerNames(
			registry,
			{ certPath: certs.B.crt, keyPath: certs.B.key },
			{ hosts: prev.hosts, fingerprint: prev.fingerprint }
		);
		expect(result.changed).toBe(true);
		expect(result.hosts).toEqual(['a.example.com', 'c.example.com']);
		// The wildcard is gone from cert B, so it must be removed; a.example.com
		// is shared and is reloaded (removed then re-added) so the renewed bytes
		// actually take effect; c.example.com is new.
		expect(registry.calls.remove).toContain('*.api.example.com');
		expect(registry.calls.remove).toContain('a.example.com');
		expect(registry.calls.add.map((c) => c.host).sort()).toEqual(['a.example.com', 'c.example.com']);
	});

	it('refuses a cert/key mismatch BEFORE touching the registry', () => {
		// The validation throw is the one that keeps TLS up: the caller still
		// holds the previous registration and the previous context. Building a
		// secure context would also reject this pair, but only DURING the
		// mutation, which is a partial swap rather than an untouched registry.
		const registry = recordingRegistry();
		expect(() => applyServerNames(
			registry,
			{ certPath: certs.A.crt, keyPath: certs.B.key },
			{ hosts: [], fingerprint: null }
		)).toThrow(/do not match/);
		expect(registry.calls.add).toEqual([]);
		expect(registry.calls.remove).toEqual([]);
	});

	it('marks a throw raised once the registry is being mutated', () => {
		const registry = recordingRegistry('c.example.com');
		let caught = null;
		try {
			applyServerNames(
				registry,
				{ certPath: certs.B.crt, keyPath: certs.B.key },
				{ hosts: [], fingerprint: null }
			);
		} catch (err) { caught = err; }
		expect(caught, 'the registry refusal must propagate').toBeTruthy();
		expect(caught.tlsAppTouched, 'a mutation-phase throw must carry the marker').toBe(true);
	});

	it('hands every host of one certificate the same options reference', () => {
		// handler/tls.js keys its SecureContext memo on this identity, so one
		// renewal must mean one read and one context for all of its hosts.
		const registry = recordingRegistry();
		applyServerNames(
			registry,
			{ certPath: certs.A.crt, keyPath: certs.A.key },
			{ hosts: [], fingerprint: null }
		);
		expect(registry.calls.add.length).toBe(2);
		expect(registry.calls.add[0].options).toBe(registry.calls.add[1].options);
		expect(registry.calls.add[0].options).toMatchObject({
			cert_file_name: certs.A.crt, key_file_name: certs.A.key
		});
	});
});

describe('createTlsDegradedLedger', () => {
	function ledgerHarness() {
		const health = { degraded: null };
		const recovered = [];
		let armed = 0;
		let disarmed = 0;
		const ledger = createTlsDegradedLedger({
			health,
			onRecovered: (was, still) => recovered.push([was, still]),
			armSentinel: () => { armed++; },
			disarmSentinel: () => { disarmed++; }
		});
		return { health, recovered, ledger, counts: () => ({ armed, disarmed }) };
	}

	it('clears a reload failure on the next success and disarms the sentinel', () => {
		// The contrast that keeps the sticky case honest: without it, making
		// EVERY degradation sticky would still pass the dead-watch case.
		const h = ledgerHarness();
		h.ledger.failed('the renewed certificate is unreadable');
		expect(h.health.degraded).toBe('the renewed certificate is unreadable');
		h.ledger.recovered();
		expect(h.health.degraded).toBeNull();
		expect(h.recovered).toEqual([['the renewed certificate is unreadable', null]]);
		expect(h.counts().disarmed).toBe(1);
	});

	it('keeps a dead watch degraded through a swap that succeeds after it', () => {
		const h = ledgerHarness();
		h.ledger.watchFailed('the watch is dead');
		h.ledger.recovered();
		// The swap worked; the watcher is still dead, so this process will not
		// see the next renewal and must not report healthy.
		expect(h.health.degraded).toBe('the watch is dead');
		expect(h.recovered).toEqual([]);
		expect(h.counts().disarmed, 'the expiry sentinel must stay armed').toBe(0);
	});

	it('supersedes a dead watch with a later swap failure, then falls back to it', () => {
		const h = ledgerHarness();
		h.ledger.watchFailed('the watch is dead');
		h.ledger.failed('the swap failed');
		expect(h.health.degraded).toBe('the swap failed');
		h.ledger.recovered();
		expect(h.health.degraded).toBe('the watch is dead');
		expect(h.recovered).toEqual([['the swap failed', 'the watch is dead']]);
		expect(h.counts().disarmed).toBe(0);
	});

	it('collapses repeated failures into one recovery', () => {
		const h = ledgerHarness();
		h.ledger.failed('first');
		h.ledger.failed('second');
		h.ledger.recovered();
		h.ledger.recovered();
		expect(h.recovered).toEqual([['second', null]]);
		expect(h.health.degraded).toBeNull();
	});
});

describe('createCertWatcher (injected clock + fs)', () => {
	function fakeTimers() {
		let seq = 0;
		const pending = new Map();
		return {
			setTimer: (cb, ms) => { const id = ++seq; pending.set(id, { cb, at: ms }); return id; },
			clearTimer: (id) => { pending.delete(id); },
			fireAll: () => { const cbs = [...pending.values()].map((p) => p.cb); pending.clear(); cbs.forEach((cb) => cb()); },
			size: () => pending.size
		};
	}

	it('coalesces a burst of fs events into a single debounced onChange', () => {
		const t = fakeTimers();
		let fsCallback;
		const watchFs = (_dir, _opts, cb) => { fsCallback = cb; return { close() {} }; };
		let reloads = 0;
		const w = createCertWatcher({ certPath: '/certs/live.crt', debounceMs: 500, onChange: () => { reloads++; }, watchFs, setTimer: t.setTimer, clearTimer: t.clearTimer });
		w.start();

		// Five rapid events - each reschedules; only the last timer survives.
		for (let i = 0; i < 5; i++) fsCallback('change', 'live.crt');
		expect(t.size()).toBe(1);
		expect(reloads).toBe(0);
		t.fireAll();
		expect(reloads).toBe(1);
		w.stop();
	});

	it('start() is idempotent and stop() clears a pending debounce timer', () => {
		const t = fakeTimers();
		let watchers = 0;
		const watchFs = () => { watchers++; return { close() {} }; };
		let reloads = 0;
		const w = createCertWatcher({ certPath: '/certs/live.crt', onChange: () => { reloads++; }, watchFs, setTimer: t.setTimer, clearTimer: t.clearTimer });
		w.start();
		w.start(); // idempotent - no second watcher
		expect(watchers).toBe(1);
		w.stop();
		expect(t.size()).toBe(0);
		expect(() => w.stop()).not.toThrow(); // safe repeat
	});

	it('surfaces a watchFs error from start() (fs.watch throws ENOENT on a missing dir) so the caller must guard it', () => {
		// Node's fs.watch throws synchronously when the watched directory is absent.
		// The watcher does not swallow it - callers (lifecycle.js, index.js primary)
		// wrap start() to degrade gracefully instead of crashing the process.
		const watchFs = () => { const e = new Error("ENOENT: no such file or directory, watch '/no/such/dir'"); e.code = 'ENOENT'; throw e; };
		const w = createCertWatcher({ certPath: '/no/such/dir/live.crt', onChange: () => {}, watchFs });
		expect(() => w.start()).toThrow(/ENOENT/);
	});

	it("a post-arm watcher 'error' closes the watcher and reaches onError instead of the process", () => {
		// An FSWatcher can error AFTER arming (directory removed by a renewal's
		// symlink swap, EPERM on teardown). With no 'error' listener node throws
		// from the emitter and the primary - and every worker thread - dies over
		// a lost watch. The watcher must consume the event, close itself, and
		// hand the error to the caller's degraded-state reporting.
		const handlers = new Map();
		let closed = 0;
		const fakeWatcher = {
			on(event, cb) { handlers.set(event, cb); },
			close() { closed++; }
		};
		const watchFs = () => fakeWatcher;
		const errors = [];
		const w = createCertWatcher({ certPath: '/certs/live.crt', onChange: () => {}, onError: (err) => { errors.push(err); }, watchFs });
		w.start();
		expect(handlers.has('error')).toBe(true);

		const boom = Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' });
		expect(() => handlers.get('error')(boom)).not.toThrow();
		expect(errors).toEqual([boom]);
		expect(closed).toBe(1);
		// The dead watcher is forgotten: stop() does not double-close it, and a
		// fresh start() may arm a replacement.
		w.stop();
		expect(closed).toBe(1);
	});
});

// The cluster-primary reload action: an UNCONDITIONAL broadcast to every worker
// (each worker fingerprint-gates its own apply), plus an observability refresh
// of the primary's view of the disk cert. The primary terminates no TLS, so no
// app is ever touched here. The broadcast paths need no certs; the identity
// refresh uses a real cert (openssl-gated).
function mockWorker() {
	const posted = [];
	return { posted, postMessage(msg) { posted.push(msg); } };
}

describe('reloadClusterTls (cluster broadcast)', () => {
	it('broadcasts {type:tls-reload} to every worker (no source to read)', () => {
		const workers = [mockWorker(), mockWorker(), mockWorker()];
		const state = reloadClusterTls({ workers, state: { hosts: ['prev.example.com'], fingerprint: 'AA:BB' } });
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
		// No source -> the primary's cert-identity state is returned unchanged.
		expect(state).toEqual({ hosts: ['prev.example.com'], fingerprint: 'AA:BB' });
	});

	it('does not let one exiting worker (postMessage throws) stop the broadcast', () => {
		const good1 = mockWorker();
		const bad = { postMessage() { throw new Error('worker exiting'); } };
		const good2 = mockWorker();
		expect(() => reloadClusterTls({ workers: [good1, bad, good2] })).not.toThrow();
		expect(good1.posted).toEqual([{ type: 'tls-reload' }]);
		expect(good2.posted).toEqual([{ type: 'tls-reload' }]);
	});

	it('reports an unreadable cert via onError but still broadcasts and keeps the prior state', () => {
		const workers = [mockWorker()];
		let errored = null;
		const state = reloadClusterTls({
			workers,
			source: { certPath: '/no/such/cert.crt' },
			state: { hosts: ['kept.example.com'], fingerprint: 'AA:BB' },
			onError: (err) => { errored = err; }
		});
		expect(errored).toBeTruthy(); // onError fired with the thrown cert-read error
		expect(String(errored.message || errored)).toMatch(/ENOENT|no such file/);
		expect(state).toEqual({ hosts: ['kept.example.com'], fingerprint: 'AA:BB' }); // read threw -> prior state kept
		expect(workers[0].posted).toEqual([{ type: 'tls-reload' }]); // workers still notified
	});
});

describeSsl()('reloadClusterTls (identity refresh with a real cert)', () => {
	it('refreshes the primary state from the disk cert and broadcasts to workers', () => {
		const workers = [mockWorker(), mockWorker()];
		const state = reloadClusterTls({
			workers,
			source: { certPath: certs.A.crt },
			state: { hosts: [], fingerprint: null }
		});
		// The primary now reflects the cert on disk...
		expect(state.hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(state.fingerprint).toBe(readCertIdentity(certs.A.crt).fingerprint);
		// ...and every worker was told to reload its own context.
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
	});
});
