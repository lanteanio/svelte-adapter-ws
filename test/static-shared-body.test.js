// A static body is handed to node as a view of the startup cache, never as a
// copy. node's socket write keeps a reference to the Buffer it is given until
// the peer has read it, so a copy made here would be retained for as long as a
// slow reader stalls - one unsent body per connection. A view costs nothing per
// connection: every stalled reader pins the same cached bytes.
//
// Drives the built runtime's serveStatic with a stand-in response that records
// what end() receives, for a full body, a range, and a precompressed
// representation. test/static-backpressure-real.test.js covers the same lane
// over real sockets with paused readers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const SIZE = 1024 * 1024;

function recorder() {
	const rec = { status: 0, /** @type {Buffer | undefined} */ body: undefined, res: /** @type {any} */ (null) };
	rec.res = {
		writeHead(/** @type {number} */ status) { rec.status = status; return rec.res; },
		end(/** @type {Buffer | undefined} */ body) { rec.body = body; return rec.res; }
	};
	return rec;
}

/**
 * @param {Buffer | undefined} body
 * @param {Buffer} cached
 * @param {number} offset
 */
function expectView(body, cached, offset) {
	expect(Buffer.isBuffer(body)).toBe(true);
	const view = /** @type {Buffer} */ (body);
	expect(view.buffer, 'the body must share the cached allocation').toBe(cached.buffer);
	expect(view.byteOffset).toBe(cached.byteOffset + offset);
}

describe('static bodies are views of the startup cache', () => {
	let dir = '';
	/** @type {any} */
	let entry;
	/** @type {any} */
	let serveStatic;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);
		const assets = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');
		serveStatic = assets.serveStatic;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-static-shared-'));
		const bytes = Buffer.alloc(SIZE, 'a');
		fs.writeFileSync(path.join(dir, 'large.bin'), bytes);
		fs.writeFileSync(path.join(dir, 'large.bin.br'), zlib.brotliCompressSync(bytes));
		assets.cacheDir(dir, '/shared-body', false);
		entry = staticCache.get('/shared-body/large.bin');
		expect(entry.buffer.byteLength).toBe(SIZE);
		expect(entry.brBuffer, 'the fixture build precompresses').toBeDefined();
	}, 400000);

	afterAll(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('serves the full identity body as the cached buffer', () => {
		const rec = recorder();
		serveStatic(rec.res, entry, 'identity', '', false);
		expect(rec.status).toBe(200);
		expectView(rec.body, entry.buffer, 0);
		expect(rec.body?.byteLength).toBe(SIZE);
	});

	it('serves a range as a view into the cached buffer', () => {
		const rec = recorder();
		serveStatic(rec.res, entry, 'identity', '', false, 'bytes=113-');
		expect(rec.status).toBe(206);
		expectView(rec.body, entry.buffer, 113);
		expect(rec.body?.byteLength).toBe(SIZE - 113);
	});

	it('serves a precompressed representation and its ranges from the cached coding', () => {
		const full = recorder();
		serveStatic(full.res, entry, 'br', '', false);
		expect(full.status).toBe(200);
		expectView(full.body, entry.brBuffer, 0);
		const ranged = recorder();
		serveStatic(ranged.res, entry, 'br', '', false, 'bytes=5-');
		expect(ranged.status).toBe(206);
		expectView(ranged.body, entry.brBuffer, 5);
	});
});
