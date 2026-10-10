import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

let payload;
let server;
let runtime;
let state;
const intervals = new Set();

beforeAll(async () => {
	payload = buildRuntime({ replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ allowedOrigins: ['http://localhost'] }) } });
	runtime = await import(pathToFileURL(path.join(payload.dir, 'runtime.js')).href);
	runtime.setRuntimeEnv({ timers: {
		setInterval(callback, delay) {
			const handle = { callback, delay, unref() {} };
			intervals.add(handle);
			return handle;
		},
		clearInterval(handle) { intervals.delete(handle); }
	} }, { force: true });
	server = await bootRuntime(payload);
	state = await import(pathToFileURL(path.join(payload.dir, 'handler/state.js')).href);
});

beforeEach(() => {
	state.decodeCache.clear();
	state.envelopePrefixCache.clear();
});

afterAll(async () => {
	await server?.close();
	runtime?.resetRuntimeEnv();
	payload?.cleanup();
});

function sweep() {
	const sweepTimers = [...intervals].filter(({ delay }) => delay === 60000);
	expect(sweepTimers).toHaveLength(1);
	for (const timer of sweepTimers) timer.callback();
}

describe.each(['decodeCache', 'envelopePrefixCache'])('%s periodic eviction', (name) => {
	it('retains a cache below capacity', () => {
		const cache = state[name];
		for (let i = 0; i < 255; i++) cache.set(String(i), 'entry');
		sweep();
		expect([...cache.keys()]).toEqual(Array.from({ length: 255 }, (_, i) => String(i)));
	});

	it('drops the oldest half of a full cache and retains the newer half', () => {
		const cache = state[name];
		for (let i = 0; i < 256; i++) cache.set(String(i), 'entry');
		sweep();
		expect([...cache.keys()]).toEqual(Array.from({ length: 128 }, (_, i) => String(i + 128)));
		sweep();
		expect(cache.size).toBe(128);
	});
});
