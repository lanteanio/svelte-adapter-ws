import { describe, expect, it } from 'vitest';
import adapter, { KNOWN_ADAPTER_OPTION_KEYS, unknownAdapterOptionKeys, renderRefusedDotfileWarning } from '../src/index.js';

describe('adapter factory options', () => {
	it('builds an adapter object with the family name and support surface', () => {
		const a = adapter();
		expect(a.name).toBe('adapter-ws');
		expect(a.supports?.read?.()).toBe(true);
		expect(typeof a.adapt).toBe('function');
	});

	it('validates warmup shapes', () => {
		expect(() => adapter({ warmup: true })).not.toThrow();
		expect(() => adapter({ warmup: false })).not.toThrow();
		expect(() => adapter({ warmup: { paths: ['/', '/dash'] } })).not.toThrow();
		expect(() => adapter({ warmup: { paths: ['relative'] } })).toThrow(/warmup\.paths/);
		expect(() => adapter({ warmup: 'yes' })).toThrow(/warmup must be/);
	});

	it('validates the readiness probe path and its distinctness', () => {
		expect(() => adapter({ readinessCheckPath: 'readyz' })).toThrow(/readinessCheckPath/);
		expect(() => adapter({ readinessCheckPath: '/healthz' })).toThrow(/must differ/);
		expect(() => adapter({ readinessCheckPath: false })).not.toThrow();
	});

	it('refuses the not-yet-shipped websocket and tracing options loudly', () => {
		expect(() => adapter({ websocket: true })).toThrow(/websocket option is not available yet/);
		expect(() => adapter({ websocket: {} })).toThrow(/websocket option is not available yet/);
		expect(() => adapter({ websocket: false })).not.toThrow();
		expect(() => adapter({ tracing: './src/lib/tracing.js' })).toThrow(/tracing option is not available yet/);
	});

	it('validates staticDotfiles strictly', () => {
		expect(() => adapter({ staticDotfiles: true })).not.toThrow();
		expect(() => adapter({ staticDotfiles: 'yes' })).toThrow(/staticDotfiles must be a boolean/);
	});

	it('throws at factory time on misshaped staticHeaders and staticCacheControl', () => {
		expect(() => adapter({ staticHeaders: 'nope' })).toThrow(/staticHeaders/);
		expect(() => adapter({ staticCacheControl: {} })).toThrow(/staticCacheControl/);
	});

	it('names unknown top-level keys without refusing them', () => {
		expect(unknownAdapterOptionKeys({ out: 'build', typoOption: 1 })).toEqual(['typoOption']);
		expect(unknownAdapterOptionKeys({})).toEqual([]);
		for (const key of KNOWN_ADAPTER_OPTION_KEYS) {
			expect(unknownAdapterOptionKeys({ [key]: undefined })).toEqual([]);
		}
	});

	it('renders the dotfile warning to survive its own list', () => {
		const warning = renderRefusedDotfileWarning(['.env', '.well-known/.nested']);
		expect(warning).toContain('.env');
		expect(warning).toContain('.well-known/.nested');
		expect(warning).toContain('staticDotfiles: true');
	});
});
