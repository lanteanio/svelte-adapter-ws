// A target that normalizes OUT of the admin prefix is refused, not rewritten.
//
// The route matches the RAW pathname, and building a Request resolves dot
// segments. So `/__realtime/../reflect` matched the prefix, reached the admin
// handler, and handed the app's `admin()` a request whose pathname was
// `/reflect` - outside the prefix that was routed, outside the namespace the
// handler's own dispatch and authorization are written against, and taking the
// app's own `/reflect` route with it. This is the one route where the adapter
// applies no authorization of its own, so a handler that authorizes by path
// prefix can be handed a path it would never have authorized.
//
// Refused rather than resolved in either direction: a target whose route and
// whose self-description disagree is ambiguous, and picking a reading for the
// caller either lets them aim the admin lane anywhere or hands the admin lane
// an app route.
//
// EVERY CASE HERE USES A RAW SOCKET. Every HTTP client resolves the target
// before sending, so fetch('/__realtime/../reflect') puts `/reflect` on the
// wire, never reaches this route at all, and passes against the defect while
// testing nothing.

import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const WS_OPTS = {
	adminPath: '/__realtime',
	adminAuthAcknowledged: true,
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

// The handler ECHOES the pathname it was handed. A status code alone cannot
// tell a served request from a refused one on the question that matters here:
// WHICH path the handler was told about.
const WS_HANDLER = `
export function message() {}
export function admin(request) {
	return new Response(JSON.stringify({ seen: new URL(request.url).pathname }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}
`;

/**
 * One raw exchange. The request target goes on the wire exactly as written -
 * which is the whole point, since a client would have resolved it first.
 *
 * @param {number} port
 * @param {string} target
 * @param {string} [method]
 * @returns {Promise<{ status: number, body: string, head: string }>}
 */
function rawGet(port, target, method = 'GET') {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		let out = '';
		socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('raw request timed out')); });
		socket.on('connect', () => {
			socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
		});
		socket.on('data', (chunk) => { out += chunk.toString(); });
		socket.on('error', reject);
		socket.on('close', () => {
			// Split the STATUS LINE off before parsing it. Splitting the whole
			// buffer on spaces takes the first header line with it.
			const statusLine = out.split('\r\n')[0] || '';
			const status = Number(statusLine.split(' ')[1]);
			const sep = out.indexOf('\r\n\r\n');
			resolve({
				status,
				body: sep === -1 ? '' : out.slice(sep + 4),
				head: (sep === -1 ? out : out.slice(0, sep)).toLowerCase()
			});
		});
	});
}

/**
 * The response's header block as WHOLE lines, for assertions about a header
 * whose value is a number. `toContain` over the raw block is a substring match,
 * and `content-length: 230` contains `content-length: 23` - so a declared
 * length that is a numeric extension of the true one slips a pin that reads as
 * though it checked the number.
 *
 * @param {{ head: string }} res
 */
function headerLines(res) {
	return res.head.split('\r\n');
}

