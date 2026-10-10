import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { createTestServer } from '../src/testing.js';

function probe(port, path, headers) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = net.connect(port, '127.0.0.1', () => socket.write(
			Buffer.from(['GET ' + path + ' HTTP/1.1', 'Host: localhost', ...headers, '', ''].join('\r\n'), 'latin1')
		));
		const timer = setTimeout(() => socket.destroy(), 180);
		socket.on('data', bytes => chunks.push(bytes));
		socket.on('error', err => { if (err.code !== 'ECONNRESET') reject(err); });
		socket.on('close', () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks).toString('utf8');
			resolve({ status: Number(raw.match(/^HTTP\/1\.1 (\d{3})/)?.[1]), body: raw.slice(raw.indexOf('\r\n\r\n') + 4), raw });
		});
	});
}
const metricSource = `
export default {counter(name){return {inc(labels){const t=globalThis.__headerDecodeCounts;const key=name+' '+JSON.stringify(labels??{});t.set(key,(t.get(key)||0)+1);}}},gauge(){return {set(){}}},histogram(name){return {observe(labels){const t=globalThis.__headerDecodeCounts;const key=name+' '+JSON.stringify(labels??{});t.set(key,(t.get(key)||0)+1);}}}};
`;
const counts = globalThis.__headerDecodeCounts = new Map();
const metrics = {
	counter: name => ({ inc(labels) { const key = name + ' ' + JSON.stringify(labels ?? {}); counts.set(key, (counts.get(key) || 0) + 1); } }),
	gauge: () => ({ set() {} }), histogram: () => ({ observe() {} })
};
let payload, runtime, mirror;
beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', adminAuthAcknowledged: true, metrics: './metrics.js' }) },
		wsHandlerSource: 'export function message() {}\nexport function admin(request) { return Response.json(Object.fromEntries(request.headers)); }',
		metricsRegistrySource: metricSource
	});
	runtime = await bootRuntime(payload);
	mirror = await createTestServer({ metrics, handler: { admin: request => Response.json(Object.fromEntries(request.headers)) } });
}, 60000);
afterAll(async () => { await runtime?.close(); await mirror?.close(); payload?.cleanup(); delete globalThis.__headerDecodeCounts; });

for (const surface of ['runtime', 'mirror']) {
	describe(`${surface} native header string boundary`, () => {
		const port = () => surface === 'runtime' ? runtime.port : mirror.port;
		it('decodes valid UTF-8 before application headers and duplicate joining', async () => {
			const answer = await probe(port(), '/__realtime/inspect', ['X-Probe: a\xc3\xa9b', 'X-Probe: c\xc3\xbfd', 'Cookie: a=\xc3\xa9x', 'Cookie: b=two']);
			expect(answer.status, answer.raw).toBe(200);
			expect(JSON.parse(answer.body)).toMatchObject({ 'x-probe': 'a\u00e9b, c\u00ffd', cookie: 'a=\u00e9x; b=two' });
		});
		it.each(['a\xe9b', 'a\xe2\x82b', 'a\xc0\xafb', 'a\xe2\x82\xacb', 'a\xf0\x9f\x98\x80b'])('lets shared application header validation refuse decoded bytes %s', async value => {
			const answer = await probe(port(), '/__realtime/inspect', ['X-Probe: ' + value]);
			expect(answer.status, answer.raw).toBe(400);
		});
		if (surface === 'runtime') it.each([
			['a'.repeat(11) + '\xc3\xa9' + 'a'.repeat(11), 1],
			['a'.repeat(10) + '\xc3\xa9' + 'a'.repeat(11), 0],
			['a'.repeat(12) + '\xc3\xa9' + 'a'.repeat(11), 0]
		])('classifies WebSocket routing by original key bytes', async (key, upgraded) => {
			counts.clear();
			const answer = await probe(port(), '/ws', ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + key]);
			expect(answer.status, answer.raw).toBe(400);
			expect(counts.get('upgrade_duration_seconds {"outcome":"rejected"}') || 0).toBe(upgraded);
		});
	});
}
