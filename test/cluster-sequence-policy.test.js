import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Read a source with its line endings normalized, so an anchor spanning a line
 * break cannot match on one checkout and miss on another.
 *
 * @param {string} rel
 * @returns {string}
 */
function readSource(rel) {
	return readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The source between two anchors, with BOTH anchors asserted.
 *
 * Assume a widened slice PASSES rather than fails: an unchecked `indexOf` that
 * misses returns -1, `slice(start, -1)` reads as one-before-the-end, and the
 * slice becomes nearly the whole file - where a `toContain` needle that appears
 * anywhere later keeps passing while the pin no longer describes the lane it
 * names. So a renamed JSDoc heading or a reordered method has to fail HERE, by
 * name, rather than quietly producing a slice these pins no longer describe.
 *
 * @param {string} source
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function carve(source, from, to) {
	const start = source.indexOf(from);
	expect(start, `carve anchor not found: ${JSON.stringify(from)}`).toBeGreaterThan(-1);
	const end = source.indexOf(to, start + from.length);
	expect(end, `carve closing anchor ${JSON.stringify(to)} not found after ${JSON.stringify(from)}`)
		.toBeGreaterThan(-1);
	return source.slice(start, end);
}
import {
	BATCH_SEQUENCE_ERROR,
	BATCH_ENTRY_SEQUENCE_ERROR,
	CLUSTER_SEQUENCE_ERROR,
	assertClusterSequenceAuthority,
	assertClusterSequenceAuthorityValues,
	assertBatchSequenceAuthority,
	assertBatchEntrySequenceAuthority,
	clusterSequenceAccepted,
	clusterSequenceValuesAccepted,
	hasMultipleWorkers,
	RELAY_ORIGIN_SEQ
} from '../src/runtime/handler/cluster-sequence-policy.js';
import { stampSeq, stampSeqValue } from '../src/runtime/utils/epoch.js';

describe('cluster sequence authority policy', () => {
	const cluster = { totalWorkers: 3, ioWorkers: 2 };

	it('accepts implicit counters only outside a multi-worker process', () => {
		expect(hasMultipleWorkers(null)).toBe(false);
		expect(hasMultipleWorkers({ totalWorkers: 1 })).toBe(false);
		expect(hasMultipleWorkers(cluster)).toBe(true);
		expect(clusterSequenceAccepted(undefined, null)).toBe(true);
		expect(clusterSequenceAccepted(undefined, { totalWorkers: 1 })).toBe(true);
		expect(clusterSequenceAccepted(undefined, cluster)).toBe(false);
	});

	it('requires either no seq or an external numeric seq with built-in relay disabled', () => {
		for (const accepted of [
			{ seq: false },
			{ seq: false, relay: false },
			{ seq: 41, relay: false }
		]) expect(clusterSequenceAccepted(accepted, cluster), JSON.stringify(accepted)).toBe(true);

		for (const rejected of [
			undefined, {}, { relay: false }, { seq: true }, { seq: 41 }, { seq: 41, relay: true },
			{ seq: 0, relay: false }, { seq: -1, relay: false }, { seq: 1.5, relay: false },
			{ seq: Number.NaN, relay: false }, { seq: Number.POSITIVE_INFINITY, relay: false }
		]) {
			expect(clusterSequenceAccepted(rejected, cluster), JSON.stringify(rejected)).toBe(false);
			expect(() => assertClusterSequenceAuthority(rejected, cluster)).toThrow(CLUSTER_SEQUENCE_ERROR);
		}
	});

	it('rejects a numeric authority on the batch surface whatever it is publishing', () => {
		expect(() => assertBatchSequenceAuthority({ seq: 7, relay: false }, cluster))
			.toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: false }, cluster)).not.toThrow();
	});

	// The refusal used to be gated on hasMultipleWorkers, so the corruption it
	// exists to prevent was live on the DEFAULT single-worker deployment: stampSeq
	// returns a caller-supplied number verbatim and publishWireBatch calls it once
	// per entry, so every entry carried the same seq whatever the topology. Only
	// the clustered case was covered here, which is why it survived.
	it('rejects the numeric authority off-cluster too, where the default deployment lives', () => {
		for (const solo of [null, { totalWorkers: 1 }, { totalWorkers: 1, ioWorkers: 1 }]) {
			expect(hasMultipleWorkers(solo), JSON.stringify(solo)).toBe(false);
			expect(
				() => assertBatchSequenceAuthority({ seq: 7, relay: false }, solo),
				JSON.stringify(solo)
			).toThrow(BATCH_SEQUENCE_ERROR);
			expect(() => assertBatchSequenceAuthority({ seq: false }, solo)).not.toThrow();
		}
	});

	// The rule is a property of the SURFACE, not of the payload: one options
	// object cannot carry one-seq-per-entry (that form lives on the entries),
	// so a numeric OPTIONS seq is refused before the entries are even looked
	// at. Otherwise the contract would depend on the runtime length of an
	// array - a call that works while a tick produces one update starts
	// throwing the day it produces two, and an empty batch would silently
	// accept options a full one rejects.
	it('does not let the entry count decide whether the contract holds', () => {
		expect(() => assertBatchSequenceAuthority({ seq: 7, relay: false })).toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: 1, relay: false })).toThrow(BATCH_SEQUENCE_ERROR);
		// The signature carries no count at all, so no caller can reintroduce one.
		// EXACTLY one: `data` has a default and so is not counted, leaving
		// `options` as the only positional parameter. An upper bound (`<= 2`)
		// would leave one parameter of slack - precisely the count slot this
		// pin exists to exclude - so a `(options, count, data = workerData)`
		// signature would pass it at length 2 and the pin would prove nothing.
		expect(assertBatchSequenceAuthority.length).toBe(1);
		// A DEFAULTED extra parameter also reports length 1, so the count the
		// pin above excludes could hide behind a default value. Pin the
		// declared parameter list in the module source (Function.prototype
		// toString is not stable under the test transform): options, then the
		// injectable workerData - no count in any position.
		const policySource = readFileSync(new URL('../src/runtime/handler/cluster-sequence-policy.js', import.meta.url), 'utf8');
		expect(policySource).toContain('export function assertBatchSequenceAuthority(options, data = workerData) {');
	});

	// An entry carrying an explicit seq is the per-entry twin of
	// publishWire({ seq: N }) and takes the same clustered rule: the external
	// allocator must also be the fan-out, and relay: false is the observable
	// proof the built-in multi-origin relay is off. Off-cluster the entry form
	// is unconditionally welcome - the counter and an external authority
	// cannot interleave across workers when there is only one.
	it('admits clustered per-entry authority only with the relay renounced', () => {
		for (const solo of [null, { totalWorkers: 1 }]) {
			for (const options of [undefined, {}, { seq: false }, { relay: true }]) {
				expect(() => assertBatchEntrySequenceAuthority(options, solo)).not.toThrow();
			}
		}
		for (const accepted of [{ relay: false }, { seq: false, relay: false }]) {
			expect(() => assertBatchEntrySequenceAuthority(accepted, cluster), JSON.stringify(accepted)).not.toThrow();
		}
		for (const rejected of [undefined, {}, { seq: false }, { relay: true }]) {
			expect(() => assertBatchEntrySequenceAuthority(rejected, cluster), JSON.stringify(rejected))
				.toThrow(BATCH_ENTRY_SEQUENCE_ERROR);
		}
	});

	// The hot lanes judge captured VALUES while colder callers judge the options
	// OBJECT. The object form delegates to the values form, and this matrix is
	// the proof the two spellings cannot drift: every (seq, relay) shape answers
	// identically through both, in both topologies.
	it('the values form and the options form agree on every shape', () => {
		const shapes = [
			[undefined, undefined], [false, undefined], [true, undefined],
			[7, undefined], [7, false], [7, true], [0, false], [-1, false],
			[1.5, false], [false, false], [Number.NaN, false]
		];
		for (const data of [null, { totalWorkers: 1 }, cluster]) {
			for (const [seq, relay] of shapes) {
				expect(clusterSequenceValuesAccepted(seq, relay, data), `${String(seq)}/${String(relay)}`)
					.toBe(clusterSequenceAccepted({ seq, relay }, data));
			}
			expect(clusterSequenceValuesAccepted(undefined, undefined, data))
				.toBe(clusterSequenceAccepted(undefined, data));
			expect(() => assertClusterSequenceAuthorityValues(7, undefined, cluster))
				.toThrow(CLUSTER_SEQUENCE_ERROR);
		}
	});

	it('the stampSeq value form and options form agree on every shape', () => {
		for (const seq of [undefined, false, true, 3, 'x']) {
			const a = new Map();
			const b = new Map();
			const call = (fn) => { try { return { value: fn() }; } catch (error) { return { threw: error.constructor.name }; } };
			const viaOptions = call(() => stampSeq(seq === undefined ? undefined : { seq }, a, 't'));
			const viaValue = call(() => stampSeqValue(seq, b, 't'));
			expect(viaValue, String(seq)).toEqual(viaOptions);
			expect([...b.entries()]).toEqual([...a.entries()]);
		}
	});

	it('guards every production sequence-stamping entry point before mutation', () => {
		const indexSource = readSource('../src/runtime/index.js');
		const source = readSource('../src/runtime/handler/platform.js');
		// The primary threads the resolved worker count into workerData, which
		// is what arms the multi-worker policy in every worker.
		expect(indexSource).toContain('totalWorkers: num');
		const publish = carve(source, 'function publish(', '\nfunction send(');
		const wire = carve(source, '\tpublishWire(', '\n\t/**');
		const wireBatch = carve(source, '\tpublishWireBatch(', '\n\t/**');
		const loopBatch = carve(source, '\tbatch(messages)', '\n\t/**');
		const batch = carve(source, '\tpublishBatched(', '\n\t/**');
		// The single lanes follow the one-read rule the batch pioneered: every
		// option field is read into a local BEFORE the authority check, and the
		// check judges the locals - so a stateful accessor cannot answer the
		// refusal with one value and hand the stamp another. The pins below
		// require the values-form assert AND exactly one read site per field
		// (the capture line itself) in each lane body.
		expect(publish).toContain('assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		expect(publish.indexOf('options.seq'), 'publish must capture before judging')
			.toBeLessThan(publish.indexOf('assertClusterSequenceAuthorityValues('));
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.jitterMs']) {
			expect(publish.split(field).length, `publish reads ${field} exactly once`).toBe(2);
		}
		expect(wire).toContain('if (!isRelay) assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.excludeWs', '[RELAY_ORIGIN_SEQ]']) {
			expect(wire.split(field).length, `publishWire reads ${field} exactly once`).toBe(2);
		}
		// The marker forces the relay decision off by itself. Without the
		// `!isRelay` term a received frame is relayed onward whenever the
		// options do not say otherwise, and the set site no longer says so.
		expect(wire, 'the relay decision must be forced off by the marker')
			.toContain('const relayed = !isRelay && !!(parentPort && relayOption !== false);');
		// The batch asserts on its OWN copy of the options, not on the caller's
		// live object - a caller that mutated it after the check would otherwise
		// stamp under an authority nobody validated. The guard runs before ANY
		// mutation and before the entries are even inspected, so an empty batch
		// cannot accept options a full one refuses.
		expect(wireBatch).toContain('assertBatchSequenceAuthority(opts);');
		const beforeAssert = wireBatch.slice(0, wireBatch.indexOf('assertBatchSequenceAuthority('));
		// Field reads, not a spread: the copy the assert vets and the copy the
		// stamping reads must be the same one read of the caller's object, and
		// a spread would let an inherited or accessor-carried numeric seq
		// vanish from the copy and slip the refusal.
		expect(beforeAssert).toContain(': { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs };');
		expect(beforeAssert, 'the batch inspects entries or fans out before its authority check')
			.not.toMatch(/stampSeq|fanOut\(|captureResumeFrame|entries\.length|Array\.isArray/);
		// The per-entry authority check runs inside the batch too: the entry
		// pre-read pass vets an explicit numeric entry seq BEFORE the separate
		// stamping pass mutates any counter, so a mid-batch refusal cannot
		// leave earlier entries already stamped.
		expect(wireBatch.split('assertBatchEntrySequenceAuthority(opts)').length, 'the entry pre-read pass vets per-entry authority')
			.toBe(2);
		expect(wireBatch.indexOf('assertBatchEntrySequenceAuthority(opts)'),
			'the entry pre-read pass must vet per-entry authority before the stamping pass')
			.toBeLessThan(wireBatch.indexOf('stampSeqValue(entrySeqs'));
		// The stamp draws from the batch options when an entry carries no
		// explicit seq: `{ seq: false }` - the one spelling a clustered batch
		// may carry - must stamp nothing, not quietly advance the per-worker
		// counter it renounced and relay the forked number cluster-wide.
		expect(wireBatch).toContain(': (opts != null ? opts.seq : undefined)');
		// The entry lane resolves through the SHARED resolver, not a
		// hand-rolled number check: restating the table here is what let an
		// over-range value past the pre-pass and into the stamping loop,
		// where the throw arrives after earlier entries are already stamped.
		expect(wireBatch).toContain('resolveEntrySeq(entry.seq, i)');
		expect(wireBatch).not.toContain('Number.isInteger(entrySeq)');
		// The relay SET site normalizes, and it is pinned here rather than
		// driven because production's relay needs a worker cluster: the
		// behavioural pair lives in test/codec-relay.test.js against the
		// harness copy. A missing seq must reach the marker as null, since
		// `undefined` is indistinguishable from an absent marker and the frame
		// would read as an origin publish on every worker that received it.
		const relaySet = source.slice(source.indexOf('export function relayPublishWire'));
		expect(relaySet.indexOf('export function relayPublishWire'), 'relayPublishWire must stay findable by name')
			.toBe(0);
		expect(relaySet).toContain("[RELAY_ORIGIN_SEQ]: typeof seq === 'number' ? seq : null,");
		// And it no longer sets the relay flag beside the marker: two settings
		// that have to agree are one that can be forgotten. Comment lines are
		// stripped first, because this pin is about the CODE and the sentence
		// explaining the change naturally quotes the spelling it removed.
		const relayEnd = relaySet.indexOf('\n}');
		expect(relayEnd, 'relayPublishWire has no closing brace, so this slice would widen')
			.toBeGreaterThan(0);
		const relayBody = relaySet.slice(0, relayEnd).replace(/^[ \t]*\/\/.*$/gm, '');
		expect(relayBody, 'the marker alone must carry the relay decision')
			.not.toContain('relay: false');
		// batch() snapshots each message's option fields once and judges the
		// snapshot, then hands publish() the SAME snapshot - so the atomic
		// pre-pass and the per-message stamp cannot disagree.
		expect(loopBatch).toContain(': { seq: o.seq, relay: o.relay, compress: o.compress, jitterMs: o.jitterMs, excludeWs: o.excludeWs };');
		expect(loopBatch).toContain('assertClusterSequenceAuthority(snap);');
		expect(loopBatch.indexOf('assertClusterSequenceAuthority(snap);'),
			'batch must vet every snapshot before the first publish')
			.toBeLessThan(loopBatch.indexOf('results.push(publish('));
		expect(loopBatch).toContain('publish(topic, event, data, /** @type {any} */ (snapshots[i]))');
		// publishBatched captures per-message seq/relay/jitter into arrays in
		// its atomic pre-pass; the stamp and the relay filter both consume the
		// captured values.
		expect(batch).toContain('assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		expect(batch).toContain('stampSeqValue(msgSeqs[i]');
		expect(batch).toContain('msgRelays[i] !== false');
		expect(batch.split('messages[i].options').length, 'publishBatched reads each message options object in the pre-pass only')
			.toBe(2);
	});
});

