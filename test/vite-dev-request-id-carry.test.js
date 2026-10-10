// vite dev carries the upgrade's request id to `open` on a key no application
// can name, as createTestServer does: an application's own upgrade userData
// property named as WS_REQUEST_ID_KEY spells it reaches its hooks unchanged,
// and an accessor for that name on Object.prototype is handed nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { bootViteDev } from './helpers/vite-dev.js';

/** The name WS_REQUEST_ID_KEY spells, which no carry slot uses. */
const REQUEST_ID_NAME = '__adapter_uws_request_id__';

const savedOrigin = process.env.ORIGIN;

/** @type {Awaited<ReturnType<typeof bootViteDev>> | null} */
let server = null;

afterEach(async () => {
	await server?.close();
	server = null;
	if (savedOrigin === undefined) delete process.env.ORIGIN;
	else process.env.ORIGIN = savedOrigin;
});

/**
 * Boot the plugin with an upgrade hook and an open hook that records what the
 * connection saw, open one client sending `requestId`, and resolve the record.
 *
 * @param {() => Record<string, unknown>} upgrade
 * @param {string} requestId
 */
async function openOnce(upgrade, requestId) {
	/** @type {Array<{ requestId: unknown, namedValue: unknown }>} */
	const seen = [];
	delete process.env.ORIGIN;
	server = await bootViteDev({
		pluginOptions: { devSkipOriginCheck: true },
		handler: {
			upgrade,
			message() {},
			open(/** @type {any} */ ws, /** @type {any} */ ctx) {
				const userData = ws.getUserData();
				seen.push({
					requestId: ctx.platform.requestId,
					namedValue: Object.hasOwn(userData, REQUEST_ID_NAME) ? userData[REQUEST_ID_NAME] : undefined
				});
			}
		}
	});
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { 'x-request-id': requestId } });
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
		ws.once('unexpected-response', (_req, res) => reject(new Error('refused ' + res.statusCode)));
	});
	await vi.waitFor(() => expect(seen).toHaveLength(1));
	ws.close();
	return seen[0];
}

describe('vite dev carries the id on a key no application can name', () => {
	it("leaves an upgrade hook's own property named as WS_REQUEST_ID_KEY spells it to the application", async () => {
		const seen = await openOnce(() => ({ [REQUEST_ID_NAME]: 'mine' }), 'dev-carry-own');
		expect(seen.requestId).toBe('dev-carry-own');
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
			const seen = await openOnce(() => ({ role: 'hooked' }), 'dev-carry-proto');
			expect(seen.requestId).toBe('dev-carry-proto');
		} finally {
			delete (/** @type {any} */ (Object.prototype))[REQUEST_ID_NAME];
		}
		expect(taken).toEqual([]);
	});
});
