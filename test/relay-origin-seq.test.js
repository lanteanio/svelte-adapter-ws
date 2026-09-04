// The relay's origin-seq marker, and the two properties that are easy to lose.
//
// A clustered publish originates on one worker and relays to the others. The
// receiving worker must stamp the origin's sequence verbatim rather than
// allocating its own, and must not relay the frame onward. Both decisions hang
// off one marker on the options object.
//
// The marker is a module Symbol rather than a string key because an
// application reaches `publishWire` with an options object of its own, and the
// check it suppresses is the cluster sequence authority. A spellable key is a
// way to stamp whatever you like.
//
// Driven against createTestServer, which carries its own copy of the publish
// lane: this file pins the HARNESS. Production's relay needs a worker cluster
// to drive, so its half is pinned in test/cluster-sequence-policy.test.js
// against the source. Both surfaces are mutated separately.

import { describe, it, expect, afterEach } from 'vitest';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe, WS_SUBSCRIPTIONS, WS_CAPS } from '../src/runtime/utils.js';

const { createTestServer } = await import('../src/testing.js');

const TOPIC = 'room:marker';
const CAP = 'test.marker:1';
const SCHEMA = 1;

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCodec() {
	return {
		capability: CAP,
		schemaVersion: SCHEMA,
		encode: (event, data) => enc.encode(JSON.stringify({ event, data }))
	};
}

/** A server whose message hook subscribes a socket to a topic on demand. */
function relayServer(extra = {}) {
	return createTestServer({
		...extra,
		handler: {
			message(ws, ctx) {
				const msg = ctx.msg;
				if (msg && msg.type === 'sub' && typeof msg.topic === 'string') trackedSubscribe(ws, msg.topic);
			}
		}
	});
}

/**
 * A scripted fake connection shaped like the subset of the harness socket the
 * publish walk touches. Assertions are made on these rather than on a real
 * client, which only exists to make the capability accounting non-zero.
 */
function scriptedWs(caps) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	if (caps) ud[WS_CAPS] = new Set(caps);
	const sent = { text: [], binary: [] };
	return {
		sent,
		getUserData() { return ud; },
		send(payload, isBinary) {
			if (isBinary) sent.binary.push(new Uint8Array(payload));
			else sent.text.push(String(payload));
			return 1;
		},
		close() { /* server.close() ends every tracked connection */ }
	};
}

describe('the relay origin-seq marker', () => {
	let server;
	let clients = [];

	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('ignores a relay marker an application spells for itself', async () => {
		// The string keys this replaced are what an application that read the
		// old source would reach for, and they must buy nothing. The call stays
		// an ordinary origin publish: stamped from the local counter, and still
		// relayed onward. A forged call is not refused, only ignored - in a
		// multi-worker runtime the sequence-authority check then refuses it,
		// because it carries no seq/relay pair of its own.
		const relayed = [];
		server = await relayServer({ __onPublish: (frame) => relayed.push(frame) });
		server.platform.registerWireCodec(makeCodec());

		server.platform.publishWire(
			TOPIC, 'move', { x: 1, y: 2 }, makeCodec(),
			/** @type {any} */ ({ _isRelay: true, _relaySeq: 999 })
		);

		expect(relayed.length, 'a forged marker suppressed the relay').toBe(1);
		expect(relayed[0].seq, 'a forged seq was stamped onto the frame').not.toBe(999);
		expect(typeof relayed[0].seq, 'the publish was not stamped locally').toBe('number');
	});

	it('keeps a received frame relayed when it carries no seq at all', async () => {
		// A relayed frame legitimately arrives with no seq, and the READ side is
		// what coerces it: the relay arm is chosen by the token beside the
		// options, so a missing seq can no longer be mistaken for an absent
		// marker, and what remains to guarantee is the number that reaches the
		// wire. Without that coercion an unsequenced frame is stamped verbatim,
		// and the frame still has to stay a relay rather than drawing this
		// worker's counter and being relayed onward.
		const onward = [];
		server = await relayServer({ __onPublish: (frame) => onward.push(frame) });
		server.platform.registerWireCodec(makeCodec());

		const { WebSocket } = await import('ws');
		const live = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => { live.on('open', resolve); live.on('error', reject); });
		live.send(JSON.stringify({ type: 'hello', caps: [CAP] }));
		live.send(JSON.stringify({ type: 'sub', topic: TOPIC }));
		await sleep(60);
		clients.push(live);

		const binFake = scriptedWs([CAP]);
		server.wsConnections.add(binFake);

		server.platform.__relayReceive({
			kind: 'publish',
			topic: TOPIC,
			envelope: JSON.stringify({ topic: TOPIC, event: 'move', data: { x: 9, y: 9 } }),
			capability: CAP,
			event: 'move',
			data: { x: 9, y: 9 }
			// no `seq` field at all: the origin published without one
		});

		expect(onward.length, 'a received frame was relayed onward').toBe(0);
		expect(binFake.sent.binary.length, 'the receiver did not re-encode the frame').toBe(1);
		const frame = parseBinaryFrame(binFake.sent.binary[0]);
		// The wire spells "carries no seq" as 0. A local stamp would read 1,
		// this server's counter never having been drawn, so the two are
		// distinguishable and this assertion is what separates them.
		expect(frame.seq, 'an absent origin seq was re-stamped locally').toBe(0);
	});
});