// The gate and the stamp speak ONE table. Every spelling the stamp learned
// has to reach this gate too: a spelling the stamp accepts and the gate
// refuses hands the caller a topology message about relay settings and worker
// counters for what is really a value they were told is legal, and a spelling
// the gate accepts while the batch surface stays blind to it is worse - it
// stamps one authority onto every entry of a batch and calls that a sequence.
describe('the gate carries every spelling the stamp accepts', () => {
	const cluster = { totalWorkers: 3, ioWorkers: 2 };

	it('takes null as a no-seq form, the way false is one', () => {
		expect(clusterSequenceValuesAccepted(null, undefined, cluster)).toBe(true);
		expect(clusterSequenceValuesAccepted(false, undefined, cluster)).toBe(true);
		expect(() => assertClusterSequenceAuthority({ seq: null }, cluster)).not.toThrow();
	});

	it('takes a bigint authority on the same terms as the number spelling', () => {
		expect(clusterSequenceValuesAccepted(5n, false, cluster)).toBe(true);
		expect(clusterSequenceValuesAccepted(5, false, cluster)).toBe(true);
		// The authority must also be the fan-out, whichever way it is spelled.
		expect(clusterSequenceValuesAccepted(5n, true, cluster)).toBe(false);
		expect(clusterSequenceValuesAccepted(5, true, cluster)).toBe(false);
		// Non-positive is not an authority in either spelling.
		expect(clusterSequenceValuesAccepted(0n, false, cluster)).toBe(false);
		expect(clusterSequenceValuesAccepted(0, false, cluster)).toBe(false);
	});

	it('refuses a bigint on the batch surface, where one options seq cannot number many entries', () => {
		// The whole point of the batch refusal: `options.seq` is ONE value and
		// a batch needs one per entry. A spelling that slips past it does not
		// fail, it stamps the same seq on every entry and calls the result a
		// sequence - so the bigint spelling has to refuse exactly as the
		// number spelling does.
		expect(() => assertBatchSequenceAuthority({ seq: 5n }, {})).toThrow(TypeError);
		expect(() => assertBatchSequenceAuthority({ seq: 5n }, {})).toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: 5 }, {})).toThrow(BATCH_SEQUENCE_ERROR);
		// The no-seq forms stay legal on the batch surface.
		expect(() => assertBatchSequenceAuthority({ seq: false }, {})).not.toThrow();
		expect(() => assertBatchSequenceAuthority({ seq: null }, {})).not.toThrow();
	});

	it('agrees with the stamp on every spelling, so neither can drift alone', () => {
		for (const seq of [false, null, 5, 5n, true, undefined]) {
			const stampTook = (() => {
				try { stampSeqValue(seq, new Map(), 't'); return true; } catch { return false; }
			})();
			// Off-cluster the gate takes everything the stamp takes.
			expect(clusterSequenceValuesAccepted(seq, false, { totalWorkers: 1 }), String(seq)).toBe(stampTook);
		}
	});
});

