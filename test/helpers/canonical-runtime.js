import { buildRuntime, bootRuntime } from './build-runtime.js';
export const hasUWS = true;
export const EVAL_TIME_ENV = ['ORIGIN', 'CANONICAL_HOST_ALIASES', 'HOST_HEADER', 'PORT_HEADER', 'PROTOCOL_HEADER', 'TRUSTED_PROXIES'];
export async function startRealRuntime({ variant, env }) {
	const prefix = 'CANONICAL_' + variant.toUpperCase() + '_';
	const before = new Map(Object.keys(env).map(key => [prefix + key, process.env[prefix + key]]));
	for (const [key, value] of Object.entries(env)) process.env[prefix + key] = value;
	const payload = buildRuntime({
		replace: { ENV_PREFIX: JSON.stringify(prefix), HEALTH_CHECK_PATH: JSON.stringify(variant === 'canonicalhost' ? '/alive-canonical' : '/healthz'), READINESS_CHECK_PATH: JSON.stringify(variant === 'canonicalhost' ? '/ready-canonical' : '/readyz') },
		files: { 'client/test.txt': 'static control', 'prerendered/pages/prerendered/caf\u00e9.html': 'prerendered control' },
		manifestSource: "export const manifest = { appPath: '_app' }; export const prerendered = new Set(['/prerendered/caf\u00e9']); export const base = '';",
		serverSource: `export class Server {
			async init() {}
			async respond(request) {
				if (request.url.includes('/slow-hold')) { globalThis.__slowHoldStarted = (globalThis.__slowHoldStarted || 0) + 1; await new Promise(resolve => setTimeout(resolve, 250)); }
				return new Response('hello from ssr');
			}
		}`
	});
	try {
		const runtime = await bootRuntime(payload);
		return { port: runtime.port, httpUrl: runtime.origin, payload, envPrefix: prefix, async stop() { await runtime.close(); payload.cleanup(); } };
	} catch (error) { payload.cleanup(); throw error; }
	finally { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
