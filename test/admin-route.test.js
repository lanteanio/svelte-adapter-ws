import { describe, it, expect, afterEach } from 'vitest';

// The reserved `/__realtime/*` admin route, driven over the node:http
// server createTestServer builds.

let server;

describe('reserved /__realtime admin route', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('mounts the app handler at /__realtime/* and writes its Response back', async () => {
		/** @type {Request | null} */
		let seen = null;
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async (request) => {
					seen = request;
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
					});
				}
			}
		});

		const res = await fetch(`${server.url}/__realtime/introspect?handlers=true`, {
			headers: { 'x-test': 'hi' }
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		// no-store survives, nosniff is default-filled by the route writer.
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');

		// The handler received a real Web Request with method, full URL, headers.
		expect(seen).not.toBeNull();
		expect(seen.method).toBe('GET');
		const u = new URL(seen.url);
		expect(u.pathname).toBe('/__realtime/introspect');
		expect(u.searchParams.get('handlers')).toBe('true');
		expect(seen.headers.get('x-test')).toBe('hi');
	});

	it('returns 500 when the app handler throws', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async () => { throw new Error('boom'); }
			}
		});
		const res = await fetch(`${server.url}/__realtime/introspect`);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal error' });
	});

	it('returns 500 when the app handler does not return a Response', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async () => ({ not: 'a response' })
			}
		});
		const res = await fetch(`${server.url}/__realtime/introspect`);
		expect(res.status).toBe(500);
	});

	it('delivers the request body to the app handler for non-GET methods', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async (request) => {
					const body = await request.text();
					return new Response(JSON.stringify({ echoed: body, method: request.method }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
			}
		});
		const res = await fetch(`${server.url}/__realtime/replay`, {
			method: 'POST',
			body: 'queue=dead-letters'
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ echoed: 'queue=dead-letters', method: 'POST' });
	});

	it('forwards an app-handler status code unchanged (the gate owns 403)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async () => new Response(JSON.stringify({ error: 'forbidden' }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				})
			}
		});
		const res = await fetch(`${server.url}/__realtime/introspect`);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'forbidden' });
	});

	it('does NOT register the route when the handler exports no admin', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: {} });
		// With no admin route mounted, the request falls through to the
		// harness's built-in 404. A mounted route would return our JSON
		// (200/500), never a plain 404 - so this proves the route is absent.
		const res = await fetch(`${server.url}/__realtime/introspect`);
		expect(res.status).toBe(404);
	});

	it('mounts at a custom adminPath and not at the default', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			adminPath: '/__admin',
			handler: { admin: async () => Response.json({ ok: true }) }
		});
		// Reachable at the custom prefix...
		const custom = await fetch(`${server.url}/__admin/introspect`);
		expect(custom.status).toBe(200);
		expect(await custom.json()).toEqual({ ok: true });
		// ...and NOT at the default prefix (harness 404, route absent there).
		const def = await fetch(`${server.url}/__realtime/introspect`);
		expect(def.status).toBe(404);
	});

	it('disables the auto-mount entirely with adminPath: false', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			adminPath: false,
			handler: { admin: async () => Response.json({ ok: true }) }
		});
		// Even though the handler exports admin, no route is mounted.
		const res = await fetch(`${server.url}/__realtime/introspect`);
		expect(res.status).toBe(404);
	});
});
