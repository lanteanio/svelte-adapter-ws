// Every lane that stamps a seq records it, and only one map is recorded into.
//
// The observed registry is the input to the cross-worker convergence hash. If a
// publish lane stamps without recording, that lane's topics are invisible to the
// comparison; if the relay receive path does not record, every worker's map
// holds only what it published itself and the comparison is between disjoint
// sets. Either way the lane still reports, every worker still agrees, and no
// test that asserts "no divergence fired" can tell.
//
// THE ONE-MAP PROPERTY IS THE SHARPEST OF THESE. `maxSeenSeq` was a
// deliberately-empty placeholder in handler/seq-bound.js before the tracker
// landed. A second declaration under the same name would leave the bound
// evicting against an empty map while the reporter hashed the live one - and
// nothing would be red.
//
// Pinned against source text because handler/platform.js cannot be imported:
// its build-substituted globals are free identifiers until the adapter emits
// the runtime. Both anchors of every carve are asserted, since a missed closing
// anchor widens the slice to nearly the whole file, where a negative assertion
// gets easier to satisfy rather than harder. The recorders themselves are driven
// as functions in test/state-convergence.test.js.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** @param {string} rel */
function readSource(rel) {
	return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const platform = readSource('../src/runtime/handler/platform.js');

/** The source between two anchors, with BOTH anchors asserted. */
function block(source, from, to) {
	const start = source.indexOf(from);
	expect(start, `anchor not found: ${JSON.stringify(from)}`).toBeGreaterThan(-1);
	const end = source.indexOf(to, start + from.length);
	expect(end, `closing anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
		.toBeGreaterThan(-1);
	return source.slice(start, end);
}

describe('one observed registry, declared in one place', () => {
	it('is declared exactly once across the whole of src', () => {
		// A second `export const maxSeenSeq = new Map()` anywhere is two maps
		// under one name: the bound holds one, the reporter hashes the other,
		// and the lane reports agreement it never checked.
		const root = new URL('../src/', import.meta.url);
		// URL objects throughout, never `.pathname`: on Windows that yields
		// `/C:/...`, which readFileSync resolves against the cwd and the scan
		// dies instead of scanning.
		/** @param {URL} dir @returns {URL[]} */
		const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory()
				? walk(new URL(e.name + '/', dir))
				: e.name.endsWith('.js')
					? [new URL(e.name, dir)]
					: []
		);
		const files = walk(root);
		expect(files.length, 'the src scan found almost no files').toBeGreaterThan(50);
		const declarers = files
			.filter((f) => /export const maxSeenSeq\s*=/.test(readFileSync(f, 'utf8')))
			.map((f) => 'src/' + decodeURIComponent(f.href.split('/src/')[1]));
		expect(declarers).toEqual(['src/runtime/handler/state.js']);
	});

	it('is read by the registry bound from the module that declares it', () => {
		// The direction matters and is not cosmetic: state.js evaluates first in
		// the real import graph, and seq-bound.js builds its bound at module
		// scope, so a re-export pointing the other way puts topicSeqs in the
		// temporal dead zone and the worker never boots.
		const seqBound = readSource('../src/runtime/handler/seq-bound.js');
		expect(seqBound).toContain("import { topicSeqs, maxSeenSeq } from './state.js';");
		expect(seqBound, 'seq-bound.js declares its own registry again').not.toMatch(/export const maxSeenSeq/);
		expect(seqBound).toContain('seenMap: maxSeenSeq,');
		const state = readSource('../src/runtime/handler/state.js');
		expect(state, 'state.js reaches back into seq-bound.js, which inverts the import edge')
			.not.toContain("from './seq-bound.js'");
	});
});

describe('every stamping lane records what it stamped', () => {
	it('publish() records, choosing the guard by where the number came from', () => {
		const body = block(platform, 'function publish(', '\nfunction send(');
		expect(body).toContain('const seq = stampSeqValue(seqOption, topicSeqs, topic, seqBound);');
		expect(body).toContain("if (typeof seqOption === 'number' || typeof seqOption === 'bigint') recordSeen(maxSeenSeq, topic, seq, seqBound);");
		expect(body).toContain('else recordStampedSeen(maxSeenSeq, topic, seq, seqBound);');
		// A `{ seq: false }` topic must never enter the comparison, or workers
		// that publish it locally-only diverge from those that do not.
		expect(body).toContain('if (seq !== null) {');
	});

	it('publishWire() records on the origin arm and not on the relay arm', () => {
		// The relay arm already recorded through the monotone-max guard in
		// relayPublish. Recording again here is harmless for the maximum but
		// would latch the foreign-seq flag on a lane that never saw one.
		const body = block(platform, '\tpublishWire(', '\n\t/**');
		expect(body).toContain('if (!isRelay && seq !== null) {');
		expect(body).toContain('recordStampedSeen(maxSeenSeq, topic, seq, seqBound);');
		const recordAt = body.indexOf('recordStampedSeen(');
		const stampAt = body.indexOf('const seq = isRelay');
		expect(stampAt, 'publishWire no longer stamps where this pin expects').toBeGreaterThan(-1);
		expect(recordAt, 'publishWire records before it has a seq to record').toBeGreaterThan(stampAt);
	});

	it('the wire batch records one watermark, or every entry when authorities mix', () => {
		const body = block(platform, '\tpublishWireBatch(', '\n\t/**');
		expect(body).toContain('if (sawEntrySeq) {');
		expect(body).toContain("if (typeof entrySeqs[i] === 'number') recordSeen(maxSeenSeq, topic, seqs[i], seqBound);");
		expect(body).toContain('} else if (highestSeq !== null) {');
		expect(body).toContain('recordStampedSeen(maxSeenSeq, topic, highestSeq, seqBound);');
		// The one-record shortcut is only sound because the counter is monotone,
		// so the highest is the only stamp that can move the watermark.
		expect(body).toContain('if (seqs[i] !== 0 && (highestSeq === null || seqs[i] > highestSeq)) highestSeq = seqs[i];');
	});

	it('the message batch records every message it stamped', () => {
		const body = block(platform, '\tpublishBatched(', '\n\t/**');
		expect(body).toContain("if (typeof msgSeqs[i] === 'number' || typeof msgSeqs[i] === 'bigint') recordSeen(maxSeenSeq, m.topic, seq, seqBound);");
		expect(body).toContain('else recordStampedSeen(maxSeenSeq, m.topic, seq, seqBound);');
	});

	it('the game lane records what it stamped', () => {
		const body = block(platform, '\tpublishGame(', '\n\t/**');
		expect(body).toContain('if (seq !== null) recordStampedSeen(maxSeenSeq, topic, seq, seqBound);');
	});
});

describe('the relay receive lanes record what a sibling worker sent', () => {
	it('the single lane records the carried seq and the origin stream', () => {
		const body = block(platform, 'export function relayPublish(', '\n/**');
		expect(body).toContain('recordSeen(maxSeenSeq, topic, seq, seqBound);');
		expect(body).toContain('if (streamTracking.enabled) {');
		expect(body).toContain('recordOriginStream(originStreams, topic, origin, ord, birth, relayAttach.at, processMonotonicNow);');
		// Recording a topic off a frame the fatal tier has already condemned
		// would put a number from a structurally broken relay into the
		// comparison every other worker is judged against.
		const guardAt = body.indexOf("if (typeof topic !== 'string'");
		expect(guardAt, 'the structural guard moved').toBeGreaterThan(-1);
		expect(body.indexOf('recordSeen('), 'the carried seq is recorded before the frame is judged well-formed')
			.toBeGreaterThan(guardAt);
	});

	it('the batched lane records every event, before the fan-out decision', () => {
		const body = block(platform, 'export function relayPublishBatched(', '\n}\n');
		expect(body).toContain('recordSeen(maxSeenSeq, events[i].topic, events[i].seq, seqBound);');
		expect(body).toContain('recordOriginStream(originStreams, events[i].topic, events[i].origin, events[i].ord, events[i].birth,');
		// Ungated by the fan-out decision and by whether this worker holds a
		// subscriber: a worker that recorded only what it delivered would report
		// a different map from a sibling with a different subscription mix, and
		// the comparison would fire on a difference that is not a loss.
		expect(body.indexOf('recordSeen('), 'the batch records after it has decided how to fan out')
			.toBeLessThan(body.indexOf('let allSeeAll'));
	});

	it('gates the contiguity tracker so an unarmed deployment allocates nothing', () => {
		// The tracker is only worth its per-frame cost where the reporter that
		// drains it exists; armed off, both lanes pay one boolean test.
		const single = block(platform, 'export function relayPublish(', '\n/**');
		const batched = block(platform, 'export function relayPublishBatched(', '\n}\n');
		for (const body of [single, batched]) {
			const gate = body.indexOf('if (streamTracking.enabled) {');
			expect(gate, 'a relay lane records origin streams ungated').toBeGreaterThan(-1);
			expect(body.indexOf('recordOriginStream('), 'the tracker runs outside its gate').toBeGreaterThan(gate);
		}
	});
});