// The marker's unforgeability is a property of HOW it is declared, and neither
// half of that is visible to a test that only drives publish lanes.
describe('the relay origin-seq marker is declared unforgeably', () => {
	it('is a module symbol, never a registry symbol', () => {
		// Symbol.for() puts a symbol in the cross-realm registry, where an
		// application retrieves it by DESCRIPTION without importing anything.
		// That would leave the marker exactly as spellable as the two string
		// keys it replaced, and the swap is otherwise invisible: every publish
		// test still passes with it.
		expect(typeof RELAY_ORIGIN_SEQ).toBe('symbol');
		expect(
			Symbol.keyFor(RELAY_ORIGIN_SEQ),
			'the marker is in the global symbol registry, so an app can fetch it by description'
		).toBeUndefined();
		expect(
			RELAY_ORIGIN_SEQ,
			'a registry symbol with this description is the same value as the marker'
		).not.toBe(Symbol.for(String(RELAY_ORIGIN_SEQ.description)));
	});

	it('leaves no string spelling of the relay marker anywhere in src', () => {
		// An ADDITIVE backdoor is what the other pins cannot see: writing
		// `|| options._isRelay` beside the symbol read leaves the symbol read
		// count unchanged, and the behavioural cases drive the harness only.
		// Scanning the whole of src catches it on both surfaces at once, and
		// catches a third surface nobody has thought of yet.
		const root = new URL('../src/', import.meta.url);
		// URL objects throughout, never `.pathname`: on Windows that yields
		// `/C:/...`, which readFileSync resolves against the cwd into
		// `C:\C:\...` and the scan dies instead of scanning.
		/** @param {URL} dir @returns {URL[]} */
		const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory()
				? walk(new URL(e.name + '/', dir))
				: e.name.endsWith('.js')
					? [new URL(e.name, dir)]
					: []
		);
		const files = walk(root);
		// Vacuity floor: an empty file list would satisfy the filter below.
		expect(files.length, 'the src scan found almost no files').toBeGreaterThan(50);
		const offenders = files
			.filter((f) => /_isRelay|_relaySeq/.test(readFileSync(f, 'utf8')))
			.map((f) => 'src/' + decodeURIComponent(f.href.split('/src/')[1]));
		expect(offenders, 'a string spelling of the relay marker is back in src').toEqual([]);
	});
});
