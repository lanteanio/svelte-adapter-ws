// A closing connection leaves the live set before anything else is released.
//
// The close teardown runs a sequence of releases - the admission permit, the
// logical subscription accounting, the capability counts, the wire states, the
// send-gate slot. None of them is wrapped individually, so one throw anywhere
// in that sequence skips whatever follows it. While the removal from
// `wsConnections` sat at the END, "whatever follows" included the removal.
//
// A stranded connection is not a leak that sits still. Every publish walk keeps
// visiting a socket whose handle is gone, and its subscription registry keeps
// contributing to the consistency auditor's summed bookkeeping while the cap
// accountant has already released those memberships - which surfaces as a
// subscription-ledger mismatch that no double charge explains, permanently,
// because nothing ever removes the entry.
//
// The production module is built with substituted globals, so the ordering is
// pinned against the source the way every other guard in that module is - as a
// statement that must be its own line, so wrapping or neutralizing it fails
// rather than matching as a substring.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expectStatement } from './helpers/source-pins.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const realtime = readFileSync(path.join(ROOT, 'src/runtime/handler/realtime.js'), 'utf8');

/** The close teardown: from the app close-hook call to the end of the function. */
function closeTeardown() {
	const hookCall = realtime.indexOf('wsModule.close(facade, ctx);');
	expect(hookCall, 'the app close-hook call moved; this slice is anchored on it').toBeGreaterThan(-1);
	const end = realtime.indexOf('\n}', hookCall);
	expect(end, 'the close function does not end').toBeGreaterThan(hookCall);
	return realtime.slice(hookCall, end);
}

describe('the close path leaves the live set before it releases anything else', () => {
	it('removes the connection as its own statement', () => {
		expectStatement(closeTeardown(), 'wsConnections.delete(facade);', 'the close path removes the connection');
	});

	it('removes it before every release that could throw first', () => {
		// The point of the ordering, and the only thing that makes the removal
		// unskippable: each of these is unguarded, and each used to sit ahead of
		// the removal.
		const slice = closeTeardown();
		const removal = slice.indexOf('wsConnections.delete(facade);');
		for (const release of [
			'releaseConnectionPermitFor(userData);',
			'accountClosedLogicalSubscriptions(subs);',
			'capCounts.adjust(userData[WS_CAPS], null);',
			'detachWireStates(facade, userData);'
		]) {
			const at = slice.indexOf(release);
			expect(at, `${release} is no longer in the close teardown`).toBeGreaterThan(-1);
			expect(removal, `${release} runs before the connection leaves the live set`).toBeLessThan(at);
		}
	});

	it('removes it exactly once', () => {
		// Two removals would read as belt-and-braces and would hide a later edit
		// that moved the real one back down.
		const slice = closeTeardown();
		expect(slice.split('wsConnections.delete(facade)').length - 1).toBe(1);
	});
});
