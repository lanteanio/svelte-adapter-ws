import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodingProblems, findEncodingOffenses } from '../scripts/check-source-encoding.js';

const trees = [];
function fixture(files = { 'note.md': 'Clean text\n' }) {
	const root = mkdtempSync(join(tmpdir(), 'source-encoding-'));
	trees.push(root);
	const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	git('init', '-q');
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, 'utf8');
	git('add', '--', ...Object.keys(files));
	return { root, git };
}
afterEach(() => { for (const root of trees.splice(0)) rmSync(root, { recursive: true, force: true }); });
const utf8 = value => Buffer.from(value, 'utf8');
const latin1Accident = value => utf8(value).toString('latin1');

it('accepts international text, individual legacy letters and literal source escapes', () => {
	expect(encodingProblems(utf8('caf\u00e9, \u0142\u00f3d\u017a, \u017c\u00f3\u0142w, \u00c3, \u00c5, \u4e2d\u6587, \ud83d\ude00, \\u00c3\\u00a9\n'))).toEqual([]);
});
it.each(['caf\u00e9', '\u0142\u00f3d\u017a', '\u017c\u00f3\u0142w', '\ud83d\ude00'])('detects repeated Latin-1 encoding damage to %s', value => {
	for (let layer = 0; layer < 3; layer++) {
		value = latin1Accident(value);
		expect(encodingProblems(utf8('first line\n' + value))[0]).toMatchObject({ line: 2, reason: expect.stringContaining('double-encoded') });
	}
});
it('detects Windows-1252 punctuation and Polish-letter damage', () => {
	for (const value of ['\u00e2\u20ac\u2122', '\u00c5\u201a']) expect(encodingProblems(utf8(value))).toHaveLength(1);
});
it.each(['\u00c9\u00a0', '\u00dc\u00a0', '\u00c9\u00ae', '\u00c5\u00a0', '\u00c5\u00ae'])('accepts legitimate accented capitals beside spaces and symbols: %s', value => {
	expect(encodingProblems(utf8(value))).toEqual([]);
});
it('refuses invalid UTF-8 instead of silently inserting replacement characters', () => {
	expect(encodingProblems(Buffer.from([0xc3, 0x28]))).toEqual([{ line: 1, reason: 'invalid UTF-8' }]);
});

describe('tracked files and index', () => {
	it('finds damaged text on disk with a useful path and line', () => {
		const { root } = fixture();
		writeFileSync(join(root, 'note.md'), 'clean\n' + latin1Accident('caf\u00e9'), 'utf8');
		expect(findEncodingOffenses(root).offenses).toEqual([expect.stringContaining('note.md:2: possible double-encoded UTF-8')]);
	});
	it('refuses staged damage after the working file has been repaired', () => {
		const { root } = fixture({ 'note.md': latin1Accident('caf\u00e9') });
		writeFileSync(join(root, 'note.md'), 'caf\u00e9\n', 'utf8');
		expect(findEncodingOffenses(root).offenses).toEqual([expect.stringContaining('(staged blob)')]);
	});
	it('still checks staged text when the working file is missing', () => {
		const { root } = fixture({ 'note.md': latin1Accident('caf\u00e9') });
		rmSync(join(root, 'note.md'));
		expect(findEncodingOffenses(root).offenses).toEqual([expect.stringContaining('(staged blob)')]);
	});
	it('skips explicitly declared binary assets without hiding text', () => {
		const { root } = fixture({ '.gitattributes': '*.bin binary\n', 'image.bin': Buffer.from([0xff, 0x00]), 'note.md': 'caf\u00e9\n' });
		expect(findEncodingOffenses(root)).toEqual({ offenses: [], scanned: 2 });
	});
	it('does not let working attributes hide damaged staged text', () => {
		const { root } = fixture({ '.gitattributes': '*.md text\n', 'note.md': latin1Accident('caf\u00e9') });
		writeFileSync(join(root, 'note.md'), 'caf\u00e9\n', 'utf8');
		writeFileSync(join(root, '.gitattributes'), '*.md binary\n', 'utf8');
		expect(findEncodingOffenses(root).offenses).toEqual([expect.stringContaining('(staged blob)')]);
	});
	it('checks newly text-declared working files without scanning staged binary assets', () => {
		const { root } = fixture({ '.gitattributes': '*.md binary\n', 'note.md': Buffer.from([0xff]) });
		writeFileSync(join(root, 'note.md'), latin1Accident('caf\u00e9'), 'utf8');
		writeFileSync(join(root, '.gitattributes'), '*.md text\n', 'utf8');
		expect(findEncodingOffenses(root).offenses).toEqual([expect.stringContaining('(working copy)')]);
	});
	it('refuses a tracked file the reader cannot open', () => {
		const { root } = fixture();
		expect(findEncodingOffenses(root, () => null).offenses).toEqual(['note.md: tracked file could not be read']);
	});
	it('refuses an empty repository instead of claiming success', () => {
		const root = mkdtempSync(join(tmpdir(), 'source-encoding-empty-'));
		trees.push(root);
		execFileSync('git', ['init', '-q'], { cwd: root });
		expect(() => findEncodingOffenses(root)).toThrow('No tracked text files');
	});
});
