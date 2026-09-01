import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { normalizeStaticCacheControl, normalizeStaticHeaders } from './build-config.js';
import { listExcludedDotPaths } from './static-scan.js';
import {
	assertWireSubscribeAuthorization,
	assertProtectiveNumber,
	assertSharedOptionValues,
	assertEgressSection,
	describeUnknownOptionKeys,
	KNOWN_PRESSURE_OPTION_KEYS,
	KNOWN_EGRESS_OPTION_KEYS,
	KNOWN_EGRESS_CEILING_KEYS,
	DEFAULT_MAX_PAYLOAD_LENGTH
} from './config-guards.js';
import { normalizeMessageAdmission } from './runtime/utils/message-admission.js';
import { compileAccessibleWaitingRoomTemplate } from './runtime/utils/waiting-room-template.js';

const runtimeDir = fileURLToPath(new URL('./runtime', import.meta.url).href);

/**
 * Import a build-time tool from the APP's dependency tree. A bare import
 * would resolve from this package's own location, which fails the moment the
 * adapter is npm-linked or file:-installed (the app's vite/esbuild are not
 * visible from there); resolving via the app's package.json covers both the
 * linked and the normally-installed shapes.
 *
 * @param {string} name
 */
async function importFromApp(name) {
	try {
		const { createRequire } = await import('node:module');
		const { pathToFileURL } = await import('node:url');
		const appRequire = createRequire(path.resolve('package.json'));
		return await import(pathToFileURL(appRequire.resolve(name)).href);
	} catch {
		return import(name);
	}
}

// Empty default WebSocket handler - subscribe/unsubscribe is handled by the
// runtime for ALL messages regardless of user handler.
const DEFAULT_WS_HANDLER = '// Built-in: subscribe/unsubscribe handled by the runtime\n';

/**
 * Every `websocket.*` option key the family declares. Keys whose lanes have
 * not shipped in this adapter REFUSE the build (see UNSHIPPED_WEBSOCKET_KEYS)
 * rather than silently no-op'ing; unknown keys warn like the top level.
 */
export const KNOWN_WEBSOCKET_OPTION_KEYS = new Set([
	'handler', 'path', 'authPath', 'adminPath', 'adminAuthAcknowledged', 'metrics', 'primaryInit', 'workers',
	'maxPayloadLength', 'idleTimeout', 'maxBackpressure', 'closeOnBackpressureLimit', 'maxTopicSeqEntries',
	'sendPingsAutomatically', 'compression', 'allowedOrigins',
	'upgradeTimeout', 'upgradeRateLimit', 'upgradeRateLimitWindow', 'upgradeAdmission',
	'messageAdmission', 'egress',
	'authPathRateLimit', 'authPathRateLimitWindow',
	'pressure', 'protection', 'stateHashIntervalMs', 'consistencyAuditIntervalMs',
	'resourceGrowthAuditIntervalMs', 'postureExport',
	'allowSystemTopicSubscribe', 'authorizeWireSubscribe', 'allowNonAsciiTopics',
	'authPathRequireOrigin', 'compressCredentialedResponses', 'unsafeSameOriginWithoutHostPin'
]);

/**
 * Family websocket options whose lanes have not shipped here. A config that
 * sets one expects behavior this build cannot deliver, so the build refuses
 * loudly - a protection knob that silently does nothing is worse than an
 * error at the only moment anyone is watching.
 */
const UNSHIPPED_WEBSOCKET_KEYS = [
	'adminPath', 'adminAuthAcknowledged', 'metrics', 'protection',
	'stateHashIntervalMs', 'consistencyAuditIntervalMs', 'resourceGrowthAuditIntervalMs',
	'postureExport'
];

/**
 * Object-valued options whose CONTENTS are also checked, keyed by dotted path.
 *
 * A top-level-only walk cannot see a typo one level down, and for
 * `upgradeAdmission` that is not cosmetic: `maxConcurent: 500` leaves the
 * handshake ceiling and cursor lane switched off (and the waiting room too
 * unless the separate `maxConnections` ceiling is enabled), silently. The
 * whole-lifetime socket bound is a separate option by design.
 *
 * `pressure` is milder - its thresholds are merged over defaults, so a typo
 * leaves the default threshold rather than "off" - but a dropped key there
 * still means the operator's tuning silently did nothing.
 */
