// The pre-parsed envelope createTestServer hands the app message hook.
//
// `MessageContext.msg` carries a plain object envelope and is absent for an
// array, null or a primitive. The harness asks the shared policy
// (carriesPreParsedEnvelope) the way production and the dev plugin do;
// message-envelope-shape-real.test.js pins production, and this pins the
// harness's own demux, which is separate code.

import { describe, it, expect } from 'vitest';

describe('the harness pre-parsed envelope', () => {
	it('is absent for a JSON array and present for an object envelope no control type claims', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({
			handler: {
				message(ws, ctx) {
					let raw;
					try { raw = JSON.parse(Buffer.from(ctx.data).toString()); } catch { return; }
					const nonce = Array.isArray(raw) ? raw[0]?.nonce : raw?.nonce;
					ctx.platform.send(ws, 'shape', 'envelope-shape', {
						nonce,
						present: ctx.msg !== undefined,
						isArray: Array.isArray(ctx.msg)
					});
				}
			}
		});
		try {
			const { WebSocket } = await import('ws');
			const ws = new WebSocket(server.wsUrl);
			/** @type {any[]} */
			const frames = [];
			ws.on('message', (d, isBinary) => {
				if (isBinary) return;
				try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ }
			});
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
			// Byte 3 is `y` in both frames, so each takes the control prefix
			// path and reaches the parse; the shape alone decides the answer.
			ws.send('[{"y":1,"nonce":"array"}]');
			ws.send('{"type":"envelope-shape-probe","nonce":"object"}');
			const deadline = Date.now() + 5000;
			while (frames.filter((f) => f.topic === 'shape').length < 2 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			const byNonce = Object.fromEntries(frames.filter((f) => f.topic === 'shape').map((f) => [f.data.nonce, f.data]));
			expect(byNonce.array, 'an array frame reaches the hook').toBeDefined();
			expect(byNonce.array.present, 'an array arrives with no envelope').toBe(false);
			expect(byNonce.array.isArray).toBe(false);
			expect(byNonce.object, 'an unclaimed object envelope reaches the hook').toBeDefined();
			expect(byNonce.object.present, 'an unclaimed object envelope still arrives as msg').toBe(true);
			ws.terminate();
		} finally {
			await server.close();
		}
	}, 30000);
});
