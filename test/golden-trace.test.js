// The deterministic golden trace: a seeded, virtual-clock run of the REAL
// runtime platform (built payload, not source imports) over fake sockets,
// captured frame-for-frame and pinned against a committed corpus. Any change
// to envelope bytes, seq stamping, batch shaping, wire framing or fan-out
// order shows up as a fingerprint drift here before a client ever sees it.
//
// Regenerate deliberately with UPDATE_GOLDENS=1 and review the diff like any
// other contract change.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRuntime } from './helpers/build-runtime.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = path.join(repoRoot, 'test', 'dst-goldens', 'platform-trace.golden.json');

/** Deterministic seeded rng (mulberry32). @param {number} seed */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** @param {string} str */
function fnv32(str) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

async function runTrace() {
	const payload = buildRuntime();
	const dir = pathToFileURL(payload.dir).href;

	const runtime = await import(`${dir}/runtime.js`);
	const { resetProcessEpoch, resetTopicEpochs } = await import(`${dir}/utils/epoch.js`);
	const random = mulberry32(0x5eed);
	// Seam installed BEFORE anything latches the epoch; virtual clock fixed.
	runtime.setRuntimeEnv({
		clock: {
			now: () => 1700000000000,
			monotonic: () => 1000,
			processMonotonic: () => 1000,
			wallEpoch: () => 1700000000000
		},
		rng: {
			float: random,
			u32: () => Math.floor(random() * 0x100000000) >>> 0,
			uuid: () => 'uuid-' + Math.floor(random() * 1e9).toString(36),
			bytes: (n) => Buffer.alloc(n, 7)
		}
	}, { force: true });
	resetProcessEpoch();
	resetTopicEpochs();

	const { wrapWebSocket } = await import(`${dir}/handler/ws-facade.js`);
	const registry = await import(`${dir}/handler/topic-registry.js`);
	const state = await import(`${dir}/handler/state.js`);
	const { platform } = await import(`${dir}/handler/platform.js`);
	const symbols = await import(`${dir}/utils/ws-symbols.js`);

	state.topicSeqs.clear();
	state.wsConnections.clear();
	state.wsWrappers.clear();

	/** @type {Record<string, string[]>} */
	const trace = {};

	/**
	 * @param {string} name
	 * @param {string[]} caps
	 */
	function connect(name, caps) {
		trace[name] = [];
		/** @type {any} */
		const rawWs = {
			readyState: 1,
			bufferedAmount: 0,
			send(payloadOut, _opts, cb) {
				trace[name].push(typeof payloadOut === 'string' ? payloadOut : 'hex:' + Buffer.from(payloadOut).toString('hex'));
				cb?.();
			},
			terminate() { this.readyState = 3; },
			close() { this.readyState = 3; },
			_socket: { remoteAddress: '10.0.0.1' }
		};
		const userData = /** @type {any} */ ({ remoteAddress: '10.0.0.1' });
		userData[symbols.WS_SUBSCRIPTIONS] = new Set();
		userData[symbols.WS_CAPS] = new Set(caps);
		const facade = wrapWebSocket(rawWs, userData, {
			maxBackpressure: 1024 * 1024,
			closeOnBackpressureLimit: false,
			compressionEnabled: false,
			peerFacadeOf: (peer) => state.wsWrappers.get(peer)
		});
		userData[symbols.WS_PLATFORM] = Object.create(platform);
		// The hello handler normally adjusts the live capability counts; the
		// trace connects below that layer, so it adjusts them itself.
		state.capCounts.adjust(null, userData[symbols.WS_CAPS]);
		registry.registerSocket(rawWs);
		state.wsWrappers.set(rawWs, facade);
		state.wsConnections.add(facade);
		return { facade, rawWs, userData };
	}

	const alpha = connect('alpha', ['batch', 'test.codec:1']);
	const beta = connect('beta', []);
	const gamma = connect('gamma', ['game.fanout:1']);

	for (const conn of [alpha, beta, gamma]) {
		conn.facade.subscribe('room');
		conn.userData[symbols.WS_SUBSCRIPTIONS].add('room');
	}
	alpha.facade.subscribe('metrics');
	alpha.userData[symbols.WS_SUBSCRIPTIONS].add('metrics');

	// The scripted sequence, exercising every delivery shape.
	platform.publish('room', 'tick', { n: 1 });
	platform.publish('room', 'tick', { n: 2 }, { jitterMs: 250 });
	platform.publish('metrics', 'gauge', 42, { seq: false });
	platform.batch([
		{ topic: 'room', event: 'a', data: 1 },
		{ topic: 'metrics', event: 'b', data: 2 }
	]);
	platform.publishBatched([
		{ topic: 'room', event: 'burst', data: 'x' },
		{ topic: 'room', event: 'burst', data: 'y' }
	]);
	const statelessCodec = {
		capability: 'test.codec:1',
		schemaVersion: 1,
		encode(event, data) {
			return new TextEncoder().encode(JSON.stringify([event, data]));
		}
	};
	platform.publishWire('room', 'pos', { x: 1, y: 2 }, statelessCodec);
	platform.publishWire('room', 'pos', { x: 3, y: 4 }, statelessCodec);
	platform.sendWire(alpha.facade, 'metrics', 'direct', 'wire', statelessCodec);
	platform.send(beta.facade, 'room', 'whisper', 'psst');
	platform.sendTo((ud) => ud[symbols.WS_CAPS]?.has('game.fanout:1'), 'room', 'targeted', 1);
	platform.grantPublish(gamma.facade, 'room');
	platform.publishGame(gamma.facade, 'room', 'move', { x: 9 }, 'input-1');
	platform.sendCoalesced(alpha.facade, { key: 'cursor', topic: 'room', event: 'cursor', data: [1, 2] });
	platform.adviseReconnect({ windowMs: 4000, close: false });

	const result = {
		schemaVersion: 1,
		trace,
		topicSeqs: [...state.topicSeqs.entries()].sort(),
		topicEpoch: platform.topicEpoch('room'),
		connections: platform.connections,
		subscribers: platform.subscribers('room')
	};

	runtime.resetRuntimeEnv();
	resetProcessEpoch();
	resetTopicEpochs();
	payload.cleanup();
	const serialized = JSON.stringify(result, null, '\t') + '\n';
	return { serialized, fingerprint: fnv32(serialized) };
}

describe('deterministic platform golden trace', () => {
	it('reproduces the committed corpus byte-for-byte', async () => {
		const { serialized, fingerprint } = await runTrace();
		if (process.env.UPDATE_GOLDENS === '1' || !existsSync(goldenPath)) {
			writeFileSync(goldenPath, serialized);
		}
		const golden = readFileSync(goldenPath, 'utf8');
		expect(fingerprint).toBe(fnv32(golden));
		expect(serialized).toBe(golden);
	});

	it('is stable across two runs in one process', async () => {
		const first = await runTrace();
		const second = await runTrace();
		expect(second.fingerprint).toBe(first.fingerprint);
	});
});

afterAll(() => {
	// Nothing persistent: each run builds and removes its own payload.
});
