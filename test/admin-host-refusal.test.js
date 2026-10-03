// createTestServer's admin mirror builds the request URL on the Host value, as
// production builds it with no ORIGIN set, so a Host carrying a path or a
// query would hand the handler a pathname the request line never named -
// another admin path, or one outside the prefix. It is refused as production
// refuses it (host-header-real.test.js pins the runtime's lanes).

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';

/** @type {any} */
let server = null;

afterEach(async () => {
	await server?.close();
	server = null;
});

describe('the admin mirror under a Host that is not an authority', () => {
	it('refuses it before the handler runs, and serves a well-formed one', async () => {
		/** @type {string[]} */
		const seen = [];
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				message() {},
				admin: async (/** @type {Request} */ request) => {
					seen.push(new URL(request.url).pathname);
					return new Response('reached', { status: 200 });
				}
			}
		});
		const port = Number(new URL(server.url).port);

		/** @param {string} host @returns {Promise<number>} */
		const statusFor = (host) => new Promise((resolve) => {
			let buf = '';
			const sock = net.connect(port, '127.0.0.1', () => {
				sock.write(`GET /__realtime/introspect HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
			});
			sock.setTimeout(5000, () => { sock.destroy(); resolve(0); });
			sock.on('data', (d) => { buf += d.toString(); });
			sock.on('close', () => resolve(Number(buf.split('\r\n')[0].split(' ')[1] || 0)));
			sock.on('error', () => resolve(0));
		});

		for (const host of ['a/__realtime/other?', 'a/reflect?', 'a#', '']) {
			expect(await statusFor(host), JSON.stringify(host)).toBe(400);
		}
		expect(seen, 'a moved path reached the app handler').toEqual([]);
		expect(await statusFor(`127.0.0.1:${port}`)).toBe(200);
		expect(seen).toEqual(['/__realtime/introspect']);
	});
});
