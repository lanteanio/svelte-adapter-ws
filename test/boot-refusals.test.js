import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});

/**
 * Build a payload under a unique env prefix, set the given env vars under
 * that prefix, and return the import promise plus teardown.
 *
 * @param {string} prefix
 * @param {Record<string, string>} env
 */
function bootWith(prefix, env) {
	for (const [k, v] of Object.entries(env)) process.env[prefix + k] = v;
	const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
	cleanups.push(() => {
		for (const k of Object.keys(env)) delete process.env[prefix + k];
		payload.cleanup();
	});
	return payload.importRuntime();
}

describe('boot-time refusals', () => {
	it('refuses PROXY_PROTOCOL=1 loudly', async () => {
		await expect(bootWith('SAW_B1_', { PROXY_PROTOCOL: '1' })).rejects.toThrow(/PROXY_PROTOCOL=1 is not supported/);
	});

	it('refuses a partial TLS config', async () => {
		await expect(bootWith('SAW_B2_', { SSL_CERT: '/certs/fullchain.pem' })).rejects.toThrow(/Incomplete TLS config/);
	});

	it('refuses an invalid XFF_DEPTH', async () => {
		await expect(bootWith('SAW_B3_', { XFF_DEPTH: '0' })).rejects.toThrow(/Invalid XFF_DEPTH/);
		await expect(bootWith('SAW_B4_', { XFF_DEPTH: 'abc' })).rejects.toThrow(/Invalid XFF_DEPTH/);
	});

	it('refuses a malformed BODY_SIZE_LIMIT', async () => {
		await expect(bootWith('SAW_B5_', { BODY_SIZE_LIMIT: 'junk' })).rejects.toThrow(/Invalid BODY_SIZE_LIMIT/);
		await expect(bootWith('SAW_B6_', { BODY_SIZE_LIMIT: '-100' })).rejects.toThrow(/Invalid BODY_SIZE_LIMIT/);
	});

	it('refuses a malformed TRUSTED_PROXIES entry', async () => {
		await expect(bootWith('SAW_B7_', { TRUSTED_PROXIES: 'not-an-ip' })).rejects.toThrow(/not a valid IP/);
	});

	it('refuses a prefixed env var outside the family surface', async () => {
		await expect(bootWith('SAW_B8_', { NOT_A_KNOWN_VAR: '1' })).rejects.toThrow(/change envPrefix/);
	});

	it('accepts every var in the family env surface under a prefix', async () => {
		// Values chosen inert: no TLS pair, no cluster trigger, no proxy refusal.
		const payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify('SAW_B9_') } });
		process.env.SAW_B9_ORIGIN = 'https://example.com';
		process.env.SAW_B9_XFF_DEPTH = '2';
		process.env.SAW_B9_ADDRESS_HEADER = 'x-forwarded-for';
		process.env.SAW_B9_BODY_SIZE_LIMIT = '1M';
		process.env.SAW_B9_WS_DEBUG = '0';
		cleanups.push(() => {
			for (const k of ['ORIGIN', 'XFF_DEPTH', 'ADDRESS_HEADER', 'BODY_SIZE_LIMIT', 'WS_DEBUG']) {
				delete process.env['SAW_B9_' + k];
			}
			payload.cleanup();
		});
		await expect(payload.importRuntime()).resolves.toBeTruthy();
	});
});
