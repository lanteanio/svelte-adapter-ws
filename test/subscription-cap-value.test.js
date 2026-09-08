// The subscriptions-per-connection ceiling is a number the family agrees on,
// not a value this repo may drift: 65,536. The other cases that drive the
// cap import the constant and would follow a silent bump, so the literal is
// pinned here, in the source and at the seam the refusal reads it from.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../src/runtime/utils/caps.js';
import { exceedsSubscriptionCap } from '../src/runtime/utils/subscribe-policy.js';

describe('the subscriptions-per-connection ceiling', () => {
	it('is 65,536, the family value, and the source says so', () => {
		expect(MAX_SUBSCRIPTIONS_PER_CONNECTION).toBe(65_536);
		const source = readFileSync(new URL('../src/runtime/utils/caps.js', import.meta.url), 'utf8');
		expect(source).toContain('export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 65_536;');
	});

	it('admits the 65,536th subscription and refuses the 65,537th, with nothing held lost', () => {
		const max = MAX_SUBSCRIPTIONS_PER_CONNECTION;
		// A new topic on a connection one short of the cap lands; one at the
		// cap is refused; a topic the connection already holds is never
		// counted against it.
		expect(exceedsSubscriptionCap({ held: false, size: max - 1, max })).toBe(false);
		expect(exceedsSubscriptionCap({ held: false, size: max, max })).toBe(true);
		expect(exceedsSubscriptionCap({ held: true, size: max, max })).toBe(false);
	});
});
