// Build servers as a node before 22.21 and 24.9 builds them: one that ignores
// http.createServer's shouldUpgradeCallback. node stores the option with a
// plain assignment while it constructs an http or https server, so a setter on
// both prototypes sees it. A server built inside `withUpgradeOptionIgnored`
// keeps the decision such a node makes in the option's place, an upgrade
// whenever an 'upgrade' listener is attached, under the name node reads it by;
// every other server keeps what it was given.

import http from 'node:http';
import https from 'node:https';

/**
 * What node before 22.21 and 24.9 asks instead of the option.
 *
 * @this {import('node:http').Server}
 */
export function listenerDecides() {
	return this.listenerCount('upgrade') > 0;
}

const PROTOTYPES = [http.Server.prototype, https.Server.prototype];

/** Whether this node keeps the option at all. One that does not is the older node already. */
const takesOption = (() => {
	const probe = () => false;
	return /** @type {any} */ (http.createServer({ shouldUpgradeCallback: probe })).shouldUpgradeCallback === probe;
})();

/** @type {WeakMap<object, unknown>} */
const stored = new WeakMap();
let ignoring = false;
let built = 0;
let installed = false;

function install() {
	if (installed) return;
	for (const proto of PROTOTYPES) {
		Object.defineProperty(proto, 'shouldUpgradeCallback', {
			configurable: true,
			get() { return stored.get(this); },
			set(value) {
				if (ignoring) built++;
				stored.set(this, ignoring ? listenerDecides : value);
			}
		});
	}
	installed = true;
}

/**
 * Run `build`, and build every server it constructs as one that ignores the
 * option. Throws when it constructed none, so a case cannot pass on a server
 * this node built its own way.
 *
 * @template T
 * @param {() => Promise<T> | T} build
 * @returns {Promise<T>}
 */
export async function withUpgradeOptionIgnored(build) {
	if (!takesOption) return build();
	install();
	const before = built;
	ignoring = true;
	/** @type {T} */
	let result;
	try {
		result = await build();
	} finally {
		ignoring = false;
	}
	if (built === before) throw new Error('no server was built ignoring shouldUpgradeCallback');
	return result;
}

/**
 * Put both prototypes back. Call it once every server built since the first
 * `withUpgradeOptionIgnored` is closed: those read the option through the
 * accessor.
 */
export function restoreUpgradeOption() {
	if (!installed) return;
	for (const proto of PROTOTYPES) delete (/** @type {any} */ (proto)).shouldUpgradeCallback;
	installed = false;
}

/**
 * Each suite runs once on the servers this node builds and once on servers
 * built as an older node builds them.
 */
export const UPGRADE_OPTION_MODES = [
	{ name: 'this node', build: (/** @type {() => any} */ build) => Promise.resolve(build()) },
	{ name: 'a node that ignores shouldUpgradeCallback', build: withUpgradeOptionIgnored }
];
