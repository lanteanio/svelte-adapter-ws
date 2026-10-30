// The catch-all asks entersExactMount of the raw target and of each reading of
// it (resolved, decoded). The set holds the paths the adapter answers exactly
// as spelled; the end-to-end cases live in request-target-real.test.js.

import { describe, it, expect } from 'vitest';
import { addExactMount, entersExactMount, entersPlainMount } from '../src/runtime/handler/exact-mounts.js';

addExactMount('/probe');
addExactMount('/probe.json');
addExactMount('/');

describe('entersExactMount', () => {
	it('holds a reading of the target that lands on an exact mount it does not spell', () => {
		expect(entersExactMount('/probe', '/x/../probe')).toBe(true);
		expect(entersExactMount('/probe', '/%70robe')).toBe(true);
		expect(entersExactMount('/probe.json', '/x/../probe.json')).toBe(true);
	});

	it('never holds the direct spelling, which reaches the catch-all only for a method the mount does not answer', () => {
		expect(entersExactMount('/probe', '/probe')).toBe(false);
		expect(entersExactMount('/probe.json', '/probe.json')).toBe(false);
	});

	it('reads a data or route-resolution request as the path in front of its suffix', () => {
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json')).toBe(true);
		expect(entersExactMount('/probe/__route.js', '/probe/__route.js')).toBe(true);
		expect(entersExactMount('/__data.json', '/__data.json'), 'the root page').toBe(true);
		expect(entersExactMount('/other/__data.json', '/other/__data.json')).toBe(false);
		expect(entersExactMount('/probe.html__data.json', '/probe.html__data.json'), 'reads as /probe.html').toBe(false);
	});

	it('reads a trailing slash as the page\'s own, as SvelteKit rebuilds it', () => {
		// `/probe/` is a page of its own - the mount is never matched for it -
		// and a data request carries that slash in a query parameter.
		expect(entersExactMount('/probe/', '/probe/')).toBe(false);
		expect(entersExactMount('/probe//__data.json', '/probe//__data.json')).toBe(false);
		expect(entersExactMount('/probe//__route.js', '/probe//__route.js')).toBe(false);
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-trailing-slash=1')).toBe(false);
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=%31'), 'decoded as URLSearchParams decodes').toBe(false);
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json', 'x-sveltekit-invalidated=01')).toBe(true);
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json', 'xx-sveltekit-trailing-slash=1'), 'another parameter').toBe(true);
		expect(entersExactMount('/probe/__data.json', '/probe/__data.json', '?x-sveltekit-trailing-slash=1'), 'a second `?` belongs to the name').toBe(true);
		addExactMount('/slashed/');
		expect(entersExactMount('/slashed/__data.json', '/slashed/__data.json', 'x-sveltekit-trailing-slash=1'), 'a mount spelled with its slash').toBe(true);
		expect(entersExactMount('/slashed/__data.json', '/slashed/__data.json')).toBe(false);
	});
});

describe('entersExactMount with mounts spelled with escapes', () => {
	// An escaped mount is matched only as written; the catch-all judges other
	// spellings by the decoded path they share with it.
	addExactMount('/files/x%20y');
	addExactMount('/gesundheit-pr%C3%BCfung');
	addExactMount('/a%22b');
	addExactMount('/odd%25zz');
	addExactMount('/status:ready');

	it('holds another spelling of the same decoded path, and never the mount\'s own', () => {
		expect(entersExactMount('/gesundheit-pr%c3%bcfung', '/gesundheit-pr%c3%bcfung'), 'lowercase hex').toBe(true);
		expect(entersExactMount('/a"b', '/a"b'), 'the raw character, no escape at all').toBe(true);
		expect(entersExactMount('/gesundheit-pr%C3%BCfung/__data.json', '/gesundheit-pr%C3%BCfung/__data.json'), 'its data').toBe(true);
		expect(entersExactMount('/gesundheit-pr%C3%BCfung', '/gesundheit-pr%C3%BCfung')).toBe(false);
		expect(entersExactMount('/files/x%20y', '/files/x%20y')).toBe(false);
	});

	it('does not hold a path that only decodes to the mount\'s spelling', () => {
		expect(entersExactMount('/files/x%2520y', '/files/x%2520y')).toBe(false);
		expect(entersExactMount('/gesundheit-pr%25C3%25BCfung', '/gesundheit-pr%25C3%25BCfung')).toBe(false);
		// The catch-all's own ASCII-decoded reading is checked against plain
		// mounts only.
		expect(entersPlainMount('/files/x%20y', '/files/x%2520y')).toBe(false);
	});

	it('decodes each run of escapes on its own, so a malformed one does not hide the rest', () => {
		expect(entersExactMount('/odd%zz', '/odd%zz'), 'a target reading as the mount with its bad escape kept').toBe(true);
	});

	it('treats a colon inside a segment as part of a plain mount', () => {
		expect(entersExactMount('/status:ready', '/x/../status:ready')).toBe(true);
	});
});
