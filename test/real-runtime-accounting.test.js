import { afterEach, expect, it } from 'vitest';
import { connectRealClient, startRealRuntime } from './helpers/real-runtime.js';

let server;
afterEach(async () => { await server?.stop(); });

it('restores the original accounting owner when a cached fixture boots again', async () => {
	server = await startRealRuntime({ variant: 'default' });
	const original = globalThis[Symbol.for('adapter-uws.subscription-accounting-hook')];
	expect(typeof original).toBe('function');
	await server.stop();

	server = await startRealRuntime({ variant: 'hookcrash' });
	const other = await import('./fixture/build-hook-crash/handler/state.js');
	expect(globalThis[Symbol.for('adapter-uws.subscription-accounting-hook')]).not.toBe(original);
	await server.stop();
	const otherTotal = other.counters.totalSubscriptions;

	server = await startRealRuntime({ variant: 'default' });
	const state = await import('./fixture/build/handler/state.js');
	const client = await connectRealClient(server.wsUrl);
	try {
		const before = state.counters.totalSubscriptions;
		client.send({ type: 'membership-probe', mode: 'tracked', topic: '__probe:restart', nonce: 1 });
		expect(await client.waitFor((frame) => frame?.event === 'membership-done' && frame.data?.nonce === 1)).not.toBeNull();
		expect(state.counters.totalSubscriptions).toBe(before + 1);
		expect(other.counters.totalSubscriptions).toBe(otherTotal);
		expect(globalThis[Symbol.for('adapter-uws.subscription-accounting-hook')]).toBe(original);

		client.send({ type: 'membership-probe', mode: 'tracked-leave', topic: '__probe:restart', nonce: 2 });
		expect(await client.waitFor((frame) => frame?.event === 'membership-done' && frame.data?.nonce === 2)).not.toBeNull();
		expect(state.counters.totalSubscriptions).toBe(before);
		expect(other.counters.totalSubscriptions).toBe(otherTotal);
	} finally {
		client.close();
	}
}, 120000);
