import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { once } from 'node:events';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const handler = `
export function subscribe() { return true; }
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
				for (const line of lines) expect(line).toContain('debug-topic');
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
