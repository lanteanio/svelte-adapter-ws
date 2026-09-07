// The server entry's shutdown sequence, driven as a child process the way an
// orchestrator drives it. Two properties only the entry can show, because both
// live in src/runtime/index.js and only run as a process:
//
//   - a stop signal that lands while the server module is still EVALUATING
//     leaves the rotation before boot can announce readiness. The handler
//     module is most of boot, so this is the longer half of the window, and
//     a signal handler that flips readiness through a handler reference sees
//     nothing there yet;
//   - SHUTDOWN_TIMEOUT bounds the hook and the cleanup listeners TOGETHER. A
//     hook that spends most of it leaves the listeners the remainder, not a
//     fresh allowance, so the process is down when the operator's number says
//     it is.
//
// Windows does not deliver SIGTERM to a Node child, so a wrapper re-emits the
// event on the child's own process object from a line on stdin; everything
// downstream of that is production code either way.

import { spawn } from 'node:child_process';
import { rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

/** @type {Array<() => void>} */
const cleanups = [];

// The payload lives under the temp directory, where a spawned process cannot
// resolve the runtime's packages; a link back to the repo's node_modules is
// enough. Removed as a LINK before the payload is deleted, so nothing ever
// deletes through it into the real packages.
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));

/** @param {{ dir: string, cleanup: () => void }} payload */
function linkPackages(payload) {
	const link = path.join(payload.dir, 'node_modules');
	symlinkSync(repoNodeModules, link, process.platform === 'win32' ? 'junction' : 'dir');
	cleanups.push(() => {
		try { rmdirSync(link); } catch { /* already gone */ }
		payload.cleanup();
	});
}
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

afterEach(() => {
	if (child && !child.killed) {
		try { child.kill('SIGKILL'); } catch { /* already gone */ }
	}
	child = null;
	for (const fn of cleanups.splice(0)) fn();
});

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS_OPTS = {
	adminPath: '/__realtime',
	adminAuthAcknowledged: true,
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false
};

/**
 * A wrapper entry: installs the cleanup listener the case asks for, arms the
 * stdin re-emit, then imports the payload's real entry.
 * @param {string} dir
 * @param {{ cleanupMs?: number }} [opts]
 */
function writeWrapper(dir, opts = {}) {
	const file = path.join(dir, 'entry.mjs');
	writeFileSync(file, [
		opts.cleanupMs
			? `process.on('sveltekit:shutdown', () => new Promise((r) => setTimeout(r, ${opts.cleanupMs})));`
			: '',
		"process.stdin.on('data', (d) => { if (String(d).includes('shutdown')) process.emit('SIGTERM'); });",
		'process.stdin.unref();',
		`await import(${JSON.stringify(pathToFileURL(path.join(dir, 'index.js')).href)});`,
		''
	].join('\n'));
	return file;
}

/**
 * @param {string} entry
 * @param {Record<string, string>} env
 * @param {(text: string) => boolean} until resolve once the output satisfies this
 */
function startEntry(entry, env, until) {
	const output = { text: '' };
	const proc = spawn(process.execPath, [entry], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: (() => {
			const merged = { ...process.env, HOST: '127.0.0.1', ...env };
			for (const key of ['CLUSTER_WORKERS', 'CLUSTER_MODE', 'SSL_CERT', 'SSL_KEY', 'SHUTDOWN_DELAY_MS', 'SHUTDOWN_TIMEOUT']) {
				if (!(key in env)) delete merged[key];
			}
			return merged;
		})()
	});
	child = proc;
	const ready = new Promise((resolve) => {
		const scan = (buf) => {
			output.text += buf.toString();
			if (until(output.text)) resolve(true);
		};
		proc.stdout.on('data', scan);
		proc.stderr.on('data', scan);
		proc.on('exit', () => resolve(false));
		setTimeout(() => resolve(false), 20000);
	});
	return { proc, output, ready };
}

function requestShutdown(proc) {
	if (process.platform === 'win32') proc.stdin.write('shutdown\n');
	else proc.kill('SIGTERM');
}

function whenExited(proc, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		proc.on('exit', (code, signal) => {
			clearTimeout(timer);
			resolve(code === null && signal ? `killed:${signal}` : (code ?? 0));
		});
	});
}

describe('the entry under a stop signal', () => {
	it('leaves the rotation on a signal that lands while the server module is still evaluating', async () => {
		// The server bundle takes 1500ms to evaluate; the signal lands at 300ms,
		// before the handler module - and with it the lifecycle state - exists.
		const SLOW_SERVER = `
await new Promise((r) => setTimeout(r, 1500));
console.log('SERVER MODULE EVALUATED');
export class Server {
	constructor(manifest) {}
	async init(opts) {}
	async respond(request) { return new Response('SSR', { headers: { 'content-type': 'text/html' } }); }
}
`;
		const payload = buildRuntime({ serverSource: SLOW_SERVER });
		linkPackages(payload);
		const entry = writeWrapper(payload.dir);
		const port = await freePort();
		const { proc, output } = startEntry(entry, { PORT: String(port), SHUTDOWN_TIMEOUT: '5' }, () => false);

		await sleep(300);
		expect(output.text, 'the signal must land before the server module evaluated').not.toContain('SERVER MODULE EVALUATED');
		requestShutdown(proc);

		const code = await whenExited(proc, 20000);
		expect(code, `the entry did not exit cleanly.\n--- server output ---\n${output.text}`).toBe(0);
		expect(output.text).toContain('SERVER MODULE EVALUATED');
		// The drain was announced once the state existed, and the boot that
		// completed underneath the signal never announced the instance ready.
		expect(output.text).toContain('Readiness now reports NOT ready (draining)');
		expect(output.text, 'a condemned boot announced itself ready').not.toContain('Ready for traffic');
		expect(output.text).toContain('Shutdown complete');
	}, 60000);

	it('bounds the hook and the cleanup listeners by ONE budget', async () => {
		// The ws shutdown hook spends 1500ms of a 2000ms budget; the cleanup
		// listener needs 1000ms more. Under one budget the listener is cut at
		// the 2000ms mark and reported; under a fresh allowance it would finish
		// at 2500ms with nothing reported.
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: [
				'export async function shutdown() {',
				'	await new Promise((r) => setTimeout(r, 1500));',
				"	console.log('WS HOOK DONE');",
				'}',
				''
			].join('\n')
		});
		linkPackages(payload);
		const entry = writeWrapper(payload.dir, { cleanupMs: 1000 });
		const port = await freePort();
		const { proc, output, ready } = startEntry(entry, { PORT: String(port), SHUTDOWN_TIMEOUT: '2' }, (t) => t.includes('Ready for traffic'));
		expect(await ready, `server never became ready.\n--- server output ---\n${output.text}`).toBe(true);

		const t0 = Date.now();
		requestShutdown(proc);
		const code = await whenExited(proc, 20000);
		const elapsed = Date.now() - t0;

		expect(code, `the entry did not exit cleanly.\n--- server output ---\n${output.text}`).toBe(0);
		expect(output.text).toContain('WS HOOK DONE');
		// Cut at the budget, not at hook + listener.
		expect(output.text).toContain('[ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED]');
		expect(output.text).toContain('was NOT clean');
		expect(elapsed).toBeGreaterThanOrEqual(1900);
		expect(elapsed, 'the listeners were handed a budget of their own').toBeLessThan(2450);
	}, 60000);
});
