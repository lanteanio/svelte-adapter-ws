import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.js'],
		// The integration lane boots real node:http servers on ephemeral ports;
		// keep the default forks pool so a wedged server cannot hang the runner.
		testTimeout: 15000,
		hookTimeout: 15000
	}
});
