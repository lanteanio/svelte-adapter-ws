import { describe, expect, it } from 'vitest';
import adapter, { KNOWN_ADAPTER_OPTION_KEYS, unknownAdapterOptionKeys, unknownWebsocketOptionKeys, renderRefusedDotfileWarning, serializeWsOptions } from '../src/index.js';

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

	it('accepts the websocket lane and refuses only its unshipped sub-options', () => {
		expect(() => adapter({ websocket: true })).not.toThrow();
		expect(() => adapter({ websocket: {} })).not.toThrow();
		expect(() => adapter({ websocket: false })).not.toThrow();
		expect(() => adapter({ websocket: { maxPayloadLength: 2 * 1024 * 1024, idleTimeout: 60 } })).not.toThrow();
		expect(() => adapter({ websocket: { pressure: { publishRatePerSec: 500 } } })).not.toThrow();
		expect(() => adapter({ websocket: { upgradeAdmission: { maxConcurrent: 500 } } })).not.toThrow();
		// The admission ceilings are judged where the section is serialized
		// into the build: a value the gate cannot read leaves every ceiling
		// unset, so it fails the build instead of silently disabling the gate.
		expect(() => serializeWsOptions({ upgradeAdmission: 500 })).toThrow(/upgradeAdmission must be an object/);
		expect(() => serializeWsOptions({ upgradeAdmission: { maxConcurrent: -1 } })).toThrow(/maxConcurrent/);
		expect(() => serializeWsOptions({ upgradeAdmission: { maxConcurrent: 500 } })).not.toThrow();
		// A typo one level down is reported rather than dropped - the gate it
		// meant to configure would otherwise stay off in silence.
		expect(unknownWebsocketOptionKeys({ upgradeAdmission: { maxConcurent: 500 } }))
			.toEqual(['upgradeAdmission.maxConcurent']);
		expect(unknownWebsocketOptionKeys({ upgradeAdmission: { waitingRoom: { pollIntervalMs: 3000 } } }))
			.toEqual([]);
		for (const key of ['metrics', 'protection', 'adminPath', 'postureExport']) {
			expect(() => adapter({ websocket: { [key]: '/x' } }), key)
				.toThrow(/is not available yet/);
		}
	});

	it('accepts maxTopicSeqEntries and refuses a misshaped cap at factory time', () => {
		expect(() => adapter({ websocket: { maxTopicSeqEntries: 50_000 } })).not.toThrow();
		// 0 is the documented "no bound" spelling, so it stays legal; a
		// negative cap bounds nothing and is refused before any build work.
		expect(() => adapter({ websocket: { maxTopicSeqEntries: 0 } })).not.toThrow();
		expect(() => adapter({ websocket: { maxTopicSeqEntries: -1 } })).toThrow(/maxTopicSeqEntries/);
		expect(() => adapter({ websocket: { maxTopicSeqEntries: 'lots' } })).toThrow(/maxTopicSeqEntries/);
	});

	it('accepts the egress section and refuses misshaped ceilings at factory time', () => {
		expect(() => adapter({ websocket: { egress: { topic: { deliveries: 1000 } } } })).not.toThrow();
		expect(() => adapter({ websocket: { egress: { tenant: { bytes: 1024 }, windowMs: 1000 } } })).not.toThrow();
		expect(() => adapter({ websocket: { egress: '/x' } })).toThrow(/egress/);
		expect(() => adapter({ websocket: { egress: { windowMs: 50 } } })).toThrow(/windowMs/);
		expect(() => adapter({ websocket: { egress: { tenantOf: () => 't' } } })).toThrow(/egressTenantOf/);
	});

	it('accepts the tracing option as a module path and refuses other shapes at factory time', () => {
		expect(() => adapter({ tracing: './src/lib/server/tracing.js' })).not.toThrow();
		expect(() => adapter({ tracing: undefined })).not.toThrow();
		expect(() => adapter({ tracing: '' })).toThrow(/non-empty module path/);
		expect(() => adapter({ tracing: '   ' })).toThrow(/non-empty module path/);
		expect(() => adapter({ tracing: () => {} })).toThrow(/non-empty module path/);
		expect(() => adapter({ tracing: 42 })).toThrow(/non-empty module path/);
	});

	it('validates the cluster build options at factory time', () => {
		expect(() => adapter({ websocket: { primaryInit: './src/lib/server/cluster.js' } })).not.toThrow();
		expect(() => adapter({ websocket: { workers: { compute: 2 } } })).not.toThrow();
		expect(() => adapter({ websocket: { workers: {} } })).not.toThrow();
		// A live function cannot ride the serialized build; the path form is
		// the only shape that reaches the production runtime.
		expect(() => adapter({ websocket: { primaryInit: () => {} } })).toThrow(/module path string/);
		expect(() => adapter({ websocket: { workers: 'two' } })).toThrow(/websocket\.workers must be an object/);
		expect(() => adapter({ websocket: { workers: [2] } })).toThrow(/websocket\.workers must be an object/);
		expect(() => adapter({ websocket: { workers: { compute: -1 } } })).toThrow(/non-negative integer/);
		expect(() => adapter({ websocket: { workers: { compute: 1.5 } } })).toThrow(/non-negative integer/);
	});

	it('refuses misshaped protective websocket values at factory time', () => {
		expect(() => adapter({ websocket: { handler: 42 } })).toThrow(/websocket\.handler/);
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

	// The warning is only useful if it names the key the operator meant. A
	// casing slip or one transposed letter is the usual mistake, and a
	// `websocket.*` option typed at the top level is the most likely way to
	// lose a real option outright - it is spelled correctly, so nothing but
	// this suggestion points at its nested home.
	it('names the closest documented key for an unknown top-level option', () => {
		expect(unknownAdapterOptionKeys({ precompres: true }))
			.toEqual(["precompres (did you mean 'precompress'?)"]);
		expect(unknownAdapterOptionKeys({ HealthCheckPath: '/healthz' }))
			.toEqual(["HealthCheckPath (did you mean 'healthCheckPath'?)"]);
		expect(unknownAdapterOptionKeys({ allowedOrigins: '*' }))
			.toEqual(["allowedOrigins (did you mean 'websocket.allowedOrigins'?)"]);
		expect(unknownAdapterOptionKeys({ turboMode: true })).toEqual(['turboMode']);
	});

	it('renders the dotfile warning to survive its own list', () => {
		const warning = renderRefusedDotfileWarning(['.env', '.well-known/.nested']);
		expect(warning).toContain('.env');
		expect(warning).toContain('.well-known/.nested');
		expect(warning).toContain('staticDotfiles: true');
	});
});
