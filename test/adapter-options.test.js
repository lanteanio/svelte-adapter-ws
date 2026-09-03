import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import adapter, { KNOWN_ADAPTER_OPTION_KEYS, unknownAdapterOptionKeys, unknownWebsocketOptionKeys, renderRefusedDotfileWarning, serializeWsOptions } from '../src/index.js';

// The path options are normalized inside adapt(), not by the factory, so the
// cases below run a real adapt over a stub Builder. The build tree lands in a
// gitignored temp dir; `copy` records the substitution map, which is where the
// serialized WS_OPTIONS - the only carrier that reaches the runtime - is
// visible.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = mkdtempSync(path.join(repoRoot, 'test', '.tmp-adapt-options-'));
const FIXTURE_SERVER = 'export class Server { constructor(m) { this.m = m; } async init() {} async respond() { return new Response("x"); } }\n';

/** @param {string} source @param {Record<string, string>} replace */
function substitute(source, replace) {
	let result = source;
	for (const [key, value] of Object.entries(replace)) {
		result = result.replace(new RegExp(`\\b${key}\\b`, 'g'), value);
	}
	return result;
}

/** @param {string} from @param {string} to @param {Record<string, string>} replace */
function copyTree(from, to, replace) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst, replace);
		else writeFileSync(dst, substitute(readFileSync(src, 'utf8'), replace));
	}
}

/**
 * Run adapt() over a stub Builder and hand back the serialized WS_OPTIONS.
 * @param {Record<string, unknown>} websocket
 * @returns {Promise<Record<string, any>>}
 */
async function adaptWebsocket(websocket) {
	const appDir = mkdtempSync(path.join(buildDir, 'app-'));
	/** @type {Record<string, string> | null} */
	let replaceMap = null;
	const log = Object.assign(() => {}, { minor() {}, info() {}, success() {}, warn() {}, error() {} });
	await adapter({ out: path.join(appDir, 'build'), precompress: false, websocket }).adapt({
		log,
		rimraf: (/** @type {string} */ p) => rmSync(p, { recursive: true, force: true }),
		mkdirp: (/** @type {string} */ p) => mkdirSync(p, { recursive: true }),
		getBuildDirectory: (/** @type {string} */ name) => path.join(appDir, '.svelte-kit', name),
		config: {
			kit: {
				paths: { base: '' },
				env: { dir: appDir, publicPrefix: 'PUBLIC_', privatePrefix: '' },
				files: { assets: path.join(appDir, 'static') },
				alias: {},
				version: { name: 'test' }
			}
		},
		writeClient(/** @type {string} */ dest) { mkdirSync(dest, { recursive: true }); return []; },
		writePrerendered(/** @type {string} */ dest) { mkdirSync(dest, { recursive: true }); return []; },
		writeServer(/** @type {string} */ dest) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'index.js'), FIXTURE_SERVER);
			return [];
		},
		generateManifest: () => "{ appPath: '_app', mimeTypes: {}, assets: new Set([]) }",
		prerendered: { paths: [] },
		compress: async () => {},
		hasServerInstrumentationFile: () => false,
		copy(/** @type {string} */ from, /** @type {string} */ to, /** @type {{ replace: Record<string, string> }} */ opts) {
			replaceMap ??= opts.replace;
			copyTree(from, to, opts.replace);
		}
	});
	return JSON.parse(/** @type {Record<string, string>} */ (replaceMap).WS_OPTIONS);
}

