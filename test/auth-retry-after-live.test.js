import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

describe('authentication rate-limit retry delays on the built runtime', () => {
	it.each([
		{ label: 'sub-second window', window: 0.25, low: 1, high: 2 },
		{ label: 'fractional window', window: 1.5, low: 2, high: 3 },
		{ label: 'integer window', window: 2, low: 2, high: 3 },
		{ label: 'default window', window: undefined, low: 10, high: 14 }
	])('returns whole seconds for a $label', async ({ window, low, high }) => {
		const payload = buildRuntime({
			replace: {
				WS_ENABLED: 'true',
				WS_OPTIONS: JSON.stringify({
					authPathRequireOrigin: true,
					allowedOrigins: 'same-origin',
					authPathRateLimit: 1,
					authPathRateLimitWindow: window,
					upgradeRateLimit: 0
				})
			},
			wsHandlerSource: 'export function upgrade() { return {}; }\nexport function message() {}\nexport function authenticate() { return {}; }\n'
		});
		const environment = await import(pathToFileURL(path.join(payload.dir, 'runtime.js')).href);
		let runtime;
		let jitter = 0;
		try {
			environment.setRuntimeEnv({ clock: { now: () => 100000 }, rng: { float: () => jitter } });
			runtime = await bootRuntime(payload);
			const request = () => fetch(`${runtime.origin}/__ws/auth`, {
				method: 'POST',
				headers: { 'x-requested-with': 'XMLHttpRequest' }
			});
			const admitted = await request();
			expect(admitted.status).toBe(204);
			expect(admitted.headers.has('retry-after')).toBe(false);
			await admitted.text();
			for (const [random, seconds] of [[0, low], [0.999999, high]]) {
				jitter = random;
				const refused = await request();
				expect(refused.status).toBe(429);
				expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
				expect(refused.headers.get('retry-after')).toBe(String(seconds));
				expect(await refused.text()).toBe('Too many authentication requests');
			}
		} finally {
			environment.resetRuntimeEnv();
			await runtime?.close();
			payload.cleanup();
		}
	}, 15000);
});
