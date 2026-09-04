import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Dependency discovery and pre-bundling buy nothing here: modules load
	// through Node's own resolver.
	optimizeDeps: {
		noDiscovery: true,
		include: []
	},
	server: {
		watch: { ignored: ['**/source/**', '**/bench/**'] },
		fs: { deny: ['source'] }
	},
	test: {
		// Expose `global.gc` so the real-server leak harness runs instead of
		// gating itself off. Set here rather than in NODE_OPTIONS because an
		// inline environment assignment in an npm script does not carry across
		// Windows. The flag only publishes the collection hook; it does not
		// change how V8 collects, so no other suite's behaviour moves.
		execArgv: ['--expose-gc'],
		include: ['test/**/*.test.js'],
		// `**/node_modules/**`, not `node_modules/**`. And `test/fixture/**`
		// specifically: the fixture is a SvelteKit app with its own sources and
		// build output, and collecting inside it would run third-party suites as
		// part of this repository's run.
		exclude: ['source/**', '**/node_modules/**', 'bench/**', 'test/e2e/**', 'test/fixture/**'],
		// Build the fixture variants once, serially, before any worker starts.
		// Without this every suite that needs a build races the others for one
		// on-disk lock, and the losers sleep-poll through somebody else's
		// `vite build` - which on a loaded machine becomes a failure that only
		// reproduces under full parallelism. See the helper.
		globalSetup: ['./test/helpers/global-setup.js'],
		// Restore `globalThis.WebSocket` / `window` after each test FILE, and
		// stop any runtime a suite left listening. See the helpers.
		setupFiles: ['./test/helpers/restore-globals.js', './test/helpers/stop-leaked-runtimes.js'],
		// The integration lane boots real node:http servers on ephemeral ports;
		// keep the default forks pool so a wedged server cannot hang the runner.
		// This is the one place this config deliberately differs from the lead's,
		// which runs vmForks against a native transport.
		testTimeout: 15000,
		hookTimeout: 15000
	}
});
