// The cluster primary end to end: configuration refusals exit before any
// worker spawns (catalog-indexed console lines, status 1), and on Linux a
// real reuseport fleet boots, serves HTTP from every worker, relays publishes
// across workers, and shuts down cleanly on SIGTERM. The refusal cases run on
// every platform; the live fleet needs SO_REUSEPORT accept distribution, so
// it runs where the runtime itself does (Linux).

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

const onLinux = process.platform === 'linux';

/** @type {Array<() => void | Promise<void>>} */
const cleanups = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/**
 * Run the payload's process entry as a child with the given env.
 *
 * @param {Record<string, string>} env
 * @param {{ replace?: Record<string, string>, wsHandlerSource?: string, primaryInitSource?: string }} [build]
 */
function spawnPayload(env, build = {}) {
	const payload = buildRuntime(build);
	const proc = spawn(process.execPath, [path.join(payload.dir, 'index.js')], {
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	proc.stdout.on('data', (c) => { stdout += c; });
	proc.stderr.on('data', (c) => { stderr += c; });
	const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
	const handle = {
		proc,
		exited,
		out: () => stdout,
		err: () => stderr,
		/** Wait until the combined output matches, or time out. */
		waitFor: (pattern, timeoutMs = 15000) => new Promise((resolve, reject) => {
			const t0 = Date.now();
			const poll = () => {
				const all = stdout + stderr;
				if (pattern.test(all)) { resolve(all); return; }
				if (Date.now() - t0 > timeoutMs) { reject(new Error('timeout waiting for ' + pattern + '\n--- output ---\n' + all)); return; }
				setTimeout(poll, 50);
			};
			poll();
		})
	};
	cleanups.push(async () => {
		if (proc.exitCode === null) {
			proc.kill('SIGKILL');
			await exited;
		}
		payload.cleanup();
	});
	return handle;
}

/** A free TCP port the fleet can bind with a fixed number. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const p = /** @type {net.AddressInfo} */ (probe.address()).port;
			probe.close(() => resolve(p));
		});
	});
}

describe('cluster configuration refusals', () => {
	it("refuses a CLUSTER_WORKERS token that is not a positive integer or 'auto'", async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '3workers' });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain("Invalid CLUSTER_WORKERS value: '3workers'");
		expect(run.err()).toContain('ADAPTER-ERR-CLUSTER-CONFIG-WORKERS');
	});

	it('refuses a fractional CLUSTER_WORKERS before any worker spawns', async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '2.5' });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain("Invalid CLUSTER_WORKERS value: '2.5'");
		// The refusal is pre-spawn: no worker line ever printed.
		expect(run.out()).not.toContain('Worker thread');
	});

	it('refuses a compute count that leaves no I/O worker', async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '2' }, { replace: { WORKERS_CONFIG: JSON.stringify({ compute: 2 }) } });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain('websocket.workers.compute (2) must be less than the total worker count (2)');
		expect(run.err()).toContain('ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE');
	});

	it('refuses CLUSTER_MODE=acceptor with the reason it cannot exist here', async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '2', CLUSTER_MODE: 'acceptor' });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain('CLUSTER_MODE=acceptor is not available on this runtime');
		expect(run.err()).toContain('ADAPTER-ERR-CLUSTER-CONFIG-ACCEPTOR');
	});

	it('refuses an unknown CLUSTER_MODE', async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '2', CLUSTER_MODE: 'roundrobin' });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain("Invalid CLUSTER_MODE: 'roundrobin'");
		expect(run.err()).toContain('ADAPTER-ERR-CLUSTER-CONFIG-MODE');
	});

	it.skipIf(onLinux)('refuses CLUSTER_WORKERS off Linux, where SO_REUSEPORT cannot distribute accepts', async () => {
		const run = spawnPayload({ CLUSTER_WORKERS: '2' });
		expect(await run.exited).toBe(1);
		expect(run.err()).toContain('CLUSTER_WORKERS requires Linux');
		expect(run.err()).toContain('ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT');
	});
});

// The WS handler every fleet test ships: publishes on command and answers
// which worker thread a socket landed on, so a test can prove cross-worker
// delivery instead of hoping the kernel spread its connections.
const FLEET_WS_HANDLER = `
import { threadId } from 'node:worker_threads';
export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'whoami') {
		platform.send(ws, 'sys', 'tid', threadId);
	} else if (cmd.cmd === 'publish') {
		platform.publish(cmd.topic, cmd.event, cmd.data, { seq: false });
	}
}
`;

const FLEET_WS_OPTS = {
	allowedOrigins: '*',
	upgradeRateLimit: 0,
	authPathRateLimit: 0
};

