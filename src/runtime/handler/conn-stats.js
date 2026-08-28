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
 * @param {any} userData
 * @param {string | ArrayBuffer | Uint8Array} payload
 */
export function bumpIn(userData, payload) {
	if (!statsEnabled) return;
	const stats = userData?.[WS_STATS];
	if (!stats) return;
	stats.messagesIn++;
	stats.bytesIn += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
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
	stats.bytesOut += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
}
