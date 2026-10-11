import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const prefix = 'UPGRADE_DRAIN_TEST_';
const controlSlot = Symbol.for('upgrade-drain-test-controls');
const hookSource = `
import { shutdown } from '../handler/lifecycle.js';
let enter;
let release;
const entered = new Promise(resolve => { enter = resolve; });
const gate = new Promise(resolve => { release = resolve; });
export function init() {
	globalThis[Symbol.for('upgrade-drain-test-controls')] = { entered, releaseUpgrade: release, shutdown };
}
export async function upgrade({ url }) {
	if (url.includes('wait')) { enter(); await gate; }
	return url.includes('deny') ? false : {};
}
`;

function request(target, upgrade = false) {
	return [
		`GET ${target} HTTP/1.1`, 'Host: localhost',
		...(upgrade ? [
			'Connection: Upgrade', 'Upgrade: websocket',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'
		] : []), '', ''
	].join('\r\n');
}

function exchange(port, secure, requests) {
	return new Promise((resolve, reject) => {
		const socket = secure
			? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
			: net.connect(port, '127.0.0.1');
		const responses = [];
		let pending = Buffer.alloc(0);
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(responses);
		};
		const timer = setTimeout(() => finish(new Error('incomplete response: ' + pending.toString('latin1'))), 5000);
		socket.once('error', (error) => finish(error));
		socket.once('close', () => finish());
		socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(requests[0]));
		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			const end = pending.indexOf('\r\n\r\n');
			if (end < 0) return;
			const lines = pending.subarray(0, end).toString('latin1').split('\r\n');
			const status = Number(lines.shift().split(' ')[1]);
			const headers = Object.fromEntries(lines.map((line) => {
				const colon = line.indexOf(':');
				return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
			}));
			const length = status === 101 ? 0 : Number(headers['content-length']);
			if (!Number.isSafeInteger(length) || length < 0) return finish(new Error('missing response length'));
			if (pending.length < end + 4 + length) return;
			responses.push({ status, headers, body: pending.subarray(end + 4, end + 4 + length).toString() });
			pending = pending.subarray(end + 4 + length);
			if (responses.length === requests.length) finish();
			else socket.write(requests[responses.length]);
		});
	});
}

for (const secure of [false, true]) describe(`upgrade admission during drain over ${secure ? 'TLS' : 'TCP'}`, () => {
	let payload;
	let runtime;
	let hooks;
	async function boot() {
		process.env[prefix + 'RECONNECT_DISPERSAL_MS'] = '0';
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify(prefix), WS_ENABLED: 'true',
				WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0, upgradeTimeout: 10 })
			},
			wsHandlerSource: hookSource
		});
		runtime = await bootRuntime(payload);
		hooks = globalThis[controlSlot];
		expect(hooks).toBeDefined();
	}

	afterEach(async () => {
		hooks?.releaseUpgrade();
		await runtime?.close();
		payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH', 'RECONNECT_DISPERSAL_MS']) delete process.env[prefix + key];
		delete globalThis[controlSlot];
		hooks = runtime = payload = undefined;
	});

	it('changes readiness while preserving accepted and refused upgrade admission', async () => {
		await boot();
		expect((await exchange(runtime.port, secure, [request('/readyz')]))[0].status).toBe(200);
		runtime.handler.beginDrain();
		const [readiness] = await exchange(runtime.port, secure, [request('/readyz')]);
		expect(readiness.status).toBe(503);
		expect(readiness.body).toBe('draining');
		expect((await exchange(runtime.port, secure, [request('/ws', true)])).map((r) => r.status)).toEqual([101]);
		const refused = await exchange(runtime.port, secure, [request('/ws?deny', true), request('/healthz')]);
		expect(refused.map((r) => r.status)).toEqual([401, 200]);
		expect(refused[1].body).toBe('OK');
	});

	it('finishes an accepted hook after readiness changes', async () => {
		await boot();
		const answer = exchange(runtime.port, secure, [request('/ws?wait', true)]);
		await hooks.entered;
		runtime.handler.beginDrain();
		hooks.releaseUpgrade();
		expect((await answer).map((r) => r.status)).toEqual([101]);
	});

	it('keeps a refused connection usable after its listener closes', async () => {
		await boot();
		const answer = exchange(runtime.port, secure, [request('/ws?wait&deny', true), request('/healthz')]);
		await hooks.entered;
		await hooks.shutdown();
		expect(runtime.handler.server.listening).toBe(false);
		hooks.releaseUpgrade();
		const responses = await answer;
		expect(responses.map((r) => r.status)).toEqual([401, 200]);
		expect(responses[0].headers.connection).not.toBe('close');
		expect(responses[1].body).toBe('OK');
	});
	it.each([0, 3000])('closes an upgrade accepted after the first shutdown sweep with budget %i', async timeoutMs => {
		await boot();
		const client = new WebSocket(`${secure ? 'wss' : 'ws'}://127.0.0.1:${runtime.port}/ws?wait`, { rejectUnauthorized: false });
		const opened = new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
		const closed = new Promise(resolve => client.once('close', code => resolve(code)));
		let release;
		let deadline;
		try {
			await hooks.entered;
			const started = Date.now();
			const shutdown = runtime.handler.shutdown({ timeoutMs });
			release = setTimeout(() => hooks.releaseUpgrade(), 150);
			await opened;
			expect(await Promise.race([
				shutdown,
				new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Late upgrade held shutdown open')), 1800); })
			])).toBe(true);
			expect(await closed).toBe(1001);
			expect(Date.now() - started).toBeLessThan(1500);
			expect(client.readyState).toBe(WebSocket.CLOSED);
		} finally {
			clearTimeout(release); clearTimeout(deadline); client.terminate();
		}
	});

});
