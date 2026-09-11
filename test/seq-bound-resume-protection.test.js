// The bounded seq registry passes over a topic with an open resume buffer.
// Evicting it would restart its counter at 1 and hand the resuming client
// seqs it has already seen - silent frame loss through the dedup - so the
// buffer protects the topic exactly as a live subscriber does, and only for
// as long as it is open.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { buildRuntime } from './helpers/build-runtime.js';

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
	// Two live counters, so the third insert has to evict one.
	maxTopicSeqEntries: 2
};

/** @type {ReturnType<typeof buildRuntime>} */
let payload;
/** @type {any} */
let state;
/** @type {any} */
let bound;
/** @type {any} */
let buffers;

beforeAll(async () => {
	payload = buildRuntime({
		replace: { WS_ENABLED: JSON.stringify(true), WS_OPTIONS: JSON.stringify(WS_OPTS) }
	});
	const dir = pathToFileURL(payload.dir).href;
	state = await import(`${dir}/handler/state.js`);
	bound = await import(`${dir}/handler/seq-bound.js`);
	buffers = await import(`${dir}/handler/resume-buffer.js`);
}, 60000);

afterAll(() => {
	payload?.cleanup?.();
});

/** A socket the capture window can be opened on; nothing is flushed to it. */
function scriptedFacade() {
	const userData = {};
	return { getUserData: () => userData, send: () => 1, close: () => {} };
}

describe('the seq registry bound', () => {
	it('passes over a topic with an open resume buffer, and evicts it once the buffer closes', () => {
		state.topicSeqs.clear();
		state.maxSeenSeq.clear();
		expect(state.resumeBuffers.size).toBe(0);
		const capture = buffers.beginResumeCapture(['protected'], scriptedFacade());
		try {
			state.topicSeqs.set('protected', 1);
			bound.seqBound.onInsert('protected');
			state.topicSeqs.set('quiet', 1);
			bound.seqBound.onInsert('quiet');
			// Over the cap: the oldest entry is the protected one, so the sweep
			// must pass it over and take the quiet topic instead.
			state.topicSeqs.set('third', 1);
			bound.seqBound.onInsert('third');
			expect(state.topicSeqs.has('protected'), 'an open resume buffer protects its topic').toBe(true);
			expect(state.topicSeqs.has('quiet')).toBe(false);
		} finally {
			buffers.discardResumeCapture(capture);
		}
		expect(state.resumeBuffers.size).toBe(0);
		// The window is closed. Being passed over rotated the topic to the tail,
		// so the next insert takes the entry ahead of it and the one after that
		// takes the topic itself: nothing protects it any more.
		state.topicSeqs.set('fourth', 1);
		bound.seqBound.onInsert('fourth');
		expect(state.topicSeqs.has('third')).toBe(false);
		expect(state.topicSeqs.has('protected')).toBe(true);
		state.topicSeqs.set('fifth', 1);
		bound.seqBound.onInsert('fifth');
		expect(state.topicSeqs.has('protected'), 'a closed window protects nothing').toBe(false);
		state.topicSeqs.clear();
	});
});
