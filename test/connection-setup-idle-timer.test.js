import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';

// A connection whose setup throws after the upgrade must not leave its idle
// interval running. Each failure point sits where the old arming order had
// already started the timer but no close listener existed to clear it.
beforeAll(() => { expect(buildFixtureOnce('setupfailure')).toBe(true); }, 400000);
it.each(['message', 'close'])('leaves no idle interval after a setup failure registering %s', failPoint => {
	const env = { ...process.env };
	delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
	if (env.NODE_ENV === 'test') delete env.NODE_ENV;
	const output = execFileSync(process.execPath, [fileURLToPath(new URL('./helpers/setup-failure-idle-timer-child.mjs', import.meta.url)), failPoint], {
		env, encoding: 'utf8', timeout: 60000, windowsHide: true
	});
	expect(output).toContain('SETUP_FAILURE_IDLE_TIMER_CLEAN');
}, 65000);
