// Empirical probe of every node:http + ws behavior this adapter's design relies
// on. Run with `node probe/ws-api-facts.mjs`; it writes
// probe/ws-api-facts.report.md next to itself. The report is committed so a
// Node or ws upgrade that changes an observed behavior shows up as a diff.
//
// Design rules:
// - every probe is isolated: its own server on an ephemeral port, its own
//   clients, teardown in finally. One failing probe never blocks the rest.
// - probes record what was OBSERVED, never what was expected. Interpretation
//   happens in the adapter design docs, not here.
// - anything that cannot be probed automatically (e.g. TLS SNI without certs)
//   is recorded as MANUAL so the report stays a complete checklist.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const findings = [];
const HOST = '127.0.0.1';

function record(section, question, observed) {
	findings.push({ section, question, observed: String(observed) });
	console.log(`[${section}] ${question}\n    -> ${observed}`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
	let timer;
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// A node:http server with a ws server mounted in noServer mode - the shape the
// adapter will use, because the HTTP half owns the request listener.
async function serveWs({ wssOptions = {}, onUpgrade = null, onConnection = null } = {}) {
	const state = { sockets: [], messages: [], closes: [], pongs: [], errors: [] };
	const http = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('http-ok');
	});
	const wss = new WebSocketServer({ noServer: true, ...wssOptions });

	http.on('upgrade', (req, socket, head) => {
		const done = (ws) => {
			state.sockets.push(ws);
			ws.on('message', (data, isBinary) => state.messages.push({ data, isBinary }));
			ws.on('close', (code, reason) => state.closes.push({ code, reason: reason.toString() }));
			ws.on('pong', (data) => state.pongs.push(data.toString()));
			// A server socket that emits 'error' with no listener takes the
			// process down (an over-limit frame does exactly that), which would
			// end the run before the report is written.
			ws.on('error', (err) => state.errors.push(`${err.code || err.name}: ${err.message}`));
			if (onConnection) onConnection(ws, req);
		};
		if (onUpgrade) {
			onUpgrade({ req, socket, head, complete: () => wss.handleUpgrade(req, socket, head, done) });
		} else {
			wss.handleUpgrade(req, socket, head, done);
		}
	});

	await new Promise((resolve) => http.listen(0, HOST, resolve));
	let closed = false;
	return {
		port: http.address().port,
		http,
		wss,
		state,
		firstSocket: () => state.sockets[0],
		async close() {
			if (closed) return;
			closed = true;
			for (const ws of state.sockets) {
				try { ws.terminate(); } catch {}
			}
			wss.close();
			// Bounded: http.close() hangs on any connection still open, and a
			// probe that leaves one behind must not stall the whole run.
			await Promise.race([
				new Promise((resolve) => http.close(() => resolve())),
				sleep(1000).then(() => http.closeAllConnections && http.closeAllConnections())
			]);
		}
	};
}

function openClient(server, { protocols, path = '/', headers } = {}) {
	return withTimeout(new Promise((resolve, reject) => {
		const url = `ws://${HOST}:${server.port}${path}`;
		const client = protocols
			? new WebSocket(url, protocols, { headers })
			: new WebSocket(url, { headers });
		client.binaryType = 'arraybuffer';
		client.on('open', () => resolve(client));
		client.on('error', (e) => reject(new Error(`client error: ${e.message || 'unknown'}`)));
	}), 3000, 'client open');
}

function closeEvent(client) {
	return withTimeout(new Promise((resolve) => {
		client.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
	}), 4000, 'client close event');
}

async function run(name, fn) {
	try {
		await fn();
	} catch (err) {
		record(name, 'PROBE CRASHED', `${err && err.message}`);
	}
}

