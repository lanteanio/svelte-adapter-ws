import { describe, expect, it } from 'vitest';
import { createPredictor } from '../src/plugins/smooth/predict.js';

const apply = (state, command) => ({ x: state.x + command.dx, y: 0 });

function predictor(options = {}) {
	return createPredictor({ apply, initial: { x: 0, y: 0 }, smoothTimeMs: 100, ...options });
}

function warmed(options = {}) {
	const p = predictor(options);
	let mono = 1000;
	for (let i = 1; i <= 4; i++) {
		mono += 16;
		const id = p.command({ dx: 2 }, mono);
		p.ack(id, { x: i * 2, y: 0 }, mono);
	}
	return { predictor: p, mono };
}

function expectColdCorrection(p, mono) {
	const id = p.command({ dx: 2 }, mono);
	const before = { x: 0, y: 0 };
	p.renderInto(before, mono);
	p.ack(id, { x: 155, y: 0 }, mono);
	const after = { x: 0, y: 0 };
	p.renderInto(after, mono);
	expect(p.predicted).toEqual({ x: 155, y: 0 });
	expect(p.correcting).toBe(true);
	expect(after.x).toBeCloseTo(before.x, 8);
}

describe('local placement motion history lifetime', () => {
	it('reset removes the old speed baseline before the first new command', () => {
		const { predictor: p, mono } = warmed();
		p.reset({ x: 0, y: 0 });
		expectColdCorrection(p, mono + 16);
	});

	it('count overflow removes the baseline before acknowledgement recovery', () => {
		let { predictor: p, mono } = warmed({ windowCap: 4 });
		let id;
		for (let i = 0; i < 5; i++) id = p.command({ dx: 2 }, (mono += 16));
		expect(p.overflowed).toBe(true);
		expect(p.windowSize).toBe(0);
		p.ack(id, { x: 0, y: 0 }, mono);
		expect(p.overflowed).toBe(false);
		expectColdCorrection(p, mono + 16);
	});

	it('age overflow removes the baseline before acknowledgement recovery', () => {
		let { predictor: p, mono } = warmed({ windowMaxAgeMs: 32 });
		const id = p.command({ dx: 2 }, (mono += 16));
		expect(p.checkOverflow(mono + 33)).toBe(true);
		expect(p.windowSize).toBe(0);
		mono += 33;
		p.ack(id, { x: 0, y: 0 }, mono);
		expect(p.overflowed).toBe(false);
		expectColdCorrection(p, mono + 16);
	});
});

describe('local placement motion peak', () => {
	function drive(p, mono, dx, ackX) {
		const id = p.command({ dx }, mono);
		p.ack(id, { x: ackX, y: 0 }, mono);
		return id;
	}

	it('falls back to the remaining lower peak when the faster interval leaves the window', () => {
		let { predictor: p, mono } = warmed();
		drive(p, (mono += 16), 160, 168);
		drive(p, (mono += 16), 80, 248);
		for (let i = 0; i < 30; i++) drive(p, (mono += 16), 0, 248);
		expect(p.correcting).toBe(false);
		// The fast interval has just been overwritten; the slower one still covers 3000.
		drive(p, (mono += 16), 0, 3248);
		expect(p.correcting).toBe(true);
		// The slower interval is overwritten next and the window is stationary.
		drive(p, (mono += 16), 0, 3348);
		expect(p.correcting).toBe(false);
		expect(p.renderInto(out(), mono)).toBe(false);
	});

	it('raises the peak for a faster interval recorded after the window filled', () => {
		let { predictor: p, mono } = warmed();
		for (let i = 0; i < 32; i++) drive(p, (mono += 16), 0, 8);
		drive(p, (mono += 16), 160, 168);
		// Eight times 160 per 16 ms over 100 ms bounds an 8000 correction.
		drive(p, (mono += 16), 0, 7168);
		expect(p.correcting).toBe(true);
	});

	it('raises an already measured peak for a faster interval in a slot that held less', () => {
		let { predictor: p, mono } = warmed();
		drive(p, (mono += 16), 4, 12);
		// An eased correction reads the peak of the slow intervals.
		drive(p, (mono += 16), 2, 34);
		expect(p.correcting).toBe(true);
		drive(p, (mono += 16), 160, 194);
		// Eight times 160 per 16 ms over 100 ms bounds an 8000 correction.
		drive(p, (mono += 16), 0, 7194);
		expect(p.correcting).toBe(true);
	});

	it('prediction overflow forgets the peak even when its slot was not overwritten', () => {
		const p = predictor({ windowCap: 4 });
		let mono = 1000;
		for (const dx of [2, 2, 2, 160]) p.command({ dx }, (mono += 16));
		expect(p.ack(4, { x: 166, y: 0 }, mono).divergence).toBe(0);
		let id = 0;
		for (let i = 0; i < 5; i++) id = p.command({ dx: 2 }, (mono += 16));
		expect(p.overflowed).toBe(true);
		p.ack(id, { x: 0, y: 0 }, mono);
		expect(p.overflowed).toBe(false);
		for (let i = 0; i < 2; i++) id = p.command({ dx: 0 }, (mono += 16));
		p.ack(id, { x: 500, y: 0 }, mono);
		expect(p.correcting).toBe(false);
		const point = out();
		expect(p.renderInto(point, mono)).toBe(false);
		expect(point).toEqual({ x: 500, y: 0 });
	});

	for (const [name, rebase] of [
		['sync', (p) => p.sync({ x: 0, y: 0 }, 0)],
		['reset', (p) => p.reset()]
	]) {
		it(name + ' forgets the peak even when its slot was not overwritten', () => {
			const p = predictor();
			let mono = 1000;
			for (const dx of [2, 2, 2, 160]) p.command({ dx }, (mono += 16));
			expect(p.ack(4, { x: 166, y: 0 }, mono).divergence).toBe(0);
			rebase(p);
			let id = 0;
			for (let i = 0; i < 3; i++) id = p.command({ dx: 0 }, (mono += 16));
			p.ack(id, { x: 500, y: 0 }, mono);
			expect(p.correcting).toBe(false);
			const point = out();
			expect(p.renderInto(point, mono)).toBe(false);
			expect(point).toEqual({ x: 500, y: 0 });
		});
	}
});

function out() {
	return { x: 0, y: 0 };
}
