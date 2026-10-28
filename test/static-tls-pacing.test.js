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
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const SLICE = 64 * 1024;
const SIZE = 4 * SLICE + 123;

/**
 * A server with one paced connection whose writes complete only on demand.
 * @param {(server: any) => void} pace
 * @param {(cb: (error?: Error | null) => void) => void} [complete]
 */
function pacedSocket(pace, complete) {
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
			complete?.(cb);
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
	/** @type {Buffer[]} */
	let compressed;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);
		const assets = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');
		pace = assets.paceStaticTlsWrites;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-static-tls-pacing-'));
		const bytes = Buffer.concat([randomBytes(2 * SLICE), Buffer.alloc(SIZE - 2 * SLICE)]);
		fs.writeFileSync(path.join(dir, 'large.bin'), bytes);
		fs.writeFileSync(path.join(dir, 'slice.bin'), randomBytes(SLICE));
		fs.writeFileSync(path.join(dir, 'large.bin.br'), brotliCompressSync(bytes));
		fs.writeFileSync(path.join(dir, 'large.bin.gz'), gzipSync(bytes));
		assets.cacheDir(dir, '/tls-pacing', false);
		const entry = staticCache.get('/tls-pacing/large.bin');
		body = entry.buffer;
		compressed = [entry.brBuffer, entry.gzBuffer];
		for (const encoded of compressed) expect(encoded?.byteLength).toBeGreaterThan(SLICE);
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

	it.each([['br', 0], ['gzip', 1]])('paces the cached %s representation', (_coding, index) => {
		const { socket, calls } = pacedSocket(pace);
		const bytes = compressed[Number(index)];
		let done = 0;
		socket._writeGeneric(false, bytes, 'buffer', () => done++);
		while (done === 0) calls.at(-1)?.cb();
		expect(calls).toHaveLength(Math.ceil(bytes.byteLength / SLICE));
		expectSlices(calls.map((call) => call.data), bytes, 0);
	});

	it('drains synchronous completions without nesting socket writes', () => {
		let depth = 0;
		let maximum = 0;
		const { socket, calls } = pacedSocket(pace, (cb) => {
			depth++;
			maximum = Math.max(maximum, depth);
			cb();
			depth--;
		});
		let done = 0;
		socket._writeGeneric(false, body, 'buffer', () => done++);
		expect(maximum).toBe(1);
		expect(done).toBe(1);
		expectSlices(calls.map((call) => call.data), body, 0);
	});

	it('resumes synchronous slices after an asynchronous completion', () => {
		let writes = 0;
		const { socket, calls } = pacedSocket(pace, (cb) => {
			if (++writes !== 3) cb();
		});
		let done = 0;
		socket._writeGeneric(false, body, 'buffer', () => done++);
		expect(calls).toHaveLength(3);
		expect(done).toBe(0);
		calls[2].cb();
		expect(done).toBe(1);
		expectSlices(calls.map((call) => call.data), body, 0);
	});

	it('reports a synchronous write failure once and stops', () => {
		const failure = new Error('write EPIPE');
		const { socket, calls } = pacedSocket(pace, (cb) => cb(failure));
		/** @type {(Error | null | undefined)[]} */
		const results = [];
		socket._writeGeneric(false, body, 'buffer', (error) => results.push(error));
		expect(calls).toHaveLength(1);
		expect(results).toEqual([failure]);
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
		expect(calls).toHaveLength(3);
		expect(calls[0].data === small).toBe(true);
		expect(calls[1].data === foreign).toBe(true);
		expect(calls[2].data).toBe('text');
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