// --- send results and backpressure ------------------------------------------
// The adapter's platform.send returns a uWS-shaped tri-state. node-ws send()
// returns nothing, so the facade has to synthesize it from what IS observable.
await run('send-and-backpressure', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		const ws = server.firstSocket();

		record('send-and-backpressure', 'ws.send() return value', JSON.stringify(ws.send('ping')));
		record('send-and-backpressure', 'bufferedAmount right after a small send', ws.bufferedAmount);

		const order = [];
		await new Promise((resolve) => {
			ws.send('with-callback', () => { order.push('callback'); resolve(); });
			order.push('send-returned');
		});
		record('send-and-backpressure', 'send(data, cb) - observed order', JSON.stringify(order));

		// Grow the buffer the way a slow consumer does: stop reading on the
		// client, then burst.
		client.pause();
		const payload = Buffer.alloc(1024 * 1024, 0x61);
		const samples = [];
		for (let i = 0; i < 24; i++) {
			ws.send(payload);
			if (i % 8 === 0) samples.push(`${i}:${ws.bufferedAmount}`);
		}
		record('send-and-backpressure', 'bufferedAmount during a 24x1MiB burst (iteration:value)', JSON.stringify(samples));
		record('send-and-backpressure', 'bufferedAmount unit', ws.bufferedAmount > 1000 ? 'bytes (grew past 1000 on MiB frames)' : `unclear, ended at ${ws.bufferedAmount}`);

		let drained = false;
		ws.send('drain-probe', () => { drained = true; });
		client.resume();
		for (let i = 0; i < 60 && !drained; i++) await sleep(25);
		record('send-and-backpressure', 'does the send callback fire once the peer reads (a drain signal)', drained ? 'yes' : 'NO - not within 1.5s');
		record('send-and-backpressure', 'bufferedAmount after the peer drained', ws.bufferedAmount);

		client.close();
	} finally {
		await server.close();
	}
});

// --- closed-socket behavior -------------------------------------------------
// The throw-on-closed contract: extensions drives its WsClosedError rollback off
// a raw socket call THROWING. Whatever this records, the facade must reproduce
// the uWS semantics.
await run('closed-socket', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		const ws = server.firstSocket();
		client.close();
		await sleep(150);

		record('closed-socket', 'readyState after the client closed', `${ws.readyState} (CLOSED=${WebSocket.CLOSED})`);

		let threw = 'did NOT throw';
		try { ws.send('after-close'); } catch (err) { threw = `THREW ${err.constructor.name}: ${err.message}`; }
		record('closed-socket', 'ws.send() on a closed socket', threw);

		let cbErr = 'callback never fired';
		await new Promise((resolve) => {
			ws.send('after-close-cb', (err) => { cbErr = err ? `error: ${err.message}` : 'no error'; resolve(); });
			setTimeout(resolve, 500);
		});
		record('closed-socket', 'send(data, cb) on a closed socket reports', cbErr);
		record('closed-socket', 'bufferedAmount on a closed socket', ws.bufferedAmount);

		let pingThrew = 'did NOT throw';
		try { ws.ping(); } catch (err) { pingThrew = `THREW: ${err.message}`; }
		record('closed-socket', 'ws.ping() on a closed socket', pingThrew);

		let closeThrew = 'did NOT throw';
		try { ws.close(); } catch (err) { closeThrew = `THREW: ${err.message}`; }
		record('closed-socket', 'ws.close() on an already closed socket', closeThrew);
	} finally {
		await server.close();
	}
});

// --- native pub/sub surface -------------------------------------------------
await run('pubsub-surface', async () => {
	const server = await serveWs();
	try {
		await openClient(server);
		const ws = server.firstSocket();
		const uwsNames = ['subscribe', 'unsubscribe', 'publish', 'isSubscribed', 'getTopics', 'cork', 'getBufferedAmount'];
		const present = uwsNames.filter((n) => typeof ws[n] === 'function');
		record('pubsub-surface', 'uWS socket methods present on a ws socket', present.length ? JSON.stringify(present) : 'NONE - every one of them is facade work');
		record('pubsub-surface', 'a publish()/topic surface on WebSocketServer', typeof server.wss.publish === 'function' ? 'has publish()' : 'absent - fan-out is a JS registry walk');
		const raw = ws._socket;
		record('pubsub-surface', 'underlying net.Socket reachable for cork/writev', raw && typeof raw.cork === 'function' ? 'yes, via the private _socket field' : 'no');
	} finally {
		await server.close();
	}
});

