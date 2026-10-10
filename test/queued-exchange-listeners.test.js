import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const COUNT = 32;
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));

describe.each([false, true])('queued exchange cleanup with TLS=%s', secure => {
	let payload, runtime, counters;
	const prefix = 'QUEUED_EXCHANGE_TEST_';
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) } });
		try { runtime = await bootRuntime(payload); }
		catch (error) { throw new Error('Runtime setup failed: ' + (error?.stack || String(error))); }
		({ counters } = await import(pathToFileURL(path.join(payload.dir, 'handler/state.js')).href));
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});

	it.each(['/healthz', '/api/tiny'])('shares one connection close listener across queued %s replies', async target => {
		const sockets = new Set();
		const warnings = [];
		const observed = [];
		let initialListeners = 0, peakListeners = 0, peakInFlight = 0;
		const listenerAdded = function(event) {
			if (event === 'close') peakListeners = Math.max(peakListeners, this.listenerCount('close') + 1);
		};
		const observer = (req, res) => {
			peakInFlight = Math.max(peakInFlight, counters.inFlightCount);
			if (!sockets.has(req.socket)) {
				initialListeners = req.socket.listenerCount('close');
				peakListeners = initialListeners;
				req.socket.on('newListener', listenerAdded);
				sockets.add(req.socket);
			}
			observed.push({ queued: res.socket === null, listeners: req.socket.listenerCount('close') });
		};
		const warning = value => { if (sockets.has(value.emitter) && value.name === 'MaxListenersExceededWarning') warnings.push(value.message); };
		runtime.handler.server.on('request', observer);
		process.on('warning', warning);
		try {
			const raw = await new Promise((resolve, reject) => {
				const socket = secure ? tls.connect({ host: '127.0.0.1', port: runtime.port, rejectUnauthorized: false }) : net.connect(runtime.port, '127.0.0.1');
				let text = '', pending = '', received = 0, done = false;
				const finish = error => {
					if (done) return;
					done = true; clearTimeout(deadline); socket.destroy();
					if (error) reject(error); else resolve(text);
				};
				const deadline = setTimeout(() => finish(new Error('Incomplete pipelined response')), 5000);
				socket.on('error', finish);
				socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(
					('GET ' + target + ' HTTP/1.1\r\nHost: x\r\nCookie: s=1\r\n\r\n').repeat(COUNT)
				));
				socket.on('data', chunk => {
					const bytes = chunk.toString('latin1');
					text += bytes; pending += bytes;
					while (pending.length) {
						const end = pending.indexOf('\r\n\r\n');
						if (end < 0) return;
						const head = pending.slice(0, end);
						const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);
						if (!head.startsWith('HTTP/1.1 200 OK\r\n') || length !== 2) {
							finish(new Error('Invalid pipelined response framing')); return;
						}
						if (pending.length < end + 4 + length) return;
						if (pending.slice(end + 4, end + 4 + length) !== (target === '/healthz' ? 'OK' : 'ok')) {
							finish(new Error('Incomplete or incorrect pipelined response body')); return;
						}
						received++; pending = pending.slice(end + 4 + length);
					}
					if (received === COUNT) finish();
				});
				socket.on('end', () => finish(new Error('Connection ended before all replies')));
			});
			expect(raw.match(/HTTP\/1\.1 200/g)).toHaveLength(COUNT);
			expect(observed).toHaveLength(COUNT);
			expect(observed.filter(value => value.queued).length, 'the real transport must queue responses').toBeGreaterThan(10);
			expect(peakListeners).toBeLessThanOrEqual(initialListeners + 1);
			expect(peakInFlight, 'the imported production accounting was active').toBeGreaterThan(1);
			for (let i = 0; i < 100 && counters.inFlightCount !== 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
			expect(counters.inFlightCount).toBe(0);
			await new Promise(resolve => setImmediate(resolve));
			expect(warnings).toEqual([]);
		} finally {
			runtime.handler.server.off('request', observer);
			process.off('warning', warning);
			for (const socket of sockets) socket.off('newListener', listenerAdded);
		}
	});
});
