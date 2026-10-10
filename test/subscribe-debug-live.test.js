import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { once } from 'node:events';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const handler = `
export function subscribe(_ws, topic) { return topic !== 'batch-denied'; }
export function message(ws, { platform }) { platform.send(ws, 'probe', 'alive', {}); }
`;

for (const enabled of [false, true]) {
	it(`subscription diagnostics follow WS_DEBUG=${Number(enabled)}`, async () => {
		const previous = process.env.WS_DEBUG;
		process.env.WS_DEBUG = enabled ? '1' : '0';
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const payload = buildRuntime({ replace: {
			WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: '*', idleTimeout: 120, compression: false })
		}, wsHandlerSource: handler });
		let rt;
		let ws;
		try {
			rt = await bootRuntime(payload);
			ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`);
			await once(ws, 'open');
			const ack = once(ws, 'message');
			ws.send(JSON.stringify({ type: 'subscribe', topic: 'debug-topic', ref: 1 }));
			expect(JSON.parse((await ack)[0].toString()).type).toBe('subscribed');
			const barrier = once(ws, 'message');
			ws.send(JSON.stringify({ type: 'unsubscribe', topic: 'debug-topic' }));
			ws.send(JSON.stringify({ type: 'probe' }));
			expect(JSON.parse((await barrier)[0].toString()).event).toBe('alive');
			const lines = log.mock.calls.flat().filter(x => typeof x === 'string' && /runtime\.subscription\.(accepted|removed)/.test(x));
			expect(lines).toHaveLength(enabled ? 2 : 0);
			if (enabled) {
				expect(lines[0]).toContain('runtime.subscription.accepted');
				expect(lines[0]).toContain('A client topic subscription was installed.');
				expect(lines[1]).toContain('runtime.subscription.removed');
				expect(lines[1]).toContain('A client topic subscription was removed.');
				for (const line of lines) {
					expect(line).toContain('debug-topic');
					expect(line).toContain(' component=runtime.subscription ');
					expect(line).toContain(' severity=debug]');
					const record = JSON.parse(line.slice(line.indexOf('{')));
					expect(record).toMatchObject({ source: 'svelte-adapter-ws', component: 'runtime.subscription', severity: 'debug', level: 'debug' });
				}
			}
			const frames = [];
			ws.on('message', data => frames.push(JSON.parse(data.toString())));
			for (const [ref, topics, expected] of [
				[2, ['batch-a', 'batch-b', 'batch-a', 'batch-denied'], 2],
				[3, ['batch-a', 'batch-b', 'batch-c', 'batch-denied'], 1],
				[4, ['batch-a', 'batch-denied'], 0]
			]) {
				ws.send(JSON.stringify({ type: 'subscribe-batch', topics, ref }));
				await vi.waitFor(() => expect(frames.filter(frame => frame.ref === ref)).toHaveLength(topics.length));
				expect(frames.filter(frame => frame.ref === ref && frame.topic === 'batch-denied'))
					.toEqual([expect.objectContaining({ type: 'subscribe-denied', reason: 'FORBIDDEN' })]);
				const batchLines = log.mock.calls.filter(call => call[0] === '[ws] subscribe-batch count=%d');
				expect(batchLines).toHaveLength(enabled ? ref - 1 : 0);
				if (enabled) expect(batchLines.at(-1)).toEqual(['[ws] subscribe-batch count=%d', expected]);
			}
		} finally {
			ws?.terminate();
			await rt?.close();
			payload.cleanup();
			log.mockRestore();
			if (previous === undefined) delete process.env.WS_DEBUG;
			else process.env.WS_DEBUG = previous;
		}
	}, 30000);
}
