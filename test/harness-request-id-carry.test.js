// createTestServer carries the upgrade's request id to the connection's
// platform the way production does: the X-Request-ID the upgrade sent, or a
// minted id, crossing to `open` on a key private to the runtime and gone from
// userData before any hook reads it. The harness stamps it at two sites, the
// fast path with no upgrade hook and the path behind one, so each has a case.
// The key is a Symbol: an application's own userData property named as
// WS_REQUEST_ID_KEY spells it reaches its hooks unchanged, and an accessor for
// that name on Object.prototype is handed nothing.

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

/** The name WS_REQUEST_ID_KEY spells, which no carry slot uses. */
const REQUEST_ID_NAME = '__adapter_ws_request_id__';

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
	/** @type {Array<{ requestId: unknown, keys: string[], symbols: string[], namedValue: unknown }>} */
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
					namedValue: Object.hasOwn(userData, REQUEST_ID_NAME) ? userData[REQUEST_ID_NAME] : undefined
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
	it("leaves an upgrade hook's own property named as WS_REQUEST_ID_KEY spells it to the application", async () => {
		const seen = await openOnce({ upgrade: () => ({ [REQUEST_ID_NAME]: 'mine' }) }, { 'x-request-id': 'harness-carry-own' });
		expect(seen.requestId).toBe('harness-carry-own');
		expect(seen.namedValue).toBe('mine');
	});

	it('hands an accessor for that name on Object.prototype nothing', async () => {
		/** @type {unknown[]} */
		const taken = [];
		Object.defineProperty(Object.prototype, REQUEST_ID_NAME, {
			configurable: true,
			get() { return undefined; },
			set(value) { taken.push(value); }
		});
		try {
			const seen = await openOnce({ upgrade: () => ({ role: 'hooked' }) }, { 'x-request-id': 'harness-carry-proto' });
			expect(seen.requestId).toBe('harness-carry-proto');
		} finally {
			delete (/** @type {any} */ (Object.prototype))[REQUEST_ID_NAME];
		}
		expect(taken).toEqual([]);
	});
});
