import { expect, it } from 'vitest';
import config from '../vitest.config.js';

it('resets shared application state before setup files capture globals', () => {
	expect(config.test.sequence.setupFiles).toBe('list');
	expect(config.test.setupFiles[0]).toBe('./test/helpers/reset-modules.js');
	for (const project of config.test.projects) {
		expect(project.extends).toBe(true);
		expect(project.test.setupFiles).toBeUndefined();
		expect(project.test.sequence).toBeUndefined();
	}
});
