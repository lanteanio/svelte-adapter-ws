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
	describeUnknownOptionKeys,
	DEFAULT_MAX_PAYLOAD_LENGTH
} from './config-guards.js';
import { normalizeMessageAdmission } from './runtime/utils/message-admission.js';

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
	'adminPath', 'adminAuthAcknowledged', 'metrics', 'primaryInit', 'workers',
	'maxTopicSeqEntries', 'upgradeAdmission', 'egress', 'protection',
	'stateHashIntervalMs', 'consistencyAuditIntervalMs', 'resourceGrowthAuditIntervalMs',
	'postureExport'
];

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
		messageAdmission: websocket?.messageAdmission,
		pressure: websocket?.pressure,
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

	// The tracing lane has not shipped in this adapter. A config that sets it
	// expects behavior this build cannot deliver, so the build refuses loudly
	// instead of dropping the option on the floor.
	if (opts.tracing != null) {
		throw new Error(
			'[adapter-ws] The tracing option is not available yet in svelte-adapter-ws. ' +
			'Remove the option, or instrument via OpenTelemetry auto-instrumentation, which ' +
			'hooks node:http directly.'
		);
	}

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
				'ws-handler': `${tmp}/ws-handler.js`
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
				const unknownWsKeys = describeUnknownOptionKeys(websocket, KNOWN_WEBSOCKET_OPTION_KEYS);
				if (unknownWsKeys.length) {
					builder.log.warn(
						`[adapter-ws] unknown websocket option(s): ${unknownWsKeys.join(', ')} - ` +
						'not recognized by the adapter and ignored. Check the spelling against the ' +
						'documented websocket options.'
					);
				}
			}

			builder.copy(runtimeDir, out, {
				replace: {
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					KIT_NODE: './server/kit-node.js',
					WS_HANDLER: './server/ws-handler.js',
					TRACING_PROVIDER: './tracing-provider.js',
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
					STATIC_DOTFILES: JSON.stringify(staticDotfiles)
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
			// The tracing provider stub keeps the bridge import resolvable; the
			// tracing option itself is refused until its lane ships.
			writeFileSync(out + '/tracing-provider.js', 'export default null;\n');

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