// --- upgrade flow -----------------------------------------------------------
await run('upgrade-flow', async () => {
	const server = await serveWs({
		onUpgrade: async ({ req, socket, complete }) => {
			// Await BEFORE completing the handshake - the shape an async auth
			// check needs. Records whether the socket survives the await.
			await sleep(30);
			if (req.url === '/reject') { socket.destroy(); return; }
			complete();
		}
	});
	try {
		const client = await openClient(server, { path: '/late' });
		record('upgrade-flow', 'handshake completed after an await before handleUpgrade', client.readyState === WebSocket.OPEN ? 'yes - the socket survived the await' : `no, readyState ${client.readyState}`);
		client.close();

		let rejected = 'connected anyway';
		try {
			await openClient(server, { path: '/reject' });
		} catch (err) {
			rejected = `refused: ${err.message}`;
		}
		record('upgrade-flow', 'destroying the socket mid-upgrade', rejected);
	} finally {
		await server.close();
	}
});

await run('upgrade-headers', async () => {
	const server = await serveWs({
		wssOptions: { handleProtocols: (protocols) => (protocols.has('v2') ? 'v2' : false) }
	});
	try {
		const client = await openClient(server, { protocols: ['v1', 'v2'] });
		record('upgrade-headers', 'subprotocol chosen by handleProtocols', JSON.stringify(client.protocol));
		client.close();
	} finally {
		await server.close();
	}
});

// --- payload limits, compression, ping --------------------------------------
await run('limits-and-compression', async () => {
	const limited = await serveWs({ wssOptions: { maxPayload: 1024 } });
	try {
		const client = await openClient(limited);
		const closed = closeEvent(client);
		client.send(Buffer.alloc(4096, 0x62));
		const ev = await closed.catch((e) => ({ code: `no close event: ${e.message}`, reason: '' }));
		record('limits-and-compression', 'close code when a client frame exceeds maxPayload', `${ev.code} ${JSON.stringify(ev.reason)}`);
		record('limits-and-compression', 'what the server socket reports for that frame', limited.state.errors.length ? limited.state.errors[0] : 'no error event on the server socket');
	} finally {
		await limited.close();
	}

	const deflate = await serveWs({ wssOptions: { perMessageDeflate: { threshold: 0 } } });
	try {
		const client = await openClient(deflate);
		record('limits-and-compression', 'perMessageDeflate negotiated with the client', client.extensions ? JSON.stringify(client.extensions) : 'no extensions negotiated');
		let perMessage = 'accepted';
		try { deflate.firstSocket().send('x', { compress: false }); } catch (err) { perMessage = `THREW: ${err.message}`; }
		record('limits-and-compression', 'per-message { compress: false } option', perMessage);
		client.close();
	} finally {
		await deflate.close();
	}
});

await run('ping-and-idle', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		server.firstSocket().ping('probe');
		for (let i = 0; i < 40 && server.state.pongs.length === 0; i++) await sleep(25);
		record('ping-and-idle', 'the client answered a server ping', server.state.pongs.length ? `yes, payload ${JSON.stringify(server.state.pongs[0])}` : 'NO pong within 1s');

		const probe = new WebSocketServer({ noServer: true });
		const opts = Object.keys(probe.options || {});
		record('ping-and-idle', 'a built-in idleTimeout option on WebSocketServer', opts.includes('idleTimeout') ? 'present' : 'ABSENT - the idle timer is adapter work (JS timer plus ping/pong)');
		probe.close();
		client.close();
	} finally {
		await server.close();
	}
});

// --- message buffer lifetime ------------------------------------------------
await run('message-buffer', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		client.send(Buffer.from([1, 2, 3, 4]));
		client.send('text-frame');
		for (let i = 0; i < 40 && server.state.messages.length < 2; i++) await sleep(25);
		const [binary, text] = server.state.messages;
		record('message-buffer', 'a binary frame arrives as', binary ? `${binary.data.constructor.name}, isBinary=${binary.isBinary}` : 'nothing received');
		record('message-buffer', 'a text frame arrives as', text ? `${text.data.constructor.name}, isBinary=${text.isBinary}` : 'nothing received');

		const before = binary ? Buffer.from(binary.data).toString('hex') : '';
		client.send(Buffer.from([9, 9, 9, 9]));
		for (let i = 0; i < 40 && server.state.messages.length < 3; i++) await sleep(25);
		const after = binary ? Buffer.from(binary.data).toString('hex') : '';
		record('message-buffer', 'is the first frame buffer mutated by a later frame', before && before === after ? `no, still ${after}` : `MUTATED: ${before} -> ${after}`);
		client.close();
	} finally {
		await server.close();
	}
});

