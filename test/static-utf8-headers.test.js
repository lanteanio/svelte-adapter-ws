// A built asset's headers go out as the bytes the native tier writes: a value
// past ASCII - a download's file name, a configured header - as its UTF-8
// bytes. node re-encodes a content-disposition written after a content-length
// as latin1, so the length goes last, and a download whose name is not ASCII
// is served.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const U_UMLAUT = String.fromCharCode(220);
const ZIP = U_UMLAUT + 'bersicht.zip';
const ZIP_TARGET = '/%C3%9Cbersicht.zip';
const utf8Wire = (/** @type {string} */ text) => Buffer.from(text, 'utf8').toString('latin1');

/**
 * One request on its own socket; the head lines read as latin1, one character
 * per byte, so a value is compared as the bytes on the wire.
 *
 * @param {number} port
 * @param {string[]} lines
 * @returns {Promise<{ status: string, lines: string[] }>}
 */
function exchange(port, lines) {
	return new Promise((resolve, reject) => {
		let raw = '';
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write([...lines, 'Host: 127.0.0.1', 'Connection: close'].join('\r\n') + '\r\n\r\n');
		});
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('close', () => {
			const head = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
			resolve({ status: head[0], lines: head.slice(1) });
		});
		socket.on('error', reject);
		socket.setTimeout(5000, () => socket.destroy());
	});
}

/** @param {string[]} lines @param {string} name */
const header = (lines, name) => lines
	.filter((line) => line.toLowerCase().startsWith(name + ':'))
	.map((line) => line.slice(name.length + 1).trim());

describe('a built asset\'s headers past ASCII', () => {
	/** @type {any} */ let payload;
	/** @type {any} */ let rt;

	beforeAll(async () => {
		payload = buildRuntime({
			files: {
				['client/' + ZIP]: 'PK-fake-zip-bytes',
				'client/plain.txt': 'plain'
			},
			replace: {
				STATIC_HEADERS: JSON.stringify({ 'x-note': 'caf' + String.fromCharCode(233) })
			}
		});
		rt = await bootRuntime(payload);
	}, 60000);

	afterAll(async () => {
		await rt?.close();
		payload?.cleanup();
	});

	it('names a download whose file name is not ASCII by its UTF-8 bytes, on GET, HEAD and a range', async () => {
		const disposition = `attachment; filename="${utf8Wire(ZIP)}"`;
		for (const lines of [[`GET ${ZIP_TARGET} HTTP/1.1`], [`HEAD ${ZIP_TARGET} HTTP/1.1`]]) {
			const answer = await exchange(rt.port, lines);
			expect(answer.status, lines[0]).toBe('HTTP/1.1 200 OK');
			expect(header(answer.lines, 'content-disposition'), lines[0]).toEqual([disposition]);
		}
		const range = await exchange(rt.port, [`GET ${ZIP_TARGET} HTTP/1.1`, 'Range: bytes=0-1']);
		expect(range.status).toBe('HTTP/1.1 206 Partial Content');
		expect(header(range.lines, 'content-disposition')).toEqual([disposition]);
		// The worker is still serving.
		expect((await exchange(rt.port, ['GET /plain.txt HTTP/1.1'])).status).toBe('HTTP/1.1 200 OK');
	});

	it('writes a configured header past ASCII as its UTF-8 bytes', async () => {
		const answer = await exchange(rt.port, ['GET /plain.txt HTTP/1.1']);
		expect(answer.status).toBe('HTTP/1.1 200 OK');
		expect(header(answer.lines, 'x-note')).toEqual([utf8Wire('caf' + String.fromCharCode(233))]);
	});
});
