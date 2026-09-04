// A handler module can be started again after it has been shut down.
//
// The drain latches and the lifecycle state are per-LIFECYCLE, but both were
// module-scope and neither was ever cleared. So a second `start()` on the same
// module instance ran against a state left at 'closed': `isDraining()` is
// `state !== 'ready'`, and the realtime upgrade path refuses while draining, so
// the second boot bound a port and then answered every WebSocket upgrade with
// 503. A third called `listen()` on a server that was still listening, whose
// rejection path ends in `process.exit(1)`.
//
// The assertions here are deliberately BEHAVIOURAL as well as state-reading: a
// runtime that reports 'ready' while refusing upgrades is the failure this file
// exists for, so reading the state alone would not have caught it.

import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('fixture', import.meta.url));

/** @type {any} */
let handler;

beforeAll(async () => {
	expect(buildFixtureOnce('default'), 'the default fixture variant must build').toBeTruthy();
	handler = await import(
		pathToFileURL(path.join(fixtureDir, variantOut('default'), 'handler.js')).href
	);
}, 120000);

afterAll(async () => {
	if (handler && handler.lifecycleState() !== 'closed') await handler.shutdown({ timeoutMs: 1000 });
});

/** @returns {Promise<number>} an unused loopback port */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {net.AddressInfo} */ (probe.address());
			probe.close(() => resolve(port));
		});
	});
}

/** Resolves true when the server accepts a WebSocket upgrade. */
function upgrades(port) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const done = (ok) => { try { ws.close(); } catch { /* already gone */ } resolve(ok); };
		ws.on('open', () => done(true));
		ws.on('error', () => done(false));
		ws.on('unexpected-response', () => done(false));
	});
}

describe('a handler module can begin a new lifecycle after it has closed', () => {
	it('reaches ready again and accepts upgrades, twice over', async () => {
		const first = await freePort();
		await handler.start('127.0.0.1', first);
		expect(handler.lifecycleState()).toBe('ready');
		expect(await upgrades(first), 'the first boot must accept upgrades').toBe(true);

		await handler.shutdown({ timeoutMs: 1000 });
		expect(handler.lifecycleState()).toBe('closed');

		// The second boot is where a stale 'closed' state bound a port and then
		// answered every upgrade with 503 - bound, reachable over HTTP, and
		// useless for the thing this adapter exists to do.
		const second = await freePort();
		await handler.start('127.0.0.1', second);
		expect(handler.lifecycleState(), 'a new lifecycle must reach ready').toBe('ready');
		expect(handler.isDraining(), 'a fresh lifecycle is not draining').toBe(false);
		expect(await upgrades(second), 'the second boot must accept upgrades').toBe(true);

		await handler.shutdown({ timeoutMs: 1000 });

		// And a third, because the stale latch made shutdown a no-op the second
		// time: the server was never unbound, so this call reached listen() on a
		// still-listening server, whose rejection path exits the process.
		const third = await freePort();
		await handler.start('127.0.0.1', third);
		expect(handler.lifecycleState()).toBe('ready');
		expect(await upgrades(third), 'the third boot must accept upgrades').toBe(true);
		await handler.shutdown({ timeoutMs: 1000 });
	}, 60000);

	it('still shares one drain between concurrent callers within a lifecycle', async () => {
		const port = await freePort();
		await handler.start('127.0.0.1', port);
		// The latch is cleared BETWEEN lifecycles and never within one: two
		// callers racing a single shutdown must still get one run, so live
		// sockets receive one advisory and one close frame rather than two.
		const both = await Promise.all([
			handler.shutdown({ timeoutMs: 1000 }),
			handler.shutdown({ timeoutMs: 1000 })
		]);
		expect(both[0]).toBe(both[1]);
		expect(handler.lifecycleState()).toBe('closed');
	}, 60000);
});