// --- prototype patchability -------------------------------------------------
await run('prototype-patch', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		let patched = 'failed';
		try {
			Object.defineProperty(WebSocket.prototype, '__probeStamp', { value: () => 'stamped', configurable: true });
			patched = typeof server.firstSocket().__probeStamp === 'function'
				? `visible on a live socket, returns ${server.firstSocket().__probeStamp()}`
				: 'defined but not visible on a live socket';
		} catch (err) {
			patched = `THREW: ${err.message}`;
		}
		record('prototype-patch', 'ws.WebSocket.prototype accepts a new method', patched);

		const later = await openClient(server);
		record('prototype-patch', 'the stamp is visible on a socket opened afterwards', typeof server.state.sockets[1].__probeStamp === 'function' ? 'yes' : 'no');
		delete WebSocket.prototype.__probeStamp;
		client.close();
		later.close();
	} finally {
		await server.close();
	}
});

// --- shutdown drain ---------------------------------------------------------
await run('shutdown-drain', async () => {
	const server = await serveWs();
	try {
		const client = await openClient(server);
		const ws = server.firstSocket();
		// http.close() waits for every connection to end, and a live WebSocket
		// is one - so this callback may never fire. Race it rather than await
		// it, because whether it fires IS the finding.
		let closeCallbackFired = false;
		server.http.close(() => { closeCallbackFired = true; });
		await sleep(300);
		record('shutdown-drain', 'http.close() callback fired while a WebSocket was open', closeCallbackFired ? 'yes' : 'NO - the callback waits on the live socket, so shutdown must close sockets itself');
		record('shutdown-drain', 'WebSocket readyState after http.close()', `${ws.readyState} (OPEN=${WebSocket.OPEN})`);

		let echoed = false;
		const heard = new Promise((resolve) => client.on('message', () => { echoed = true; resolve(); }));
		ws.send('after-http-close');
		await Promise.race([heard, sleep(500)]);
		record('shutdown-drain', 'a send still reaches the client after http.close()', echoed ? 'yes - live sockets survive the HTTP close, so a managed drain is adapter work' : 'no');
		client.close();
	} finally {
		await server.close();
	}
});

// --- listen options ---------------------------------------------------------
await run('listen-options', async () => {
	const first = createServer(() => {});
	let second = createServer(() => {});
	try {
		await new Promise((resolve, reject) => {
			first.once('error', reject);
			first.listen({ host: HOST, port: 0, reusePort: true }, resolve);
		});
		record('listen-options', 'server.listen({ reusePort: true }) on this Node', 'accepted');
		const port = first.address().port;
		try {
			await new Promise((resolve, reject) => {
				second.once('error', reject);
				second.listen({ host: HOST, port, reusePort: true }, resolve);
			});
			record('listen-options', 'a second listener on the same port with reusePort', 'accepted - two listeners share the port');
		} catch (err) {
			record('listen-options', 'a second listener on the same port with reusePort', `refused: ${err.code || err.message}`);
		}
	} catch (err) {
		record('listen-options', 'server.listen({ reusePort: true }) on this Node', `refused: ${err.code || err.message}`);
	} finally {
		await new Promise((resolve) => first.close(() => resolve()));
		await new Promise((resolve) => second.close(() => resolve()));
	}
});

// --- kit primitives ---------------------------------------------------------
await run('kit-primitives', async () => {
	try {
		const mod = await import('@sveltejs/kit/node');
		const names = ['getRequest', 'setResponse', 'createReadableStream'].filter((n) => typeof mod[n] === 'function');
		record('kit-primitives', 'public @sveltejs/kit/node exports available', JSON.stringify(names));
	} catch (err) {
		record('kit-primitives', 'public @sveltejs/kit/node exports available', `not installed in this tree: ${err.code || err.message}`);
	}
});

