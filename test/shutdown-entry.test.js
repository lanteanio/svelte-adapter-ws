// The server entry's shutdown sequence, driven as a child process the way an
// orchestrator drives it. Properties only the entry can show, because they
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
//     it is;
//   - a request still in flight has its signal aborted before the process
//     exits, also when the sequence threw ahead of the drain that aborts it,
//     and when fatal() or an uncaught exception ends a worker.
//
// Windows does not deliver SIGTERM to a Node child, so a wrapper re-emits the
// event on the child's own process object from a line on stdin; everything
// downstream of that is production code either way.

import { spawn } from 'node:child_process';
import { readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';
import { expectStatement, expectStatementBlockCount } from './helpers/source-pins.js';

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
 * @param {{ cleanupMs?: number, cleanupLog?: boolean, breakIdleClose?: boolean, markSignals?: boolean }} [opts]
 */
function writeWrapper(dir, opts = {}) {
	const file = path.join(dir, 'entry.mjs');
	writeFileSync(file, [
		// A broken global of the kind instrumentation layers leave behind: the
		// listener's idle-connection close throws, which the shutdown sequence
		// meets after the listener stops accepting and before its drain.
		opts.breakIdleClose
			? "(await import('node:http')).default.Server.prototype.closeIdleConnections = function () { throw new Error('__CLOSE_IDLE_THREW__'); };"
			: '',
		opts.cleanupMs
			? `process.on('sveltekit:shutdown', () => new Promise((r) => setTimeout(r, ${opts.cleanupMs})));`
			: '',
		// A listener that announces itself, so the test can read where in the
		// shutdown it ran relative to the request still in flight.
		opts.cleanupLog
			? "process.on('sveltekit:shutdown', () => { console.log('CLEANUP RAN'); });"
			: '',
		// A marker for every stop signal the process receives, with how many
		// listeners were added after it, which only the runtime does, so a case
		// can count the signals and see that the runtime's own listener was there
		// for each. Opt-in: on POSIX a listener replaces node's default
		// disposition.
		opts.markSignals ? "for (const signal of ['SIGTERM', 'SIGINT']) { process.on(signal, () => { console.log('[wrapper] ' + signal + ' added=' + (process.listenerCount(signal) - base)); }); const base = process.listenerCount(signal); }" : '',
		// One signal per line, however the lines arrive.
		"process.stdin.on('data', (d) => { for (const line of String(d).split('\\n')) { if (line.includes('shutdown')) process.emit('SIGTERM'); if (line.includes('interrupt')) process.emit('SIGINT'); } });",
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
	it('runs the cleanup listeners only after the in-flight requests have drained', async () => {
		// A listener that closes a pool must not pull it out from under a request
		// still being served: the drain settles first, then the listeners run.
		// Both edges are read off the server's own output, so the order is a
		// fact of the process, not of a delay.
		const payload = buildRuntime();
		cleanups.push(() => payload.cleanup());
		linkPackages(payload);
		const entry = writeWrapper(payload.dir, { cleanupLog: true });
		const port = await freePort();
		const { proc, output, ready } = startEntry(entry, { PORT: String(port), SHUTDOWN_TIMEOUT: '10' }, (text) => text.includes('Ready for traffic'));
		expect(await ready, 'the entry never came up: ' + output.text).toBe(true);

		const held = new Promise((resolve) => {
			const req = http.get({ host: '127.0.0.1', port, path: '/api/hold?ms=1500' }, (res) => {
				let body = '';
				res.on('data', (d) => { body += d; });
				res.on('end', () => resolve(body));
			});
			req.on('error', () => resolve('reset'));
		});
		const t0 = Date.now();
		while (!output.text.includes('[hold] holding') && Date.now() - t0 < 10000) await sleep(25);
		expect(output.text, 'the held request never reached the server').toContain('[hold] holding');

		requestShutdown(proc);
		expect(await whenExited(proc, 30000)).toBe(0);
		expect(await held, 'the held request must be answered, not dropped').toBe('held');

		const released = output.text.indexOf('[hold] released');
		const cleanup = output.text.indexOf('CLEANUP RAN');
		expect(released, 'the hold never released').toBeGreaterThan(-1);
		expect(cleanup, 'the cleanup listener never ran').toBeGreaterThan(-1);
		expect(cleanup, 'a cleanup listener ran while a request was still in flight').toBeGreaterThan(released);
	}, 60000);

	it('aborts what is still in flight when the sequence itself throws ahead of the drain', async () => {
		// The drain is where shutdown tells a request it is about to be dropped.
		// A throw ahead of it skips that, and the exit still owes the request
		// its signal.
		const payload = buildRuntime();
		cleanups.push(() => payload.cleanup());
		linkPackages(payload);
		const entry = writeWrapper(payload.dir, { breakIdleClose: true });
		const port = await freePort();
		const { proc, output, ready } = startEntry(entry, { PORT: String(port), SHUTDOWN_TIMEOUT: '10' }, (text) => text.includes('Ready for traffic'));
		expect(await ready, 'the entry never came up: ' + output.text).toBe(true);
		const closed = new Promise((resolve) => proc.once('close', resolve));

		http.get({ host: '127.0.0.1', port, path: '/api/hold?ms=20000' }).on('error', () => { /* dropped by the exit */ });
		const t0 = Date.now();
		while (!output.text.includes('[hold] holding') && Date.now() - t0 < 10000) await sleep(25);
		expect(output.text, 'the held request never reached the server').toContain('[hold] holding');

		requestShutdown(proc);
		expect(await whenExited(proc, 30000)).toBe(0);
		await closed;
		expect(output.text, 'the sequence threw').toContain('__CLOSE_IDLE_THREW__');
		expect(output.text).toContain('[hold] aborted: The server shut down before the request finished');
		expect(output.text).not.toContain('[hold] released');
	}, 60000);

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
		// A second signal during boot changes nothing: the first is the one
		// reported, and the boot is not dispatched twice. Sent apart: POSIX
		// delivers two pending signals lowest number first, SIGINT ahead of
		// SIGTERM.
		await sleep(50);
		if (process.platform === 'win32') proc.stdin.write('interrupt\n');
		else proc.kill('SIGINT');

		const code = await whenExited(proc, 20000);
		expect(code, `the entry did not exit cleanly.\n--- server output ---\n${output.text}`).toBe(0);
		expect(output.text).toContain('SERVER MODULE EVALUATED');
		// The drain was announced once the state existed, and the boot that
		// completed underneath the signal never announced the instance ready.
		expect(output.text).toContain('Readiness now reports NOT ready (draining)');
		expect(output.text, 'a condemned boot announced itself ready').not.toContain('Ready for traffic');
		expect(output.text).toContain('Received SIGTERM, shutting down gracefully');
		expect(output.text, 'the second boot signal replaced the first').not.toContain('Received SIGINT');
		expect(output.text).toContain('Shutdown complete');
	}, 60000);

	it('lets a second stop signal change nothing about the shutdown already running', async () => {
		const payload = buildRuntime();
		cleanups.push(() => payload.cleanup());
		linkPackages(payload);
		const entry = writeWrapper(payload.dir, { cleanupLog: true, markSignals: true });
		const port = await freePort();
		const { proc, output, ready } = startEntry(entry, { PORT: String(port), SHUTDOWN_TIMEOUT: '10' }, (text) => text.includes('Ready for traffic'));
		expect(await ready, 'the entry never came up: ' + output.text).toBe(true);

		const held = new Promise((resolve) => {
			const req = http.get({ host: '127.0.0.1', port, path: '/api/hold?ms=1500' }, (res) => {
				let body = '';
				res.on('data', (d) => { body += d; });
				res.on('end', () => resolve(body));
			});
			req.on('error', () => resolve('reset'));
		});
		const t0 = Date.now();
		while (!output.text.includes('[hold] holding') && Date.now() - t0 < 10000) await sleep(25);
		expect(output.text, 'the held request never reached the server').toContain('[hold] holding');

		// The same signal again, then the other one: a listener taken off after
		// its first signal shows on the repeat, one that treats SIGINT apart on
		// the last.
		const exited = whenExited(proc, 30000);
		requestShutdown(proc);
		await sleep(200);
		requestShutdown(proc);
		await sleep(200);
		if (process.platform === 'win32') proc.stdin.write('interrupt\n');
		else proc.kill('SIGINT');
		expect(await exited).toBe(0);
		expect(await held, 'the held request is answered').toBe('held');
		/** @param {RegExp} pattern */
		const count = (pattern) => (output.text.match(pattern) || []).length;
		const marks = [...output.text.matchAll(/\[wrapper\] (SIGTERM|SIGINT) added=(\d+)/g)];
		expect(marks.map((mark) => mark[1]), 'every signal arrived, in order').toEqual(['SIGTERM', 'SIGTERM', 'SIGINT']);
		expect(marks.map((mark) => Number(mark[2]) >= 1), 'the runtime still listens').toEqual([true, true, true]);
		expect(count(/Received SIGTERM, shutting down gracefully/g), 'one shutdown ran').toBe(1);
		expect(output.text, 'the SIGINT started nothing').not.toContain('Received SIGINT');
		expect(count(/CLEANUP RAN/g), 'the cleanup listeners ran once').toBe(1);
		expect(output.text, 'the held request was not cut off').not.toContain('[hold] aborted');
	}, 60000);

	it('bounds the hook and the cleanup listeners by ONE budget', async () => {
		// The ws shutdown hook spends 1000ms of a 2000ms budget; the cleanup
		// listener needs 1800ms more. Under one budget the listener is cut at
		// the 2000ms mark and reported; under a fresh allowance it would finish
		// at 2800ms with nothing reported.
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: [
				'export async function shutdown() {',
				'	await new Promise((r) => setTimeout(r, 1000));',
				"	console.log('WS HOOK DONE');",
				'}',
				''
			].join('\n')
		});
		linkPackages(payload);
		const entry = writeWrapper(payload.dir, { cleanupMs: 1800 });
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

// The cluster primary and its workers run only under CLUSTER_WORKERS, which
// needs Linux, so what they install is pinned from source here.
const entrySource = readFileSync(fileURLToPath(new URL('../src/runtime/index.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('a cluster primary under a second stop signal', () => {
	const source = entrySource;

	it('hands every stop signal to the one graceful shutdown', () => {
		// The signal handler starts with the hand-off, so a signal during a
		// shutdown already running reaches graceful_shutdown's own guard and
		// nothing else.
		const opening = '\tconst onPrimarySignal = (reason) => {\n';
		const start = source.indexOf(opening);
		expect(start, 'the primary has no signal handler').toBeGreaterThan(-1);
		const end = source.indexOf('\n\t};\n', start);
		expect(end, 'the handler has no end').toBeGreaterThan(start);
		const code = source.slice(start + opening.length, end).split('\n')
			.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'));
		expect(code[0]).toBe('if (primary_booted) { graceful_shutdown(reason); return; }');
		const guard = source.indexOf('\tasync function graceful_shutdown(reason) {\n\t\tif (shutting_down) return;\n\t\tshutting_down = true;\n');
		expect(guard, 'graceful_shutdown returns when one is already running').toBeGreaterThan(-1);
	});
});

describe('a worker that fatal() or an uncaught exception ends', () => {
	const source = entrySource;

	it('aborts what is still in flight before fatal() exits', () => {
		const start = source.indexOf('\t\tsetFatalSink({\n');
		expect(start, 'the worker installs no fatal sink').toBeGreaterThan(-1);
		const close = '\n\t\t});';
		const end = source.indexOf(close, start);
		expect(end, 'the sink has no end').toBeGreaterThan(start);
		expectStatementBlockCount(source.slice(start, end + close.length), ['abortInFlightRequests();', 'process.exit(code);'], 1,
			'the sink aborts the requests in flight, then exits');
	});

	it('aborts what is still in flight on an uncaught exception no application handler keeps', () => {
		const opening = "\t\tprocess.on('uncaughtExceptionMonitor', () => {\n";
		const start = source.indexOf(opening);
		expect(start, 'the worker watches no uncaught exception').toBeGreaterThan(-1);
		const close = '\n\t\t});';
		const end = source.indexOf(close, start);
		expect(end, 'the monitor has no end').toBeGreaterThan(start);
		expectStatement(source.slice(start, end + close.length),
			"if (process.listenerCount('uncaughtException') === 0) abortInFlightRequests();",
			'the monitor aborts the requests in flight when nothing keeps the worker');
	});
});
