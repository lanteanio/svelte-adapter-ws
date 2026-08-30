// The bounded per-topic sequence registry: `websocket.maxTopicSeqEntries`
// caps how many topics hold live seq counters, evicting quiet topics once
// the cap is crossed so high-cardinality topic names (per-user, per-request)
// cannot grow the registry without bound.
//
// Protection is fail-closed: a topic with live subscribers or an open resume
// barrier is passed over, and a probe that throws protects rather than
// authorizes. Eviction of an ACTIVE topic would restart its counter at 1 and
// hand resuming clients seqs they have already seen - silent frame loss
// through the dedup - so only genuinely quiet topics leave.

import { createSeqBound } from '../utils/seq-bound.js';
import { TOPIC_SEQS_WARN_THRESHOLD } from '../utils/caps.js';
import { numSubscribers } from './topic-registry.js';
import { topicSeqs } from './state.js';
import { resumeTopicHeld } from './resume-capture.js';
import { maybeWarnTopicRegistry } from './pressure-metrics.js';

/* global WS_OPTIONS */

function resolveCapacity() {
	if (typeof WS_OPTIONS !== 'undefined' && WS_OPTIONS && WS_OPTIONS.maxTopicSeqEntries !== undefined) {
		return WS_OPTIONS.maxTopicSeqEntries;
	}
	// Default = the long-standing warn threshold: zero-config behavior only
	// changes where today's deployment was already in warned pathology.
	return TOPIC_SEQS_WARN_THRESHOLD;
}

const CAPACITY = resolveCapacity();

/**
 * The divergence detector's max-seen registry arms with the state-hash lane;
 * until then the bound keeps eviction consistent across both maps by
 * tracking this one empty.
 * @type {Map<string, number>}
 */
export const maxSeenSeq = new Map();

/**
 * The shared bound over the runtime's seq registries, threaded into every
 * stamping site.
 */
export const seqBound = createSeqBound({
	seqMap: topicSeqs,
	seenMap: maxSeenSeq,
	capacity: CAPACITY,
	floorCap: CAPACITY === 0 ? 0 : Math.max(1024, Math.floor(CAPACITY / 4)),
	isProtected(topic) {
		try {
			if (resumeTopicHeld(topic)) return true;
			return numSubscribers(topic) > 0;
		} catch {
			return true;
		}
	},
	onOverCap(size) {
		maybeWarnTopicRegistry(CAPACITY, size);
	}
});
