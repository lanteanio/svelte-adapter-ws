import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

// The body receive deadline is 10 s, re-armed per 160 KiB received (16 KiB/s).
// The runtime's timers are scaled so the 10 s deadline fires after DEADLINE ms;
// the byte threshold is not scaled, so the throughput floor here becomes
// 160 KiB per DEADLINE ms. FAST sends four times that floor, SLOW a quarter.
const DEADLINE = 3000;
const FLOOR = 160 * 1024 / DEADLINE; // bytes per ms
const TICK = 100;
const FAST = Math.ceil(FLOOR * 4 * TICK);
const SLOW = Math.floor(FLOOR / 4 * TICK);
const SUSTAIN = DEADLINE * 4;
const slot = Symbol.for('body-throughput-test');
const prefix = 'BODY_THROUGHPUT_TEST_';

let payload, runtime, runtimeModule;
beforeAll(async () => {
	process.env[prefix + 'BODY_SIZE_LIMIT'] = '1G';
	payload = buildRuntime({
		replace: {
			ENV_PREFIX: JSON.stringify(prefix),
			WS_ENABLED: 'true',
			WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', authPathRequireOrigin: false, authPathRateLimit: 0 })
		},
		wsHandlerSource: 'export async function authenticate() {}',
		serverSource: `
const slot = Symbol.for('body-throughput-test');
const count = async reader => {
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return bytes;
		bytes += value.byteLength;
	}
};
export class Server {
	async init() {}
	async respond(request) {
		const url = new URL(request.url);
		if (request.method !== 'POST') return new Response('ok');
		if (url.pathname === '/count') return new Response(String(await count(request.body.getReader())));
		if (url.pathname === '/late') {
			const reader = request.body.getReader();
			(globalThis[slot] ||= {})[url.searchParams.get('id')] = () => count(reader);
		}
		if (url.pathname === '/answer-later') await new Promise(resolve => setTimeout(resolve, Number(url.searchParams.get('ms'))));
		return new Response('ok');
	}
}`
	});
	runtimeModule = await import(pathToFileURL(path.join(payload.dir, 'runtime.js')).href);
	runtimeModule.setRuntimeEnv({ timers: {
		set: (callback, ms, ...args) => setTimeout(callback, ms === 10_000 ? DEADLINE : ms, ...args),
		clear: handle => clearTimeout(handle)
	} }, { force: true });
	runtime = await bootRuntime(payload);
}, 60000);
afterAll(async () => {
	await runtime?.close();
	runtimeModule?.resetRuntimeEnv();
	payload?.cleanup();
	delete globalThis[slot];
	delete process.env[prefix + 'BODY_SIZE_LIMIT'];
});

/**
 * POST `target` and stream its body at `size` bytes per TICK for `duration` ms,
 * then end it and pipeline a GET /healthz. A declared length sends the body
 * raw and never ends it. Resolves when the server closes the connection.
 */
function upload(target, { size, duration = Infinity, declared = 0, onAnswer }) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(runtime.port, '127.0.0.1');
		const answers = [];
		let pending = Buffer.alloc(0), sent = 0, started = 0, interval, ended = false;
		const finish = error => {
			if (ended) return;
			ended = true; clearInterval(interval); clearTimeout(limit); socket.destroy();
			if (error) reject(error);
			else resolve({ answers, sent, elapsed: Date.now() - started });
		};
		const limit = setTimeout(() => finish(new Error('connection still open: ' + JSON.stringify(answers))), SUSTAIN + DEADLINE * 3);
		socket.on('error', error => { if (error.code !== 'ECONNRESET') finish(error); });
		socket.on('close', () => finish());
		socket.on('data', bytes => {
			pending = Buffer.concat([pending, bytes]);
			for (;;) {
				const end = pending.indexOf('\r\n\r\n');
				if (end < 0) return;
				const head = pending.subarray(0, end).toString('latin1');
				const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? 0);
				if (pending.length < end + 4 + length) return;
				answers.push({ status: Number(head.slice(9, 12)), body: pending.subarray(end + 4, end + 4 + length).toString() });
				pending = pending.subarray(end + 4 + length);
				if (answers.length === 1) onAnswer?.();
			}
		});
		socket.once('connect', () => {
			started = Date.now();
			socket.write(`POST ${target} HTTP/1.1\r\nHost: localhost\r\n${declared ? 'Content-Length: ' + declared : 'Transfer-Encoding: chunked'}\r\n\r\n`);
			const chunk = 'x'.repeat(size);
			interval = setInterval(() => {
				if (Date.now() - started >= duration) {
					clearInterval(interval);
					socket.write('0\r\n\r\nGET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
					return;
				}
				sent += size;
				socket.write(declared ? chunk : size.toString(16) + '\r\n' + chunk + '\r\n');
			}, TICK);
		});
	});
}

