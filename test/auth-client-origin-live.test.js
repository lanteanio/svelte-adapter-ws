import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as client from '../src/client.js';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

describe('bundled auth preflight on the built runtime', () => {
	let payload;
	let runtime;
	let connection;

	beforeAll(async () => {
		payload = buildRuntime({
			replace: {
				WS_ENABLED: 'true',
				WS_OPTIONS: JSON.stringify({
					allowedOrigins: 'same-origin',
					authPathRequireOrigin: true,
					authPathRateLimit: 0,
					upgradeRateLimit: 0
				})
			},
			wsHandlerSource: `
export function upgrade() { return {}; }
export function message() {}
export function authenticate({ headers }) {
	return Response.json({ headers });
}
`
		});
		runtime = await bootRuntime(payload);
	}, 60000);

	afterEach(() => {
		connection?.close();
		connection = undefined;
		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;
	});
	afterAll(async () => {
		await runtime?.close();
		payload?.cleanup();
	});

	it.each([undefined, 'svelte-adapter-ws', 'svelte-adapter-uws', 'unrecognized'])(
		'refuses an auth request whose only origin signal is %s',
		async (value) => {
			const response = await originalFetch(`${runtime.origin}/__ws/auth`, {
				method: 'POST',
				headers: value === undefined ? {} : { 'x-requested-with': value }
			});
			expect(response.status).toBe(403);
			await response.text();
		}
	);

	it('opens the real client with only its preflight header as the origin signal', async () => {
		const seen = [];
		globalThis.WebSocket = WebSocket;
		globalThis.fetch = async (url, init) => {
			const response = await originalFetch(url, init);
			seen.push({ status: response.status, echo: response.ok ? await response.clone().json() : null });
			return response;
		};
		connection = client.connect({ url: runtime.origin.replace('http:', 'ws:') + '/ws', auth: true });
		let deadline;
		try {
			await Promise.race([
				client.ready(),
				new Promise((_, reject) => {
					deadline = setTimeout(() => reject(new Error('authenticated socket did not open: ' + JSON.stringify(seen))), 3000);
				})
			]);
		} finally {
			clearTimeout(deadline);
		}
		expect(seen).toHaveLength(1);
		expect(seen[0].status).toBe(200);
		expect(seen[0].echo.headers['x-requested-with']).toBe('XMLHttpRequest');
		expect(seen[0].echo.headers).not.toHaveProperty('origin');
		expect(seen[0].echo.headers).not.toHaveProperty('sec-fetch-site');
	});
});
