import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { installProxyProtocol } from '../src/runtime/handler/proxy-protocol.js';

it('retains a TLS record behind ended responses while pipelining backpressure pauses reads', async () => {
	const certs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
	const wide = 'w'.repeat(128 * 1024);
	const order = [];
	const errors = [];
	const ended = [];
	let prior;
	let didPause = false;
	let paused;
	const pauseSeen = new Promise((resolve) => { paused = resolve; });
	const server = https.createServer({ key: fs.readFileSync(path.join(certs, 'localhost.key')), cert: fs.readFileSync(path.join(certs, 'localhost.crt')) }, (req, res) => {
		if (prior) ended.push(prior.writableEnded);
		prior = res;
		order.push(req.url);
		req.resume();
		const body = req.url === '/last' ? 'last' : wide;
		res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
		res.end(body);
	});
	installProxyProtocol(server);
	server.on('clientError', (error, socket) => { errors.push(error.code); socket.destroy(); });
	server.on('secureConnection', (socket) => {
		const pause = socket.pause;
		socket.pause = function () {
			if (this._paused) { didPause = true; paused(); }
			return pause.call(this);
		};
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	let capture = false;
	const captured = [];
	let upstream;
	let downstream;
	let packetReady;
	const havePacket = new Promise((resolve) => { packetReady = resolve; });
	// Forward the handshake normally, then combine both encrypted request
	// records into one TCP write. A record after the full 512-byte one is
	// the final short request, even if the handshake's last record precedes it.
	const relay = net.createServer((socket) => {
		downstream = socket;
		upstream = net.connect(server.address().port, '127.0.0.1');
		upstream.setNoDelay(true);
		socket.setNoDelay(true);
		upstream.pipe(socket);
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
		upstream.on('close', () => socket.destroy());
		socket.on('close', () => upstream.destroy());
		socket.on('data', (chunk) => {
			if (!capture) { upstream.write(chunk); return; }
			captured.push(chunk);
			const bytes = Buffer.concat(captured);
			let sawFull = false;
			for (let at = 0; at + 5 <= bytes.length;) {
				const length = bytes.readUInt16BE(at + 3);
				if (at + 5 + length > bytes.length) break;
				if (sawFull) packetReady();
				if (length >= 512) sawFull = true;
				at += 5 + length;
			}
		});
	});
	relay.listen(0, '127.0.0.1');
	await once(relay, 'listening');
	const client = tls.connect({ host: '127.0.0.1', port: relay.address().port, rejectUnauthorized: false });
	client.setNoDelay(true);
	expect(client.setMaxSendFragment(512)).toBe(true);
	let raw = '';
	let finished;
	const complete = new Promise((resolve) => { finished = resolve; });
	client.on('data', (chunk) => { raw += chunk.toString(); if (raw.endsWith('\r\n\r\nlast')) finished(); });
	client.on('error', () => {});
	const timeout = setTimeout(() => { client.destroy(); finished(); packetReady(); paused(); }, 3000);
	try {
		await once(client, 'secureConnect');
		client.pause();
		capture = true;
		const wire = (target, extra = '') => `GET ${target} HTTP/1.1\r\nHost:x\r\n${extra}\r\n`;
		const first = wire('/wide');
		const empty = wire('/queued', 'X-Pad:\r\n');
		const second = wire('/queued', `X-Pad:${'p'.repeat(512 - first.length - empty.length)}\r\n`);
		expect(first.length + second.length).toBe(512);
		client.write(first + second + wire('/last'));
		await havePacket;
		capture = false;
		upstream.write(Buffer.concat(captured));
		await pauseSeen;
		client.resume();
		await complete;
		expect(didPause).toBe(true);
		expect(ended).toEqual([true, true]);
		expect(errors).toEqual([]);
		expect(order).toEqual(['/wide', '/queued', '/last']);
		expect([...raw.matchAll(/HTTP\/1\.1 200/g)]).toHaveLength(3);
		expect(raw.split(wide)).toHaveLength(3);
	} finally {
		clearTimeout(timeout);
		client.destroy();
		upstream?.destroy();
		downstream?.destroy();
		server.closeAllConnections();
		await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => relay.close(resolve))]);
	}
});