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

it.each(['complete', 'error', 'closed'])('waits for a previous transport write to %s before a held refusal', async outcome => {
	const written = [];
	const callbacks = [];
	const errors = [];
	let completed = 0;
	const socket = new Writable({
		write(chunk, encoding, callback) {
			written.push(chunk.toString());
			callbacks.push(callback);
		}
	});
	socket.on('error', error => errors.push(error));
	try {
		socket.write('committed reply', () => { completed++; });
		beginHttpRead(socket);
		socket.write('held reply');
		endParserRefusal(socket, 'terminal refusal');
		expect(written).toEqual(['committed reply']);
		const closed = new Promise(resolve => socket.once('close', resolve));
		if (outcome === 'closed') socket.destroy();
		const failure = outcome === 'error' ? new Error('transport write failed') : null;
		callbacks.shift()(failure);
		expect(completed).toBe(1);
		if (outcome === 'complete') {
			expect(written).toEqual(['committed reply', 'terminal refusal']);
			callbacks.shift()();
		} else expect(written).toEqual(['committed reply']);
		await closed;
		expect(errors).toEqual(failure ? [failure] : []);
	} finally {
		socket.destroy();
	}
});