export const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS = {
	upgradeAdmission: new Set(['maxConcurrent', 'maxConnections', 'perTickBudget', 'maxDeferred', 'cursorLane', 'waitingRoom']),
	'upgradeAdmission.cursorLane': new Set(['fraction']),
	'upgradeAdmission.waitingRoom': new Set([
		'path', 'admitCheckPath', 'pollIntervalMs', 'retryAfterSeconds', 'template',
		'renderer', 'appName', 'statusUrl', 'supportUrl', 'incidentId'
	]),
	messageAdmission: new Set([
		'perConnectionRate', 'globalRate',
		'perConnectionBytesRate', 'globalBytesRate', 'rateWindowMs',
		'perConnectionConcurrent', 'globalConcurrent', 'maxQueue'
	]),
	// One set with the value judgment in config-guards.js, so the unknown-key
	// warning and the threshold guard can never recognize different keys.
	pressure: KNOWN_PRESSURE_OPTION_KEYS,
	// Same sharing rule for the egress ledger: the guard and the walk read one
	// key set. A typo'd ceiling (`deliverys`) would otherwise leave that
	// ceiling silently open while the operator believes it is enforced.
	egress: KNOWN_EGRESS_OPTION_KEYS,
	'egress.topic': KNOWN_EGRESS_CEILING_KEYS,
	'egress.tenant': KNOWN_EGRESS_CEILING_KEYS,
	// `workers: { comptue: 2 }` silently runs zero compute workers - the same
	// failure class, one level down, on a different option.
	workers: new Set(['compute']),
	postureExport: new Set(['path'])
};

/**
 * Every `websocket.*` key - at any depth this walk knows about - the adapter
 * does not recognize, as dotted paths. The adapt step warns on every returned
 * key.
 *
 * @param {Record<string, unknown> | null} websocket - normalized websocket options
 * @returns {string[]}
 */
export function unknownWebsocketOptionKeys(websocket) {
	if (!websocket || typeof websocket !== 'object') return [];
	/** @type {string[]} */
	const out = [];
	collectUnknownKeys(websocket, KNOWN_WEBSOCKET_OPTION_KEYS, '', out);
	return out;
}

/**
 * @param {Record<string, unknown>} bag
 * @param {Set<string>} known
 * @param {string} prefix
 * @param {string[]} out
 */
function collectUnknownKeys(bag, known, prefix, out) {
	for (const key of Object.keys(bag)) {
		const dotted = prefix ? `${prefix}.${key}` : key;
		if (!known.has(key)) {
			out.push(dotted);
			continue;
		}
		const nested = KNOWN_NESTED_WEBSOCKET_OPTION_KEYS[dotted];
		const value = bag[key];
		// `false` disables a whole section (waitingRoom, pressure) and an array
		// is never a section - neither has keys worth walking.
		if (nested && value && typeof value === 'object' && !Array.isArray(value)) {
			collectUnknownKeys(/** @type {Record<string, unknown>} */ (value), nested, dotted, out);
		}
	}
}

/**
 * The `wsOpts` payload serialized into the build as `WS_OPTIONS`. Every
 * runtime-tunable `websocket.*` key this adapter honors is threaded through
 * here - a documented key missing from this object would be silently dropped
 * at build time.
 *
 * @param {Record<string, any> | null} websocket - normalized websocket options
 * @returns {Record<string, unknown>}
 */
export function serializeWsOptions(websocket) {
	// A flag that RESTRICTS access must never be coerced: `=== true` reads
	// treat every other value as "off", so a misshaped value is a build error.
	assertWireSubscribeAuthorization(websocket, 'authorizeWireSubscribe');
	assertProtectiveNumber(websocket, 'upgradeRateLimit');
	assertProtectiveNumber(websocket, 'authPathRateLimit');
	const ZERO_WINDOW =
		'A zero WINDOW does not disable the limiter, it breaks it: every request then looks ' +
		'like a fresh window, the estimate evaluates to NaN, and NaN >= limit is false - so ' +
		'everything is admitted. Set the limit itself to 0 to disable it deliberately.';
	assertProtectiveNumber(websocket, 'upgradeRateLimitWindow', 'websocket.upgradeRateLimitWindow', { allowZero: false, zeroMeans: ZERO_WINDOW });
	assertProtectiveNumber(websocket, 'authPathRateLimitWindow', 'websocket.authPathRateLimitWindow', { allowZero: false, zeroMeans: ZERO_WINDOW });
	assertProtectiveNumber(websocket, 'maxPayloadLength', 'websocket.maxPayloadLength', {
		allowZero: false,
		ceiling: 0x7fffffff,
		zeroMeans:
			'ws reads maxPayload 0 as UNLIMITED, the opposite of a zero-byte ceiling. ' +
			'Raise the limit instead.'
	});
	assertProtectiveNumber(websocket, 'maxBackpressure', 'websocket.maxBackpressure', {
		allowZero: false,
		zeroMeans:
			'A zero backpressure ceiling reads as "drop every frame the socket cannot flush ' +
			'synchronously". Raise the ceiling instead.'
	});
	assertProtectiveNumber(websocket, 'idleTimeout');
	assertProtectiveNumber(websocket, 'upgradeTimeout');
	assertProtectiveNumber(websocket, 'maxTopicSeqEntries');
	assertSharedOptionValues(websocket, (key) => `websocket.${key}`);
	normalizeMessageAdmission(websocket?.messageAdmission, 'websocket.messageAdmission');
	return {
		maxPayloadLength: websocket?.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH,
		idleTimeout: websocket?.idleTimeout ?? 120,
		maxBackpressure: websocket?.maxBackpressure ?? 1024 * 1024,
		closeOnBackpressureLimit: websocket?.closeOnBackpressureLimit ?? false,
		sendPingsAutomatically: websocket?.sendPingsAutomatically ?? true,
		compression: websocket?.compression ?? false,
		allowedOrigins: websocket?.allowedOrigins ?? 'same-origin',
		upgradeTimeout: websocket?.upgradeTimeout ?? 10,
		upgradeRateLimit: websocket?.upgradeRateLimit ?? 10,
		upgradeRateLimitWindow: websocket?.upgradeRateLimitWindow ?? 10,
		authPathRateLimit: websocket?.authPathRateLimit ?? 30,
		authPathRateLimitWindow: websocket?.authPathRateLimitWindow ?? 10,
		upgradeAdmission: websocket?.upgradeAdmission,
		messageAdmission: websocket?.messageAdmission,
		// The per-topic seq registry cap. Absent leaves the runtime on its
		// warn-threshold default, so a zero-config build keeps today's
		// behavior and only a deployment already in warned pathology moves.
		maxTopicSeqEntries: websocket?.maxTopicSeqEntries,
		pressure: websocket?.pressure,
		// Publish-egress window and ceilings (plain numbers, so the section
		// rides the JSON payload cleanly). The tenant resolver travels
		// separately as the handler module's egressTenantOf export - the one
		// carrier that reaches the runtime as a function.
		egress: websocket?.egress,
		allowSystemTopicSubscribe: websocket?.allowSystemTopicSubscribe === true,
		authorizeWireSubscribe: websocket?.authorizeWireSubscribe === 'strict'
			? 'strict'
			: websocket?.authorizeWireSubscribe === true,
		allowNonAsciiTopics: websocket?.allowNonAsciiTopics === true,
		authPathRequireOrigin: websocket?.authPathRequireOrigin !== false,
		compressCredentialedResponses: websocket?.compressCredentialedResponses === true,
		unsafeSameOriginWithoutHostPin: websocket?.unsafeSameOriginWithoutHostPin === true
	};
}

