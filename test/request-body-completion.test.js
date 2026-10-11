import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const prefix = 'BODY_COMPLETION_TEST_';
const slot = Symbol.for('body-completion-test-reader');
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const serverSource = `
const outcome = promise => promise.then(value => ({ done: value.done, bytes: value.value?.byteLength || 0 }), error => ({ error: error.message }));
export class Server {
	async init() {}
	async respond(request) {
		if (request.method !== 'POST') return new Response('ok');
		if (new URL(request.url).pathname === '/unread') {
			globalThis[Symbol.for('body-completion-test-reader')] = { read: () => request.text() };
			return new Response('ok');
		}
		const reader = request.body.getReader();
		const first = await reader.read();
		const mode = new URL(request.url).pathname.slice(1);
		if (mode === 'complete' && !first.done) await reader.read();
		const pending = mode === 'pending' ? outcome(reader.read()) : null;
		globalThis[Symbol.for('body-completion-test-reader')] = {
			first: { done: first.done, bytes: first.value?.byteLength || 0 },
			read: (() => { let next = pending; return () => { const value = next || outcome(reader.read()); next = null; return value; }; })()
		};
		return new Response('ok');
	}
}`;

function conversation(port, secure) {
	const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
	const answers = [];
	let pending = Buffer.alloc(0), failure, wake;
	const changed = () => { wake?.(); wake = null; };
	socket.on('data', bytes => {
		pending = Buffer.concat([pending, bytes]);
		for (;;) {
			const end = pending.indexOf('\r\n\r\n');
			if (end < 0) break;
			const head = pending.subarray(0, end).toString('latin1');
			const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
			const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);
			if (!Number.isSafeInteger(length)) { failure = new Error('Missing response framing'); break; }
			if (pending.length < end + 4 + length) break;
			answers.push({ status, body: pending.subarray(end + 4, end + 4 + length).toString() });
			pending = pending.subarray(end + 4 + length);
		}
		changed();
	});
	socket.on('error', error => { failure = error; changed(); });
	socket.on('close', () => { failure ||= new Error('Connection closed before expected answer'); changed(); });
	const connected = new Promise(resolve => socket.once(secure ? 'secureConnect' : 'connect', resolve));
	return {
		socket, connected, answers,
		async until(count) {
			const deadline = Date.now() + 3000;
			while (answers.length < count) {
				if (failure) throw failure;
				if (Date.now() >= deadline) throw new Error('Following HTTP request stalled');
				await new Promise(resolve => {
					const timer = setTimeout(resolve, 25);
					wake = () => { clearTimeout(timer); resolve(); };
				});
			}
		}
	};
}

describe.each([false, true])('request readers after response completion over TLS=%s', secure => {
	let payload, runtime;
	beforeAll(async () => {
		if (secure) {
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({ replace: { ENV_PREFIX: JSON.stringify(prefix) }, serverSource });
		try { runtime = await bootRuntime(payload); }
		catch (error) { throw new Error('Runtime setup failed: ' + (error?.stack || String(error))); }
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup(); delete globalThis[slot];
		for (const name of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + name];
	});
	it.each(['pending', 'late'])('continues a %s reader after the response with a partial body', async mode => {
		const wire = conversation(runtime.port, secure);
		try {
			await wire.connected;
			wire.socket.write(`POST /${mode} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 70000\r\n\r\nabc`);
			await wire.until(1);
			expect(wire.answers).toEqual([{ status: 200, body: 'ok' }]);
			expect(globalThis[slot].first).toEqual({ done: false, bytes: 3 });
			const remainder = 'd'.repeat(69997);
			wire.socket.write(remainder + 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			let bytes = 0;
			for (;;) {
				const chunk = await globalThis[slot].read();
				expect(chunk.error).toBeUndefined();
				bytes += chunk.bytes;
				if (chunk.done) break;
			}
			expect(bytes).toBe(69997);
			await wire.until(2);
			expect(wire.answers).toEqual([{ status: 200, body: 'ok' }, { status: 200, body: 'OK' }]);
		} finally { wire.socket.destroy(); }
	});
	it.each([3, 200000])('preserves %i bytes first read after the response', async bytes => {
		const wire = conversation(runtime.port, secure);
		try {
			await wire.connected;
			const body = 'x'.repeat(bytes);
			wire.socket.write(`POST /unread HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${bytes}\r\n\r\n${body}`);
			await wire.until(1);
			await new Promise(resolve => setTimeout(resolve, 300));
			expect(await globalThis[slot].read()).toBe(body);
			wire.socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			await wire.until(2);
			expect(wire.answers[1]).toEqual({ status: 200, body: 'OK' });
		} finally { wire.socket.destroy(); }
	});
	it.each(['abc', ''])('preserves a completely consumed body of %s', async body => {
		const wire = conversation(runtime.port, secure);
		try {
			await wire.connected;
			wire.socket.write(`POST /complete HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
			await wire.until(1);
			expect(wire.answers).toEqual([{ status: 200, body: 'ok' }]);
			expect(await globalThis[slot].read()).toEqual({ done: true, bytes: 0 });
			wire.socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			await wire.until(2);
			expect(wire.answers[1]).toEqual({ status: 200, body: 'OK' });
		} finally { wire.socket.destroy(); }
	});
});
