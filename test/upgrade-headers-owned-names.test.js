// The header names the handshake itself writes are not an application's to
// set on the 101: the server writes Connection, Upgrade and
// Sec-WebSocket-Accept on every upgrade and negotiates the two
// Sec-WebSocket-* offers, so an app value goes out BESIDE the server's line
// and a conforming client refuses the doubled handshake with nothing logged.
// The shared predicate refuses those names the way it refuses an unsafe
// byte, case-insensitively, and still accepts any other token.

import { describe, expect, it } from 'vitest';
import { findUnsafeUpgradeHeader, HANDSHAKE_OWNED_HEADER_NAMES } from '../src/runtime/utils/upgrade-headers.js';

describe('handshake-owned header names on a custom 101', () => {
	it('names the five headers the server writes or negotiates', () => {
		expect([...HANDSHAKE_OWNED_HEADER_NAMES]).toEqual([
			'connection', 'upgrade', 'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol'
		]);
		expect(Object.isFrozen(HANDSHAKE_OWNED_HEADER_NAMES)).toBe(true);
	});

	it('refuses each owned name in any spelling of case, naming the header', () => {
		for (const name of HANDSHAKE_OWNED_HEADER_NAMES) {
			for (const spelled of [name, name.toUpperCase(), name.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase())]) {
				const reason = findUnsafeUpgradeHeader({ [spelled]: 'x' });
				expect(reason, spelled + ' must be refused').not.toBeNull();
				expect(reason).toContain(JSON.stringify(spelled));
				expect(reason).toContain('belongs to the WebSocket handshake');
			}
		}
	});

	it('still accepts an application header beside them, and refuses the owned one first by position', () => {
		expect(findUnsafeUpgradeHeader({ 'x-session': 'abc', 'set-cookie': 'a=b' })).toBeNull();
		// The owned-name check sits after the token check: a name that is not
		// a token is refused for that first, an owned token for ownership.
		expect(findUnsafeUpgradeHeader({ 'bad name': 'x' })).toContain('not a valid RFC 7230 token');
		expect(findUnsafeUpgradeHeader({ 'x-ok': 'v', Upgrade: 'websocket' })).toContain('"Upgrade"');
	});
});