/**
 * Every top-level option key the adapter factory consumes. A key outside this
 * set warns and is ignored rather than refused, because an app pinning an
 * older adapter must still build with a config that carries a newer version's
 * key - only a KNOWN key with an unusable VALUE fails the build.
 */
export const KNOWN_ADAPTER_OPTION_KEYS = new Set([
	'out', 'precompress', 'envPrefix', 'healthCheckPath', 'readinessCheckPath',
	'tracing', 'staticHeaders', 'staticCacheControl', 'staticDotfiles', 'websocket',
	'warmup'
]);

/**
 * Top-level keys the adapter does not recognize.
 *
 * @param {Record<string, unknown> | null | undefined} opts - raw adapter options
 * @returns {string[]}
 */
export function unknownAdapterOptionKeys(opts) {
	if (!opts || typeof opts !== 'object') return [];
	return Object.keys(opts).filter((key) => !KNOWN_ADAPTER_OPTION_KEYS.has(key));
}

/**
 * The build-time warning naming every static path the dotfile rule refuses.
 *
 * The wording has to survive its own list. The `.well-known` carve-out exempts
 * the first path SEGMENT, not the tree beneath it, so `.well-known/.nested`
 * appears among the refused paths - and a message claiming `.well-known/ is
 * always served` would be contradicted by the very list it introduces.
 *
 * @param {string[]} refused - refused static paths, relative and already deduped
 * @returns {string}
 */
export function renderRefusedDotfileWarning(refused) {
	return (
		'[adapter-ws] not served - dotfiles are refused by default (a top-level ' +
		`.well-known/ still serves its own non-dot files): ${refused.join(', ')}. ` +
		'Rename the file to serve it, or set staticDotfiles: true to serve every dotfile.'
	);
}

/**
 * Bundle a user-authored server module (the ws-handler fallback) through
 * esbuild, resolving SvelteKit aliases ($lib, kit.alias) and the $env / $app
 * virtual modules the way the app's own build would.
 *
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {string} entry - path to the user module to bundle
 * @param {string} outfile - destination in the build temp dir
 */
