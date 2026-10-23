// If-None-Match list syntax on the static lane. Weak comparison matches the
// selected representation's quoted tag with or without W/, and the list walk
// reads quoted members only: a member that is not a quoted tag, or a quoted
// tag followed by anything but a comma, ends the walk without a match, so a
// malformed list cannot resynchronize onto a later copy of the tag. Drives the
// built runtime's staticPreconditions; test/static-weak-etag-real.test.js
// covers the wire.

import { beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const TAG = 'W/"lx3k9-1f4"';
const OPAQUE = '"lx3k9-1f4"';

describe('static If-None-Match list syntax', () => {
	/** @type {any} */
	let staticPreconditions;
	const entry = { etag: TAG, lastModifiedMs: undefined, lastModified: undefined };
	const noneMatch = (/** @type {string} */ header) => staticPreconditions(entry, TAG, '', '', header, '');

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);
		({ staticPreconditions } = await import('./fixture/build/handler/static-assets.js'));
	}, 400000);

	it.each([
		TAG,
		OPAQUE,
		'*',
		'"other", ' + OPAQUE,
		'W/"other",W/"lx3k9-1f4"',
		'"other" ,\t' + OPAQUE,
		', , ' + OPAQUE + ' ,',
		'"a,b", ' + OPAQUE
	])('revalidates %s', (header) => {
		expect(noneMatch(header)).toBe(304);
	});

	it.each([
		['a member followed by more than a comma', '"x"y' + OPAQUE],
		['an unquoted member ahead of the tag', 'x", ' + OPAQUE],
		['an unquoted tag', 'lx3k9-1f4'],
		['a lowercase weak prefix', 'w/' + OPAQUE],
		['a space inside the weak prefix', 'W/ ' + OPAQUE],
		['a doubled weak prefix', 'W/W/' + OPAQUE],
		['the tag inside another tag', '"prefix,' + OPAQUE + ',suffix"'],
		['an unclosed member', '"other", "lx3k9-1f4'],
		['a different case', OPAQUE.toUpperCase()]
	])('does not revalidate %s', (_name, header) => {
		expect(noneMatch(header)).toBe(0);
	});

	it('keeps If-Match exact: the opaque tag without W/ fails', () => {
		expect(staticPreconditions(entry, TAG, OPAQUE, '', '', '')).toBe(412);
		expect(staticPreconditions(entry, TAG, TAG, '', '', '')).toBe(0);
	});
});
