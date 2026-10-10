import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';

let server;
afterEach(async () => { await server?.close(); server = undefined; });

describe.each([false, true])('test-server HEAD routing with admission=%s', (admission) => {
	it.each(['/ws', '/__admit-check', '/__waiting-room'])('does not dispatch HEAD %s to a GET mount', async (target) => {
		let rendered = 0;
		server = await createTestServer({
			handler: { message() {} },
			...(admission ? { upgradeAdmission: {
				maxConcurrent: 1,
				waitingRoom: {
					admitCheckPath: '/__admit-check', pagePath: '/__waiting-room',
					render() { rendered++; return new Response('holding'); }
				}
			} } : {})
		});
		const response = await fetch(`http://127.0.0.1:${server.port}${target}`, { method: 'HEAD' });
		expect(response.status).toBe(404);
		expect(rendered).toBe(0);
		expect(await response.text()).toBe('');
	});
});
