// A WebSocket message or a handshake handed to the application ends every
// open HTTP turn, as on the native tier where that handler's call is its own
// turn: on the BUILT runtime and on createTestServer. The frame or handshake
// is put on the wire while a stand-in turn is opened in the same callback,
// so the server reads it in the next poll phase, before the check phase that
// would end the turn anyway; the application's hook records whether the
// stand-in's turn was still open when it ran.

import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { createTestServer } from '../src/testing.js';
import * as mirrorHelpers from '../src/runtime/handler/http-helpers.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false,
	adminAuthAcknowledged: true
};

const HANDSHAKE = 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

/** The application's hooks report to the test through this. */
const WS_HANDLER = 'export function message() { globalThis.__turnProbe?.("message"); }\n' +
	'export function upgrade() { globalThis.__turnProbe?.("upgrade"); return {}; }\n';

/** A stand-in connection for the line, as in test/http-turn.test.js. */
function connection() {
	const socket = /** @type {any} */ ({ corked: 0, writableLength: 0, destroyed: false, cork() { this.corked++; }, uncork() { if (this.corked > 0) this.corked--; } });
	Object.defineProperty(socket, 'writableCorked', { get() { return this.corked; } });
	return { socket, req: /** @type {any} */ ({ socket }), res: /** @type {any} */ ({ socket, writableEnded: false, _last: false, on() {} }) };
}

/**
 * Puts `send` on the wire, keeps the loop busy so the bytes are waiting in
 * the server's socket when the callback returns, opens a stand-in turn with
 * the same line module the server uses, and resolves with what the hook saw.
 *
 * @param {{ servePipelined: Function, inOwnTurn: Function }} helpers
 * @param {() => void} send
 * @param {string} kind
 */
function dispatchDuringTurn(helpers, send, kind) {
	return new Promise((resolve) => {
		/** @type {Array<boolean | null>} */
		const seen = [];
		setTimeout(() => {
			send();
			const until = Date.now() + 20;
			while (Date.now() < until) { /* the frame reaches the server socket */ }
			const standIn = connection();
			/** @type {any} */ (globalThis).__turnProbe = (/** @type {string} */ hook) => { if (hook === kind) seen.push(helpers.inOwnTurn(standIn.res)); };
			helpers.servePipelined(standIn.req, standIn.res, () => {});
			setTimeout(() => { delete /** @type {any} */ (globalThis).__turnProbe; resolve(seen); }, 100);
		}, 5);
	});
}

/** @param {number} port */
function openClient(port) {
	return new Promise((resolve, reject) => {
		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		client.once('open', () => resolve(client));
		client.once('error', reject);
	});
}

/** @param {number} port */
function openRaw(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
		socket.once('error', reject);
	});
}

describe('the built runtime', () => {
	/** @type {any} */ let open;
	/** @type {any} */ let helpers;

	beforeAll(async () => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
			wsHandlerSource: WS_HANDLER
		});
		open = { payload, rt: await bootRuntime(payload) };
		helpers = await import(pathToFileURL(path.join(payload.dir, 'handler', 'http-helpers.js')).href);
	}, 60000);

	afterAll(async () => {
		await open?.rt.close();
		open?.payload.cleanup();
	});

	it('ends an open turn when a WebSocket message is handed to the application', async () => {
		const client = await openClient(open.rt.port);
		for (let i = 0; i < 3; i++) {
			expect(await dispatchDuringTurn(helpers, () => client.send('x'), 'message')).toEqual([false]);
		}
		client.close();
	});

	it('ends an open turn when a handshake is handed to the application', async () => {
		for (let i = 0; i < 3; i++) {
			const socket = /** @type {net.Socket} */ (await openRaw(open.rt.port));
			expect(await dispatchDuringTurn(helpers, () => socket.write(HANDSHAKE), 'upgrade')).toEqual([false]);
			socket.destroy();
		}
	});
});

describe('createTestServer', () => {
	/** @type {any} */ let mirror;
	const helpers = mirrorHelpers;

	beforeAll(async () => {
		mirror = await createTestServer({
			handler: {
				message() { /** @type {any} */ (globalThis).__turnProbe?.('message'); },
				upgrade() { /** @type {any} */ (globalThis).__turnProbe?.('upgrade'); return {}; }
			}
		});
	}, 60000);

	afterAll(async () => {
		await mirror?.close();
	});

	it('ends an open turn when a WebSocket message is handed to the application', async () => {
		const client = await openClient(mirror.port);
		for (let i = 0; i < 3; i++) {
			expect(await dispatchDuringTurn(helpers, () => client.send('x'), 'message')).toEqual([false]);
		}
		client.close();
	});

	it('ends an open turn when a handshake is handed to the application', async () => {
		for (let i = 0; i < 3; i++) {
			const socket = /** @type {net.Socket} */ (await openRaw(mirror.port));
			expect(await dispatchDuringTurn(helpers, () => socket.write(HANDSHAKE), 'upgrade')).toEqual([false]);
			socket.destroy();
		}
	});
});
