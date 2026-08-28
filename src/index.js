import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { normalizeStaticCacheControl, normalizeStaticHeaders } from './build-config.js';
import { listExcludedDotPaths } from './static-scan.js';

const runtimeDir = fileURLToPath(new URL('./runtime', import.meta.url).href);

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

	// These two option families are declared surface across the adapter family,
	// but their lanes have not shipped in this adapter. A config that sets them
	// expects behavior this build cannot deliver, so the build refuses loudly
	// instead of dropping the option on the floor.
	if (opts.websocket !== undefined && opts.websocket !== false) {
		throw new Error(
			'[adapter-ws] The websocket option is not available yet in svelte-adapter-ws. ' +
			'The realtime lane is under construction; until it ships, use svelte-adapter-uws ' +
			'for realtime apps or remove the websocket option.'
		);
	}
	if (opts.tracing != null) {
		throw new Error(
			'[adapter-ws] The tracing option is not available yet in svelte-adapter-ws. ' +
			'Remove the option, or instrument via OpenTelemetry auto-instrumentation, which ' +
			'hooks node:http directly.'
		);
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
				'kit-node': `${tmp}/kit-node.js`
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
				]
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

			builder.copy(runtimeDir, out, {
				replace: {
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					KIT_NODE: './server/kit-node.js',
					ENV_PREFIX: JSON.stringify(envPrefix),
					PRECOMPRESS: JSON.stringify(precompress),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath),
					READINESS_CHECK_PATH: JSON.stringify(readinessCheckPath),
					WARMUP_PATHS: JSON.stringify(warmupPaths),
					STATIC_HEADERS: JSON.stringify(staticHeadersResult.headers),
					STATIC_CACHE_CONTROL: JSON.stringify(staticCacheControl),
					STATIC_DOTFILES: JSON.stringify(staticDotfiles)
				}
			});

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
