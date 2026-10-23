// Large static answers over TLS with readers that stop reading. A TLS socket
// encrypts everything it is handed into its own output buffer, so a body
// handed over whole would leave one encrypted copy per stalled reader; the
// static lane hands it over a slice per writable socket instead. The built
// runtime runs in a child process with the fixture certificate, as the plain
// suite in test/static-backpressure-real.test.js runs it without one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const SIZE = 32 * 1024 * 1024;
const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
const digest = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
	const socket = net.createServer();
	await new Promise((resolve) => socket.listen(0, '127.0.0.1', () => resolve(undefined)));
	const port = /** @type {import('node:net').AddressInfo} */ (socket.address()).port;
	await new Promise((resolve) => socket.close(() => resolve(undefined)));
	return port;
}

/**
 * @param {number} port
 * @param {string} method
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number | undefined, headers: import('node:http').IncomingHttpHeaders, length: number, hash: string }>}
 */
function response(port, method, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = https.request({ host: '127.0.0.1', port, method, path: '/large-static/media.bin', headers, rejectUnauthorized: false, agent: false }, (res) => {
			const hash = createHash('sha256');
			let length = 0;
			res.on('data', (chunk) => { length += chunk.length; hash.update(chunk); });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, length, hash: hash.digest('hex') }));
			res.on('error', reject);
		});
		req.setTimeout(15000, () => req.destroy(new Error('static response timed out')));
		req.on('error', reject);
		req.end();
	});
}

/**
 * A TLS reader that pauses as soon as it has the response head.
 * @param {number} port
 * @param {string} coding
 * @param {string} range
 * @returns {Promise<{ socket: import('node:tls').TLSSocket, status: number, headers: Record<string, string>, resume: () => Promise<{ length: number, hash: string }> }>}
 */
function hold(port, coding = 'identity', range = 'bytes=0-') {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, highWaterMark: 1024 }, () => {
			socket.write('GET /large-static/media.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept-Encoding: ' + coding + '\r\nRange: ' + range + '\r\n\r\n');
		});
		const hash = createHash('sha256');
		let length = 0;
		/** @type {Buffer | null} */
		let headerBytes = Buffer.alloc(0);
		let headed = false;
		/** @type {(value: { length: number, hash: string }) => void} */
		let finish = () => {};
		const done = new Promise((resolveDone) => { finish = resolveDone; });
		socket.setTimeout(15000, () => socket.destroy(new Error('held response timed out')));
		socket.on('error', reject);
		socket.on('data', (chunk) => {
			if (!headed) {
				headerBytes = Buffer.concat([/** @type {Buffer} */ (headerBytes), chunk]);
				const end = headerBytes.indexOf('\r\n\r\n');
				if (end < 0) return;
				const lines = headerBytes.subarray(0, end).toString('latin1').split('\r\n');
				/** @type {Record<string, string>} */
				const headers = {};
				for (const line of lines.slice(1)) {
					const colon = line.indexOf(':');
					headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
				}
				chunk = headerBytes.subarray(end + 4);
				headerBytes = null;
				headed = true;
				socket.pause();
				resolve({ socket, status: Number(lines[0].split(' ')[1]), headers, resume: () => { socket.resume(); return done; } });
			}
			length += chunk.length;
			hash.update(chunk);
		});
		socket.on('end', () => finish({ length, hash: hash.digest('hex') }));
	});
}

describe('large static response backpressure over TLS', () => {
	/** @type {string} */
	let dir;
	/** @type {import('node:child_process').ChildProcess} */
	let child;
	/** @type {number} */
	let port;
	let childErrors = '';
	let serial = 0;
	const pending = new Map();
	/** @type {Set<import('node:tls').TLSSocket>} */
	const sockets = new Set();
	/** @type {Record<string, Buffer>} */
	const bodies = {};

	beforeAll(async () => {
		expect(buildFixtureOnce()).toBe(true);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-large-static-tls-'));
		bodies.identity = Buffer.alloc(SIZE);
		randomBytes(8 * 1024 * 1024).copy(bodies.identity);
		bodies.br = zlib.brotliCompressSync(bodies.identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
		for (const [coding, bytes] of Object.entries(bodies)) {
			expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
			fs.writeFileSync(path.join(dir, 'media.bin' + (coding === 'identity' ? '' : '.br')), bytes);
		}
		port = await freePort();
		child = fork(fileURLToPath(new URL('./helpers/static-backpressure-child.js', import.meta.url)), [dir, String(port)], {
			execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			env: {
				...process.env,
				ORIGIN: 'https://127.0.0.1:' + port,
				SSL_CERT: path.join(certs, 'localhost.crt'),
				SSL_KEY: path.join(certs, 'localhost.key'),
				SSL_WATCH: '0'
			}
		});
		/** @type {any} */ (child.stderr).on('data', (/** @type {Buffer} */ chunk) => { childErrors += chunk; });
		child.on('message', (/** @type {any} */ message) => pending.get(message.id)?.(message));
		await new Promise((resolve, reject) => {
			child.once('message', resolve);
			child.once('exit', (code) => reject(new Error('static server exited ' + code + ': ' + childErrors)));
		});
	}, 400000);

	afterAll(async () => {
		for (const socket of sockets) socket.destroy();
		if (child && child.exitCode === null) {
			const stopped = new Promise((resolve) => child.once('exit', resolve));
			child.send({ op: 'stop' });
			await stopped;
		}
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	async function memory() {
		const id = ++serial;
		const result = await new Promise((resolve) => { pending.set(id, resolve); child.send({ id, op: 'memory' }); });
		pending.delete(id);
		return /** @type {any} */ (result).rss;
	}

	it('keeps resident memory bounded while eight TLS clients stop reading an open-ended range', async () => {
		await response(port, 'HEAD');
		const before = await memory();
		const held = [];
		for (let i = 0; i < 8; i++) {
			const peer = await hold(port);
			sockets.add(peer.socket);
			held.push(peer);
			expect(peer.status).toBe(206);
			expect(peer.headers['content-length']).toBe(String(SIZE));
		}
		await delay(150);
		const delta = (await memory()) - before;
		expect(delta, 'eight paused TLS readers must not each hold an encrypted copy of a 32 MiB file').toBeLessThan(SIZE * 3);
		for (const peer of held) { peer.socket.destroy(); sockets.delete(peer.socket); }
		await delay(50);
		const healthy = await response(port, 'GET', { Range: 'bytes=17-1030' });
		expect(healthy.status).toBe(206);
		expect(healthy.hash).toBe(digest(bodies.identity.subarray(17, 1031)));
	}, 30000);

	it.each(['identity', 'br'])('resumes paused %s bytes over TLS without loss or duplication', async (coding) => {
		const peer = await hold(port, coding, 'bytes=113-');
		sockets.add(peer.socket);
		expect(peer.status).toBe(206);
		await delay(50);
		const received = await peer.resume();
		sockets.delete(peer.socket);
		const expected = bodies[coding].subarray(113);
		expect(received.length).toBe(expected.length);
		expect(received.hash).toBe(digest(expected));
	}, 30000);

	it.each(['identity', 'br'])('serves a complete %s body over TLS', async (coding) => {
		const full = await response(port, 'GET', { 'Accept-Encoding': coding });
		expect(full.status).toBe(200);
		expect(full.length).toBe(bodies[coding].length);
		expect(full.hash).toBe(digest(bodies[coding]));
	}, 30000);
});
