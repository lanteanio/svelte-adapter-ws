// A tracked leave that lands after its socket closed, on the built runtime.
//
// The socket facade still answers getUserData after the close, so a plugin
// that holds a closed socket and calls trackedUnsubscribe reaches the cohort
// leave. The close already released the socket's shared wire-id references;
// releasing them again would drop the id from under the members that remain.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const TOPIC = 'late-leave';
const CAP = 'late.shared:1';

const WS_HANDLER = `
export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'plugin-join') {
		globalThis.__lateLeaveJoin(ws, msg.topic);
		platform.send(ws, 'probe', 'joined', { topic: msg.topic });
	}
}
export function close(ws) {
	(globalThis.__lateLeaveClosed ??= []).push(ws);
}
`;

/** A codec the cohort lane shares across every capable member. */
const sharedCodec = () => ({
	capability: CAP,
	schemaVersion: 1,
	shared: true,
	encode: () => new Uint8Array([1, 2, 3])
});

/** @type {any} */ let payload;
/** @type {any} */ let rt;
/** @type {any} */ let platform;
/** @type {any} */ let symbols;
/** @type {any} */ let wireIds;

beforeAll(async () => {
	payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', upgradeRateLimit: 0, authPathRateLimit: 0 })
		},
		wsHandlerSource: WS_HANDLER
	});
	const dir = pathToFileURL(payload.dir).href;
	symbols = await import(`${dir}/utils/ws-symbols.js`);
	platform = (await import(`${dir}/handler/platform.js`)).platform;
	wireIds = await import(`${dir}/handler/shared-wire-id.js`);
	/** @type {any} */ (globalThis).__lateLeaveJoin = symbols.trackedSubscribe;
	rt = await bootRuntime(payload);
}, 60000);

afterAll(async () => {
	delete /** @type {any} */ (globalThis).__lateLeaveJoin;
	delete /** @type {any} */ (globalThis).__lateLeaveClosed;
	await rt?.close();
	payload?.cleanup();
});

/** A capable client that records its binary frames and probe answers. */
async function member() {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
	const seen = { binary: 0, joined: 0 };
	ws.on('message', (data, isBinary) => {
		if (isBinary) { seen.binary++; return; }
		const msg = JSON.parse(data.toString());
		if (msg?.event === 'joined') seen.joined++;
	});
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	ws.send(JSON.stringify({ type: 'hello', caps: [CAP] }));
	ws.send(JSON.stringify({ type: 'plugin-join', topic: TOPIC }));
	return { ws, seen };
}

async function until(/** @type {() => boolean} */ predicate, /** @type {string} */ what) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe('a tracked leave after close', () => {
	it('releases nothing the close already released, so the remaining member keeps the shared id', async () => {
		const a = await member();
		const b = await member();
		try {
			await until(() => a.seen.joined === 1 && b.seen.joined === 1, 'both joins');
			// The first shared publish moves both members into the binary cohort.
			platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
			await until(() => b.seen.binary === 1, 'the first shared frame');
			expect(wireIds.sharedWireIdRefs(TOPIC), 'both members hold the id').toBe(2);

			a.ws.close();
			await until(() => (/** @type {any} */ (globalThis).__lateLeaveClosed ?? []).length === 1, 'the close hook');
			expect(wireIds.sharedWireIdRefs(TOPIC), 'the close released its reference').toBe(1);
			symbols.trackedUnsubscribe(/** @type {any} */ (globalThis).__lateLeaveClosed[0], TOPIC);
			expect(wireIds.sharedWireIdRefs(TOPIC), 'the late leave releases nothing').toBe(1);

			platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
			await until(() => b.seen.binary === 2, 'the second shared frame');
		} finally {
			a.ws.terminate();
			b.ws.terminate();
		}
	});
});
