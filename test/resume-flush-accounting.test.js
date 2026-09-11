// The gap-fill flush is the one send lane whose frames leave through the
// resume buffer instead of a platform method, so it is where a second byte
// counter goes unnoticed: this runtime counts bytesOut in BYTES on every
// other lane, and a flushed frame must not report UTF-16 code units instead.
// The second case pins the PRIMITIVE the batch lane sweeps with: a flush
// deregisters only its own topic, so closing the rest is discardResumeCapture's
// job and not something the flush does on its way past. The lane driving that
// sweep over a real socket is pinned in resume-batch-lane.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');

describe('the gap-fill flush accounts for what it sent', () => {
	/** @type {any} */ let resumeBuffer;
	/** @type {any} */ let state;
	/** @type {any} */ let connStats;
	/** @type {any} */ let symbols;
	/** @type {any} */ let config;

	beforeAll(async () => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		resumeBuffer = await import(pathToFileURL(path.join(builtDir, 'resume-buffer.js')).href);
		state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);
		connStats = await import(pathToFileURL(path.join(builtDir, 'conn-stats.js')).href);
		symbols = await import(pathToFileURL(path.join(builtDir, '..', 'utils.js')).href);
		config = await import(pathToFileURL(path.join(builtDir, 'config.js')).href);
	}, 120000);

	function scriptedWs() {
		const ud = {};
		const sent = [];
		return {
			sent,
			getUserData() { return ud; },
			send(payload) { sent.push(String(payload)); return 1; }
		};
	}

	it('counts a flushed frame in bytes, not UTF-16 code units', () => {
		const conn = scriptedWs();
		const topic = 'flush-accounting-bytes';
		// Two-byte characters in the payload, so the two counts differ: any
		// lane still measuring `.length` under-reports this frame by 2.
		const envelope = `{"topic":"${topic}","event":"update","data":"Grüße"}`;
		expect(Buffer.byteLength(envelope), 'the payload must actually be multi-byte').toBeGreaterThan(envelope.length);
		// Arm BOTH stats gates. They are wired to the same thing in the runtime
		// (a registered close hook), so leaving one off would let a lane that
		// counts the wrong unit pass as a lane that counts nothing.
		connStats.setStatsEnabled(true);
		config.armCloseHookAccounting(true);
		const ud = conn.getUserData();
		ud[symbols.WS_STATS] = connStats.createConnStats(0);
		const capture = resumeBuffer.beginResumeCapture([topic], conn);
		try {
			state.captureResumeFrame(topic, 5, envelope, false);
			expect(resumeBuffer.flushResumeTopic(capture, topic, 0), 'the flush must not report a closed connection').toBe(false);
			expect(conn.sent).toEqual([envelope]);
			expect(ud[symbols.WS_STATS].messagesOut).toBe(1);
			expect(ud[symbols.WS_STATS].bytesOut).toBe(Buffer.byteLength(envelope));
		} finally {
			connStats.setStatsEnabled(false);
			config.armCloseHookAccounting(false);
			resumeBuffer.discardResumeCapture(capture);
		}
	});

	it('closes a recovered topic that never reached its flush', () => {
		const conn = scriptedWs();
		const flushed = 'flush-accounting-swept-a';
		const denied = 'flush-accounting-swept-b';
		const capture = resumeBuffer.beginResumeCapture([flushed, denied], conn);
		try {
			expect(state.resumeBuffers.has(flushed)).toBe(true);
			expect(state.resumeBuffers.has(denied)).toBe(true);
			resumeBuffer.flushResumeTopic(capture, flushed, 0);
			// A flush deregisters its own topic and leaves every other buffer in
			// the handle open, so a caller that flushes some topics and not others
			// still holds live buffers until it discards the handle.
			expect(state.resumeBuffers.has(flushed)).toBe(false);
			expect(state.resumeBuffers.has(denied)).toBe(true);
			resumeBuffer.discardResumeCapture(capture);
			expect(state.resumeBuffers.has(denied)).toBe(false);
		} finally {
			resumeBuffer.discardResumeCapture(capture);
		}
	});
});
