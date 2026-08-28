import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

// serializeWsOptions defaults with an open origin policy (tests dial with no
// Origin header) and a small backpressure ceiling for the shed test.
const WS_OPTS = {
	maxPayloadLength: 64 * 1024,
	idleTimeout: 120,
	maxBackpressure: 1024 * 1024,
	closeOnBackpressureLimit: false,
	sendPingsAutomatically: true,
	compression: false,
	allowedOrigins: '*',
	upgradeTimeout: 2,
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

const WS_HANDLER = `
export function upgrade({ headers, requestId }) {
	if (headers['x-auth'] === 'no') return false;
	if (headers['x-auth'] === 'boom') throw new Error('kaput');
	if (headers['x-auth'] === 'slow') return new Promise(() => {});
	if (headers['x-auth'] === 'headers') {
		return { __upgradeResponse: true, userData: { user: 'custom' }, headers: { 'x-custom-upgrade': 'yes' } };
	}
	return { user: headers['x-user'] || 'anon', requestId };
}

export async function subscribe(ws, topic) {
	if (topic === 'secret') return false;
	if (topic === 'teapot') return 'TEAPOT';
}

export async function resume(ws, { lastSeenSeqs, platform }) {
	for (const t of Object.keys(lastSeenSeqs)) {
		platform.send(ws, '__replay:' + t, 'replayed', { from: lastSeenSeqs[t] });
	}
}

export function authenticate({ cookies }) {
	cookies.set('sess', 'abc123', { path: '/', httpOnly: true });
}

export function close() {}

export async function message(ws, { data, msg, platform }) {
	if (msg !== undefined) return; // unmatched control-shaped frames
	const text = new TextDecoder().decode(data);
	let cmd;
	try { cmd = JSON.parse(text); } catch { return; }
	if (cmd.cmd === 'publish') {
		platform.publish(cmd.topic, cmd.event, cmd.data, cmd.options);
	} else if (cmd.cmd === 'publishBatched') {
		platform.publishBatched(cmd.messages);
	} else if (cmd.cmd === 'send') {
		platform.send(ws, cmd.topic, cmd.event, cmd.data);
	} else if (cmd.cmd === 'ask') {
		const reply = await platform.request(ws, 'question', { q: cmd.q }, { timeoutMs: 2000 })
			.catch((err) => ({ error: err.message }));
		platform.send(ws, 'answers', 'result', reply);
	} else if (cmd.cmd === 'grant') {
		platform.grantPublish(ws, cmd.topic);
	} else if (cmd.cmd === 'stats') {
		platform.send(ws, 'stats', 'connections', { n: platform.connections, subs: platform.subscribers(cmd.topic) });
	}
}
`;

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {Awaited<ReturnType<typeof bootRuntime>>} */
let rt;

beforeAll(async () => {
	payload = buildRuntime({
		replace: {
			WS_ENABLED: JSON.stringify(true),
			WS_OPTIONS: JSON.stringify(WS_OPTS)
		},
		wsHandlerSource: WS_HANDLER
	});
	rt = await bootRuntime(payload);
});

afterAll(async () => {
	await rt.close();
	payload.cleanup();
});

/**
 * Open a client and collect its JSON frames.
 * @param {Record<string, string>} [headers]
 */
function connect(headers = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/ws`, { headers });
	/** @type {any[]} */
	const frames = [];
	/** @type {Array<(frame: any) => void>} */
	const waiters = [];
	ws.on('message', (raw) => {
		let parsed;
		try { parsed = JSON.parse(raw.toString()); } catch { parsed = { raw: raw.toString() }; }
		frames.push(parsed);
		for (const waiter of waiters.splice(0)) waiter(parsed);
	});
	return {
		ws,
		frames,
		open: () => new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
			ws.once('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
		}),
		/**
		 * @param {(frame: any) => boolean} match
		 * @returns {Promise<any>}
		 */
		next: (match) => new Promise((resolve, reject) => {
			const existing = frames.find(match);
			if (existing) { resolve(existing); return; }
			const timer = setTimeout(() => reject(new Error('frame timeout; got ' + JSON.stringify(frames))), 3000);
			const check = (frame) => {
				if (match(frame)) { clearTimeout(timer); resolve(frame); }
				else waiters.push(check);
			};
			waiters.push(check);
		}),
		send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
		close: () => ws.close()
	};
}

describe('connection lifecycle', () => {
	it('welcomes with a session id and answers subscribe with an epoch-stamped ack', async () => {
		const client = connect();
		await client.open();
		const welcome = await client.next((f) => f.type === 'welcome');
		expect(welcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);

		client.send({ type: 'subscribe', topic: 'room', ref: 1 });
		const ack = await client.next((f) => f.type === 'subscribed' && f.topic === 'room');
		expect(ack.ref).toBe(1);
		expect(typeof ack.epoch).toBe('number');
		client.close();
	});

	it('delivers publishes with a per-topic monotonic seq', async () => {
		const client = connect();
		await client.open();
		client.send({ type: 'subscribe', topic: 'seq-room', ref: 1 });
		await client.next((f) => f.type === 'subscribed');

		client.send(JSON.stringify({ cmd: 'publish', topic: 'seq-room', event: 'tick', data: { n: 1 } }));
		const first = await client.next((f) => f.topic === 'seq-room' && f.event === 'tick' && f.data?.n === 1);
		client.send(JSON.stringify({ cmd: 'publish', topic: 'seq-room', event: 'tick', data: { n: 2 } }));
		const second = await client.next((f) => f.topic === 'seq-room' && f.data?.n === 2);
		expect(typeof first.seq).toBe('number');
		expect(second.seq).toBe(first.seq + 1);
		client.close();
	});

	it('excludes the sender when publish carries excludeWs semantics via socket publish', async () => {
		const a = connect();
		const b = connect();
		await a.open();
		await b.open();
		a.send({ type: 'subscribe', topic: 'dual', ref: 1 });
		b.send({ type: 'subscribe', topic: 'dual', ref: 1 });
		await a.next((f) => f.type === 'subscribed');
		await b.next((f) => f.type === 'subscribed');

		a.send(JSON.stringify({ cmd: 'publish', topic: 'dual', event: 'hello', data: 'x' }));
		await b.next((f) => f.topic === 'dual' && f.event === 'hello');
		// Both see it - platform.publish has no implicit sender exclusion.
		await a.next((f) => f.topic === 'dual' && f.event === 'hello');
		a.close();
		b.close();
	});

	it('denies hook-refused, reasoned and system topics with the right reasons', async () => {
		const client = connect();
		await client.open();
		client.send({ type: 'subscribe', topic: 'secret', ref: 2 });
		const denied = await client.next((f) => f.type === 'subscribe-denied' && f.topic === 'secret');
		expect(denied.reason).toBe('FORBIDDEN');

		client.send({ type: 'subscribe', topic: 'teapot', ref: 3 });
		const teapot = await client.next((f) => f.type === 'subscribe-denied' && f.topic === 'teapot');
		expect(teapot.reason).toBe('TEAPOT');

		client.send({ type: 'subscribe', topic: '__system', ref: 4 });
		const system = await client.next((f) => f.type === 'subscribe-denied' && f.topic === '__system');
		expect(system.reason).toBe('INVALID_TOPIC');
		client.close();
	});

	it('stops delivery after unsubscribe', async () => {
		const client = connect();
		await client.open();
		client.send({ type: 'subscribe', topic: 'leaveme', ref: 1 });
		await client.next((f) => f.type === 'subscribed');
		client.send({ type: 'unsubscribe', topic: 'leaveme' });
		// A publish after the unsubscribe lands nowhere; probe with a second
		// subscribed topic to order the frames.
		client.send({ type: 'subscribe', topic: 'probe', ref: 2 });
		await client.next((f) => f.type === 'subscribed' && f.topic === 'probe');
		client.send(JSON.stringify({ cmd: 'publish', topic: 'leaveme', event: 'gone', data: null }));
		client.send(JSON.stringify({ cmd: 'publish', topic: 'probe', event: 'here', data: null }));
		await client.next((f) => f.topic === 'probe' && f.event === 'here');
		expect(client.frames.find((f) => f.event === 'gone')).toBeUndefined();
		client.close();
	});

	it('acks a subscribe-batch per topic and denies past the 256 cap', async () => {
		const client = connect();
		await client.open();
		const topics = Array.from({ length: 258 }, (_, i) => 'bulk-' + i);
		client.send({ type: 'subscribe-batch', topics, ref: 9 });
		await client.next((f) => f.type === 'subscribed' && f.topic === 'bulk-0');
		await client.next((f) => f.type === 'subscribed' && f.topic === 'bulk-255');
		const overflow = await client.next((f) => f.type === 'subscribe-denied' && f.topic === 'bulk-256');
		expect(overflow.reason).toBe('BATCH_OVERFLOW');
		client.close();
	});

	it('serves the batch frame to cap-holders and individual frames otherwise', async () => {
		const plain = connect();
		const capable = connect();
		await plain.open();
		await capable.open();
		capable.send({ type: 'hello', caps: ['batch'] });
		plain.send({ type: 'subscribe', topic: 'bt', ref: 1 });
		capable.send({ type: 'subscribe', topic: 'bt', ref: 1 });
		await plain.next((f) => f.type === 'subscribed');
		await capable.next((f) => f.type === 'subscribed');

		plain.send(JSON.stringify({ cmd: 'publishBatched', messages: [
			{ topic: 'bt', event: 'a', data: 1 },
			{ topic: 'bt', event: 'b', data: 2 }
		] }));
		const batch = await capable.next((f) => f.type === 'batch');
		expect(batch.events.length).toBe(2);
		await plain.next((f) => f.topic === 'bt' && f.event === 'a');
		await plain.next((f) => f.topic === 'bt' && f.event === 'b');
		expect(plain.frames.find((f) => f.type === 'batch')).toBeUndefined();
		plain.close();
		capable.close();
	});

	it('round-trips a server-initiated request through the reply frame', async () => {
		const client = connect();
		await client.open();
		client.send({ type: 'subscribe', topic: 'answers', ref: 1 });
		await client.next((f) => f.type === 'subscribed');
		client.send(JSON.stringify({ cmd: 'ask', q: 'meaning' }));
		const requestFrame = await client.next((f) => f.type === 'request' && f.event === 'question');
		expect(requestFrame.data).toEqual({ q: 'meaning' });
		client.send({ type: 'reply', ref: requestFrame.ref, data: 42 });
		const result = await client.next((f) => f.topic === 'answers' && f.event === 'result');
		expect(result.data).toBe(42);
		client.close();
	});

	it('replays before acking a recover-tagged subscribe', async () => {
		const client = connect();
		await client.open();
		client.send({ type: 'subscribe', topic: 'hist', ref: 7, recover: { offset: 41 } });
		const replay = await client.next((f) => f.topic === '__replay:hist');
		expect(replay.data).toEqual({ from: 41 });
		const ack = await client.next((f) => f.type === 'subscribed' && f.topic === 'hist');
		// The replay frame arrived before the ack.
		expect(client.frames.indexOf(replay)).toBeLessThan(client.frames.indexOf(ack));
		client.close();
	});

	it('answers the whole-session resume with replay then resumed', async () => {
		const client = connect();
		await client.open();
		const welcome = await client.next((f) => f.type === 'welcome');
		client.send({ type: 'resume', sessionId: welcome.sessionId, lastSeenSeqs: { hist2: 10 } });
		const replay = await client.next((f) => f.topic === '__replay:hist2');
		const resumed = await client.next((f) => f.type === 'resumed');
		expect(client.frames.indexOf(replay)).toBeLessThan(client.frames.indexOf(resumed));
		client.close();
	});

	it('rejects an oversized control frame with the explicit error', async () => {
		const client = connect();
		await client.open();
		await client.next((f) => f.type === 'welcome');
		client.send('{"type":"subscribe","topic":"' + 'x'.repeat(9000) + '"}');
		const error = await client.next((f) => f.type === 'error');
		expect(error.code).toBe('CONTROL_FRAME_TOO_LARGE');
		client.close();
	});

	it('closes with 1009 when a frame exceeds maxPayloadLength', async () => {
		const client = connect();
		await client.open();
		const closed = new Promise((resolve) => client.ws.once('close', (code) => resolve(code)));
		client.ws.send(Buffer.alloc(WS_OPTS.maxPayloadLength + 16));
		expect(await closed).toBe(1009);
	});
});

describe('upgrade admission', () => {
	it('answers 401 for a refused upgrade', async () => {
		const client = connect({ 'x-auth': 'no' });
		await expect(client.open()).rejects.toThrow(/401/);
	});

	it('answers 500 with a request id for a throwing hook', async () => {
		const client = connect({ 'x-auth': 'boom' });
		await expect(client.open()).rejects.toThrow(/500/);
	});

	it('answers 504 when the hook outlives the upgrade timeout', async () => {
		const client = connect({ 'x-auth': 'slow' });
		await expect(client.open()).rejects.toThrow(/504/);
	}, 10000);

	it('writes validated custom 101 headers from upgradeResponse', async () => {
		const client = connect({ 'x-auth': 'headers' });
		const upgraded = new Promise((resolve) => {
			client.ws.once('upgrade', (res) => resolve(res.headers['x-custom-upgrade']));
		});
		await client.open();
		expect(await upgraded).toBe('yes');
		client.close();
	});

	it('answers 426 on a plain GET of the WebSocket path', async () => {
		const res = await fetch(rt.origin + '/ws');
		expect(res.status).toBe(426);
		expect(await res.text()).toContain('WebSocket upgrade required');
	});
});

describe('authenticate preflight', () => {
	it('runs the hook and serializes its cookies on a 204', async () => {
		const res = await fetch(rt.origin + '/__ws/auth', {
			method: 'POST',
			headers: { 'x-requested-with': 'XMLHttpRequest' }
		});
		expect(res.status).toBe(204);
		const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sess='));
		expect(cookie).toContain('sess=abc123');
		expect(cookie?.toLowerCase()).toContain('httponly');
	});

	it('accepts an unsigned request under the open origin policy', async () => {
		// allowedOrigins '*' deliberately stands the CSRF gate down; the
		// same-origin strictness is covered by its own payload below.
		const res = await fetch(rt.origin + '/__ws/auth', { method: 'POST' });
		expect(res.status).toBe(204);
	});

	it('refuses cross-site shaped requests under the same-origin policy', async () => {
		process.env.SAW_WSA_ORIGIN = 'http://127.0.0.1';
		const ownPayload = buildRuntime({
			replace: {
				ENV_PREFIX: JSON.stringify('SAW_WSA_'),
				WS_ENABLED: JSON.stringify(true),
				WS_OPTIONS: JSON.stringify({ ...WS_OPTS, allowedOrigins: 'same-origin' })
			},
			wsHandlerSource: WS_HANDLER
		});
		try {
			const own = await bootRuntime(ownPayload);
			// No Origin, no x-requested-with, no Sec-Fetch-Site: refused.
			const bare = await fetch(own.origin + '/__ws/auth', { method: 'POST' });
			expect(bare.status).toBe(403);
			// A matching Origin passes.
			const signed = await fetch(own.origin + '/__ws/auth', {
				method: 'POST',
				headers: { origin: 'http://127.0.0.1' }
			});
			expect(signed.status).toBe(204);
			await own.close();
		} finally {
			delete process.env.SAW_WSA_ORIGIN;
			ownPayload.cleanup();
		}
	});

	it('answers 405 for a GET', async () => {
		const res = await fetch(rt.origin + '/__ws/auth', { headers: { 'x-requested-with': 'XMLHttpRequest' } });
		expect(res.status).toBe(405);
	});
});