async function esbuildServerModule(builder, entry, outfile) {
	const esbuild = await importFromApp('esbuild');
	const { loadEnv } = await importFromApp('vite');
	const libDir = path.resolve(builder.config.kit.files?.lib || 'src/lib');
	const publicPrefix = builder.config.kit.env?.publicPrefix ?? 'PUBLIC_';
	const allEnv = loadEnv('production', process.cwd(), '');
	const version = builder.config.kit.version?.name ?? '';
	/** @type {Record<string, string>} */
	const aliasMap = { '$lib': libDir };
	const kitAliases = builder.config.kit.alias;
	if (kitAliases) {
		for (const [key, value] of Object.entries(kitAliases)) {
			if (!(key in aliasMap)) aliasMap[key] = path.resolve(value);
		}
	}
	await esbuild.build({
		entryPoints: [path.resolve(entry)],
		bundle: true,
		format: 'esm',
		platform: 'node',
		outfile,
		alias: aliasMap,
		packages: 'external',
		plugins: [{
			name: 'sveltekit-virtual-modules',
			setup(build) {
				build.onResolve({ filter: /^\$(env|app)\// }, (args) => ({
					path: args.path,
					namespace: 'sveltekit'
				}));
				build.onLoad({ filter: /.*/, namespace: 'sveltekit' }, (args) => {
					if (args.path === '$app/environment') {
						return { contents: `export const dev = false;\nexport const building = false;\nexport const version = ${JSON.stringify(version)};` };
					}
					const isPublic = args.path.includes('/public');
					const isStatic = args.path.includes('/static');
					if (!isStatic) {
						if (isPublic) {
							return { contents: `export const env = new Proxy(process.env, { get(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) ? t[k] : undefined; }, ownKeys(t) { return Object.keys(t).filter(k => k.startsWith(${JSON.stringify(publicPrefix)})); }, has(t, k) { return typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t; }, getOwnPropertyDescriptor(t, k) { if (typeof k === 'string' && k.startsWith(${JSON.stringify(publicPrefix)}) && k in t) return { value: t[k], enumerable: true, configurable: true }; return undefined; } });` };
						}
						return { contents: 'export const env = process.env;' };
					}
					const entries = Object.entries(allEnv).filter(([k]) =>
						(isPublic ? k.startsWith(publicPrefix) : !k.startsWith(publicPrefix))
						&& /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
					);
					return { contents: entries.map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n') || 'export {};' };
				});
			}
		}]
	});
}

