import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const handler = `
export const pending = [];
export function subscribe(ws, topic) {
  return new Promise(resolve => pending.push({ ws, topic, resolve }));
}
export function message(ws, { platform }) { platform.send(ws, 'probe', 'alive', {}); }
`;

it.each(['landing', 'cap'])('a %s refusal never grants authority to its revoked sibling', async refusal => {
	const payload = buildRuntime({ replace: {
		WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', idleTimeout: 120, compression: false })
	}, wsHandlerSource: handler });
	let rt;
	let ws;
	try {
		rt = await bootRuntime(payload);
		const load = p => import(pathToFileURL(`${payload.dir}/${p}`).href);
		const { wsModule } = await load('ws-handler-bridge.js');
		const { platform } = await load('handler/platform.js');
		const { trackedSubscribe, WS_SUBSCRIPTIONS, WS_PENDING_SUBSCRIBES } = await load('utils/ws-symbols.js');
		ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
		const frames = [];
		ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
		await once(ws, 'open');
		const topic = 'landing-authority';
		ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
		await expect.poll(() => wsModule.pending.length).toBe(1);
		const first = wsModule.pending[0];
		platform.unsubscribe(first.ws, topic);
		ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 2 }));
		await expect.poll(() => wsModule.pending.length).toBe(2);
		if (refusal === 'landing') platform.authorizeWireSubscribe('strict');
		else {
			const { MAX_SUBSCRIPTIONS_PER_CONNECTION: max } = await load('utils/caps.js');
			for (let i = 0; i < max; i++) {
				if (!trackedSubscribe(first.ws, `cap-fill:${i}`)) throw new Error('could not fill the subscription cap');
			}
			expect(first.ws.getUserData()[WS_SUBSCRIPTIONS].size).toBe(max);
		}
		wsModule.pending[1].resolve(true);
		await expect.poll(() => frames.find(f => f.ref === 2)).toMatchObject({ type: 'subscribe-denied', reason: refusal === 'cap' ? 'RATE_LIMITED' : 'FORBIDDEN' });
		if (refusal === 'cap') platform.unsubscribe(first.ws, 'cap-fill:0');
		const ud = first.ws.getUserData();
		// A plugin finishing the revoked hook installs tracked membership in
		// its own await window. The refused sibling supplies no authority for it.
		trackedSubscribe(first.ws, topic);
		expect(ud[WS_SUBSCRIPTIONS].has(topic)).toBe(true);
		first.resolve(true);
		await expect.poll(() => frames.find(f => f.ref === 1)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(ud[WS_SUBSCRIPTIONS].has(topic)).toBe(false);
		expect(ud[WS_PENDING_SUBSCRIBES].size).toBe(0);
		const barrier = once(ws, 'message');
		ws.send(JSON.stringify({ type: 'probe' }));
		expect(JSON.parse((await barrier)[0].toString()).event).toBe('alive');
	} finally {
		ws?.terminate();
		await rt?.close();
		payload.cleanup();
	}
}, 30000);
