// A TLS socket encrypts everything it is handed into its own output buffer at
// once, so the static lane hands a TLS socket a cached body larger than 64 KiB
// one slice at a time, the next once the socket has written the last. Every
// other write passes through as it was. Drives the built runtime's
// paceStaticTlsWrites with a stand-in socket that records each write it is
// handed and completes it when the test says so.
// test/static-backpressure-tls-real.test.js covers the same lane over real
// TLS sockets with paused readers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const SLICE = 64 * 1024;
const SIZE = 4 * SLICE + 123;

/**
 * A server with one paced connection whose writes complete only on demand.
 * @param {(server: any) => void} pace
 */
function pacedSocket(pace) {
	/** @type {{ writev: boolean, data: any, encoding: string, cb: (error?: Error | null) => void }[]} */
	const calls = [];
	const socket = {
		/**
		 * @param {boolean} writev
		 * @param {any} data
		 * @param {string} encoding
		 * @param {(error?: Error | null) => void} cb
		 */
		_writeGeneric(writev, data, encoding, cb) {
			calls.push({ writev, data: writev ? data.map((/** @type {any} */ entry) => entry.chunk) : data, encoding, cb });
		}
	};
	const server = new EventEmitter();
	pace(server);
	server.emit('secureConnection', socket);
	return { socket: /** @type {any} */ (socket), calls };
}

/**
 * @param {any[]} chunks
 * @param {Buffer} body
 * @param {number} offset
 */
function expectSlices(chunks, body, offset) {
	let at = offset;
	for (const chunk of chunks) {
		expect(chunk.buffer, 'each slice is a view of the cached body').toBe(body.buffer);
		expect(chunk.byteOffset).toBe(body.byteOffset + at);
		expect(chunk.byteLength).toBeLessThanOrEqual(SLICE);
		at += chunk.byteLength;
	}
	expect(at).toBe(body.byteLength);
}

describe('TLS writes of large cached static bodies are paced', () => {
	let dir = '';
	/** @type {any} */
	let pace;
	/** @type {Buffer} */
	let body;
	/** @type {Buffer} */
	let small;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);
		const assets = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');
		pace = assets.paceStaticTlsWrites;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-static-tls-pacing-'));
		fs.writeFileSync(path.join(dir, 'large.bin'), randomBytes(SIZE));
		fs.writeFileSync(path.join(dir, 'slice.bin'), randomBytes(SLICE));
		assets.cacheDir(dir, '/tls-pacing', false);
		body = staticCache.get('/tls-pacing/large.bin').buffer;
		small = staticCache.get('/tls-pacing/slice.bin').buffer;
		expect(body.byteLength).toBe(SIZE);
	}, 400000);

	afterAll(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('hands over the next slice only once the last one was written', () => {
		const { socket, calls } = pacedSocket(pace);
		let done = 0;
		socket._writeGeneric(false, body, 'buffer', () => done++);
		expect(calls).toHaveLength(1);
		for (let i = 1; i < Math.ceil(SIZE / SLICE); i++) {
			calls[i - 1].cb();
			expect(calls).toHaveLength(i + 1);
			expect(done).toBe(0);
		}
		calls.at(-1)?.cb();
		expect(done).toBe(1);
		expect(calls.every((call) => !call.writev && call.encoding === 'buffer')).toBe(true);
		expectSlices(calls.map((call) => call.data), body, 0);
	});

	it('paces a range of a cached body', () => {
		const { socket, calls } = pacedSocket(pace);
		const range = body.subarray(5);
		socket._writeGeneric(false, range, 'buffer', () => {});
		while (calls.length < Math.ceil(range.byteLength / SLICE)) calls.at(-1)?.cb();
		expectSlices(calls.map((call) => call.data), range, 0);
	});

	it('sends the response head with the first slice of a batched body', () => {
		const { socket, calls } = pacedSocket(pace);
		const head = 'HTTP/1.1 200 OK\r\n\r\n';
		const batch = /** @type {any} */ ([{ chunk: head, encoding: 'latin1' }, { chunk: body, encoding: 'buffer' }, { chunk: '', encoding: 'latin1' }]);
		batch.allBuffers = false;
		let done = 0;
		socket._writeGeneric(true, batch, '', () => done++);
		while (done === 0) calls.at(-1)?.cb();
		expect(calls[0].writev).toBe(true);
		expect(calls[0].data[0]).toBe(head);
		expect(calls[0].data).toHaveLength(2);
		const slices = calls.flatMap((call) => call.writev ? call.data.filter((/** @type {any} */ chunk) => typeof chunk !== 'string') : [call.data]);
		expectSlices(slices, body, 0);
		expect(calls.at(-1)?.writev).toBe(true);
		expect(calls.at(-1)?.data.at(-1)).toBe('');
	});

	it('passes every other write through as one write', () => {
		const { socket, calls } = pacedSocket(pace);
		const callback = () => {};
		socket._writeGeneric(false, small, 'buffer', callback);
		const foreign = Buffer.alloc(SIZE);
		socket._writeGeneric(false, foreign, 'buffer', callback);
		socket._writeGeneric(false, 'text', 'utf8', callback);
		expect(calls.map((call) => call.data)).toEqual([small, foreign, 'text']);
		expect(calls.every((call) => call.cb === callback)).toBe(true);
	});

	it('stops at the first failed slice and reports it once', () => {
		const { socket, calls } = pacedSocket(pace);
		/** @type {any[]} */
		const results = [];
		socket._writeGeneric(false, body, 'buffer', (/** @type {any} */ error) => results.push(error));
		calls[0].cb();
		const failure = new Error('write EPIPE');
		calls[1].cb(failure);
		expect(calls).toHaveLength(2);
		expect(results).toEqual([failure]);
	});
});
