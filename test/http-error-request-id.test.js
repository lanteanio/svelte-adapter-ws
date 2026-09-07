import { describe, expect, it } from 'vitest';
import { send500 } from '../src/runtime/handler/http-helpers.js';

describe('owned HTTP 500 request correlation', () => {
	it('echoes the resolved request id without changing the body', () => {
		const calls = [];
		// node:http's response: one writeHead carries the status and the headers.
		const res = {
			writeHead(status, headers) {
				calls.push(['status', status]);
				for (const [name, value] of Object.entries(headers)) calls.push(['header', name, value]);
			},
			end(value) { calls.push(['end', value]); }
		};

		send500(/** @type {any} */ (res), 'request-500');

		expect(calls).toContainEqual(['header', 'x-request-id', 'request-500']);
		expect(calls.at(-1)).toEqual(['end', 'Internal Server Error']);
	});

	it('does not invent a response header when no id is available', () => {
		const headers = [];
		const res = {
			writeHead(status, h) { for (const [name, value] of Object.entries(h)) headers.push([name, value]); },
			end() {}
		};

		send500(/** @type {any} */ (res));

		// content-length is node:http framing for the fixed body, not an invented header.
		expect(headers).toEqual([['content-type', 'text/plain'], ['content-length', '21']]);
	});
});