describe.skipIf(!onLinux)('cluster fleet (reuseport)', () => {
	it('boots the fleet, relays a publish to a subscriber on another worker, and drains on SIGTERM', async () => {
		const port = await freePort();
		const run = spawnPayload(
			{ CLUSTER_WORKERS: '2', HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT: '10' },
			{
				replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(FLEET_WS_OPTS) },
				wsHandlerSource: FLEET_WS_HANDLER
			}
		);
		await run.waitFor(/Primary thread starting 2 workers \(2 io, reuseport mode\)/);
		await run.waitFor(/listening on :\d+[\s\S]*listening on :\d+/, 30000);

		// Collect connections until two distinct workers hold at least one
		// each. SO_REUSEPORT hashes the 4-tuple, so a few dozen distinct
		// source ports cover both listeners.
		/** @type {Map<number, any>} */
		const byWorker = new Map();
		const all = [];
		for (let i = 0; i < 64 && byWorker.size < 2; i++) {
			const client = await fleetClient(port);
			all.push(client);
			client.send({ cmd: 'whoami' });
			const tid = (await client.next((f) => f.json?.event === 'tid')).json.data;
			if (!byWorker.has(tid)) byWorker.set(tid, client);
		}
		expect(byWorker.size).toBe(2);

		const [a, b] = [...byWorker.values()];
		await subscribe(a, 'fleet.room');
		await subscribe(b, 'fleet.room');
		// Publish FROM a's worker; b lives on the other worker, so its copy
		// can only have crossed the relay.
		a.send({ cmd: 'publish', topic: 'fleet.room', event: 'hello', data: { x: 1 } });
		const atA = await a.next((f) => f.json?.event === 'hello');
		const atB = await b.next((f) => f.json?.event === 'hello');
		expect(atA.json.data).toEqual({ x: 1 });
		expect(atB.json.data).toEqual({ x: 1 });

		for (const client of all) client.ws.close();
		run.proc.kill('SIGTERM');
		await run.waitFor(/Primary received SIGTERM, shutting down 2 workers/);
		expect(await run.exited).toBe(0);
	}, 60000);

	it('runs a compute worker without a listen socket and replays primaryInit output to it', async () => {
		const port = await freePort();
		const run = spawnPayload(
			{ CLUSTER_WORKERS: '2', HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT: '10' },
			{
				replace: {
					WS_ENABLED: JSON.stringify(true),
					WS_OPTIONS: JSON.stringify(FLEET_WS_OPTS),
					WORKERS_CONFIG: JSON.stringify({ compute: 1 })
				},
				primaryInitSource: 'export default function primaryInit() { console.log("primary-init-ran"); return { shared: new SharedArrayBuffer(8) }; }\n',
				wsHandlerSource: `
export function init({ platform, workerData }) {
	console.log('worker-init shared=' + (workerData && workerData.shared instanceof SharedArrayBuffer));
}
`
			}
		);
		await run.waitFor(/Primary thread starting 2 workers \(1 io, 1 compute, reuseport mode\)/);
		await run.waitFor(/Compute worker \d+ ready/, 30000);
		await run.waitFor(/listening on :\d+/, 30000);
		// primaryInit ran exactly once, on the primary; each worker's init saw
		// the identical SharedArrayBuffer it returned.
		const out = run.out();
		expect(out.match(/primary-init-ran/g)).toHaveLength(1);
		expect(out.match(/worker-init shared=true/g)).toHaveLength(2);

		run.proc.kill('SIGTERM');
		expect(await run.exited).toBe(0);
	}, 60000);

	it('respawns a crashed worker into the same slot', async () => {
		const port = await freePort();
		const run = spawnPayload(
			{ CLUSTER_WORKERS: '2', HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT: '10' },
			{
				replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(FLEET_WS_OPTS) },
				wsHandlerSource: `
export async function message(ws, { data }) {
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'crash') process.exit(3);
}
`
			}
		);
		await run.waitFor(/listening on :\d+[\s\S]*listening on :\d+/, 30000);
		const client = await fleetClient(port);
		client.send({ cmd: 'crash' });
		await run.waitFor(/exited with code 3, restarting in \d+ms/, 15000);
		// The replacement comes up listening again.
		await run.waitFor(/listening on :\d+[\s\S]*listening on :\d+[\s\S]*listening on :\d+/, 30000);
		client.ws.close();
		run.proc.kill('SIGTERM');
		expect(await run.exited).toBe(0);
	}, 60000);
});

/** Open one WS client against the fleet port. */
async function fleetClient(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw) => {
		let frame;
		try { frame = { json: JSON.parse(raw.toString()), raw: raw.toString() }; } catch { frame = { raw: raw.toString() }; }
		frames.push(frame);
		for (const waiter of waiters.splice(0)) waiter(frame);
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	return {
		ws,
		frames,
		send: (obj) => ws.send(JSON.stringify(obj)),
		next: (match) => new Promise((resolve, reject) => {
			const existing = frames.find(match);
			if (existing) { resolve(existing); return; }
			const timer = setTimeout(() => reject(new Error('frame timeout: ' + JSON.stringify(frames))), 5000);
			const check = (frame) => {
				if (match(frame)) { clearTimeout(timer); resolve(frame); }
				else waiters.push(check);
			};
			waiters.push(check);
		})
	};
}

/** Subscribe and await the ack. */
async function subscribe(client, topic) {
	client.send({ type: 'subscribe', topic, ref: 1 });
	await client.next((f) => f.json?.type === 'subscribed' && f.json?.topic === topic);
}
