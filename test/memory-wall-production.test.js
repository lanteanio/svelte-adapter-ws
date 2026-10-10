import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildRuntime } from './helpers/build-runtime.js';

const fixture = vi.hoisted(() => ({ limit: '100' }));
vi.mock('../src/runtime/utils/memory-wall.js', async (original) => {
	const actual = await original();
	return { ...actual, createMemoryWallReader: () => actual.createMemoryWallReader({
		heapStatistics: () => ({ heap_size_limit: 0 }),
		readFile(file) {
			if (file === '/proc/self/cgroup') return '0::/';
			if (file === '/sys/fs/cgroup/memory.max') return fixture.limit;
			throw Object.assign(new Error('absent'), { code: 'ENOENT' });
		}
	}) };
});
import { normalizePressureThresholds, samplePressureOnce } from '../src/runtime/handler/pressure.js';
import { counters, pressureSnapshot } from '../src/runtime/handler/state.js';
import { leaseGrantSize } from '../src/runtime/wire.js';

afterEach(() => vi.restoreAllMocks());

it('the production sampler distinguishes unavailable memory from a measured zero', () => {
	vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 60, heapUsed: 10, heapTotal: 12, external: 0, arrayBuffers: 0 });
	const thresholds = normalizePressureThresholds({ memoryHeapUsedRatio: 0.5, psiCpuSome: false, psiMemoryFull: false, psiIoFull: false, cpuThrottledRatio: false });
	fixture.limit = '100';
	samplePressureOnce(thresholds);
	expect(counters.lastMeasuredHeapUsedRatio).toBe(0.6);
	expect(counters.memoryWallPermanent).toBe(false);
	expect(pressureSnapshot.reason).toBe('MEMORY');
	fixture.limit = 'max';
	samplePressureOnce(thresholds);
	expect(counters.lastMeasuredHeapUsedRatio).toBeNull();
	expect(counters.lastHeapUsedRatio).toBe(0);
	expect(pressureSnapshot.reason).toBe('NONE');
	expect(pressureSnapshot.value).toBe(0);
	expect(pressureSnapshot.memoryMB).toBeGreaterThan(0);
	expect(leaseGrantSize({ heapRatio: counters.lastHeapUsedRatio, subscriberRatio: 0 })).toBe(256);
	fixture.limit = '50';
	samplePressureOnce(thresholds);
	expect(counters.lastMeasuredHeapUsedRatio).toBe(1);
	expect(pressureSnapshot.reason).toBe('MEMORY');
	expect(leaseGrantSize({ heapRatio: counters.lastHeapUsedRatio, subscriberRatio: 0 })).toBeLessThan(256);
});

describe('production metric hook availability', () => {
	it.each([
		{ removable: true, permanent: false },
		{ removable: false, permanent: false },
		{ removable: false, permanent: true }
	])('retains mirror and external semantics for $removable removal and $permanent engine', async ({ removable, permanent }) => {
		const payload = buildRuntime({
			replace: { WS_ENABLED: 'true', WS_OPTIONS: JSON.stringify({ metrics: './metrics.js', allowedOrigins: '*' }) },
			wsHandlerSource: 'export function message() {}\n',
			metricsRegistrySource: `
export const values = new Map();
export default {
	counter() { return { inc() {} }; },
	gauge(name) { return { set(value) { values.set(name, value); }, ${removable ? 'remove() { values.delete(name); }' : ''} }; },
	histogram() { return { observe() {} }; }
};
`
		});
		let handler;
		try {
			handler = await payload.importRuntime();
			const moduleAt = (file) => import(pathToFileURL(path.join(payload.dir, file)).href);
			const state = await moduleAt('handler/state.js');
			const metrics = await moduleAt('server/metrics-registry.js');
			const telemetry = { transition: null, os: { psi: null, cpuThrottle: null } };
			expect(state.counters.metricsSampleHook).toBeTypeOf('function');
			for (const value of permanent ? [0.6, 0, 0.2] : [0.6, null, 0, 0.2]) {
				state.counters.lastMeasuredHeapUsedRatio = value;
				state.counters.lastHeapUsedRatio = value ?? 0;
				state.counters.memoryWallPermanent = permanent;
				state.counters.metricsSampleHook(telemetry);
				const mirror = handler.collectLocalMetrics().filter((s) => s.name === 'heap_used_ratio');
				expect(mirror.map((s) => s.value)).toEqual(value === null ? [] : [value]);
				expect(metrics.values.has('heap_used_ratio')).toBe(value !== null && (removable || permanent));
				if (value !== null && (removable || permanent)) expect(metrics.values.get('heap_used_ratio')).toBe(value);
			}
		} finally {
			await handler?.shutdown({ timeoutMs: 2000 });
			payload.cleanup();
		}
	});
});
