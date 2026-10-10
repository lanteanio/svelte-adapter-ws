import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';
import { rawConversation } from './helpers/raw-http.js';

const small = 'small static answer';
const large = 's'.repeat(17 * 1024);
const prefixBody = 'p'.repeat(15000);
const bad = 'GET /bad HTTP/1.0\r\nHost: localhost\r\n\r\n';
const request = (target, headers = '', method = 'GET') =>
	`${method} ${target} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`;

function responses(raw) {
	const answers = [];
	while (raw.length) {
		const end = raw.indexOf('\r\n\r\n');
		expect(end).toBeGreaterThanOrEqual(0);
		const head = raw.slice(0, end);
		const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
		const length = status === 204 || status === 304 ? 0 : Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);
		expect(Number.isInteger(length)).toBe(true);
		expect(raw.length).toBeGreaterThanOrEqual(end + 4 + length);
		answers.push({ status, head, body: raw.slice(end + 4, end + 4 + length) });
		raw = raw.slice(end + 4 + length);
	}
	return answers;
}

describe.each([false, true])('static and SSR pipeline cork limit with TLS=%s', secure => {
	let payload, runtime;
	const prefix = 'STATIC_CORK_LIMIT_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[prefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[prefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[prefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: { ENV_PREFIX: JSON.stringify(prefix) },
			files: {
				'client/small.txt': small,
				'client/large.txt': large,
				'client/prefix.txt': prefixBody,
				'prerendered/docs/index.html': small,
				'prerendered/about.html': large
			},
			serverSource: `export class Server {
				async init() {}
				async respond(request) {
					const body = new URL(request.url).pathname === '/ssr-large' ? 's'.repeat(17 * 1024) : 'small static answer';
					return new Response(body, { headers: { 'content-type': 'text/plain' } });
				}
			}`
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close();
		payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[prefix + key];
	});

	it.each([
		['small static', request('/small.txt'), []],
		['prefix below limit', request('/prefix.txt'), []],
		['large static', request('/large.txt'), [[200, large]]],
		['small then large static', request('/small.txt') + request('/large.txt'), [[200, small], [200, large]]],
		['two large static answers', request('/large.txt').repeat(2), [[200, large], [200, large]]],
		['large static HEAD', request('/large.txt', '', 'HEAD'), []],
		['large static range', request('/large.txt', 'Range: bytes=1-17407\r\n'), [[206, large.slice(1)]]],
		['large prerendered page', request('/about'), [[200, large]]],
		...[[304, '/small.txt', 'If-None-Match: *\r\n', 8], [412, '/small.txt', 'If-Match: \"absent\"\r\n', 24], [416, '/small.txt', 'Range: bytes=500-600\r\n', 20], [308, '/docs', '', 20], [308, '/about/', '', 20]].map(([status, target, headers, count]) => [
			`prefix plus ${count} ${status} answers from ${target}`,
			request('/prefix.txt') + request(target, headers).repeat(count),
			[[200, prefixBody], ...Array.from({ length: count }, () => [status, ''])]
		]),
		['small SSR', request('/ssr-small'), []],
		['large SSR', request('/ssr-large'), [[200, large]]]
	])('preserves the native boundary for %s before refusal', async (_name, input, expected) => {
		const { raw, closed } = await rawConversation(runtime.port, [[0, input + bad]], { secure, wait: 2000 });
		expect(closed).toBe(true);
		const answers = responses(raw);
		expect(answers.map(answer => answer.status)).toEqual([...expected.map(([status]) => status), 505]);
		expect(answers.slice(0, -1).map(answer => answer.body)).toEqual(expected.map(([, body]) => body));
		expect(answers.at(-1).body).toContain('HTTP Version Not Supported');
	});
});


describe.each([false, true])('realtime HTTP pipeline cork limit with TLS=%s', secure => {
	let payload, runtime;
	const envPrefix = 'REALTIME_CORK_LIMIT_';
	beforeAll(async () => {
		if (secure) {
			const certs = fileURLToPath(new URL('./fixtures/tls/', import.meta.url));
			process.env[envPrefix + 'SSL_CERT'] = path.join(certs, 'localhost.crt');
			process.env[envPrefix + 'SSL_KEY'] = path.join(certs, 'localhost.key');
			process.env[envPrefix + 'SSL_WATCH'] = '0';
		}
		payload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify(envPrefix),
				WS_ENABLED: 'true',
				WS_OPTIONS: JSON.stringify({
					allowedOrigins: 'same-origin', authPathRequireOrigin: true,
					authPathRateLimit: 0, upgradeRateLimit: 0,
					upgradeAdmission: { maxConcurrent: 1, waitingRoom: { path: '/hold' } }
				})
			},
			wsHandlerSource: `export function upgrade() { return {}; }
				export function message() {}
				export function authenticate({ headers, cookies }) {
					const size = headers['x-size'] === 'large' ? 17 * 1024 : 8;
					cookies.set('session', 'c'.repeat(size), { path: '/' });
				}`,
			waitingRoomRendererSource: `export default ({ request }) => ({
				body: '<!doctype html><html lang="en"><head><title>Waiting</title></head><body><main><p role="status">Waiting</p><a href="/">Retry</a><p>' +
					(request.headers.get('x-size') === 'large' ? 'w'.repeat(17 * 1024) : 'small') + '</p></main></body></html>',
				lang: 'en', dir: 'ltr'
			});`
		});
		runtime = await bootRuntime(payload);
	}, 60000);
	afterAll(async () => {
		await runtime?.close(); payload?.cleanup();
		for (const key of ['SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete process.env[envPrefix + key];
	});
	it.each(['small', 'large'])('preserves %s implicit auth cookie headers before refusal', async size => {
		const input = request('/__ws/auth', 'Content-Length: 0\r\nX-Requested-With: XMLHttpRequest\r\nX-Size: ' + size + '\r\n', 'POST');
		const { raw, closed } = await rawConversation(runtime.port, [[0, input + bad]], { secure, wait: 2000 });
		expect(closed).toBe(true);
		const answers = responses(raw);
		expect(answers.map(answer => answer.status)).toEqual(size === 'large' ? [204, 505] : [505]);
		if (size === 'large') expect(answers[0].head).toContain('session=' + 'c'.repeat(17 * 1024) + ';');
	});
	it.each(['small', 'large'])('preserves the %s waiting-room page before refusal', async size => {
		const { raw, closed } = await rawConversation(runtime.port, [[0, request('/hold', 'X-Size: ' + size + '\r\n') + bad]], { secure, wait: 2000 });
		expect(closed).toBe(true);
		const answers = responses(raw);
		expect(answers.map(answer => answer.status)).toEqual(size === 'large' ? [200, 505] : [505]);
		if (size === 'large') expect(answers[0].body).toContain('<p>' + 'w'.repeat(17 * 1024) + '</p>');
	});
});
