import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const handler = `
export const state = { park: false, pending: null, resume: null, failure: null, calls: [] };
export function subscribe() {
  if (!state.park) return true;
  return new Promise(resolve => { state.pending = resolve; });
}
export function resume() { return new Promise(resolve => { state.resume = resolve; }); }
export function unsubscribe(ws, topic) {
  state.calls.push(topic);
  if (state.failure === 'throw') throw new Error('unsubscribe failed');
  if (state.failure === 'reject') return Promise.reject(new Error('unsubscribe failed'));
}
export function message(ws, { platform }) { platform.send(ws, 'probe', 'alive', {}); }
`;
let payload, rt, state, platform, symbols, runtimeState, dispose;
const records = [];
beforeAll(async () => {
	payload = buildRuntime({ replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', idleTimeout: 120, compression: false, upgradeRateLimit: 0 }) }, wsHandlerSource: handler });
	rt = await bootRuntime(payload);
	const load = p => import(pathToFileURL(`${payload.dir}/${p}`).href);
	state = (await load('ws-handler-bridge.js')).wsModule.state;
	platform = (await load('handler/platform.js')).platform;
	symbols = await load('utils/ws-symbols.js');
	runtimeState = await load('handler/state.js');
	dispose = (await load('diagnostic.js')).setOperationalEventSink(record => records.push(record));
}, 30000);
afterAll(async () => { dispose?.(); await rt?.close(); payload?.cleanup(); });

const lanes = ['single-denied', 'single-held', 'single-recover', 'batch-denied', 'batch-held', 'platform-denied', 'platform-held', 'observer-denied', 'observer-held'];
for (const lane of lanes) for (const failure of ['throw', 'reject']) {
	it(`${lane} contains a hook ${failure} after unwinding membership`, async () => {
		Object.assign(state, { park: false, pending: null, resume: null, failure: null, calls: [] });
		const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
		const frames = [];
		ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
		await once(ws, 'open');
		await expect.poll(() => runtimeState.wsWrappers.size).toBe(1);
		const facade = [...runtimeState.wsWrappers.values()][0];
		const ud = facade.getUserData();
		const topic = `${lane}:${failure}`;
		try {
			expect(await platform.subscribe(facade, topic)).toBe(null);
			expect(ud[symbols.WS_SUBSCRIPTIONS].has(topic)).toBe(true);
			if (lane.startsWith('platform')) platform.unsubscribe(facade, topic);
			state.park = true;
			let completion;
			if (lane.startsWith('platform')) completion = platform.subscribe(facade, topic);
			else if (lane.startsWith('observer')) completion = symbols.authorizeDerivedSubscribe(facade, topic, () => new Promise(resolve => { state.pending = resolve; }));
			else ws.send(JSON.stringify(lane.startsWith('batch') ? { type: 'subscribe-batch', topics: [topic], ref: 1 } : { type: 'subscribe', topic, ref: 1, ...(lane === 'single-recover' ? { recover: { offset: 0 } } : {}) }));
			await expect.poll(() => typeof state.pending).toBe('function');
			if (lane === 'single-recover') {
				state.pending(true);
				await expect.poll(() => typeof state.resume).toBe('function');
			}
			platform.unsubscribe(facade, topic);
			expect(ud[symbols.WS_SUBSCRIPTIONS].has(topic)).toBe(false);
			// The revoked hook installs membership after the revocation. Its
			// landing must unwind it and contain the app's failing cleanup hook.
			symbols.trackedSubscribe(facade, topic);
			state.calls = [];
			records.length = 0;
			state.failure = failure;
			if (lane === 'single-recover') state.resume({});
			else state.pending(lane.startsWith('observer') ? lane.endsWith('denied') : !lane.endsWith('denied'));
			if (completion) expect(await completion).toBe(lane.startsWith('observer') ? false : 'FORBIDDEN');
			else await expect.poll(() => frames.find(f => f.ref === 1)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			await expect.poll(() => records.filter(r => r.event === 'unsubscribe.hook-failed').length).toBe(1);
			expect(state.calls).toEqual([topic]);
			expect(ud[symbols.WS_SUBSCRIPTIONS].has(topic)).toBe(false);
			const report = records.find(r => r.event === 'unsubscribe.hook-failed');
			expect(report.attributes.topic).toBe(topic);
			expect(report.event).toBe(ADAPTER_ERROR_REGISTRY.find(r => r.id === 'ADAPTER-ERR-UNSUBSCRIBE-HOOK').event);
			expect(report.attributes.error.message).toBe('unsubscribe failed');
			const barrier = once(ws, 'message');
			ws.send(JSON.stringify({ type: 'probe' }));
			expect(JSON.parse((await barrier)[0].toString()).event).toBe('alive');
			expect(records.filter(r => r.event === 'unsubscribe.hook-failed')).toHaveLength(1);
		} finally {
			state.failure = null;
			ws.terminate();
			await expect.poll(() => runtimeState.wsWrappers.size).toBe(0);
		}
	}, 10000);
}
