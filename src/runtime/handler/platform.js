// The base `platform` object exposed to SvelteKit as `event.platform`.
//
// Per-request (and later per-connection) platforms are created with
// `Object.create(platform)` so getters stay live and keys installed by
// sibling packages reach every clone through the prototype chain - a flat
// spread would freeze them to their value at clone time. The object stays
// extensible for the same reason.
//
// The realtime surface (publish, send, subscribe, pressure, ...) attaches
// here as its lanes land; what exists today is the transport-independent
// request-facing core.

import { now, monotonicNow, randomFloat, randomU32, randomUuid, randomBytes } from '../runtime.js';
import { isWarmupRequest } from './warmup-registry.js';

export const platform = {
	/**
	 * Whether `request` is a synthetic boot-warmup render rather than a real
	 * client request. Tagged by object identity, so a client cannot forge one.
	 * @param {Request} request
	 * @returns {boolean}
	 */
	isWarmupRequest,

	/** Wall-clock ms, ~1s precision, one variable read. */
	now,

	/** Strictly-forward monotonic ms for duration math. */
	monotonic: monotonicNow,

	/** Seam-routed randomness, replayable under a seeded harness. */
	random: {
		float: randomFloat,
		u32: randomU32,
		uuid: randomUuid,
		bytes: randomBytes
	}
};
