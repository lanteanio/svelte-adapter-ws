// createTestServer carries the upgrade's request id to the connection's
// platform the way production does: the X-Request-ID the upgrade sent, or a
// minted id, crossing to `open` on a key private to the runtime and gone from
// userData before any hook reads it. The harness stamps it at two sites, the
// fast path with no upgrade hook and the path behind one, so each has a case.
// The key is a Symbol: an application's own userData property of the name the
// id once crossed on reaches its hooks unchanged, and an accessor for that
// name on Object.prototype is handed nothing.

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

/** The string key the id crossed the upgrade on before it rode a Symbol. */
const OLD_KEY = '__adapter_ws_request_id__';

/** @type {any} */
let server = null;

afterEach(async () => {
	await server?.close();
	server = null;
});

/**
 * Boot a test server whose open hook records what the connection saw, open one
 * client, and resolve the record.
 *
 * @param {Record<string, unknown>} extraHandler
 * @param {Record<string, string>} [headers]
 */
async function openOnce(extraHandler, headers) {
	const { createTestServer } = await import('../src/testing.js');
	/** @type {Array<{ requestId: unknown, keys: string[], symbols: string[], oldKey: unknown }>} */
	const seen = [];
	server = await createTestServer({
		handler: {
			message() {},
			open(/** @type {any} */ ws, /** @type {any} */ ctx) {
				const userData = ws.getUserData();
				seen.push({
					requestId: ctx.platform.requestId,
					keys: Object.keys(userData),
					symbols: Object.getOwnPropertySymbols(userData).map((s) => String(s.description)),
					oldKey: Object.hasOwn(userData, OLD_KEY) ? userData[OLD_KEY] : undefined
				});
			},
			...extraHandler
		}
	});
	const ws = new WebSocket(server.wsUrl, headers ? { headers } : undefined);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
		ws.once('unexpected-response', (_req, res) => reject(new Error('refused ' + res.statusCode)));
	});
	ws.close();
	expect(seen).toHaveLength(1);
	return seen[0];
}

describe('createTestServer hands open the request id the upgrade carried', () => {
	it('on the fast path, with no upgrade hook', async () => {
		const seen = await openOnce({}, { 'x-request-id': 'harness-carry-fast' });
		expect(seen.requestId).toBe('harness-carry-fast');
		expect(seen.symbols.filter((d) => d.includes('carry')), 'the carry slot is deleted before open').toEqual([]);
	});

	it('behind an upgrade hook', async () => {
		const seen = await openOnce({ upgrade: () => ({ role: 'hooked' }) }, { 'x-request-id': 'harness-carry-hooked' });
		expect(seen.requestId).toBe('harness-carry-hooked');
		expect(seen.keys).toContain('role');
		expect(seen.symbols.filter((d) => d.includes('carry')), 'the carry slot is deleted before open').toEqual([]);
	});

	it('mints one when the upgrade sent none', async () => {
		const seen = await openOnce({});
		expect(seen.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

describe('createTestServer carries the id on a key no application can name', () => {
	it("leaves an upgrade hook's own property of the old name to the application", async () => {
		const seen = await openOnce({ upgrade: () => ({ [OLD_KEY]: 'mine' }) }, { 'x-request-id': 'harness-carry-own' });
		expect(seen.requestId).toBe('harness-carry-own');
		expect(seen.oldKey).toBe('mine');
	});

	it('hands an accessor for the old name on Object.prototype nothing', async () => {
		/** @type {unknown[]} */
		const taken = [];
		Object.defineProperty(Object.prototype, OLD_KEY, {
			configurable: true,
			get() { return undefined; },
			set(value) { taken.push(value); }
		});
		try {
			const seen = await openOnce({ upgrade: () => ({ role: 'hooked' }) }, { 'x-request-id': 'harness-carry-proto' });
			expect(seen.requestId).toBe('harness-carry-proto');
		} finally {
			delete (/** @type {any} */ (Object.prototype))[OLD_KEY];
		}
		expect(taken).toEqual([]);
	});
});