/** @type {import('./index.js').default} */
export default function (opts = {}) {
	const { out = 'build', precompress = true, envPrefix = '', healthCheckPath = '/healthz', readinessCheckPath = '/readyz' } = opts;

	// Readiness-gated boot warmup: render the configured paths once during the
	// `starting` window so the SSR render path is warm before the readiness
	// probe reports ready (a cold first render costs ~20x a warm one, and a
	// load balancer routes the first real client the moment readiness turns
	// green). Default on, warming '/'; `false` disables it; `{ paths }` names
	// the routes to warm. The value is baked to the list of paths (or an empty
	// list when disabled).
	const warmupOption = opts.warmup === undefined ? true : opts.warmup;
	let warmupPaths;
	if (warmupOption === false) {
		warmupPaths = [];
	} else if (warmupOption === true) {
		warmupPaths = ['/'];
	} else if (warmupOption && typeof warmupOption === 'object' && Array.isArray(warmupOption.paths)) {
		if (!warmupOption.paths.every((p) => typeof p === 'string' && p[0] === '/')) {
			throw new Error(
				`warmup.paths must be an array of absolute pathname strings starting with '/' ` +
				`(e.g. ['/', '/dashboard']), got ${JSON.stringify(warmupOption.paths)}.`
			);
		}
		warmupPaths = warmupOption.paths.slice();
	} else {
		throw new Error(
			`warmup must be true, false, or an object like { paths: ['/'] }, got ${JSON.stringify(warmupOption)}.`
		);
	}

	// Readiness probe path (distinct from the `healthCheckPath` liveness probe):
	// reports 503 once graceful shutdown begins so a load balancer drains the
	// instance. Default `/readyz`; set `false` to disable. Validated here so a
	// misconfiguration fails the build rather than silently no-op'ing.
	if (readinessCheckPath !== false) {
		if (typeof readinessCheckPath !== 'string' || readinessCheckPath[0] !== '/') {
			throw new Error(
				`readinessCheckPath must be an absolute path string starting with '/' ` +
				`(e.g. '/readyz'), or false to disable the readiness route - ` +
				`got ${JSON.stringify(readinessCheckPath)}.`
			);
		}
		if (healthCheckPath !== false && readinessCheckPath === healthCheckPath) {
			throw new Error(
				`readinessCheckPath ('${readinessCheckPath}') must differ from healthCheckPath ('${healthCheckPath}') - ` +
				`liveness and readiness are distinct probes (a readiness 503 during drain must not trip a liveness restart).`
			);
		}
	}

	const tracingOption = opts.tracing;
	if (tracingOption != null && (typeof tracingOption !== 'string' || tracingOption.trim() === '')) {
		throw new Error(
			"tracing must be a non-empty module path string (e.g. './src/lib/server/tracing.js') " +
			'whose default or named tracing export implements startSpan(name, options).'
		);
	}
	const tracingPath = typeof tracingOption === 'string' ? tracingOption.trim() : null;

	// Normalize websocket config: true -> {}, false/undefined -> null
	const websocket =
		opts.websocket === true
			? {}
			: opts.websocket || null;

	if (websocket) {
		for (const key of UNSHIPPED_WEBSOCKET_KEYS) {
			if (websocket[key] !== undefined) {
				throw new Error(
					`[adapter-ws] websocket.${key} is not available yet in svelte-adapter-ws. ` +
					'The lane behind it has not shipped here; remove the option, or use ' +
					'svelte-adapter-uws where it is supported.'
				);
			}
		}
		if (websocket.handler != null && typeof websocket.handler !== 'string') {
			throw new Error(
				`websocket.handler must be a path string (e.g. './src/lib/server/ws.js') - ` +
				`got ${JSON.stringify(websocket.handler)}.`
			);
		}
		// The holding page an operator supplies, judged here rather than at
		// boot: a renderer is a module PATH (a live function cannot survive the
		// options serialization), the two override forms are mutually
		// exclusive, and a template string is compiled now so a broken token or
		// an inaccessible document fails the build instead of the first
		// refusal a real user sees.
		const waitingRoomTemplate = websocket.upgradeAdmission?.waitingRoom?.template;
		const waitingRoomRenderer = websocket.upgradeAdmission?.waitingRoom?.renderer;
		if (waitingRoomRenderer != null && typeof waitingRoomRenderer !== 'string') {
			throw new Error(
				`websocket.upgradeAdmission.waitingRoom.renderer must be a module path string ` +
				`(e.g. './src/lib/server/waiting-room.js') - got ${JSON.stringify(waitingRoomRenderer)}.`
			);
		}
		if (typeof waitingRoomRenderer === 'string' && waitingRoomRenderer.trim() === '') {
			throw new Error(
				'websocket.upgradeAdmission.waitingRoom.renderer must not be an empty module path.'
			);
		}
		if (waitingRoomRenderer && waitingRoomTemplate != null) {
			throw new Error(
				'websocket.upgradeAdmission.waitingRoom.renderer and .template are mutually exclusive.'
			);
		}
		if (typeof waitingRoomTemplate === 'string') {
			compileAccessibleWaitingRoomTemplate(waitingRoomTemplate);
		}
		// A misshaped ceiling must fail at the factory, before any build work:
		// a typo'd egress key would otherwise leave that ceiling silently open
		// while the operator believes it is enforced. The seq-registry cap
		// rides the same rule - a bad value would fall back to the default
		// bound and silently size nothing the operator asked for.
		assertEgressSection(websocket);
		assertProtectiveNumber(websocket, 'maxTopicSeqEntries');
		if (websocket.primaryInit != null && typeof websocket.primaryInit !== 'string') {
			throw new Error(
				"websocket.primaryInit must be a module path string (e.g. './src/lib/server/cluster.js') " +
				'whose default (or named `primaryInit`) export is a function run once in the primary thread ' +
				'before workers spawn. A live function cannot be passed: adapter options are serialized into ' +
				'the build, so it would never reach the production runtime.'
			);
		}
	}

	// Worker roles: `websocket.workers.compute` is how many of the cluster's
	// CLUSTER_WORKERS total are dedicated compute workers (no listen socket;
	// app-driven via the primaryInit shared memory). io = total - compute.
	// Serialized into the primary-visible WORKERS_CONFIG placeholder (plain
	// data - the count - so it rides the JSON cleanly, unlike primaryInit).
	let computeWorkers = 0;
	if (websocket?.workers != null) {
		const w = websocket.workers;
		if (typeof w !== 'object' || Array.isArray(w)) {
			throw new Error('websocket.workers must be an object, e.g. { compute: 2 }.');
		}
		if (w.compute != null) {
			if (!Number.isInteger(w.compute) || w.compute < 0) {
				throw new Error(
					`websocket.workers.compute must be a non-negative integer (how many of the ` +
					`CLUSTER_WORKERS total are compute workers), got ${JSON.stringify(w.compute)}.`
				);
			}
			computeWorkers = w.compute;
		}
	}

	// Validate `staticHeaders` eagerly so a misshaped value fails before any
	// build work. The reserved-key warning needs builder.log, so it is emitted
	// inside adapt(); the throw-on-bad-shape path runs here at factory time.
	const staticHeadersResult = normalizeStaticHeaders(opts.staticHeaders);
	const staticCacheControl = normalizeStaticCacheControl(opts.staticCacheControl);

	if (opts.staticDotfiles !== undefined && typeof opts.staticDotfiles !== 'boolean') {
		// JSON.stringify throws on a BigInt and erases functions and Symbols;
		// String() throws on a null-prototype object. The tag form renders any
		// object, String() everything else.
		const shown = typeof opts.staticDotfiles === 'object' && opts.staticDotfiles !== null
			? Object.prototype.toString.call(opts.staticDotfiles)
			: String(opts.staticDotfiles);
		throw new Error(
			`staticDotfiles must be a boolean - got ${shown} (${typeof opts.staticDotfiles}). ` +
			'The default (false) refuses every dot-segment static path, except that a ' +
			'top-level .well-known/ keeps serving its own non-dot files; true indexes ' +
			'and serves them all.'
		);
	}
	const staticDotfiles = opts.staticDotfiles === true;

	return {
		name: 'adapter-ws',

		async adapt(builder) {
			const tmp = builder.getBuildDirectory('adapter-ws');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`)
				]);
			}

			builder.log.minor('Building server');

			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			// - WebSocket handler module -----------------------------------------
			if (websocket) {
				if (existsSync(`${tmp}/ws-handler.js`)) {
					// A Vite plugin already emitted the handler through the app's
					// own bundle; take it as it stands.
					builder.log.minor('WebSocket handler: built by Vite plugin');
				} else {
					let handlerFile = websocket.handler;
					if (!handlerFile) {
						const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
						for (const candidate of candidates) {
							if (existsSync(candidate)) {
								handlerFile = candidate;
								break;
							}
						}
					}
					if (handlerFile) {
						if (!existsSync(handlerFile) && (handlerFile.startsWith('./') || handlerFile.startsWith('../'))) {
							throw new Error(
								`[adapter-ws] WebSocket handler ${JSON.stringify(handlerFile)} does not exist.`
							);
						}
						// Bundle through esbuild to resolve SvelteKit aliases and TS.
						await esbuildServerModule(builder, handlerFile, `${tmp}/ws-handler.js`);
						builder.log.minor(`WebSocket handler: ${handlerFile}`);
					} else {
						writeFileSync(`${tmp}/ws-handler.js`, DEFAULT_WS_HANDLER);
						builder.log.minor('WebSocket enabled (built-in handler)');
					}
				}
			} else {
				writeFileSync(`${tmp}/ws-handler.js`, '// No WebSocket handler configured\n');
			}

			// - primaryInit module ------------------------------------------------
			// Like `handler`, this is a module PATH, not a live function: it is
			// bundled as its own isolated rollup entry whose default export (or a
			// named `primaryInit` export) runs ONCE in the cluster primary before
			// any worker spawns. Importing the entry must never pull the app graph
			// into the primary, which is why it gets its own bundle.
			const primaryInitPath = websocket?.primaryInit;
			if (primaryInitPath && existsSync(`${tmp}/primary-init.js`)) {
				builder.log.minor('primaryInit: built by Vite plugin');
			} else if (primaryInitPath) {
				const primaryInitEntry = `${tmp}/primary-init-src.js`;
				// Pass the namespace through a pick() so esbuild does not
				// statically resolve `.default`/`.primaryInit` against the user's
				// module and warn for whichever export form they did not use.
				writeFileSync(
					primaryInitEntry,
					`import * as m from ${JSON.stringify(path.resolve(primaryInitPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.primaryInit ?? null;\n' +
					'export default pick(m);\n'
				);
				await esbuildServerModule(builder, primaryInitEntry, `${tmp}/primary-init.js`);
				builder.log.minor(`primaryInit: ${primaryInitPath}`);
			} else {
				writeFileSync(`${tmp}/primary-init.js`, 'export default null;\n');
			}

			// `workers: { comptue: 2 }` would silently run zero compute workers -
			// the same unknown-key failure class as the top level, one level down.
			if (websocket?.workers != null && typeof websocket.workers === 'object' && !Array.isArray(websocket.workers)) {
				const unknownWorkerKeys = describeUnknownOptionKeys(websocket.workers, new Set(['compute']));
				if (unknownWorkerKeys.length) {
					builder.log.warn(
						`[adapter-ws] unknown websocket.workers option(s): ${unknownWorkerKeys.join(', ')} - ` +
						'not recognized by the adapter and ignored. The one recognized key is compute.'
					);
				}
			}

			// The public @sveltejs/kit/node primitives the runtime is built on,
			// bundled INTO the build output. The copied runtime cannot import
			// '@sveltejs/kit/node' from node_modules at deploy time - kit is a
			// devDependency in most apps and absent from a production install -
			// so the primitives ride the server bundle like the app itself does.
			writeFileSync(
				`${tmp}/kit-node.js`,
				"export { getRequest, setResponse, createReadableStream } from '@sveltejs/kit/node';\n"
			);

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			/** @type {Record<string, string>} */
			const input = {
				index: `${tmp}/index.js`,
				manifest: `${tmp}/manifest.js`,
				'kit-node': `${tmp}/kit-node.js`,
				'ws-handler': `${tmp}/ws-handler.js`,
				'primary-init': `${tmp}/primary-init.js`
			};

			if (builder.hasServerInstrumentationFile?.()) {
				input['instrumentation.server'] = `${tmp}/instrumentation.server.js`;
			}

			// Bundle the Vite output so that deployments only need their
			// production dependencies. Anything in devDependencies gets
			// included in the bundled code.
			const bundle = await rollup({
				input,
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`)),
					// the transport library stays external - it is this adapter's
					// own runtime dependency and ships with it
					/^ws$/
				],
				plugins: [
					nodeResolve({
						preferBuiltins: true,
						exportConditions: ['node']
					}),
					commonjs({ strictRequires: true }),
					json()
				],
				onwarn(warning, warn) {
					// Rollup's default for an unresolved import is a warning and
					// a bare specifier left in the bundle - which surfaces only
					// at deploy time, on a machine with no devDependencies to
					// fall back on. Refusing the build here is the loud version.
					if (warning.code === 'UNRESOLVED_IMPORT') {
						throw new Error(
							`[adapter-ws] could not resolve ${JSON.stringify(warning.exporter)} ` +
							`imported by ${JSON.stringify(warning.id)} - the server bundle must be ` +
							'self-contained apart from its declared runtime dependencies.'
						);
					}
					warn(warning);
				}
			});

			try {
				await bundle.write({
					dir: `${out}/server`,
					format: 'esm',
					sourcemap: true,
					chunkFileNames: 'chunks/[name]-[hash].js'
				});
			} finally {
				// Rollup does not implicitly close after a successful write, and
				// close() is what runs closeBundle hooks and releases handles.
				await bundle.close();
			}

			// Loud on unknown top-level keys: a key the factory does not read is
			// dropped silently otherwise. Warned, never refused: an app pinning
			// an older adapter must still build with a config carrying a newer
			// version's key.
			const unknownTopLevelKeys = unknownAdapterOptionKeys(opts);
			if (unknownTopLevelKeys.length) {
				builder.log.warn(
					`[adapter-ws] unknown adapter option(s): ${unknownTopLevelKeys.join(', ')} - ` +
					'not recognized by the adapter and ignored. Check the spelling against the ' +
					'documented adapter options.'
				);
			}

			// staticHeaders: app-chosen response headers for static and prerendered
			// assets (CSP, HSTS, X-Frame-Options, ...). These bypass the SvelteKit
			// `handle` hook, which only runs on the SSR path - so security headers
			// set there never reach static/prerendered responses. Reserved
			// transfer/caching headers are stripped (the handler owns them); warn
			// so a dropped override is never silent.
			if (staticHeadersResult.dropped.length) {
				builder.log.warn(
					`[adapter-ws] staticHeaders ignored: ${staticHeadersResult.dropped.join(', ')}. ` +
					'These transfer/caching/range headers are managed by the static file ' +
					'handler and cannot be overridden (content-type, content-encoding, etag, ' +
					'cache-control, vary, accept-ranges, ...). Use staticCacheControl for ' +
					'path-specific cache policies. Every other header is applied.'
				);
			}

			// Dotfiles are excluded from the static index by default, so a
			// dot-path in the output would 404 in production with nothing saying
			// why. Say so here, where the file is still in front of the developer.
			if (!staticDotfiles) {
				const outBase = builder.config.kit.paths.base;
				const refused = [...new Set([
					...listExcludedDotPaths(`${out}/client${outBase}`),
					...listExcludedDotPaths(`${out}/prerendered${outBase}`)
				])];
				if (refused.length) {
					builder.log.warn(renderRefusedDotfileWarning(refused));
				}
			}

			// WebSocket path config, serialized as globals for the runtime.
			const wsPath = websocket?.path ?? '/ws';
			if (wsPath[0] !== '/') {
				throw new Error(
					`websocket.path must start with '/' - got '${wsPath}'. Use '/${wsPath}' instead.`
				);
			}
			const wsAuthPath = websocket?.authPath ?? '/__ws/auth';
			if (wsAuthPath[0] !== '/') {
				throw new Error(
					`websocket.authPath must start with '/' - got '${wsAuthPath}'. Use '/${wsAuthPath}' instead.`
				);
			}
			if (wsAuthPath === wsPath) {
				throw new Error(
					`websocket.authPath ('${wsAuthPath}') must differ from websocket.path ('${wsPath}').`
				);
			}
			const wsOpts = websocket ? serializeWsOptions(websocket) : null;

			// Loud on unknown websocket.* keys: options are serialized into the
			// build, so a key the adapter does not recognize would be dropped
			// silently - warn so a typo surfaces instead of no-op'ing.
			if (websocket) {
				const unknownWsKeys = unknownWebsocketOptionKeys(websocket);
				if (unknownWsKeys.length) {
					builder.log.warn(
						`[adapter-ws] unknown websocket option(s): ${unknownWsKeys.join(', ')} - ` +
						'not recognized by the adapter and ignored. Check the spelling against the ' +
						'documented websocket options.'
					);
				}
			}

			// A function waiting-room template cannot be serialized into the
			// build, so it would be dropped in silence and the operator would
			// get the built-in page believing theirs was in use. The template
			// is an HTML string with {{token}} placeholders.
			const wrTemplate = websocket?.upgradeAdmission?.waitingRoom;
			if (wrTemplate && typeof wrTemplate === 'object' && typeof wrTemplate.template === 'function') {
				builder.log.warn(
					'[adapter-ws] upgradeAdmission.waitingRoom.template must now be an HTML string ' +
					'with {{queueDepth}} / {{estimatedSeconds}} / {{pollIntervalMs}} / ' +
					'{{retryAfterSeconds}} / {{admitCheckPath}} / {{appName}} / {{statusUrl}} / ' +
					'{{supportUrl}} / {{incidentId}} tokens. A function cannot be serialized ' +
					'into the build and was ignored; the built-in holding page is being used.'
				);
			}

			builder.copy(runtimeDir, out, {
				replace: {
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					KIT_NODE: './server/kit-node.js',
					WS_HANDLER: './server/ws-handler.js',
					TRACING_PROVIDER: './tracing-provider.js',
					WAITING_ROOM_RENDERER: './server/waiting-room-renderer.js',
					ENV_PREFIX: JSON.stringify(envPrefix),
					PRECOMPRESS: JSON.stringify(precompress),
					WS_ENABLED: JSON.stringify(!!websocket),
					WS_PATH: JSON.stringify(wsPath),
					WS_AUTH_PATH: JSON.stringify(wsAuthPath),
					WS_OPTIONS: JSON.stringify(wsOpts),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath),
					READINESS_CHECK_PATH: JSON.stringify(readinessCheckPath),
					WARMUP_PATHS: JSON.stringify(warmupPaths),
					STATIC_HEADERS: JSON.stringify(staticHeadersResult.headers),
					STATIC_CACHE_CONTROL: JSON.stringify(staticCacheControl),
					STATIC_DOTFILES: JSON.stringify(staticDotfiles),
					PRIMARY_INIT: './server/primary-init.js',
					WORKERS_CONFIG: JSON.stringify({ compute: computeWorkers })
				}
			});
			// tracing.js reaches trace-context.js at the runtime root once
			// copied; in the source tree it sits one level up.
			const tracingRuntimePath = out + '/tracing.js';
			const tracingRuntimeSource = readFileSync(tracingRuntimePath, 'utf8');
			const generatedTracingRuntime = tracingRuntimeSource.replace(
				"from '../trace-context.js';",
				"from './trace-context.js';"
			);
			if (generatedTracingRuntime === tracingRuntimeSource) {
				throw new Error('Failed to rewrite the generated tracing helper import.');
			}
			writeFileSync(tracingRuntimePath, generatedTracingRuntime);
			writeFileSync(
				out + '/trace-context.js',
				readFileSync(new URL('./trace-context.js', import.meta.url), 'utf8')
			);
			// The tracing provider: the configured module is bundled through
			// esbuild (resolving SvelteKit aliases and TS) behind a wrapper that
			// validates the export shape at boot; a null stub keeps the bridge
			// import resolvable when the option is unset.
			if (tracingPath) {
				const tracingEntry = `${tmp}/tracing-provider-entry-src.js`;
				writeFileSync(
					tracingEntry,
					`import * as m from ${JSON.stringify(path.resolve(tracingPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.tracing ?? ns.provider ?? null;\n' +
					'const selected = pick(m);\n' +
					"if (!selected || typeof selected.startSpan !== 'function') {\n" +
					"  throw new Error('[adapter-ws] configured tracing module must export a provider with startSpan(name, options).');\n" +
					'}\n' +
					'export default selected;\n'
				);
				await esbuildServerModule(builder, tracingEntry, out + '/tracing-provider.js');
				builder.log.minor(`Tracing provider: ${tracingPath}`);
			} else {
				writeFileSync(out + '/tracing-provider.js', 'export default null;\n');
			}

			// Per-request waiting-room renderer. A module path rather than a
			// live function for the same serialization reason as primaryInit:
			// adapter options are serialized into the build. The user's default
			// or named renderWaitingRoom export is bundled into an isolated
			// server entry; a null stub keeps the runtime bridge resolvable
			// when the feature is unused.
			const waitingRoomRendererPath =
				websocket?.upgradeAdmission?.waitingRoom &&
				typeof websocket.upgradeAdmission.waitingRoom === 'object'
					? websocket.upgradeAdmission.waitingRoom.renderer
					: null;
			if (waitingRoomRendererPath) {
				const rendererEntry = `${tmp}/waiting-room-renderer-entry-src.js`;
				writeFileSync(
					rendererEntry,
					`import * as m from ${JSON.stringify(path.resolve(waitingRoomRendererPath))};\n` +
					'const pick = (ns) => ns.default ?? ns.renderWaitingRoom ?? null;\n' +
					'export default pick(m);\n'
				);
				await esbuildServerModule(builder, rendererEntry, out + '/server/waiting-room-renderer.js');
				builder.log.minor(`Waiting-room renderer: ${waitingRoomRendererPath}`);
			} else {
				writeFileSync(out + '/server/waiting-room-renderer.js', 'export default null;\n');
			}

			// Runtime-readable identity metadata. Keep this as package/schema
			// files beside the copied runtime rather than compiling version
			// literals into JavaScript: diagnostics then report the adapter and
			// protocol artifacts that actually produced this server build.
			const metadataDir = out + '/meta/svelte-adapter-ws';
			mkdirSync(metadataDir, { recursive: true });
			writeFileSync(
				metadataDir + '/package.json',
				readFileSync(new URL('../package.json', import.meta.url), 'utf8')
			);
			writeFileSync(
				out + '/meta/protocol.schema.json',
				readFileSync(new URL('../protocol.schema.json', import.meta.url), 'utf8')
			);

			if (builder.hasServerInstrumentationFile?.()) {
				builder.instrument?.({
					entrypoint: `${out}/index.js`,
					instrumentation: `${out}/server/instrumentation.server.js`,
					module: {
						exports: ['host', 'port']
					}
				});
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		}
	};
}
