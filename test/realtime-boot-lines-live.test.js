// The lines a realtime build prints at boot about its endpoints, on the BUILT
// runtime: the authenticate endpoint when the app exports the hook, the
// WebSocket endpoint always, and the client-side path to match when it is not
// the default. Operators and the family's docs read these lines, so their
// spelling and order are part of what a drop-in boot looks like.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 5,
	upgradeRateLimit: 0,
	upgradeRateLimitWindow: 10,
	authPathRateLimit: 0,
	authPathRateLimitWindow: 10,
	allowSystemTopicSubscribe: false,
	authorizeWireSubscribe: false,
	allowNonAsciiTopics: false,
	authPathRequireOrigin: true,
	compressCredentialedResponses: false,
	unsafeSameOriginWithoutHostPin: false,
	adminAuthAcknowledged: true
};

const WITH_HOOKS = `
export function message() {}
export function authenticate() { return {}; }
export function admin() { return new Response('ok'); }
`;
const BARE = `
export function message() {}
`;

/**
 * Boot one payload and return the lines its module evaluation and boot wrote
 * through console.log that name an endpoint or route.
 *
 * @param {Record<string, string>} replace
 * @param {string} handlerSource
 */
async function bootLines(replace, handlerSource) {
	const payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS), ...replace },
		wsHandlerSource: handlerSource
	});
	/** @type {string[]} */
	const lines = [];
	const original = console.log;
	console.log = (...args) => { lines.push(args.join(' ')); };
	try {
		const rt = await bootRuntime(payload);
		return { payload, rt, lines: lines.filter((l) => /endpoint|Client must match|route registered/.test(l)) };
	} finally {
		console.log = original;
	}
}

/** @type {any} */ let custom;
/** @type {any} */ let bare;

beforeAll(async () => {
	custom = await bootLines({ WS_PATH: JSON.stringify('/live'), WS_AUTH_PATH: JSON.stringify('/live/auth') }, WITH_HOOKS);
	bare = await bootLines({}, BARE);
}, 60000);

afterAll(async () => {
	for (const built of [custom, bare]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

describe('the realtime boot lines', () => {
	it('names the authenticate endpoint, the WebSocket endpoint and the path to match, before the admin route', () => {
		expect(custom.lines).toEqual([
			'[svelte-adapter-ws] WebSocket auth endpoint registered at /live/auth',
			'[svelte-adapter-ws] WebSocket endpoint registered at /live',
			"[svelte-adapter-ws] Client must match: connect({ path: '/live' })",
			'[svelte-adapter-ws] Admin route registered at /__realtime/*'
		]);
	});

	it('names only the WebSocket endpoint for a default path and no hooks', () => {
		expect(bare.lines).toEqual(['[svelte-adapter-ws] WebSocket endpoint registered at /ws']);
	});
});
