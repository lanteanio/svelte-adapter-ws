// Every path the adapter mounts is matched on the request target exactly as a
// client sends it. A configured mount that no client sends as spelled, or two
// mounts claiming the same requests, is refused where the config is read: the
// adapter factory, createTestServer and the dev plugin.
//
// What the rule must admit is decided by real clients against the way this
// runtime routes a mount: a spelling is admissible exactly when fetch and
// node:http, each handed the path a person would write, reach the route
// registered under it.

import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import adapter from '../src/index.js';
import uws from '../src/vite.js';
import { createTestServer } from '../src/testing.js';
import { mountPathProblem } from '../src/runtime/utils/mount-path.js';

const BACKSLASH = String.fromCharCode(92);

/**
 * Answer each of `spellings` on a node:http server the way the runtime answers
 * a mount, on the raw target's path compared as sent, and let `drive` read
 * which route a request reaches.
 * @param {string[]} spellings
 * @param {(port: number) => Promise<void>} drive
 */
async function withRouter(spellings, drive) {
	const routes = new Set(spellings);
	const server = http.createServer((req, res) => {
		const target = /** @type {string} */ (req.url);
		const query = target.indexOf('?');
		const pathname = query === -1 ? target : target.slice(0, query);
		if (routes.has(pathname)) res.end(pathname);
		else { res.statusCode = 404; res.end('none'); }
	});
	const port = await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port));
	});
	try {
		await drive(port);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

/** The route `fetch` reaches for `target`. */
async function reach(port, target) {
	return (await (await fetch(`http://127.0.0.1:${port}${target}`)).text());
}

/** The route `node:http` reaches for `target`, as the URL parser hands it over. */
function reachHttp(port, target) {
	const { pathname } = new URL(`http://127.0.0.1:${port}${target}`);
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
			let body = '';
			res.setEncoding('latin1');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve(body));
		}).on('error', reject);
	});
}

/**
 * The path a person writes into a URL for the decoded path `decoded`: as it
 * reads, except the three characters that are URL syntax, which no one can
 * write into a path unescaped.
 * @param {string} decoded
 */
