// The Vite plugin against SvelteKit 3's configuration shape: the adapter sits
// directly on the sveltekit() plugin options (no `kit` key), the production
// build resolves one config for both environments (so `build.ssr` is false
// while an `ssr` environment exists), and dev serves routes through the SSR
// environment runner rather than the legacy ssrLoadModule graph. The SvelteKit
// 2 shape is driven beside each case as the control.

import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {Record<string, unknown>} adapterFields */
function kit3Plugins(adapterFields) {
	return [{ name: 'vite-plugin-sveltekit-setup', api: { options: { adapter: { name: 'adapter-ws', ...adapterFields } } } }];
}

/** @param {Record<string, unknown>} adapterFields */
function kit2Plugins(adapterFields) {
	return [{ name: 'vite-plugin-sveltekit-setup', api: { options: { kit: { adapter: { name: 'adapter-ws', ...adapterFields } } } } }];
}

describe('SvelteKit 3 production build', () => {
	it('emits the handler named on a flat adapter option from a shared-environment build', async () => {
		const mod = await import('../src/vite.js');
		const plugin = mod.default();
		await plugin.configResolved({
			root: process.cwd(),
			command: 'build',
			build: { ssr: false },
			environments: { client: {}, ssr: {} },
			plugins: kit3Plugins({ websocketHandler: './test/vite-kit3.test.js' })
		});
		const emitFile = vi.fn();
		plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });
		expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({
			type: 'chunk',
			id: path.resolve('test/vite-kit3.test.js'),
			fileName: 'ws-handler.js'
		}));
		const marker = emitFile.mock.calls.map(([arg]) => arg).find((arg) => arg.fileName === 'ws-handler.origin.json');
		expect(JSON.parse(marker.source).from).toBe('websocket.handler in SvelteKit config');
	});

	it('does not treat a dev server config with an ssr environment as a build', async () => {
		const mod = await import('../src/vite.js');
		const plugin = mod.default({ handler: './test/vite-kit3.test.js' });
		await plugin.configResolved({
			root: process.cwd(),
			command: 'serve',
			build: { ssr: false },
			environments: { client: {}, ssr: {} }
		});
		const emitFile = vi.fn();
		plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });
		expect(emitFile).not.toHaveBeenCalled();
	});
});

describe('SvelteKit 3 development server', () => {
	/** @type {import('node:http').Server | null} */
	let httpServer = null;

	afterEach(async () => {
		const server = httpServer;
		httpServer = null;
		if (server?.listening) await new Promise((resolve) => server.close(resolve));
	});

	/**
	 * Boot the real plugin against a fake Vite dev server that records which
	 * loader each module went through.
	 *
	 * @param {any[]} plugins the resolved Vite plugin list
	 * @param {{ listen?: boolean }} [options]
	 */
	async function bootDev(plugins, { listen = true } = {}) {
		const mod = await import('../src/vite.js');
		const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
		const server = createServer();
		httpServer = server;
		if (listen) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		/** @type {string[]} */
		const runnerImports = [];
		/** @type {string[]} */
		const legacyLoads = [];
		const registry = { counter: () => ({ inc() {} }), gauge: () => ({ set() {} }), histogram: () => ({ observe() {} }) };
		const captured = { platform: /** @type {any} */ (null) };
		const handlerModule = { init({ platform }) { captured.platform = platform; }, message() {} };
		/** @param {string} id */
		const answer = (id) => (String(id).includes('virtual-metrics-registry') ? { default: registry } : handlerModule);
		const viteServer = {
			httpServer: server,
			middlewares: { use() {}, stack: [] },
			config: {
				root: process.cwd(),
				logger: { warn() {}, info() {}, error() {} },
				server: {},
				plugins
			},
			environments: {
				ssr: {
					runner: {
						/** @param {string} id */
						async import(id) { runnerImports.push(String(id)); return answer(id); }
					}
				}
			},
			/** @param {string} id */
			async ssrLoadModule(id) { legacyLoads.push(String(id)); return answer(id); }
		};
		await plugin.configureServer(viteServer);
		await new Promise((r) => setTimeout(r, 80));
		return { plugin, viteServer, server, runnerImports, legacyLoads, registry, captured };
	}

	it('loads the handler and metrics module through the SSR environment runner', async () => {
		const dev = await bootDev(kit3Plugins({ websocketMetrics: '/virtual-metrics-registry.js' }));
		expect(dev.legacyLoads).toEqual([]);
		expect(dev.runnerImports.some((id) => id.includes('virtual-metrics-registry'))).toBe(true);
		expect(dev.runnerImports.some((id) => id.includes('virtual-ws-handler'))).toBe(true);
		expect(dev.captured.platform, 'the handler loaded through the runner must be initialized').toBeTruthy();
		expect(dev.captured.platform.metrics).toBe(dev.registry);
	});

	it('reloads the handler through the runner on a hot update', async () => {
		const dev = await bootDev(kit3Plugins({}));
		const before = dev.runnerImports.length;
		dev.plugin.handleHotUpdate({ server: dev.viteServer });
		await new Promise((r) => setTimeout(r, 40));
		expect(dev.runnerImports.length).toBe(before + 1);
		expect(dev.runnerImports.at(-1)).toContain('virtual-ws-handler');
		expect(dev.legacyLoads).toEqual([]);
	});

	it('waits for the dev server to listen before importing through the runner', async () => {
		const dev = await bootDev(kit3Plugins({}), { listen: false });
		expect(dev.runnerImports, 'nothing may be imported before the environment is ready').toEqual([]);
		await new Promise((resolve) => dev.server.listen(0, '127.0.0.1', resolve));
		await new Promise((r) => setTimeout(r, 80));
		expect(dev.runnerImports.some((id) => id.includes('virtual-ws-handler'))).toBe(true);
		expect(dev.legacyLoads).toEqual([]);
	});

	it('keeps the SvelteKit 2 configuration on ssrLoadModule', async () => {
		const dev = await bootDev(kit2Plugins({ websocketMetrics: '/virtual-metrics-registry.js' }));
		expect(dev.runnerImports).toEqual([]);
		expect(dev.legacyLoads.some((id) => id.includes('virtual-metrics-registry'))).toBe(true);
		expect(dev.legacyLoads.some((id) => id.includes('virtual-ws-handler'))).toBe(true);
		expect(dev.captured.platform.metrics).toBe(dev.registry);
	});
});
