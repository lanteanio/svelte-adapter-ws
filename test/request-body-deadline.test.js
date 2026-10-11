import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const prefix = 'BODY_DEADLINE_TEST_';

describe.each([false, true])('request body receive deadline with TLS=%s', secure => {
	let payload, runtime;
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix) },
			serverSource: `export class Server {
				async init() {}
				async respond(request) {
					if (new URL(request.url).pathname === '/read') {
						try { await request.text(); } catch { return new Response('too large', { status: 413 }); }
					}
					return new Response('ok');
				}
			}`
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});

	it('bounds ignored bodies and slow readers while allowing sustained receipt past the cap', async () => {
		const run = (target, fast, keepOpen = false, declared = false) => new Promise((resolve, reject) => {
			const socket = secure ? tls.connect({ host: '127.0.0.1', port: runtime.port, rejectUnauthorized: false }) : net.connect(runtime.port, '127.0.0.1');
			let raw = '', sent = 0, interval, started, ended = false;
			const finish = error => {
				if (ended) return;
				ended = true; clearInterval(interval); clearTimeout(deadline); socket.destroy();
				if (error) reject(error); else resolve({ raw, elapsed: Date.now() - started, sent });
			};
			const deadline = setTimeout(() => finish(new Error('Body receive deadline did not close the socket')), 13500);
			socket.on('error', error => { if (error.code !== 'ECONNRESET') finish(error); });
			socket.on('data', bytes => { raw += bytes.toString('latin1'); });
			socket.on('close', () => {
				if (keepOpen && Date.now() - started < 11000) finish(new Error('Sustained body receipt closed early'));
				else finish();
			});
			socket.once(secure ? 'secureConnect' : 'connect', () => {
				started = Date.now();
				socket.write(`POST ${target} HTTP/1.1\r\nHost: localhost\r\n${declared ? 'Content-Length: 100000000' : 'Transfer-Encoding: chunked'}\r\n\r\n`);
				const chunk = fast ? 'x'.repeat(16384) : 'x';
				interval = setInterval(() => {
					if (keepOpen && Date.now() - started >= 11200) {
						clearInterval(interval);
						socket.write('0\r\n\r\nGET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
						return;
					}
					sent += chunk.length;
					socket.write(declared ? chunk : chunk.length.toString(16) + '\r\n' + chunk + '\r\n');
				}, fast ? 50 : 250);
			});
		});
		const [ignoredFast, ignoredDrip, readingDrip, readingFast, declaredOversize] = await Promise.all([
			run('/ignore', true), run('/ignore', false), run('/read', false), run('/read', true, true), run('/read', true, false, true)
		]);
		for (const result of [ignoredFast, ignoredDrip, readingDrip, declaredOversize]) {
			expect(result.elapsed).toBeGreaterThanOrEqual(9000);
			expect(result.elapsed).toBeLessThan(13000);
			expect(result.sent).toBeGreaterThan(1);
		}
		expect(ignoredFast.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(ignoredDrip.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
		expect(readingDrip.raw).toBe('');
		expect(declaredOversize.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 413']);
		expect(readingFast.elapsed).toBeGreaterThanOrEqual(11000);
		expect(readingFast.raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 413', 'HTTP/1.1 200']);
		expect(readingFast.raw.endsWith('OK')).toBe(true);
	}, 16000);
});
