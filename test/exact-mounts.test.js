// The catch-all asks entersExactMount of the raw target and of each reading of
// it (resolved, decoded). The set holds the paths the adapter answers exactly
// as spelled; the end-to-end cases live in request-target-real.test.js.

import { describe, it, expect } from 'vitest';
import { addExactMount, entersExactMount } from '../src/runtime/handler/exact-mounts.js';

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