const cutAtDeadline = result => {
	expect(result.elapsed).toBeGreaterThanOrEqual(DEADLINE * 0.8);
	expect(result.elapsed).toBeLessThan(DEADLINE * 1.7);
	expect(result.sent).toBeGreaterThan(0);
};

describe.concurrent('request body receive throughput', () => {
	it('keeps a reader receiving above the throughput floor past several deadlines', async () => {
		const result = await upload('/count', { size: FAST, duration: SUSTAIN });
		expect(result.elapsed).toBeGreaterThanOrEqual(SUSTAIN);
		expect(result.answers).toEqual([{ status: 200, body: String(result.sent) }, { status: 200, body: 'OK' }]);
	}, 30000);

	it('closes a reader receiving below the throughput floor at the deadline', async () => {
		const result = await upload('/count', { size: SLOW });
		cutAtDeadline(result);
		expect(result.answers).toEqual([]);
	}, 30000);

	it('drains an answered SSR body that is never read while it arrives above the floor', async () => {
		const result = await upload('/ignore', { size: FAST, duration: SUSTAIN });
		expect(result.elapsed).toBeGreaterThanOrEqual(SUSTAIN);
		expect(result.answers).toEqual([{ status: 200, body: 'ok' }, { status: 200, body: 'OK' }]);
	}, 30000);

	it('drains an answered authenticate body that is never read while it arrives above the floor', async () => {
		const result = await upload('/__ws/auth', { size: FAST, duration: SUSTAIN });
		expect(result.elapsed).toBeGreaterThanOrEqual(SUSTAIN);
		expect(result.answers.map(answer => answer.status)).toEqual([204, 200]);
		expect(result.answers[1].body).toBe('OK');
	}, 30000);

	it('gives a reader that starts after the answer and past the deadline the whole body', async () => {
		let read;
		const result = await upload('/late?id=fast', {
			size: FAST, duration: SUSTAIN,
			onAnswer: () => { read = new Promise(resolve => setTimeout(resolve, DEADLINE * 1.5)).then(() => globalThis[slot].fast()); }
		});
		expect(result.answers).toEqual([{ status: 200, body: 'ok' }, { status: 200, body: 'OK' }]);
		expect(await read).toBe(result.sent);
	}, 30000);

	it('fails a late read whose connection the deadline closes instead of leaving it pending', async () => {
		let read;
		const result = await upload('/late?id=slow', {
			size: SLOW,
			onAnswer: () => {
				read = new Promise(resolve => setTimeout(resolve, DEADLINE * 0.3))
					.then(() => globalThis[slot].slow())
					.then(bytes => ({ bytes }), error => ({ error: error.message }));
			}
		});
		cutAtDeadline(result);
		expect(result.answers).toEqual([{ status: 200, body: 'ok' }]);
		const outcome = await Promise.race([read, new Promise(resolve => setTimeout(() => resolve({ pending: true }), 1000))]);
		expect(outcome).toEqual({ error: 'Request aborted' });
	}, 30000);

	it('re-arms the deadline when the answer is sent', async () => {
		const delay = Math.round(DEADLINE * 0.6);
		const result = await upload('/answer-later?ms=' + delay, { size: 16 });
		expect(result.answers).toEqual([{ status: 200, body: 'ok' }]);
		expect(result.elapsed).toBeGreaterThanOrEqual(delay + DEADLINE * 0.8);
		expect(result.elapsed).toBeLessThan(delay + DEADLINE * 1.7);
	}, 30000);

	it.each([
		['SSR', '/ignore', 2 * 1024 ** 3],
		['authenticate', '/__ws/auth', 100 * 1024 ** 2]
	])('closes a refused declared %s length at the deadline however fast it arrives', async (_, target, declared) => {
		const result = await upload(target, { size: FAST, declared });
		cutAtDeadline(result);
		expect(result.answers.map(answer => answer.status)).toEqual([413]);
	}, 30000);

	it('keeps the connection of a refused declared length whose body ended', async () => {
		const socket = net.connect(runtime.port, '127.0.0.1');
		let raw = '', closed = false;
		socket.on('data', bytes => { raw += bytes.toString('latin1'); });
		socket.on('close', () => { closed = true; });
		socket.on('error', () => {});
		try {
			await new Promise(resolve => socket.once('connect', resolve));
			socket.write('POST /__ws/auth HTTP/1.1\r\nHost: localhost\r\nContent-Length: 200000\r\n\r\n' + 'x'.repeat(200000));
			const started = Date.now();
			let sent = 0;
			while (Date.now() - started < DEADLINE * 2) {
				await new Promise(resolve => setTimeout(resolve, DEADLINE / 4));
				if (closed) break;
				socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
				sent++;
			}
			await new Promise(resolve => setTimeout(resolve, 200));
			expect(closed).toBe(false);
			expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 413', ...Array(sent).fill('HTTP/1.1 200')]);
		} finally { socket.destroy(); }
	}, 30000);
});
