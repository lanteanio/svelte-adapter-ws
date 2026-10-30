import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import adapter from '../src/index.js';
import { authenticate } from './fixture/src/hooks.ws.route-config.js';
import { bootViteDev } from './helpers/vite-dev.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const configuration = () => adapter({
	websocket: { path: '/socket', authPath: '/api/ws-auth' }
});

function post(port, path, length, declared = true, method = 'POST') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method, headers: {
			'x-requested-with': 'XMLHttpRequest',
			...(declared ? { 'content-length': String(length) } : { 'transfer-encoding': 'chunked' })
		} }, response => {
			let body = '';
			response.on('data', chunk => { body += chunk; });
			response.on('end', () => resolve({ status: response.statusCode, body }));
			response.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('Auth route timed out')));
		req.on('error', reject);
		req.end(Buffer.alloc(length, 65));
	});
}

async function upgrade(port, path) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
		headers: { origin: `http://127.0.0.1:${port}` }, handshakeTimeout: 2000
	});
	try {
		return await new Promise((resolve, reject) => {
			socket.once('open', () => resolve(101));
			socket.once('unexpected-response', (_request, response) => {
				response.resume();
				resolve(response.statusCode);
			});
			socket.once('error', reject);
		});
	} finally { socket.terminate(); }
}

async function bootAndClose(options) {
	let server;
	try { server = await bootViteDev(options); }
	finally { await server?.close(); }
}

const surfaces = [
	...(hasUWS ? [{ label: 'built runtime', boot: async () => {
		const server = await startRealRuntime({ variant: 'routeconfig' });
		return { port: server.port, close: () => server.stop() };
	} }] : []),
	{ label: 'Vite development', boot: () => bootViteDev({
		adapter: configuration(), handler: { authenticate }, pluginOptions: { allowedOrigins: '*' }
	}) }
];

for (const surface of surfaces) describe(`adapter endpoint configuration on ${surface.label}`, () => {
	let server;
	beforeAll(async () => { server = await surface.boot(); }, 120000);
	afterAll(async () => { await server?.close(); });

	it('serves the configured auth path and leaves the default to the application', async () => {
		expect(await post(server.port, '/api/ws-auth', 16)).toEqual({ status: 200, body: '16' });
		expect((await post(server.port, '/__ws/auth', 0)).status).toBeGreaterThanOrEqual(299);
		expect((await post(server.port, '/api/ws-auth', 0, true, 'OPTIONS')).status).toBe(405);
	});

	it('accepts WebSockets at the adapter path', async () => {
		expect(await upgrade(server.port, '/socket')).toBe(101);
	});
});

describe('development endpoint configuration conflicts', () => {
	it.each(['path', 'authPath'])('refuses two explicit %s values that disagree', async name => {
		await expect(bootAndClose({ adapter: configuration(), pluginOptions: { [name]: '/different' } }))
			.rejects.toThrow(`disagrees with websocket.${name}`);
	});

	it('accepts matching explicit values', async () => {
		const server = await bootViteDev({ adapter: configuration(), handler: { authenticate },
			pluginOptions: { path: '/socket', authPath: '/api/ws-auth' } });
		try {
			expect(await upgrade(server.port, '/socket')).toBe(101);
			expect((await post(server.port, '/api/ws-auth', 16)).status).toBe(200);
		} finally { await server.close(); }
	});

	it('keeps adapter configuration through a wrapper name', async () => {
		const server = await bootViteDev({ adapter: { ...configuration(), name: 'wrapper-adapter' }, handler: { authenticate } });
		try {
			expect(await upgrade(server.port, '/socket')).toBe(101);
			expect((await post(server.port, '/api/ws-auth', 1)).status).toBe(200);
		} finally { await server.close(); }
	});

	it('keeps plugin-only route options available', async () => {
		const server = await bootViteDev({ adapter: adapter(), handler: { authenticate },
			pluginOptions: { path: '/socket', authPath: '/api/ws-auth' } });
		try {
			expect(await upgrade(server.port, '/socket')).toBe(101);
			expect((await post(server.port, '/api/ws-auth', 1)).status).toBe(200);
		} finally { await server.close(); }
	});

	it('resolves adapter overrides before judging endpoint collisions', async () => {
		const server = await bootViteDev({ adapter: adapter({ websocket: { authPath: '/other' } }),
			handler: { authenticate }, pluginOptions: { path: '/__ws/auth' } });
		try {
			expect(await upgrade(server.port, '/__ws/auth')).toBe(101);
			expect((await post(server.port, '/other', 1)).status).toBe(200);
		} finally { await server.close(); }
	});

	it('resolves the adapter path before judging a dashboard collision', async () => {
		const server = await bootViteDev({ adapter: adapter({ websocket: { path: '/socket' } }),
			pluginOptions: { dashboard: { path: '/ws' } } });
		try { expect(await upgrade(server.port, '/socket')).toBe(101); }
		finally { await server.close(); }
	});

	it('checks the dashboard against the adapter path', async () => {
		await expect(bootAndClose({ adapter: adapter({ websocket: { path: '/__uws/dashboard' } }) }))
			.rejects.toThrow('dashboard.path collides');
	});
});