function written(decoded) {
	return decoded.replace(/[%?#]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

describe('mount path spelling against real clients and the runtime routing', () => {
	// Every ASCII character and a few beyond it between two letters, raw and as
	// an uppercase and a lowercase escape. Router syntax at a segment's start
	// and dot segments have their own cases below; none arises here.
	it('admits exactly the spellings fetch and node:http reach for the written path', async () => {
		/** @type {Map<string, string>} */
		const decodedOf = new Map();
		const chars = [];
		for (let code = 0; code < 0x80; code++) chars.push(String.fromCharCode(code));
		chars.push('ü', '€', '😀');
		for (const ch of chars) {
			decodedOf.set('/a' + ch + 'b', '/a' + ch + 'b');
			const escape = [...new TextEncoder().encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
			decodedOf.set('/a' + escape + 'b', '/a' + ch + 'b');
			decodedOf.set('/a' + escape.toLowerCase() + 'b', '/a' + ch + 'b');
		}
		const disagreements = [];
		await withRouter([...decodedOf.keys()], async (port) => {
			for (const [spelling, decoded] of decodedOf) {
				const target = written(decoded);
				const viaFetch = await reach(port, target);
				const viaHttp = await reachHttp(port, target);
				const reachable = viaFetch === spelling && viaHttp === spelling;
				const admitted = mountPathProblem(spelling) === null;
				if (admitted !== reachable) disagreements.push({ spelling, admitted, viaFetch, viaHttp });
			}
		});
		expect(disagreements).toEqual([]);
	}, 60000);

	it('answers admitted spellings with router syntax inside a segment for the path a client writes', async () => {
		const admitted = ['/status:live', '/ops*', '/v1/things:batchGet', '/gesundheit-pr%C3%BCfung', '/files/100%25', "/s!$&'()+,;=@~x"];
		for (const spelling of admitted) expect(mountPathProblem(spelling), spelling).toBeNull();
		await withRouter(admitted, async (port) => {
			expect(await reach(port, '/status:live')).toBe('/status:live');
			expect(await reach(port, '/ops*')).toBe('/ops*');
			expect(await reach(port, '/v1/things:batchGet')).toBe('/v1/things:batchGet');
			expect(await reach(port, '/gesundheit-prüfung')).toBe('/gesundheit-pr%C3%BCfung');
			expect(await reach(port, written('/files/100%'))).toBe('/files/100%25');
			expect(await reach(port, "/s!$&'()+,;=@~x")).toBe("/s!$&'()+,;=@~x");
		});
	});

	it('refuses dot segments, which clients resolve away, and router syntax at a segment start', async () => {
		const unreachable = [['/a/../b', '/a/../b'], ['/a/./b', '/a/./b'], ['/a/%2E%2E/b', '/a/../b']];
		for (const [spelling] of unreachable) expect(mountPathProblem(spelling), spelling).not.toBeNull();
		await withRouter(unreachable.map(([spelling]) => spelling), async (port) => {
			for (const [spelling, target] of unreachable) expect(await reach(port, target), spelling).toBe('none');
		});
		for (const spelling of ['/:id', '/x/*']) expect(mountPathProblem(spelling), spelling).not.toBeNull();
	});
});

describe('mount path refusals', () => {
	it.each([
		['/gesundheit-prüfung', /"ü" \(U\+00FC\), which clients send percent-encoded; write the path as "\/gesundheit-pr%C3%BCfung"/],
		['/a b', /U\+0020.*write the path as "\/a%20b"/],
		['/a#b', /"#".*"\/a%23b"/],
		['/a?b', /"\?".*"\/a%3Fb"/],
		['/pr%c3%bcfung', /lowercase hex.*"\/pr%C3%BCfung"/],
		['/%70ath', /escapes a character clients send as it is; write the path as "\/path"/],
		['/a%2Fb', /"%2F", an encoded "\/"/],
		['/a%zzb', /starts no two-digit escape/],
		['/a%FFb', /do not decode to UTF-8/],
		['/a%09b', /contains a tab, which the URL parser removes from every path, so no client can request it/],
		['/a%0Ab', /contains a line feed/],
		['/a%0Db', /contains a carriage return/],
		['/a\tb', /contains a tab/],
		['/a/../b', /"\.\." segment/],
		['/a/%2E/b', /"\." segment/],
		['/a' + BACKSLASH + 'b', /"\\", which browsers send as "\/"/],
		['/a%5Cb', /"%5C", an encoded "\\"/],
		['/:id', /segment starting with ":"/],
		['/x/*', /segment starting with "\*"/],
		['/%3Aid', /segment starting with ":"/],
		['healthz', /starting with '\/'/]
	])('refuses %j and says why', (value, why) => {
		expect(mountPathProblem(value)).toMatch(why);
	});

	it('admits a literal percent sign only as %25', () => {
		expect(mountPathProblem('/a%25b')).toBeNull();
		expect(mountPathProblem('/a%2525')).toBeNull();
		expect(mountPathProblem('/a%b')).toMatch(/starts no two-digit escape/);
	});

	it('admits router syntax inside a segment, uppercase escapes and the defaults', () => {
		for (const value of [
			'/healthz', '/readyz', '/ws', '/__ws/auth', '/__realtime', '/__waiting-room', '/__admit-check', '/__uws/dashboard',
			'/status:live', '/ops:1', '/ops*', '/v1/things:batchGet', '/gesundheit-pr%C3%BCfung', '/a%20b', '/a%3Fb',
			'/a/b/', '/a//b', "/~u/it's(1);a=b@c", '/a|b'
		]) {
			expect(mountPathProblem(value), value).toBeNull();
		}
	});

	it('names the plain ASCII a prefix mount may use instead of an escaped spelling', () => {
		expect(mountPathProblem('/__ops', { prefix: true })).toBeNull();
		expect(mountPathProblem('/ops%C3%BC', { prefix: true })).toMatch(/prefix mount is spelled in plain ASCII \(letters, digits/);
		for (const value of ['/betrieb-übersicht', '/a b', '/a"b', '/a<b>', '/a^b', '/a`b', '/a{b}', '/a#b', '/a?b']) {
			const problem = mountPathProblem(value, { prefix: true });
			expect(problem, value).toMatch(/a prefix mount takes no escapes; spell it in plain ASCII \(letters, digits/);
			expect(problem, value).not.toMatch(/write the path as/);
		}
	});
});

describe('adapter options', () => {
	const refusal = (opts) => {
		try {
			adapter(opts);
		} catch (error) {
			return /** @type {Error} */ (error).message;
		}
		return null;
	};

	it.each([
		['healthCheckPath', { healthCheckPath: '/gesundheit-prüfung' }],
		['readinessCheckPath', { readinessCheckPath: '/ready?' }],
		['websocket.path', { websocket: { path: '/w s' } }],
		['websocket.authPath', { websocket: { authPath: '/auth%2F' } }],
		['websocket.adminPath', { websocket: { adminPath: '/:ops' } }],
		['websocket.adminPath', { websocket: { adminPath: '/ops%C3%BC' } }],
		['websocket.upgradeAdmission.waitingRoom.path', { websocket: { upgradeAdmission: { maxConcurrent: 10, waitingRoom: { path: '/warte#raum' } } } }],
		['websocket.upgradeAdmission.waitingRoom.admitCheckPath', { websocket: { upgradeAdmission: { perTickBudget: 8, waitingRoom: { admitCheckPath: '/a/../check' } } } }]
	])('refuses an unreachable %s', (option, opts) => {
		const message = refusal(opts);
		expect(message).toContain(option + ' ');
		expect(message).toContain('matched on the request target exactly as a client sends it');
	});

	it('admits the spellings the router matches', () => {
		expect(refusal({ healthCheckPath: '/status:live', readinessCheckPath: '/gesundheit-pr%C3%BCfung', websocket: { adminPath: '/ops:1' } })).toBeNull();
		expect(refusal({ websocket: { upgradeAdmission: { maxConcurrent: 4, waitingRoom: { path: '/warte%20raum' } } } })).toBeNull();
	});

	it('refuses two mounts on one path and an exact mount under the admin prefix', () => {
		expect(refusal({ healthCheckPath: '/ws', websocket: true })).toMatch(/healthCheckPath \("\/ws"\) must differ from websocket\.path/);
		expect(refusal({ websocket: { adminPath: '/__ops', authPath: '/__ops/auth' } })).toMatch(/websocket\.authPath \("\/__ops\/auth"\) sits at or under websocket\.adminPath/);
		expect(refusal({ healthCheckPath: '/__realtime/health', websocket: true })).toMatch(/sits at or under websocket\.adminPath/);
		expect(refusal({ websocket: { upgradeAdmission: { maxConnections: 5, waitingRoom: { admitCheckPath: '/readyz' } } } }))
			.toMatch(/admitCheckPath \("\/readyz"\) must differ from readinessCheckPath/);
	});

	it('judges a config wrong in two ways in the order the options are read', () => {
		expect(refusal({ tracing: '', healthCheckPath: '/a b' })).toMatch(/^tracing must be a non-empty module path string/);
		expect(refusal({ tracing: /** @type {any} */ (5), readinessCheckPath: '/ready?' })).toMatch(/^tracing must be a non-empty module path string/);
		expect(refusal({ staticDotfiles: /** @type {any} */ ('yes'), websocket: { path: 'ws' } })).toMatch(/^staticDotfiles must be a boolean/);
		expect(refusal({ websocket: { path: 'ws', upgradeAdmission: { maxConcurrent: 1, waitingRoom: { renderer: /** @type {any} */ (5) } } } }))
			.toMatch(/^websocket\.upgradeAdmission\.waitingRoom\.renderer must be a module path string/);
		expect(refusal({ websocket: { handler: /** @type {any} */ (42), path: 'ws' } })).toMatch(/^websocket\.handler must be a path string/);
		expect(refusal({ websocket: { path: 'ws', metrics: /** @type {any} */ ({}) } })).toMatch(/^websocket\.path must start with '\/'/);
		expect(refusal({ websocket: { path: '/w s', metrics: /** @type {any} */ ({}) } })).toMatch(/^websocket\.metrics must be a module path string/);
	});

	it('accepts nested and trailing-slash exact mounts, and ignores what an inactive feature would mount', () => {
		expect(refusal({ healthCheckPath: '/health', readinessCheckPath: '/health/ready', websocket: true })).toBeNull();
		// The router routes /healthz and /healthz/ separately.
		expect(refusal({ healthCheckPath: '/healthz', readinessCheckPath: '/healthz/' })).toBeNull();
		expect(refusal({ healthCheckPath: '/ws', websocket: false })).toBeNull();
		expect(refusal({ healthCheckPath: '/__realtime/health', websocket: { adminPath: false } })).toBeNull();
		expect(refusal({ healthCheckPath: '/__admit-check', websocket: true })).toBeNull();
		expect(refusal({ healthCheckPath: '/__admit-check', websocket: { upgradeAdmission: { maxConcurrent: 1, waitingRoom: false } } })).toBeNull();
	});

	it('keeps null and an empty healthCheckPath meaning no liveness route', () => {
		expect(refusal({ healthCheckPath: null })).toBeNull();
		expect(refusal({ healthCheckPath: '' })).toBeNull();
		expect(refusal({ healthCheckPath: '', readinessCheckPath: '/healthz' })).toBeNull();
	});

	it('describes a value JSON cannot render without throwing', () => {
		const circular = {};
		circular.self = circular;
		expect(refusal({ healthCheckPath: 10n })).toMatch(/healthCheckPath must be a path string starting with '\/' - got 10\./);
		expect(refusal({ readinessCheckPath: '/r', healthCheckPath: circular })).toMatch(/got \[object Object\]\./);
	});
});

describe('dev plugin options', () => {
	it('refuses an unreachable endpoint or dashboard path', () => {
		expect(() => uws({ handler: '/x', path: '/w s' })).toThrow(/websocket\.path contains U\+0020/);
		expect(() => uws({ handler: '/x', authPath: '/auth?x' })).toThrow(/websocket\.authPath contains "\?"/);
		expect(() => uws({ handler: '/x', dashboard: { path: '/diagnose-übersicht' } })).toThrow(/dashboard\.path contains "ü"/);
		expect(() => uws({ handler: '/x', dashboard: { path: '/diagnose-%C3%BCbersicht' } })).toThrow(/dashboard\.path contains an escape/);
	});

	it('refuses an endpoint the dashboard prefix would answer', () => {
		expect(() => uws({ handler: '/x', authPath: '/__diag/auth', dashboard: { path: '/__diag' } }))
			.toThrow(/websocket\.authPath \("\/__diag\/auth"\) sits at or under the uws\(\) dev plugin option dashboard\.path/);
		// The dashboard beneath an exact endpoint answers paths the endpoint never does.
		expect(() => uws({ handler: '/x', authPath: '/__diag', dashboard: { path: '/__diag/board' } })).not.toThrow();
	});

	it('judges an endpoint value before comparing it with the dashboard', () => {
		expect(() => uws({ handler: '/x', path: /** @type {any} */ (123) })).toThrow("websocket.path must be a path string starting with '/'");
		expect(() => uws({ handler: '/x', path: '/w s', authPath: '/__uws/dashboard' })).toThrow(/websocket\.path contains U\+0020/);
		expect(() => uws({ handler: '/x', path: 'ws', authPath: '/__uws/dashboard' })).toThrow("websocket.path must be a path string starting with '/'");
	});

	const kitConfig = (adapterFields) => ({
		root: path.join(process.cwd(), 'test'),
		build: { ssr: true },
		plugins: [{
			name: 'vite-plugin-sveltekit-setup',
			api: { options: { kit: { adapter: { name: 'adapter-ws', websocketHandler: './test/vite.test.js', ...adapterFields } } } }
		}]
	});

	it('checks the adapter-declared endpoints once it reads them', async () => {
		await expect(uws({ dashboard: { path: '/__ws' } }).configResolved(kitConfig({})))
			.rejects.toThrow(/websocket\.authPath \("\/__ws\/auth"\) sits at or under the uws\(\) dev plugin option dashboard\.path/);
		await expect(uws().configResolved(kitConfig({ websocketPath: '/w s' })))
			.rejects.toThrow(/websocket\.path contains U\+0020/);
		await expect(uws().configResolved(kitConfig({ websocketAuthPath: '/auth%c3%bc' })))
			.rejects.toThrow(/websocket\.authPath writes an escape in lowercase hex/);
	});
});

describe('createTestServer options', () => {
	it.each([
		[{ healthCheckPath: '/gesundheit-prüfung' }, /healthCheckPath contains "ü"/],
		[{ readinessCheckPath: '/ready ' }, /readinessCheckPath contains U\+0020/],
		[{ wsPath: '/w#s' }, /wsPath contains "#"/],
		[{ adminPath: '/*ops' }, /adminPath has a segment starting with "\*"/],
		[{ upgradeAdmission: { maxConcurrent: 2, waitingRoom: { path: '/warte raum' } } }, /waitingRoom\.path contains U\+0020/],
		[{ upgradeAdmission: { maxConcurrent: 2, waitingRoom: { admitCheckPath: '/check/./now' } } }, /waitingRoom\.admitCheckPath contains a "\." segment/],
		[{ healthCheckPath: '/__realtime/health' }, /sits at or under the createTestServer option adminPath/],
		[{ readinessCheckPath: '/ws' }, /readinessCheckPath \("\/ws"\) must differ from the createTestServer option wsPath/]
	])('refuses %j', async (options, why) => {
		await expect(createTestServer(options)).rejects.toThrow(why);
	});

	it('answers probes spelled with router syntax inside a segment and with escapes', async () => {
		const server = await createTestServer({ healthCheckPath: '/status:live', readinessCheckPath: '/bereit-pr%C3%BCfung' });
		try {
			const live = await fetch(server.url + '/status:live');
			expect(live.status).toBe(200);
			await live.arrayBuffer();
			const ready = await fetch(server.url + '/bereit-prüfung');
			expect(ready.status).toBe(200);
			await ready.arrayBuffer();
		} finally {
			await server.close();
		}
	});
});
