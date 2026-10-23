// Connection setup on this runtime arms the socket's close listener before the
// idle timer and the app open hook. A setup failure after that listener is armed
// still closes the accepted socket with 1011, and its close must stay setup
// cleanup: the app close hook runs only for connections whose open hook could
// run, and the connection permit comes back so the next client is admitted.

import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const HANDLER = `
const counts = globalThis.__setupLateCounts = { opens: 0, closes: 0 };
export function upgrade() { return {}; }
export function open() { counts.opens++; }
export function close() { counts.closes++; }
export function message() {}
`;

let payload, environment, runtime;
let failNextIdleTimer = false;
let failedIdleTimers = 0;

beforeAll(async () => {
	payload = buildRuntime({
		replace: {
			WS_ENABLED: 'true',
			WS_OPTIONS: JSON.stringify({
				allowedOrigins: '*',
				upgradeRateLimit: 0,
				idleTimeout: 120,
				upgradeAdmission: { maxConnections: 1 }
			})
		},
		wsHandlerSource: HANDLER
	});
	environment = await import(pathToFileURL(path.join(payload.dir, 'runtime.js')).href);
	environment.setRuntimeEnv({
		timers: {
			setInterval(callback, ms, ...args) {
				// Only the per-connection idle timer, armed inside connection setup.
				if (failNextIdleTimer && String(new Error().stack).includes('openConnection')) {
					failNextIdleTimer = false;
					failedIdleTimers++;
					throw new Error('idle timer unavailable');
				}
				return setInterval(callback, ms, ...args); // determinism-allow: test scheduler delegates to the real timer
			}
		}
	});
	runtime = await bootRuntime(payload);
}, 60000);

afterAll(async () => {
	await runtime?.close();
	environment?.resetRuntimeEnv();
	payload?.cleanup();
	delete globalThis.__setupLateCounts;
});

/** @param {WebSocket} ws */
function opened(ws) {
	return new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
}

it('closes a socket whose setup fails after its close listener without running the close hook', async () => {
	const url = `ws://127.0.0.1:${runtime.port}/ws`;
	const counts = () => ({ ...globalThis.__setupLateCounts });

	const warmup = new WebSocket(url);
	await opened(warmup);
	const warmupClosed = once(warmup, 'close');
	warmup.close();
	await warmupClosed;
	await expect.poll(counts).toEqual({ opens: 1, closes: 1 });

	const errors = [];
	const original = console.error;
	console.error = (...args) => { errors.push(args); };
	let failing;
	try {
		failNextIdleTimer = true;
		failing = new WebSocket(url);
		let accepted = false;
		failing.once('open', () => { accepted = true; });
		const [code, reason] = await once(failing, 'close');
		expect(failedIdleTimers, 'the setup failure was injected').toBe(1);
		expect(accepted, 'the failure happened after the 101 handshake').toBe(true);
		expect(code).toBe(1011);
		expect(String(reason)).toBe('Connection setup failed');
	} finally {
		console.error = original;
	}

	// Let the server side of the failed socket finish closing.
	await new Promise((resolve) => setTimeout(resolve, 100)); // determinism-allow: lets the server close event land
	expect(counts(), 'neither hook ran for the failed connection').toEqual({ opens: 1, closes: 1 });

	const healthy = new WebSocket(url);
	await opened(healthy);
	await expect.poll(counts).toEqual({ opens: 2, closes: 1 });
	const healthyClosed = once(healthy, 'close');
	healthy.close();
	await healthyClosed;
	await expect.poll(counts).toEqual({ opens: 2, closes: 2 });
}, 30000);
