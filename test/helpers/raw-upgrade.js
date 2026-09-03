import net from 'node:net';

/**
 * Drive a handshake the `ws` client cannot express - a repeated singleton
 * header, a bad version, a non-GET - and resolve the status line the peer got
 * back. The socket is written raw because the point is usually a request the
 * client library would refuse to send in the first place.
 *
 * Resolves the empty string when the peer answers nothing at all, so a caller
 * asserting on a status line fails on the assertion rather than hanging.
 *
 * @param {number} port
 * @param {string[]} lines - request line and headers, without the blank line
 * @returns {Promise<string>} the response status line
 */
export function rawUpgrade(port, lines) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(lines.join('\r\n') + '\r\n\r\n');
		});
		let data = '';
		socket.on('data', (chunk) => { data += chunk.toString(); });
		const done = () => resolve(data.split('\r\n')[0] || '');
		socket.on('close', done);
		socket.on('error', () => resolve(''));
		setTimeout(() => { socket.destroy(); done(); }, 1500);
	});
}
