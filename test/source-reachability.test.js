import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOrphanModules } from '../scripts/check-source-reachability.js';

const cleanups = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(files, exports = { '.': { types: './src/index.d.ts', default: './src/index.js' } }) {
	const directory = mkdtempSync(join(tmpdir(), 'source-reachability-'));
	cleanups.push(directory);
	mkdirSync(join(directory, 'src'));
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ exports }));
	for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, 'src', file), source);
	return directory;
}

describe('source reachability gate', () => {
	it('keeps every production source connected to a declared entry', () => {
		const result = findOrphanModules();
		expect(result.scanned).toBeGreaterThan(100);
		expect(result.orphans).toEqual([]);
	});

	it('reports an orphan and a detached import cycle even when tests import them', () => {
		const directory = fixture({ 'index.js': '', 'orphan.js': '', 'a.js': "import './b.js';", 'b.js': "import './a.js';" });
		mkdirSync(join(directory, 'test'));
		writeFileSync(join(directory, 'test', 'test.js'), "import '../src/orphan.js'; import '../src/a.js';");
		expect(findOrphanModules(directory, {}).orphans).toEqual(['src/a.js', 'src/b.js', 'src/orphan.js']);
	});

	it('follows static, side-effect, dynamic, require and re-export edges with query or fragment', () => {
		const directory = fixture({
			'index.js': "import './side.js'; import { value } from './named.js'; export * from './export.js'; import('./dynamic.js?mode=live'); require('./require.cjs#cache');",
			'side.js': '', 'named.js': 'export const value = 1;', 'export.js': '', 'dynamic.js': '', 'require.cjs': ''
		});
		expect(findOrphanModules(directory, {}).orphans).toEqual([]);
	});

	it('ignores imports written only in comments or strings', () => {
		const directory = fixture({ 'index.js': '// import "./comment.js";\nconst s = "import(\'./string.js\')";', 'comment.js': '', 'string.js': '' });
		expect(findOrphanModules(directory, {}).orphans).toEqual(['src/comment.js', 'src/string.js']);
	});

	it('accepts conditional and subpath exports and justified file-loaded roots', () => {
		const directory = fixture({ 'index.js': '', 'browser.js': '', 'extra.js': '', 'worker.js': '' }, { '.': { browser: './src/browser.js', default: './src/index.js' }, './extra': './src/extra.js' });
		expect(findOrphanModules(directory, { 'src/worker.js': 'Started as a worker by a generated entry.' }).orphans).toEqual([]);
		expect(() => findOrphanModules(directory, { 'src/worker.js': '' })).toThrow('needs a reason');
		expect(() => findOrphanModules(directory, { 'src/missing.js': 'Unused root' })).toThrow('does not exist');
	});

	it('fails on invalid source and empty input instead of silently skipping files', () => {
		const directory = fixture({ 'index.js': 'export {' });
		expect(() => findOrphanModules(directory, {})).toThrow('src/index.js: cannot read module imports');
		const empty = fixture({});
		expect(() => findOrphanModules(empty, {})).toThrow('No JavaScript source modules');
	});
});
