// A probe may be spelled with percent-escapes or with router syntax inside a
// segment. The router answers only that spelling, so the catch-all must keep
// every other spelling of the same path out of the application - a lowercase
// escape, the raw character an escape stands for, a SvelteKit data request -
// exactly as it does for a plain ASCII mount.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * One request line exactly as written, without any client re-encoding it.
 * @param {number} port
 * @param {string} target
 */
function rawStatus(port, target) {
	return new Promise((resolve, reject) => {
		let buf = '';
		const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
		sock.on('data', (d) => { buf += d.toString('latin1'); });
		sock.on('error', reject);
		sock.on('close', () => resolve(buf.slice(9, 12)));
	});
}

describeUWS('probes spelled with escapes and router syntax', () => {
	/** @type {any} */
	let rt;
	beforeAll(async () => { rt = await startRealRuntime({ variant: 'mountspelling' }); }, 400000);
	afterAll(async () => { await rt?.stop(); });

	it('answers the spelling a client sends', async () => {
		const live = await fetch(rt.httpUrl + '/gesundheit-prüfung');
		expect(live.status).toBe(200);
		await live.arrayBuffer();
		expect(await rawStatus(rt.port, '/gesundheit-pr%C3%BCfung')).toBe('200');
		const ready = await fetch(rt.httpUrl + '/status:ready');
		expect(ready.status).toBe(200);
		expect(await ready.text()).toBe('ready');
	});

	it('refuses other spellings of a mounted path instead of handing them to the app', async () => {
		expect(await rawStatus(rt.port, '/gesundheit-pr%c3%bcfung')).toBe('400');
		expect(await rawStatus(rt.port, '/gesundheit-pr%C3%BCfung/__data.json')).toBe('400');
		expect(await rawStatus(rt.port, '/x/../gesundheit-pr%C3%BCfung')).toBe('400');
		expect(await rawStatus(rt.port, '/status:ready/__data.json')).toBe('400');
		expect(await rawStatus(rt.port, '/status%3Aready')).toBe('400');
	});

	it('hands a path that only decodes to the spelling of a mount on to the app', async () => {
		// `%25` is a literal `%`: this is the path `/gesundheit-pr%C3%BCfung` spelled
		// out, not the mounted one, so the app answers it.
		expect(await rawStatus(rt.port, '/gesundheit-pr%25C3%25BCfung')).toBe('404');
	});
});
