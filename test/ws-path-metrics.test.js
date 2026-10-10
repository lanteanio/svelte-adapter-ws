import { afterAll, beforeAll, expect, it } from 'vitest';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const registrySource = `
export const observations = [];
export default {
 counter(name) { return { inc(labels) { observations.push({ name, labels }); } }; },
 gauge() { return { set() {} }; },
 histogram(name) { return { observe(labels, seconds) { observations.push({ name, labels, seconds }); } }; },
 serialize() { return ''; }
};
`;
let payload, rt, observations, counters;
beforeAll(async () => {
	payload = buildRuntime({ replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ metrics: './metrics.js', allowedOrigins: '*', upgradeRateLimit: 0 }) }, wsHandlerSource: 'export function message() {}', metricsRegistrySource: registrySource });
	rt = await bootRuntime(payload);
	({ counters } = await import(pathToFileURL(`${payload.dir}/handler/state.js`).href));
	({ observations } = await import(pathToFileURL(`${payload.dir}/server/metrics-registry.js`).href));
}, 30000);
afterAll(async () => { await rt?.close(); payload?.cleanup(); });

function pipeline(lines) {
	return new Promise((resolve, reject) => {
		let raw = '';
		const socket = net.connect(rt.port, '127.0.0.1', () => socket.write([...lines, 'Host: 127.0.0.1', '', 'GET /healthz HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close', '', ''].join('\r\n')));
		const timeout = setTimeout(() => { socket.destroy(); reject(new Error('pipeline did not finish')); }, 5000);
		socket.on('data', value => { raw += value.toString('latin1'); });
		socket.on('error', reject);
		socket.on('close', () => { clearTimeout(timeout); resolve(raw); });
	});
}
for (const [name, lines, status, upgrades] of [
	['a 24-byte key without upgrade headers', ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='], 400, 1],
	['a noncanonical 24-byte key', ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: xxxxxxxxxxxxxxxxxxxxxxxx'], 400, 1],
	['a 23-byte key', ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: xxxxxxxxxxxxxxxxxxxxxxx'], 400, 0],
	['a 25-byte key', ['GET /ws HTTP/1.1', 'Sec-WebSocket-Key: xxxxxxxxxxxxxxxxxxxxxxxxx'], 400, 0],
	['upgrade without a key', ['GET /ws HTTP/1.1', 'Upgrade: websocket'], 400, 0],
	['a key on an HTTP route', ['GET /api/echo HTTP/1.1', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='], 200, 0]
]) {
	it(`classifies ${name} on its native metric route`, async () => {
		observations.length = 0;
		const raw = await pipeline(lines);
		expect(raw.startsWith(`HTTP/1.1 ${status} `)).toBe(true);
		expect(raw.match(/HTTP\/1\.1 200 OK/g)?.length).toBe(status === 200 ? 2 : 1);
		const http = observations.filter(r => r.name === 'http_requests_total');
		const duration = observations.filter(r => r.name === 'http_request_duration_seconds');
		const upgrade = observations.filter(r => r.name === 'upgrade_duration_seconds');
		expect(http).toHaveLength(2 - upgrades);
		expect(duration).toHaveLength(2 - upgrades);
		expect(upgrade).toHaveLength(upgrades);
		expect(counters.inFlightCount).toBe(0);
		expect(observations.filter(r => r.name === 'upgrade_rejected_total')).toHaveLength(status === 400 ? 1 : 0);
		for (const item of upgrade) {
			expect(item.labels).toEqual({ outcome: 'rejected' });
			expect(item.seconds).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(item.seconds)).toBe(true);
		}
	});
}
