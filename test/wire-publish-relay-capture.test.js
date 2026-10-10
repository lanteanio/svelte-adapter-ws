import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { buildRuntime } from './helpers/build-runtime.js';

const ipc = vi.hoisted(() => ({ messages: [] }));
vi.mock('node:worker_threads', async importOriginal => ({
	...await importOriginal(),
	parentPort: { postMessage(message) { ipc.messages.push(message); } }
}));
let payload, platform, state, symbols, registry, wrapWebSocket, resume;
const wire = { capability: 'wire.fast:1', schemaVersion: 1, state: { onAttach: () => ({}) }, encode() { return new Uint8Array([1]); } };
const entries = [{ data: { n: 1 } }, { data: { n: 2 } }];
beforeAll(async () => {
	payload = buildRuntime();
	const load = p => import(pathToFileURL(`${payload.dir}/${p}`).href);
	platform = (await load('handler/platform.js')).platform;
	state = await load('handler/state.js');
	symbols = await load('utils/ws-symbols.js');
	registry = await load('handler/topic-registry.js');
	wrapWebSocket = (await load('handler/ws-facade.js')).wrapWebSocket;
	resume = await load('handler/resume-buffer.js');
	platform.registerWireCodec(wire);
});
afterAll(() => payload?.cleanup());
beforeEach(async () => {
	// Drain the relay's zero-delay flush before clearing the IPC recorder.
	await new Promise(resolve => setTimeout(resolve, 10));
	ipc.messages.length = 0;
});
function socket(topic, caps = []) {
	const frames = [];
	const raw = { readyState: 1, bufferedAmount: 0, send(value, options, cb) { frames.push({ value, options }); cb?.(); }, close() {}, terminate() {}, _socket: { remoteAddress: '127.0.0.1' } };
	const ud = { [symbols.WS_SUBSCRIPTIONS]: new Set(), [symbols.WS_CAPS]: new Set(caps) };
	const facade = wrapWebSocket(raw, ud, { maxBackpressure: 1024 * 1024, closeOnBackpressureLimit: false, compressionEnabled: false, peerFacadeOf: peer => state.wsWrappers.get(peer) });
	ud[symbols.WS_PLATFORM] = Object.create(platform);
	registry.registerSocket(raw);
	state.wsWrappers.set(raw, facade);
	state.wsConnections.add(facade);
	state.capCounts.adjust(null, ud[symbols.WS_CAPS]);
	if (topic) symbols.trackedSubscribe(facade, topic);
	return { frames, facade, close() {
		for (const held of [...ud[symbols.WS_SUBSCRIPTIONS]]) symbols.trackedUnsubscribe(facade, held);
		state.capCounts.adjust(ud[symbols.WS_CAPS], null);
		registry.unregisterSocket(raw);
		state.wsWrappers.delete(raw);
		state.wsConnections.delete(facade);
	} };
}
async function relayed() {
	await expect.poll(() => ipc.messages.length).toBe(1);
	expect(ipc.messages[0].type).toBe('publish-batch');
	return ipc.messages[0].messages;
}
it('reports relay success for a fast-path batch with no local recipients', async () => {
	expect(platform.publishWireBatch('empty-fast', 'tick', entries, wire, { seq: false })).toBe(true);
	expect(await relayed()).toHaveLength(2);
	expect(platform.publishWireBatch('empty-local', 'tick', entries, wire, { seq: false, relay: false })).toBe(false);
});
it('relays each fast-path envelope with codec carry and entry order intact', async () => {
	const local = socket('relay-fast');
	try {
		platform.publishWireBatch('relay-fast', 'tick', entries, wire, { seq: false });
		const messages = await relayed();
		expect(messages.map(m => ({ topic: m.topic, event: m.event, capability: m.capability, data: m.data, seq: m.seq }))).toEqual(entries.map(e => ({ topic: 'relay-fast', event: 'tick', capability: wire.capability, data: e.data, seq: null })));
		expect(messages.map(m => m.envelope)).toEqual(local.frames.map(f => f.value));
	} finally { local.close(); }
});
it('captures every fast-path entry during resume and delivers it at cutover', () => {
	const pending = socket(null);
	const capture = resume.beginResumeCapture(['resume-fast'], pending.facade);
	try {
		platform.publishWireBatch('resume-fast', 'tick', entries, wire, { seq: false, relay: false });
		expect(pending.frames).toHaveLength(0);
		expect(capture.entries[0].buffer.frames).toHaveLength(2);
		resume.flushResumeTopic(capture, 'resume-fast', 0);
		expect(pending.frames.map(f => JSON.parse(f.value).data)).toEqual(entries.map(e => e.data));
		expect(state.resumeBuffers.has('resume-fast')).toBe(false);
	} finally { resume.discardResumeCapture(capture); pending.close(); }
});
it.each([false, true])('relays a declined frame without codec carry with exclusion=%s', async exclusion => {
	const declined = { capability: exclusion ? 'wire.declinedexclusion:1' : 'wire.declined:1', schemaVersion: 1, encode: vi.fn(() => null) };
	platform.registerWireCodec(declined);
	const local = socket('declined-frame', [declined.capability]);
	const excluded = exclusion ? socket('declined-frame', [declined.capability]) : null;
	try {
		platform.publishWire('declined-frame', 'tick', { n: 3 }, declined, { seq: false, excludeWs: excluded?.facade });
		expect(declined.encode).toHaveBeenCalledOnce();
		const messages = await relayed();
		expect(messages).toHaveLength(1);
		expect(messages[0].capability).toBeUndefined();
		expect(messages[0].event).toBeUndefined();
		expect(messages[0].data).toBeUndefined();
		expect(JSON.parse(messages[0].envelope)).toMatchObject({ topic: 'declined-frame', event: 'tick', data: { n: 3 } });
		expect(local.frames.map(f => f.value)).toEqual([messages[0].envelope]);
		if (excluded) expect(excluded.frames).toHaveLength(0);
	} finally { local.close(); excluded?.close(); }
});