// --- tls ---------------------------------------------------------------------
// Runs unattended against the committed self-signed fixtures under
// test/fixtures/tls (100-year expiry, localhost SANs, generated once with
// openssl and checked in - the probe never shells out).
await run('tls', async () => {
	const { createServer: createHttpsServer } = await import('node:https');
	const tlsMod = await import('node:tls');
	const { readFileSync } = await import('node:fs');
	const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'tls');
	const cert = readFileSync(join(fixturesDir, 'localhost.crt'));
	const key = readFileSync(join(fixturesDir, 'localhost.key'));
	const sniCert = readFileSync(join(fixturesDir, 'sni.crt'));
	const sniKey = readFileSync(join(fixturesDir, 'sni.key'));

	const server = createHttpsServer({ cert, key }, (_req, res) => { res.end('ok'); });
	server.addContext('sni.example', tlsMod.createSecureContext({ cert: sniCert, key: sniKey }));
	const wss = new WebSocketServer({ server });
	wss.on('connection', (socket) => socket.send('over-tls'));
	await new Promise((resolve) => server.listen(0, HOST, resolve));
	const port = server.address().port;

	const wsEcho = await new Promise((resolve) => {
		const client = new WebSocket(`wss://${HOST}:${port}/`, { rejectUnauthorized: false });
		client.once('message', (raw) => { resolve(raw.toString()); client.close(); });
		client.once('error', (err) => resolve('error: ' + err.message));
	});
	record('tls', 'ws mounted on node:https - wss upgrade and frame delivery', wsEcho === 'over-tls' ? 'works' : wsEcho);

	const sniCn = await new Promise((resolve) => {
		const socket = tlsMod.connect({ host: HOST, port, servername: 'sni.example', rejectUnauthorized: false }, () => {
			resolve(socket.getPeerCertificate().subject?.CN);
			socket.destroy();
		});
		socket.on('error', (err) => resolve('error: ' + err.message));
	});
	record('tls', 'SNI addContext serves the per-name certificate', sniCn === 'sni.example' ? 'works (CN sni.example selected)' : String(sniCn));

	server.setSecureContext({ cert: sniCert, key: sniKey });
	const swappedCn = await new Promise((resolve) => {
		const socket = tlsMod.connect({ host: HOST, port, rejectUnauthorized: false }, () => {
			resolve(socket.getPeerCertificate().subject?.CN);
			socket.destroy();
		});
		socket.on('error', (err) => resolve('error: ' + err.message));
	});
	record('tls', 'setSecureContext hot-swaps the default certificate without re-binding', swappedCn === 'sni.example' ? 'works (new connections get the new cert)' : String(swappedCn));

	const ocspBytes = Buffer.from('probe-ocsp-response');
	server.on('OCSPRequest', (_c, _i, cb) => cb(null, ocspBytes));
	const stapled = await new Promise((resolve) => {
		const socket = tlsMod.connect({ host: HOST, port, rejectUnauthorized: false, requestOCSP: true });
		socket.on('OCSPResponse', (response) => { resolve(Buffer.from(response).equals(ocspBytes)); socket.destroy(); });
		socket.on('secureConnect', () => setTimeout(() => { resolve(false); socket.destroy(); }, 300));
		socket.on('error', () => resolve(false));
	});
	record('tls', 'OCSPRequest staples a provided DER response to a requesting handshake', stapled ? 'works' : 'no OCSPResponse observed');

	await new Promise((resolve) => { wss.close(() => server.close(resolve)); });
});

// --- report ------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const wsVersion = (() => {
	try { return require('ws/package.json').version; } catch { return 'unknown'; }
})();

const sections = [];
for (const f of findings) {
	let s = sections.find((x) => x.name === f.section);
	if (!s) { s = { name: f.section, items: [] }; sections.push(s); }
	s.items.push(f);
}

const lines = [
	'# node:http + ws API facts',
	'',
	`Generated ${new Date().toISOString()} by \`probe/ws-api-facts.mjs\`.`,
	'',
	`- Node version: **${process.version}**`,
	`- ws version: **${wsVersion}**`,
	`- Platform: ${process.platform}/${process.arch}`,
	'',
	'Observed behavior only; interpretation lives in the adapter design docs.',
	'Re-run after every Node or ws upgrade; review any diff before trusting the upgrade.',
	''
];
for (const s of sections) {
	lines.push(`## ${s.name}`, '');
	for (const item of s.items) lines.push(`- ${item.question}`, `  - ${item.observed}`);
	lines.push('');
}
writeFileSync(join(here, 'ws-api-facts.report.md'), lines.join('\n'), 'utf8');
console.log(`\nWrote ${join(here, 'ws-api-facts.report.md')} - ${findings.length} findings`);
process.exit(0);
