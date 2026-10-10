// A handler module can be started again after it has been shut down.
// Drain latches and lifecycle state reset between starts. Every restart must
// reach readiness and accept WebSocket traffic, and a completed shutdown must
// unbind the listener before the next start.

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

		// A fresh lifecycle clears the closed state and accepts traffic again.
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
