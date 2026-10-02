// Per-connection traffic counters surfaced via CloseContext. Populated only
// when the app exports a `close` hook - the only place they surface - so the
// unhooked hot path pays one boolean read per frame.

import { WS_STATS } from '../utils/ws-symbols.js';

let statsEnabled = false;

/** @param {boolean} enabled */
export function setStatsEnabled(enabled) {
	statsEnabled = enabled;
}

export function statsAreEnabled() {
	return statsEnabled;
}

/**
 * The per-connection stats slot for the handler runtime. Built in one place so
 * a caller that seeds it by hand cannot describe a connection this runtime
 * never produces: a slot missing a field reads as 0 + undefined rather than as
 * the miscount it is. The test server and the dev server build their own.
 * @param {number} openedAt
 */
export function createConnStats(openedAt) {
	return {
		openedAt,
		messagesIn: 0,
		messagesOut: 0,
		bytesIn: 0,
		bytesOut: 0
	};
}

/**
 * @param {any} userData
 * @param {string | ArrayBuffer | Uint8Array} payload
 */
export function bumpIn(userData, payload) {
	if (!statsEnabled) return;
	const stats = userData?.[WS_STATS];
	if (!stats) return;
	stats.messagesIn++;
	stats.bytesIn += typeof payload === 'string' ? payload.length : payload.byteLength;
}

/**
 * @param {any} userData
 * @param {string | ArrayBuffer | Uint8Array} payload
 */
export function bumpOut(userData, payload) {
	if (!statsEnabled) return;
	const stats = userData?.[WS_STATS];
	if (!stats) return;
	stats.messagesOut++;
	// Bytes for a binary frame, UTF-16 code units for a text one: an exact UTF-8
	// count would scan every frame on every send. The unit is documented on
	// CloseContext.bytesOut.
	stats.bytesOut += typeof payload === 'string' ? payload.length : payload.byteLength;
}
