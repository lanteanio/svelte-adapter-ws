import fs, { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function certificateFiles() {
	const dir = mkdtempSync(path.join(tmpdir(), 'saw-tls-paths-'));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const certDir = path.join(dir, 'certificates');
	const keyDir = path.join(dir, 'private-keys');
	mkdirSync(certDir); mkdirSync(keyDir);
	const cert = path.join(certDir, 'server,active.pem');
	const key = path.join(keyDir, 'server,active.key');
	copyFileSync(path.join(fixtures, 'localhost.crt'), cert);
	copyFileSync(path.join(fixtures, 'localhost.key'), key);
	return { dir, certDir, keyDir, cert, key };
}

it('the primary reads literal comma-containing certificate paths and watches only its directory', async () => {
	const files = certificateFiles();
	const payload = buildRuntime();
	cleanup.push(() => payload.cleanup());
	const runner = path.join(payload.dir, 'primary-tls-probe.mjs');
	// The primary runs unchanged. Worker transport and fs.watch are observable
	// seams, so this test also runs where reuseport itself is unavailable.
	writeFileSync(runner, `
	import { createRequire, syncBuiltinESMExports } from 'node:module';
	import { EventEmitter } from 'node:events';
	const require = createRequire(import.meta.url);
	const fs = require('node:fs');
	const threads = require('node:worker_threads');
	const reads = [], watches = [], messages = [];
	const cert = ${JSON.stringify(files.cert)};
	const originalRead = fs.readFileSync;
	fs.readFileSync = function(file, ...args) {
		if (typeof file === 'string' && file.startsWith(${JSON.stringify(files.certDir)})) reads.push(file);
		return originalRead.call(this, file, ...args);
	};
	fs.watch = (dir, options, changed) => {
		const watcher = new EventEmitter(); watcher.close = () => {};
		watches.push({ dir, changed }); return watcher;
	};
	threads.Worker = class extends EventEmitter {
		constructor() { super(); this.threadId = 1; }
		postMessage(message) {
			messages.push(message.type);
			if (message.type === 'tls-reload') {
				console.log('TLS_PRIMARY_PROBE ' + JSON.stringify({ reads, watches: watches.map(w => w.dir), messages }));
				process.exit(0);
			}
		}
		terminate() { return Promise.resolve(0); }
	};
	Object.defineProperty(process, 'platform', { value: 'linux' });
	syncBuiltinESMExports();
	await import('./index.js');
	fs.writeFileSync(cert, originalRead(${JSON.stringify(path.join(fixtures, 'sni.crt'))}));
	for (const watcher of watches) watcher.changed('change', 'server,active.pem');
	setTimeout(() => { console.error('No renewal broadcast'); process.exit(2); }, 1000);
	`);
	const env = { ...process.env, CLUSTER_WORKERS: '1', CLUSTER_MODE: 'reuseport', PORT: '43001',
		SSL_CERT: files.cert, SSL_KEY: files.key, SSL_WATCH: '1', SSL_RELOAD_DEBOUNCE_MS: '0', SSL_SNI_HOSTS: ' Alias.Example ' };
	delete env.VITEST; delete env.NOTIFY_SOCKET;
	const { stdout, stderr } = await run(process.execPath, [runner], { env, timeout: 10000 });
	const line = stdout.split(/\r?\n/).find(line => line.startsWith('TLS_PRIMARY_PROBE '));
	expect(line, stdout + stderr).toBeDefined();
	const observed = JSON.parse(line.slice('TLS_PRIMARY_PROBE '.length));
	expect(observed.reads).toEqual([files.cert, files.cert]);
	expect(observed.watches).toEqual([files.certDir]);
	expect(observed.messages.filter(type => type === 'tls-reload')).toHaveLength(1);
	expect(stdout.match(/\[tls\] primary watching /g)).toHaveLength(1);
	expect(stderr).not.toMatch(/ADAPTER-ERR-TLS-PRIMARY-(?:BOOT|RELOAD)-READ/);
});

it('single-process TLS watches the certificate directory when its key is elsewhere', async () => {
	const files = certificateFiles();
	const watched = [];
	const watcher = new EventEmitter(); watcher.close = vi.fn();
	const watch = vi.spyOn(fs, 'watch').mockImplementation(dir => { watched.push(String(dir)); return watcher; });
	cleanup.push(() => watch.mockRestore());
	const prefix = 'TLS_DIRECTORY_SCOPE_';
	for (const [name, value] of Object.entries({ SSL_CERT: files.cert, SSL_KEY: files.key, SSL_WATCH: '1' })) process.env[prefix + name] = value;
	cleanup.push(() => { for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name]; });
	const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
	cleanup.push(() => payload.cleanup());
	const runtime = await bootRuntime(payload);
	cleanup.push(() => runtime.close());
	expect(watched).toEqual([files.certDir]);
	expect(runtime.handler.tlsReloadState().watching).toBe(true);
	await runtime.close();
	expect(watcher.close).toHaveBeenCalledTimes(1);
});