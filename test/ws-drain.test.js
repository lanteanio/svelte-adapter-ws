import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
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

/** @param {number} port */
function dial(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (raw) => {
		try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
	});
	return {
		ws,
		frames,
		open: () => new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		}),
		closed: () => new Promise((resolve) => ws.once('close', (code) => resolve(code)))
	};
}

describe('managed WebSocket drain', () => {
	it('advises reconnect with the dispersal window, closes 1001, and completes shutdown', async () => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: 'export function close() {}\n'
		});
		try {
			const rt = await bootRuntime(payload);
			const a = dial(rt.port);
			const b = dial(rt.port);
			await a.open();
			await b.open();

			const aClosed = a.closed();
			const bClosed = b.closed();
			await rt.handler.shutdown({ timeoutMs: 5000 });

			expect(await aClosed).toBe(1001);
			expect(await bClosed).toBe(1001);
			for (const client of [a, b]) {
				const advisory = client.frames.find((f) => f.type === 'reconnect');
				expect(advisory).toBeDefined();
				expect(advisory.windowMs).toBe(5000);
			}
			expect(rt.handler.lifecycleState()).toBe('closed');
		} finally {
			payload.cleanup();
		}
	});

	it('closes without an advisory when the dispersal window is zero', async () => {
		process.env.SAW_DR0_RECONNECT_DISPERSAL_MS = '0';
		const payload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify('SAW_DR0_'),
				WS_ENABLED: JSON.stringify(true),
				WS_OPTIONS: JSON.stringify(WS_OPTS)
			},
			wsHandlerSource: 'export function close() {}\n'
		});
		try {
			const rt = await bootRuntime(payload);
			const client = dial(rt.port);
			await client.open();
			const closed = client.closed();
			await rt.handler.shutdown({ timeoutMs: 5000 });
			expect(await closed).toBe(1001);
			expect(client.frames.find((f) => f.type === 'reconnect')).toBeUndefined();
		} finally {
			delete process.env.SAW_DR0_RECONNECT_DISPERSAL_MS;
			payload.cleanup();
		}
	});

	it('refuses a new upgrade the moment drain begins', async () => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: 'export function close() {}\n'
		});
		try {
			const rt = await bootRuntime(payload);
			rt.handler.beginDrain();
			const late = dial(rt.port);
			await expect(late.open()).rejects.toThrow();
			await rt.handler.shutdown({ timeoutMs: 1000 });
		} finally {
			payload.cleanup();
		}
	});
});
