// Each message prefix in docs/errors.md renders as exactly that prefix.
//
// The reference quotes every prefix three times: as an inline code span in its
// index-table row and in the indexed-console-lines bullet, and as an inline code span
// in its own section. A prefix that carries backticks closed a
// single-backtick span early, so the rest spilled out as prose. This parses the
// committed reference with a CommonMark renderer rather than trusting the
// string it was built from.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = readFileSync(path.join(ROOT, 'docs/errors.md'), 'utf8');
const lines = reference.split('\n');
const md = new MarkdownIt();

/** The code spans markdown-it finds in one markdown line, in order. */
function codeSpans(line) {
	const spans = [];
	for (const token of md.parse(line, {})) {
		for (const child of token.children || []) {
			if (child.type === 'code_inline') spans.push(child.content);
		}
	}
	return spans;
}

const decode = (html) => html
	.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('message prefixes in the error reference', () => {
	const withPrefix = ADAPTER_ERROR_REGISTRY.filter((entry) => typeof entry.messagePrefix === 'string');

	it('covers a prefix that carries backticks, so the cases can fail', () => {
		expect(withPrefix.some((entry) => entry.messagePrefix.includes('`'))).toBe(true);
	});

	it('renders each prefix exactly in its index-table row', () => {
		for (const entry of withPrefix) {
			const row = lines.find((l) => l.startsWith('| [' + entry.id + '](#'));
			expect(row, entry.id).toBeTruthy();
			// Rendered as a whole table so the cell boundaries are the renderer's.
			const table = md.render('| a | b | c |\n|---|---|---|\n' + row);
			const cells = [...table.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
			expect(cells, entry.id + ' keeps three cells').toHaveLength(3);
			expect(decode(cells[2].replace(/^<code>|<\/code>$/g, '')), entry.id).toBe(entry.messagePrefix);
		}
	});

	it('renders each console prefix exactly in its bullet', () => {
		const from = lines.findIndex((l) => l.startsWith('Indexed console lines'));
		expect(from, 'the console-lines section moved').toBeGreaterThan(-1);
		const to = lines.findIndex((l, i) => i > from && l.startsWith('#'));
		const section = lines.slice(from, to);
		const consoleEntries = withPrefix.filter((entry) => entry.emission === 'console');
		expect(consoleEntries.length, 'a scan that found nothing proves nothing').toBeGreaterThan(10);
		for (const entry of consoleEntries) {
			const bullet = section.find((l) => l.endsWith(' - [' + entry.id + '](#' + entry.anchor + ')'));
			expect(bullet, entry.id + ' has a console bullet').toBeTruthy();
			expect(codeSpans(bullet), entry.id).toEqual([entry.messagePrefix]);
		}
	});

	it('renders each prefix exactly in its own section', () => {
		for (const entry of withPrefix) {
			const anchor = lines.indexOf('<a id="' + entry.anchor + '"></a>');
			expect(anchor, entry.id + ' has an explicit anchor').toBeGreaterThan(-1);
			const next = lines.findIndex((line, index) => index > anchor && line.startsWith('<a id="'));
			const section = lines.slice(anchor, next === -1 ? lines.length : next);
			const prefix = section.find((line) => line.startsWith('- **Message prefix:** '));
			expect(prefix, entry.id + ' has a message prefix').toBeTruthy();
			expect(codeSpans(prefix), entry.id).toEqual([entry.messagePrefix]);
			const key = section.find((line) => line.startsWith('- **Code/event:** '));
			expect(codeSpans(key), entry.id).toEqual([entry.code || entry.event]);
			expect(section).toContain('- **Runtime help:** ' + '\x60' + entry.help + '\x60');
			for (const [label, field] of [['Cause', 'cause'], ['Consequence', 'consequence'], ['Automatic recovery', 'automaticRecovery'], ['Next action', 'nextAction']]) {
				expect(section).toContain('- **' + label + ':** ' + entry[field]);
			}
			const sources = section.find((line) => line.startsWith('- **Runtime sources:** '));
			for (const source of entry.sources) expect(sources).toContain('[' + source + '](../' + source + ')');
			if (entry.link) expect(section).toContain('- **Operator shortlink:** ' + '\x60' + entry.link + '\x60');
		}
	});
});