/** @type {any} */
let payload;
/** @type {any} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) },
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
}, 60000);

afterAll(async () => {
	await rt?.close();
	payload?.cleanup?.();
});

describe('an admin target that normalizes out of the prefix is refused', () => {
	// Each of these resolves to a path outside `/__realtime/`, so the route that
	// matched and the request the handler would be told about disagree.
	//
	// The last two land on a SIBLING of the prefix rather than somewhere
	// unrelated, and they are the ones that pin the boundary. The guard tests
	// `startsWith(ADMIN_PATH + '/')`; drop that trailing slash and
	// `/__realtimezzz` starts with `/__realtime`, so the escape is served again
	// while every target that resolves somewhere unrelated still refuses. A
	// list made only of unrelated destinations cannot tell the two spellings
	// apart.
	for (const target of [
		'/__realtime/../reflect',
		'/__realtime/%2e%2e/reflect',
		'/__realtime/%2E%2E/reflect',
		'/__realtime/./../../reflect',
		'/__realtime/./../escape',
		'/__realtime/a/../../reflect',
		'/__realtime/../__realtimezzz',
		'/__realtime/../__realtime-evil/x'
	]) {
		it(`refuses ${target}`, async () => {
			const res = await rawGet(rt.port, target);
			expect(res.status, `${target} must not reach the handler`).toBe(400);
			// And the handler was never told about it: no echo body came back.
			expect(res.body).not.toContain('"seen"');
		});
	}

	it('serves a target that normalizes back INSIDE the prefix, and tells the handler the resolved path', async () => {
		// Normalization is not the fault; landing outside is. The handler is
		// told `/__realtime/introspect`, which is where the request resolved.
		const res = await rawGet(rt.port, '/__realtime/a/../introspect');
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).seen).toBe('/__realtime/introspect');
	});

	it('serves ..%2f, which is one opaque segment rather than a dot segment', async () => {
		// A percent-encoded slash is not a separator, so this normalizes to
		// nothing and keeps the prefix. Refusing it would break a legitimate
		// target for looking dangerous - the check asks where the path ENDS UP,
		// never which characters it contains.
		const res = await rawGet(rt.port, '/__realtime/..%2freflect');
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).seen).toBe('/__realtime/..%2freflect');
	});

	it('serves a segment that merely CONTAINS dots', async () => {
		// `a..b` is one ordinary segment. The rule is about where the path
		// resolves to, not about spotting dots - refusing this would break a
		// legitimate target for its spelling.
		const res = await rawGet(rt.port, '/__realtime/a..b');
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).seen).toBe('/__realtime/a..b');
	});

	it('frames the refusal with a length rather than chunked', async () => {
		// The success writer sets content-length deliberately, because uWS
		// derives one from the body it is handed and the two backends would
		// otherwise frame the same answer differently. A refusal is an answer
		// too, and node falls back to chunked whenever the header is absent.
		const res = await rawGet(rt.port, '/__realtime/../reflect');
		expect(res.status).toBe(400);
		expect(res.head, 'refusal answered chunked').not.toContain('transfer-encoding: chunked');
		// Matched as a WHOLE header line, not as a substring: `content-length:
		// 230` contains `content-length: 23`, so a substring match accepts any
		// declared length that is a numeric extension of the true one - a
		// truncated reply every client reads as a framing error, passing a pin
		// that names itself after framing.
		expect(headerLines(res), 'refusal declared the wrong length').toContain(
			`content-length: ${Buffer.byteLength(res.body)}`
		);

		// HEAD is the other half of the reason, and the half a GET cannot show:
		// node strips the body itself, so without the header the reply carries
		// no size at all rather than a wrong one. The length must still be the
		// one a GET would have returned.
		const head = await rawGet(rt.port, '/__realtime/../reflect', 'HEAD');
		expect(head.status).toBe(400);
		expect(head.body, 'node must strip a HEAD body').toBe('');
		expect(headerLines(head), 'HEAD refusal carried no size, or the wrong one').toContain(
			`content-length: ${Buffer.byteLength(res.body)}`
		);
	});

	it('serves a target that resolves onto the bare prefix', async () => {
		// The guard's middle clause allows the resolved path to BE the prefix,
		// not only to sit under it, and nothing else in this file reaches that
		// clause: replace it with `true` and the rest of the suite stays green.
		//
		// Worth knowing what is being locked here. A DIRECT `GET /__realtime`
		// is not routed to admin at all, because the mount matches
		// `ADMIN_PATH + '/'`, so it falls through to the app's own routing.
		// This target reaches admin() and reports the bare prefix. That is the
		// family's shipped condition rather than this repo's invention, so it
		// is pinned as-is; changing it belongs upstream, not here.
		const res = await rawGet(rt.port, '/__realtime/../__realtime');
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).seen).toBe('/__realtime');
	});

	it('still serves an ordinary admin target', async () => {
		const res = await rawGet(rt.port, '/__realtime/introspect');
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).seen).toBe('/__realtime/introspect');
	});
});

// The harness takes the same decision, so the two surfaces cannot disagree
// about which targets reach an app's admin handler.
describe('the harness refuses the same targets', () => {
	/** @type {any} */
	let server;

	afterAll(async () => { await server?.close(); });

	it('refuses a target that leaves the prefix and serves one that returns to it', async () => {
		const { createTestServer } = await import('../src/testing.js');
		/** @type {string[]} */
		const seen = [];
		server = await createTestServer({
			handler: {
				message() {},
				admin(request) {
					seen.push(new URL(request.url).pathname);
					return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
				}
			}
		});
		const port = Number(new URL(server.url).port);

		const escaped = await rawGet(port, '/__realtime/../reflect');
		expect(escaped.status).toBe(400);

		// The sibling boundary, on this surface too: the harness carries its
		// own copy of the check, so a slash dropped there escapes exactly as it
		// would in the runtime and nothing else here would notice.
		const sibling = await rawGet(port, '/__realtime/../__realtimezzz');
		expect(sibling.status, 'a sibling of the prefix must not be served').toBe(400);

		const inside = await rawGet(port, '/__realtime/a/../introspect');
		expect(inside.status).toBe(200);

		// The harness frames the way the runtime does, on BOTH answers. It
		// emulates a server that derives a length from the body it is handed,
		// so answering chunked here would have an app's own tests reading
		// framing production never produces.
		for (const [label, res] of [['refusal', escaped], ['success', inside]]) {
			expect(res.head, `harness ${label} answered chunked`).not.toContain('transfer-encoding: chunked');
			expect(headerLines(res), `harness ${label} declared no length, or the wrong one`).toContain(
				`content-length: ${Buffer.byteLength(res.body)}`
			);
		}

		// The harness's own copy of the bare-prefix clause. The runtime's is
		// pinned above; this one is the other half of the pair this file exists
		// to keep aligned, and without it the two surfaces are free to disagree
		// about the exact target that pin locks in.
		const bare = await rawGet(port, '/__realtime/../__realtime');
		expect(bare.status, 'the harness must serve the bare prefix too').toBe(200);

		// The refusals never reached the handler; the two resolved targets did,
		// each carrying the path it resolved to.
		expect(seen).toEqual(['/__realtime/introspect', '/__realtime']);
	});
});
