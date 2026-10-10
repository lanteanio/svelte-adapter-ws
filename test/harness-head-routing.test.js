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
					admitCheckPath: '/__admit-check', path: '/__waiting-room',
					renderer() {
						rendered++;
						return { lang: 'en', dir: 'ltr', body: '<!doctype html><html lang="en" dir="ltr"><head><title>Please wait</title></head><body><main><h1>Server at capacity</h1><p role="status" aria-live="polite" aria-atomic="true">Holding</p><form method="get"><button type="submit">Try again</button></form></main></body></html>' };
					}
				}
			} } : {})
		});
		if (admission) {
			const control = await fetch('http://127.0.0.1:' + server.port + '/__waiting-room');
			expect(control.status).toBe(200);
			expect(await control.text()).toContain('Holding');
			expect(rendered).toBe(1);
			rendered = 0;
		}
		const response = await fetch(`http://127.0.0.1:${server.port}${target}`, { method: 'HEAD' });
		expect(response.status).toBe(404);
		expect(rendered).toBe(0);
		expect(await response.text()).toBe('');
	});
});
