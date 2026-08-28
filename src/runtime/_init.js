// Initialize SvelteKit's Server BEFORE any app-authored server module is
// evaluated.
//
// $env/dynamic/private and $env/dynamic/public are runtime-populated by
// SvelteKit's Server.init({ env }) call - until init runs, the resolved
// `private_env` / `public_env` proxies are empty objects. If a user's
// server module reads `env.X` at module-load time (the default for
// `import { env } from '$env/dynamic/private'` followed by a top-level
// `env.DATABASE_URL` read), those reads would see empty values when that
// chunk is evaluated during handler.js's static import resolution.
//
// Putting Server.init in this side-effect-bearing module and importing it in
// handler.js FIRST forces ESM to evaluate this module before the rest of the
// graph (imports are evaluated depth-first in source order). Top-level
// `await server.init(...)` blocks the import chain until the env proxies are
// populated.

import './shims.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monotonicNow } from './runtime.js';
import { createReadableStream } from 'KIT_NODE';
import { Server } from 'SERVER';
import { manifest, base } from 'MANIFEST';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${__dirname}/client${base}`;

const _t_init = monotonicNow();

/** @type {import('@sveltejs/kit').Server} */
export const server = new Server(manifest);

await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => createReadableStream(`${asset_dir}/${file}`)
});

console.log(`[svelte-adapter-ws] SvelteKit server initialized in ${(monotonicNow() - _t_init).toFixed(1)}ms`);
