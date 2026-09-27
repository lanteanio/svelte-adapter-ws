// What the app's close hook reads when the server closed the connection
// itself. The family's native tier hands it the code and reason the server
// sent - 0 when it sent no code - where the `ws` library underneath this
// adapter reports whatever the peer answered with (1005 for an empty close).
// A close() sends no frame at all, so it reads 1006 on both.
//
// Driven on the built runtime and on createTestServer, whose transports both
// run on `ws`, with a client that answers every close.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

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
	unsafeSameOriginWithoutHostPin: false
};

// The payload runs in this process, so the close hook reports through a
// global the cases read.
const HANDLER = `
export function message(ws, { data }) {
	const cmd = JSON.parse(Buffer.from(data).toString());
	if (cmd.op === 'end') ws.end(cmd.code, cmd.reason);
	if (cmd.op === 'drop') ws.close();
}
export function close(ws, ctx) {
	(globalThis.__closeCodes ??= []).push({ code: ctx.code, reason: Buffer.from(ctx.message).toString() });
}
`;

/** @type {any} */ let built;

beforeAll(async () => {
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: HANDLER
	});
	built = { payload, rt: await bootRuntime(payload) };
}, 60000);

afterAll(async () => {
	await built?.rt.close();
	built?.payload.cleanup();
});

/**
 * Open a client, send one command, and resolve once both sides have seen the
 * close: what the client read, and what the close hook was handed.
 * @param {string} url
 * @param {object} cmd
 */
async function closeWith(url, cmd) {
	const g = /** @type {any} */ (globalThis);
	g.__closeCodes = [];
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const client = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
	ws.send(JSON.stringify(cmd));
	const peer = await client;
	const deadline = Date.now() + 2000;
	while (g.__closeCodes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	return { peer, server: g.__closeCodes[0] };
}

const SURFACES = [
	{ label: 'the built runtime', url: () => `ws://127.0.0.1:${built.rt.port}/ws`, handler: null },
	{ label: 'createTestServer', url: null, handler: true }
];

describe.each(SURFACES)('the close hook on $label', ({ url, handler }) => {
	/** @type {any} */ let server = null;
	/** @type {() => string} */ let wsUrl;

	beforeAll(async () => {
		if (handler) {
			const { createTestServer } = await import('../src/testing.js');
			server = await createTestServer({
				handler: {
					message(ws, { data }) {
						const cmd = JSON.parse(Buffer.from(data).toString());
						if (cmd.op === 'end') ws.end(cmd.code, cmd.reason);
						if (cmd.op === 'drop') ws.close();
					},
					close(ws, ctx) {
						(/** @type {any} */ (globalThis).__closeCodes ??= []).push({ code: ctx.code, reason: Buffer.from(ctx.message).toString() });
					}
				}
			});
			wsUrl = () => server.wsUrl;
		} else {
			wsUrl = /** @type {() => string} */ (url);
		}
	});

	afterAll(async () => { await server?.close(); });

	it('reads 0 and no reason for a close the server sent with no code', async () => {
		const { peer, server: seen } = await closeWith(wsUrl(), { op: 'end' });
		expect(peer.code).toBe(1005);
		expect(seen).toEqual({ code: 0, reason: '' });
	});

	it('reads the code and reason the server sent', async () => {
		const { peer, server: seen } = await closeWith(wsUrl(), { op: 'end', code: 4401, reason: 'Unauthorized' });
		expect(peer).toEqual({ code: 4401, reason: 'Unauthorized' });
		expect(seen).toEqual({ code: 4401, reason: 'Unauthorized' });
	});

	it('reads 1006 for a close() that sends no frame', async () => {
		const { peer, server: seen } = await closeWith(wsUrl(), { op: 'drop' });
		expect(peer.code).toBe(1006);
		expect(seen.code).toBe(1006);
	});
});
