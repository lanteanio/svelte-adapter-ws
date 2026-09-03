// The batch seq pre-pass on the BUILT runtime.
//
// test/batch-seq-prepass.test.js drives server.platform, which is the harness
// platform in src/testing.js - a separate implementation. Only this file
// reaches src/runtime/handler/platform.js, where the production batch() and
// publishBatched() live, so it is the half that fails when the production
// pre-pass is dropped.

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// The handler reports the OUTCOME of each call back to the caller, because a
// throw inside the message hook would otherwise only close the connection and
// the test could not tell a refusal from a delivery.
const WS_HANDLER = `
export function open() {}
export function close() {}
export function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return;
	let cmd;
	try { cmd = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
	if (cmd.cmd === 'batch' || cmd.cmd === 'publishBatched') {
		let error = null;
		try {
			if (cmd.cmd === 'batch') platform.batch(cmd.messages);
			else platform.publishBatched(cmd.messages);
		} catch (err) {
			error = String(err && err.name);
		}
		platform.send(ws, 'outcome', 'done', { call: cmd.cmd, error });
	} else if (cmd.cmd === 'publish') {
		platform.publish(cmd.topic, cmd.event, cmd.data, cmd.options);
	}
}
`;

/** @type {any} */
let payload;
/** @type {any} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
}, 60000);

afterAll(async () => {
	await rt?.close();
	payload?.cleanup?.();
});

/**
 * A client that advertises the batch capability, which decides which lane
 * publishBatched takes: without it any interested connection cannot decode a
 * shared frame and the call degrades to a per-event publish loop, so the
 * stamping loop under test never runs.
 */
async function client(topics) {
	const ws = new WebSocket(rt.wsUrl ?? `${rt.origin.replace('http', 'ws')}/ws`);
	/** @type {any[]} */
	const json = [];
	ws.on('message', (raw, isBinary) => {
		if (isBinary) return;
		try { json.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	ws.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
	for (const t of topics) ws.send(JSON.stringify({ type: 'subscribe', topic: t, ref: 1 }));
	await new Promise((res) => {
		const tick = () => (
			topics.every((t) => json.some((f) => f?.type === 'subscribed' && f.topic === t))
				? res(undefined)
				: setTimeout(tick, 5)
		);
		tick();
	});
	const waitOutcome = (call) => new Promise((res, rej) => {
		const deadline = Date.now() + 3000;
		const tick = () => {
			const hit = json.find((f) => f?.topic === 'outcome' && f.data?.call === call);
			if (hit) return res(hit.data);
			if (Date.now() > deadline) return rej(new Error('no outcome for ' + call));
			setTimeout(tick, 5);
		};
		tick();
	});
	return {
		ws,
		json,
		send: (o) => ws.send(JSON.stringify(o)),
		waitOutcome,
		of: (t) => json.filter((f) => f?.topic === t && f.type !== 'subscribed'),
		seqsOf: (t) => {
			const out = [];
			for (const f of json) {
				if (f?.type === 'batch' && Array.isArray(f.events)) {
					for (const e of f.events) if (e?.topic === t && e.seq != null) out.push(e.seq);
				} else if (f?.topic === t && f.type !== 'subscribed' && f.seq != null) {
					out.push(f.seq);
				}
			}
			return out;
		}
	};
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('the production batch pre-pass judges every entry seq', () => {
	it('refuses a batch() whose later entry is unstampable, with nothing delivered', async () => {
		const c = await client(['lbt', 'outcome']);
		try {
			c.send({ cmd: 'batch', messages: [
				{ topic: 'lbt', event: 'a', data: 1 },
				{ topic: 'lbt', event: 'b', data: 2 },
				{ topic: 'lbt', event: 'c', data: 3, options: { seq: '5' } }
			] });
			expect((await c.waitOutcome('batch')).error).toBe('TypeError');
			await settle();
			expect(c.of('lbt')).toEqual([]);
		} finally {
			c.ws.close();
		}
	});

	it('leaves the topic counter untouched when publishBatched refuses', async () => {
		const c = await client(['lskip', 'lguard', 'outcome']);
		try {
			// Vacuity guard on its own topic: an accepted batch DOES draw the
			// counter, so the assertion below is about the refusal.
			c.send({ cmd: 'publishBatched', messages: [
				{ topic: 'lguard', event: 'a', data: 1, options: { seq: true } },
				{ topic: 'lguard', event: 'b', data: 2, options: { seq: true } }
			] });
			expect((await c.waitOutcome('publishBatched')).error).toBeNull();
			await settle();
			expect(c.seqsOf('lguard')).toEqual([1, 2]);
			// A batch frame proves the shared-frame lane ran, not the fallback.
			expect(c.json.some((f) => f?.type === 'batch')).toBe(true);

			c.send({ cmd: 'publishBatched', messages: [
				{ topic: 'lskip', event: 'a', data: 1, options: { seq: true } },
				{ topic: 'lskip', event: 'b', data: 2, options: { seq: 1.5 } }
			] });
			await settle();
			expect(c.of('lskip')).toEqual([]);

			// The counter, not delivery: this path throws before its send
			// either way, so only the NEXT accepted publish reveals a skip.
			c.send({ cmd: 'publish', topic: 'lskip', event: 'e', data: 9, options: { seq: true } });
			await settle();
			expect(c.seqsOf('lskip')).toEqual([1]);
		} finally {
			c.ws.close();
		}
	});
});
