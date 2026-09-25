// The admission span a refused handshake opens, on the BUILT runtime with a
// recording tracing provider. The refusals written before the handshake's
// header set is collected - the framing guard, siege, a full handshake gate
// and a full connection ceiling - read the trace context straight off the
// request, so the span is parented on the context the client sent rather than
// opened as a root.

import net from 'node:net';
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
	unsafeSameOriginWithoutHostPin: false
};

const RECORDING_PROVIDER = `
const spans = globalThis.__admissionSpans ??= [];
export default {
	startSpan(name, options) {
		spans.push({ name, parent: options.parent, attributes: options.attributes });
		return { end() {} };
	}
};
`;

// `x-park` holds the handshake inside the hook until the socket goes, which is
// how a test fills the in-flight gate.
const WS_HANDLER = `
export function message() {}
export async function upgrade({ headers }) {
	if (headers['x-park']) await new Promise(() => {});
	return {};
}
`;

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const HANDSHAKE = [
	'GET /ws HTTP/1.1',
	'Upgrade: websocket',
	'Connection: Upgrade',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
	'Sec-WebSocket-Version: 13'
];

/** @returns {Array<{ parent: any, attributes: Record<string, unknown> }>} */
const refusals = () => (/** @type {any} */ (globalThis).__admissionSpans ?? [])
	.filter((/** @type {any} */ s) => s.name === 'adapter.websocket.admission');

/**
 * Write a handshake and resolve with the status line, leaving the socket open
 * when `hold` is set (for a handshake that parks in the hook).
 *
 * @param {number} port
 * @param {string[]} extra
 * @param {{ hold?: boolean }} [opts]
 * @returns {Promise<{ status: string, socket: net.Socket }>}
 */
function handshake(port, extra, { hold = false } = {}) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write([...HANDSHAKE, `Host: 127.0.0.1:${port}`, ...extra].join('\r\n') + '\r\n\r\n');
			if (hold) setTimeout(() => resolve({ status: '', socket }), 200);
		});
		let raw = '';
		socket.on('data', (chunk) => {
			raw += chunk.toString('latin1');
			if (!hold && raw.includes('\r\n')) resolve({ status: raw.split('\r\n')[0], socket });
		});
		socket.on('error', () => {});
		socket.on('close', () => resolve({ status: raw.split('\r\n')[0], socket }));
	});
}

/**
 * The refusal spans opened while `fn` ran.
 *
 * @param {() => Promise<unknown>} fn
 */
async function spansDuring(fn) {
	const before = refusals().length;
	await fn();
	return refusals().slice(before);
}

/** @param {Record<string, unknown>} wsOptions */
async function boot(wsOptions) {
	const payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify({ ...WS_OPTS, ...wsOptions })
		},
		wsHandlerSource: WS_HANDLER,
		files: { 'tracing-provider.js': RECORDING_PROVIDER }
	});
	return { payload, rt: await bootRuntime(payload) };
}

/** @type {any} */ let sieged;
/** @type {any} */ let gated;
/** @type {any} */ let ceiling;
/** @type {net.Socket[]} */
const held = [];

beforeAll(async () => {
	sieged = await boot({ protection: 'siege' });
	gated = await boot({ upgradeAdmission: { maxConcurrent: 1, waitingRoom: false } });
	ceiling = await boot({ upgradeAdmission: { maxConnections: 1, waitingRoom: false } });
}, 60000);

afterAll(async () => {
	for (const socket of held) socket.destroy();
	for (const built of [sieged, gated, ceiling]) {
		await built?.rt.close();
		built?.payload.cleanup();
	}
});

/** @param {Array<{ parent: any, attributes: Record<string, unknown> }>} spans @param {string} reason */
function expectParentedRefusal(spans, reason) {
	const match = spans.filter((s) => s.attributes['admission.reason'] === reason);
	expect(match, `one ${reason} span`).toHaveLength(1);
	expect(match[0].parent?.traceparent, `the ${reason} span is parented on the request's context`).toBe(TRACEPARENT);
}

describe('a handshake refused before its headers are collected keeps its trace context', () => {
	it('under siege', async () => {
		const spans = await spansDuring(async () => {
			const { status } = await handshake(sieged.rt.port, [`traceparent: ${TRACEPARENT}`]);
			expect(status).toContain('503');
		});
		expectParentedRefusal(spans, 'siege');
	});

	it('for framing the server cannot read', async () => {
		const spans = await spansDuring(async () => {
			const { status } = await handshake(sieged.rt.port, [`traceparent: ${TRACEPARENT}`, 'Transfer-Encoding: gzip, chunked']);
			expect(status).toContain('400');
		});
		expectParentedRefusal(spans, 'ambiguous_framing');
	});

	it('at a full handshake gate', async () => {
		const parked = await handshake(gated.rt.port, ['x-park: 1'], { hold: true });
		held.push(parked.socket);
		const spans = await spansDuring(async () => {
			const { status } = await handshake(gated.rt.port, [`traceparent: ${TRACEPARENT}`]);
			expect(status).toContain('503');
		});
		expectParentedRefusal(spans, 'over_capacity');
	});

	it('at a full connection ceiling', async () => {
		const open = await handshake(ceiling.rt.port, []);
		expect(open.status).toContain('101');
		held.push(open.socket);
		const spans = await spansDuring(async () => {
			const { status } = await handshake(ceiling.rt.port, [`traceparent: ${TRACEPARENT}`]);
			expect(status).toContain('503');
		});
		expectParentedRefusal(spans, 'connection_capacity');
	});
});
