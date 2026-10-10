import { once } from 'node:events';
import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { beginHttpRead, endHttpRead, endParserRefusal } from '../src/runtime/handler/read-turn.js';

it('discards held replies when another read arrives before a terminal refusal drains', async () => {
	const written = [];
	let drainRefusal;
	const socket = new Writable({
		write(chunk, encoding, callback) {
			written.push(chunk.toString());
			if (chunk.toString() === 'terminal refusal') drainRefusal = callback;
			else callback();
		}
	});
	try {
		beginHttpRead(socket);
		socket.write('earlier reply');
		endParserRefusal(socket, 'terminal refusal');
		expect(written).toEqual(['terminal refusal']);

		// The transport can deliver another read while its refusal write is pending.
		beginHttpRead(socket);
		endHttpRead(socket);
		expect(written).toEqual(['terminal refusal']);

		const closed = once(socket, 'close');
		drainRefusal();
		await closed;
		expect(written).toEqual(['terminal refusal']);
	} finally {
		socket.destroy();
	}
});