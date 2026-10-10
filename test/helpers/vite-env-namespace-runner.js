import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { createServer } from 'vite';
import adapter from '../../src/index.js';
import uws from '../../src/vite.js';

const [configStyle, mode, root] = process.argv.slice(2);
assert(['consolidated', 'fallback'].includes(configStyle));
assert(['prefixed', 'bare-only', 'empty-prefix'].includes(mode));
assert(root);
process.env.ORIGIN = 'https://bare.example';
if (mode === 'prefixed') process.env.TEST_APP_ORIGIN = 'https://prefixed.example';
else delete process.env.TEST_APP_ORIGIN;

const previousCwd = process.cwd();
const clients = [];
let server;
try {
	const envPrefix = mode === 'empty-prefix' ? '' : 'TEST_APP_';
	mkdirSync(join(root, 'src', 'routes'), { recursive: true });
	writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
	writeFileSync(join(root, 'src', 'app.html'), '<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>');
	writeFileSync(join(root, 'src', 'routes', '+page.svelte'), '<p>Test</p>');
	writeFileSync(join(root, 'src', 'hooks.ws.js'), `
export function authenticate({ request, url }) { return Response.json({ requestUrl: request.url, url }); }
export function open() {}
`);
	const adapterUrl = new URL('../../src/index.js', import.meta.url).href;
	writeFileSync(join(root, 'svelte.config.js'), configStyle === 'fallback'
		? `import adapter from ${JSON.stringify(adapterUrl)}; export default { kit: { adapter: adapter({ envPrefix: ${JSON.stringify(envPrefix)} }) } };`
		: 'export default { kit: {} };');
	process.chdir(root);
	const plugins = [];
	if (configStyle === 'consolidated') {
		const { sveltekit } = await import('@sveltejs/kit/vite');
		plugins.push(sveltekit({ adapter: adapter({ envPrefix }) }));
	}
	server = await createServer({
		configFile: false,
		root,
		logLevel: 'silent',
		appType: 'custom',
		plugins: [...plugins, uws({ allowedOrigins: 'same-origin' })],
		server: { host: '127.0.0.1', allowedHosts: true, hmr: false, ws: false, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] }
	});
	await new Promise((resolve, reject) => {
		server.httpServer.once('error', reject);
		server.httpServer.listen(0, '127.0.0.1', resolve);
	});
	const port = server.httpServer.address().port;
	const host = 'attacker.example';
	const allowedOrigin = mode === 'prefixed' ? 'https://prefixed.example'
		: mode === 'empty-prefix' ? 'https://bare.example' : 'http://' + host;
	async function auth(origin) {
		return new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, path: '/__ws/auth?probe=1', method: 'POST',
				headers: { host, origin, 'content-length': '0' } }, response => {
				let body = '';
				response.on('data', chunk => { body += chunk; });
				response.once('error', reject);
				response.once('end', () => resolve({ status: response.statusCode, body }));
			});
			req.once('error', reject);
			req.end();
		});
	}
	async function upgrade(origin) {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { host, origin } });
			clients.push(ws);
			ws.once('open', () => resolve(101));
			ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
			ws.once('error', reject);
		});
	}
	for (const refusedOrigin of ['https://bare.example', 'http://' + host, 'https://prefixed.example'].filter(origin => origin !== allowedOrigin)) {
		assert.equal((await auth(refusedOrigin)).status, 403, `auth refused ${refusedOrigin}`);
		assert.equal(await upgrade(refusedOrigin), 403, `upgrade refused ${refusedOrigin}`);
	}
	const accepted = await auth(allowedOrigin);
	assert.equal(accepted.status, 200);
	const echo = JSON.parse(accepted.body);
	assert.equal(echo.requestUrl, allowedOrigin + '/__ws/auth?probe=1');
	assert.equal(echo.url, '/__ws/auth?probe=1');
	assert.equal(await upgrade(allowedOrigin), 101);
	console.log(`vite-env-namespace: ${configStyle} ${mode} passed`);
} finally {
	for (const client of clients) client.terminate();
	await server?.close();
	process.chdir(previousCwd);
}
