import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';

describe('Vite uses the adapter environment namespace', () => {
	it.each([
		['consolidated', 'prefixed'],
		['consolidated', 'bare-only'],
		['consolidated', 'empty-prefix'],
		['fallback', 'prefixed'],
		['fallback', 'bare-only']
	])('%s configuration with %s ORIGIN', async (configStyle, mode) => {
		const runner = fileURLToPath(new URL('./helpers/vite-env-namespace-runner.js', import.meta.url));
		const root = mkdtempSync(fileURLToPath(new URL('./.tmp-adapt-env-', import.meta.url)));
		try {
			const result = await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [runner, configStyle, mode, root], {
					windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
				});
				let output = '';
				child.stdout.on('data', chunk => { output += chunk; });
				child.stderr.on('data', chunk => { output += chunk; });
				let timedOut = false;
				const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
				child.once('error', error => { clearTimeout(timer); reject(error); });
				child.once('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
			});
			expect(result.timedOut, result.output).toBe(false);
			expect(result.code, result.output).toBe(0);
			expect(result.output).toContain(`vite-env-namespace: ${configStyle} ${mode} passed`);
		} finally {
			// Vite's loader can retain directory handles until the child exits.
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}, 65000);
});