afterAll(() => {
	rmSync(buildDir, { recursive: true, force: true });
});

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
		// The protection and posture lane builds here.
		expect(() => adapter({ websocket: { protection: 'auto' } })).not.toThrow();
		expect(() => adapter({ websocket: { postureExport: '/run/app/posture.sock' } })).not.toThrow();
		expect(() => adapter({ websocket: { postureExport: { path: '/run/app/posture.sock' } } })).not.toThrow();
		expect(() => adapter({ websocket: { consistencyAuditIntervalMs: 0 } })).not.toThrow();
		expect(() => adapter({ websocket: { resourceGrowthAuditIntervalMs: 30_000 } })).not.toThrow();
		// A known key the serializer drops would be lost in silence - the
		// unknown-key walk cannot see it, because the key IS known.
		const posture = serializeWsOptions({
			protection: 'siege',
			postureExport: { path: '/run/app/posture.sock' },
			consistencyAuditIntervalMs: 250,
			resourceGrowthAuditIntervalMs: 30_000
		}, '/__realtime');
		expect(posture.protection).toBe('siege');
		expect(posture.postureExport).toEqual({ path: '/run/app/posture.sock' });
		expect(posture.consistencyAuditIntervalMs).toBe(250);
		expect(posture.resourceGrowthAuditIntervalMs).toBe(30_000);
		// The two defaults a zero-config build carries: the invariant net is on,
		// the probabilistic trend detector is off.
		const defaults = serializeWsOptions({}, '/__realtime');
		expect(defaults.consistencyAuditIntervalMs).toBe(5000);
		expect(defaults.resourceGrowthAuditIntervalMs).toBe(0);
		// The clustered state-hash lane still refuses.
		for (const key of ['stateHashIntervalMs']) {
			expect(() => adapter({ websocket: { [key]: '/x' } }), key)
				.toThrow(/is not supported by svelte-adapter-ws/);
		}
	});

	it('accepts a metrics module path and refuses anything that is not one', () => {
		// A module PATH, not a live registry: adapter options are serialized into
		// the build, so an object handed here could never reach the runtime.
		expect(() => adapter({ websocket: { metrics: './src/lib/server/metrics.js' } })).not.toThrow();
		expect(adapter({ websocket: { metrics: './src/lib/server/metrics.js' } }).websocketMetrics)
			.toBe('./src/lib/server/metrics.js');
		// Absent stays absent - the adapter publishes null so the Vite plugin can
		// tell "not configured" from "configured to this path".
		expect(adapter({ websocket: {} }).websocketMetrics).toBe(null);
		expect(() => adapter({ websocket: { metrics: { counter() {} } } }))
			.toThrow(/websocket\.metrics must be a module path string/);
		expect(() => adapter({ websocket: { metrics: 42 } }))
			.toThrow(/websocket\.metrics must be a module path string/);
		// The refusal names the read point an app is meant to use instead.
		expect(() => adapter({ websocket: { metrics: { counter() {} } } }))
			.toThrow(/platform\.metrics/);
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

	it('normalizes websocket.adminPath and refuses the paths that cannot mount', async () => {
		// The default is the reserved prefix, carried into the build as the
		// only thing the runtime reads.
		expect((await adaptWebsocket({})).adminPath).toBe('/__realtime');
		expect((await adaptWebsocket({ adminPath: '/__ops' })).adminPath).toBe('/__ops');
		// `false` disables the auto-mount and survives serialization as false,
		// not as a string or a dropped key.
		expect((await adaptWebsocket({ adminPath: false })).adminPath).toBe(false);
		// Trailing slashes are stripped BEFORE the empty and collision checks,
		// so the stripped value is what mounts and what the checks judge.
		expect((await adaptWebsocket({ adminPath: '/x/' })).adminPath).toBe('/x');
		expect((await adaptWebsocket({ adminPath: '/x///' })).adminPath).toBe('/x');
		// The acknowledgement flag is a strict boolean: a truthy string leaves
		// the boot warning armed rather than silencing it by coercion.
		expect((await adaptWebsocket({ adminAuthAcknowledged: true })).adminAuthAcknowledged).toBe(true);
		expect((await adaptWebsocket({ adminAuthAcknowledged: 'yes' })).adminAuthAcknowledged).toBe(false);

		await expect(adaptWebsocket({ adminPath: 5 }))
			.rejects.toThrow(/websocket\.adminPath must be an absolute path string starting with '\/'/);
		await expect(adaptWebsocket({ adminPath: 'ops' }))
			.rejects.toThrow(/websocket\.adminPath must be an absolute path string starting with '\/'/);
		await expect(adaptWebsocket({ adminPath: '/' }))
			.rejects.toThrow(/websocket\.adminPath cannot be '\/' or empty/);
		await expect(adaptWebsocket({ adminPath: '/ws' }))
			.rejects.toThrow(/websocket\.adminPath \('\/ws'\) must differ from websocket\.path/);
		await expect(adaptWebsocket({ adminPath: '/__ws/auth' }))
			.rejects.toThrow(/must differ from websocket\.path \('\/ws'\) and websocket\.authPath/);
	}, 60000);
});
