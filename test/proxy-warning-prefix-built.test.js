// The untrusted-peer and upgrade 429 proxy warnings name the settings the
// runtime actually reads, so under an environment prefix they print the
// prefixed names. Driven on the built runtime, which is where both warnings
// live; each payload is its own module graph, so each one-shot warning is
// fresh per block.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const prefix = 'TEST_PROXY_';

/** @param {number} port @returns {Promise<number>} */
function upgrade(port) {
	return new Promise((resolve, reject) => {
		let response = '';
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
		});
		socket.setTimeout(5000, () => socket.destroy(new Error('Upgrade response timed out')));
		socket.on('data', chunk => {
			response += chunk.toString();
			if (response.includes('\r\n\r\n')) {
				resolve(Number(response.split(' ')[1]));
				socket.destroy();
			}
		});
		socket.on('error', reject);
	});
}

/** @param {import('vitest').MockInstance} spy @param {string} needle */
const printed = (spy, needle) => spy.mock.calls.map(([message]) => String(message)).filter(message => message.includes(needle));

describe('prefixed untrusted-proxy warning on the built runtime', () => {
	let payload, runtime, warn;
	beforeAll(async () => {
		process.env[prefix + 'ADDRESS_HEADER'] = 'x-forwarded-for';
		process.env[prefix + 'TRUSTED_PROXIES'] = '192.0.2.1';
		warn = vi.spyOn(console, 'warn');
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		warn?.mockRestore();
		await runtime?.close();
		payload?.cleanup();
		delete process.env[prefix + 'ADDRESS_HEADER'];
		delete process.env[prefix + 'TRUSTED_PROXIES'];
	});

	it('names the prefixed allowlist in both the explanation and remedy, once', async () => {
		for (let i = 0; i < 2; i++) {
			const response = await fetch(runtime.origin + '/api/echo', { headers: { 'x-forwarded-for': '198.51.100.1' } });
			expect(response.status).toBe(200);
			expect((await response.json()).clientAddress).toBe('127.0.0.1');
		}
		const messages = printed(warn, 'untrusted peer');
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('not in TEST_PROXY_TRUSTED_PROXIES');
		expect(messages[0]).toContain('to TEST_PROXY_TRUSTED_PROXIES.');
	});
});

describe('prefixed upgrade rate-limit warning on the built runtime', () => {
	let payload, runtime, warn;
	beforeAll(async () => {
		warn = vi.spyOn(console, 'warn');
		payload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify(prefix),
				WS_ENABLED: 'true',
				WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 2 })
			},
			wsHandlerSource: 'export function message() {}\n'
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		warn?.mockRestore();
		await runtime?.close();
		payload?.cleanup();
	});

	it('names the prefixed address and depth settings when a loopback client exhausts the limit, once', async () => {
		const statuses = [];
		for (let i = 0; i < 4; i++) statuses.push(await upgrade(runtime.port));
		expect(statuses).toEqual([101, 101, 429, 429]);
		const messages = printed(warn, 'Rejected a WebSocket upgrade (429)');
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('keyed on a loopback client address (127.0.0.1) while TEST_PROXY_ADDRESS_HEADER is unset');
		expect(messages[0]).toContain('TEST_PROXY_ADDRESS_HEADER=x-forwarded-for (+ TEST_PROXY_XFF_DEPTH for the trusted-proxy hop count)');
	});
});
