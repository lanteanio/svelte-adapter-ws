// Boot the built fixture handler against a host:port the parent already holds,
// so the bind failure runs its real path.
//
// A child rather than an in-worker import for one reason: that path ends in
// `process.exit(1)`, which would take the vitest worker with it. The parent
// reads this process's output and status, which is exactly what an operator
// sees.
//
// The fixture is used instead of a `buildRuntime` payload because the payload is
// copied to an OS temp directory, where the handler graph's own dependencies do
// not resolve. The fixture lives inside the repo and boots the same lifecycle.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { variantOut } from '../fixture/variants.js';

const [host, port] = process.argv.slice(2);
const fixtureDir = fileURLToPath(new URL('../fixture', import.meta.url));
const built = path.join(fixtureDir, variantOut('default'), 'handler.js');

const handler = await import(pathToFileURL(built).href);
await handler.start(host, Number(port));

// Only reached when the bind unexpectedly SUCCEEDED. Say so and fail loudly
// rather than hanging until the parent's timeout, which would report as a
// timeout instead of as the wrong outcome.
console.error('listen-failure-child: the bind succeeded, so no failure was exercised');
process.exit(0);
