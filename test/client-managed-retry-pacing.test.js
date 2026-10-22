import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class Socket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	static all = [];
	constructor() { this.readyState = 0; this.sent = []; Socket.all.push(this); }
	send(frame) { this.sent.push(JSON.parse(frame)); }
	open() { this.readyState = 1; this.onopen?.(); }
	close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
	receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
let client, runtime, connection;
beforeEach(async () => {
	vi.resetModules(); vi.useFakeTimers(); Socket.all = [];
	vi.stubGlobal('WebSocket', Socket);
	vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:5173' } });
	runtime = await import('../src/client-runtime.js');
	runtime.setRuntimeEnv({ rng: { float: () => 0.5 } });
	client = await import('../src/client.js');
});
afterEach(() => { connection?.close(); runtime.resetRuntimeEnv(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('does not let a managed topic denial pace the retry of an ordinary topic', async () => {
	connection = client.connect();
	const socket = Socket.all[0]; socket.open();
	const releaseManaged = client.on('managed:pacing').subscribe(() => {});
	const releasePlain = client.on('plain:pacing').subscribe(() => {});
	await vi.advanceTimersByTimeAsync(0);
	const batch = socket.sent.find(frame => frame.type === 'subscribe-batch');
	expect(batch.topics).toEqual(['managed:pacing', 'plain:pacing']);
	client.setTopicManaged('managed:pacing');
	socket.receive({ type: 'subscribe-denied', topic: 'managed:pacing', ref: batch.ref, reason: 'RATE_LIMITED' });
	await vi.advanceTimersByTimeAsync(200);
	socket.receive({ type: 'subscribe-denied', topic: 'plain:pacing', ref: batch.ref, reason: 'RATE_LIMITED' });
	const retries = () => socket.sent.filter(frame =>
		(frame.type === 'subscribe' && frame.topic === 'plain:pacing') ||
		(frame.type === 'subscribe-batch' && frame !== batch && frame.topics.includes('plain:pacing')));
	// The ordinary topic's own first retry waits its full jittered 375 ms.
	await vi.advanceTimersByTimeAsync(300);
	expect(retries()).toEqual([]);
	await vi.advanceTimersByTimeAsync(100);
	expect(retries()).toHaveLength(1);
	expect(socket.sent.some(frame => frame.topic === 'managed:pacing' || (frame !== batch && frame.topics?.includes('managed:pacing')))).toBe(false);
	releaseManaged(); releasePlain();
});
