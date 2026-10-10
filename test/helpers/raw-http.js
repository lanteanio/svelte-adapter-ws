import net from 'node:net';
import tls from 'node:tls';

/** Collect a bounded raw HTTP conversation, retaining whether the peer ended it. */
export function rawConversation(port, writes, { secure = false, wait = 250 } = {}) {
	return new Promise(resolve => {
		let raw = '';
		let settled = false;
		const socket = secure ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
		const timers = [];
		const finish = closed => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			socket.destroy();
			resolve({ raw, closed });
		};
		timers.push(setTimeout(() => finish(false), wait));
		socket.on('data', chunk => raw += chunk.toString('latin1'));
		socket.on('end', () => finish(true));
		socket.on('error', () => finish(true));
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			for (const [delay, bytes] of writes) timers.push(setTimeout(() => { if (!socket.destroyed) socket.write(bytes, 'latin1'); }, delay));
		});
	});
}
