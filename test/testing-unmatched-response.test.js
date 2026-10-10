import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../src/testing.js';

const HTML = '<html><body><h1>File Not Found</h1><hr><i>uWebSockets/20 Server</i></body></html>';
let server;
afterEach(async () => { await server?.close(); server = null; });

/** Read payload bytes on HEAD only when the requested route writes them. */
function exchange(port, requests) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		const answers = [];
		let buffer = Buffer.alloc(0);
		let sent = 0;
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('incomplete unmatched-route response'));
		}, 3000);
		const send = () => {
			const request = requests[sent++];
			const lines = [request.line, `Host: 127.0.0.1:${port}`, ...(request.headers || [])];
			if (sent === requests.length) lines.push('Connection: close');
			socket.write(lines.join('\r\n') + '\r\n\r\n');
		};
		socket.once('connect', send);
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf('\r\n\r\n');
			if (end < 0) return;
			const [status, ...headers] = buffer.toString('latin1', 0, end).split('\r\n');
			const declared = headers.find(line => /^content-length: /i.test(line));
			const length = requests[answers.length].noBody ? 0 : Number(declared?.slice(declared.indexOf(':') + 1));
			if (!Number.isSafeInteger(length) || length < 0) {
				clearTimeout(timer); socket.destroy(); reject(new Error('missing or invalid response length')); return;
			}
			if (buffer.length < end + 4 + length) return;
			answers.push({ status, headers: headers.map(line => line.toLowerCase()), body: buffer.subarray(end + 4, end + 4 + length).toString() });
			buffer = buffer.subarray(end + 4 + length);
			if (answers.length < requests.length) send();
		});
		socket.on('error', error => { clearTimeout(timer); reject(error); });
		socket.on('close', () => {
			clearTimeout(timer);
			if (answers.length !== requests.length || buffer.length !== 0) reject(new Error('response sequence was truncated or carried extra bytes'));
			else resolve(answers);
		});
	});
}

function expectMissing(answer) {
	expect(answer.status).toBe('HTTP/1.1 404 File Not Found');
	expect(answer.body).toBe(HTML);
	expect(answer.headers).toContain(`content-length: ${Buffer.byteLength(HTML)}`);
	expect(answer.headers.some(line => line.startsWith('content-type:'))).toBe(false);
	expect(answer.headers.some(line => line.startsWith('transfer-encoding:'))).toBe(false);
}

describe('unmatched test-server responses on the wire', () => {
	for (const line of [
		'GET /missing HTTP/1.1',
		'HEAD /missing HTTP/1.1',
		'POST /missing?query=1 HTTP/1.1',
		'OPTIONS /missing HTTP/1.1',
		'GET /ws HTTP/1.1',
		'GET /ws?query=1 HTTP/1.1',
		'HEAD /ws HTTP/1.1',
		'GET /ws/ HTTP/1.1'
	]) {
		it(line + ' keeps the complete fallback body and connection framing', async () => {
			server = await createTestServer();
			const [missing, health] = await exchange(server.port, [
				{ line }, { line: 'GET /healthz HTTP/1.1' }
			]);
			expectMissing(missing);
			expect(missing.headers).not.toContain('connection: close');
			expect(health.status).toBe('HTTP/1.1 200 OK');
			expect(health.body).toBe('OK');
		});
	}

	it('sends the complete HEAD fallback before a requested connection close', async () => {
		server = await createTestServer();
		const [answer] = await exchange(server.port, [{ line: 'HEAD /missing HTTP/1.1' }]);
		expectMissing(answer);
	});

	it('keeps registered HEAD responses bodyless, including an application 404', async () => {
		server = await createTestServer({ handler: {
			admin: () => new Response('application missing', { status: 404, headers: { 'content-type': 'text/plain' } })
		} });
		const [health, admin, get] = await exchange(server.port, [
			{ line: 'HEAD /healthz HTTP/1.1', noBody: true },
			{ line: 'HEAD /__realtime/missing HTTP/1.1', noBody: true },
			{ line: 'GET /__realtime/missing HTTP/1.1' }
		]);
		expect(health.status).toBe('HTTP/1.1 200 OK');
		expect(health.body).toBe('');
		expect(health.headers).toContain('content-length: 2');
		expect(admin.body).toBe('');
		expect(admin.headers).toContain('content-length: 19');
		expect(get.body).toBe('application missing');
		expect(get.headers).toContain('content-type: text/plain');
	});

	it('retains the configured WebSocket navigation answer ahead of the fallback', async () => {
		server = await createTestServer({ upgradeAdmission: { maxConcurrent: 1 } });
		const [navigation, head] = await exchange(server.port, [
			{ line: 'GET /ws HTTP/1.1' }, { line: 'HEAD /ws HTTP/1.1' }
		]);
		expect(navigation.status).toBe('HTTP/1.1 426 Upgrade Required');
		expect(navigation.body).toBe('WebSocket upgrade required');
		expectMissing(head);
	});
});
