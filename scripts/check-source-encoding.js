#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredBinary, divergentPaths, indexBlobs, trackedEol } from './check-source-bytes.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });
// Windows-1252 gives these byte positions printable characters. The remaining
// positions map directly, including Latin-1's C1 range after a mistaken read.
const cp1252 = new Map([
	[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
	[0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
	[0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
	[0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
	[0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
	[0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
	[0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
]);
const legacyByte = code => code <= 0xff ? code : cp1252.get(code);
// These common corruption markers cover Western text and repeated encoding.
// Do not treat every accented capital as a UTF-8 lead byte: legitimate letters
// followed by a nonbreaking space or a symbol can form the same byte pattern.
const markers = new Set([0xc2, 0xc3, 0xc5, 0xe2, 0xef, 0xf0]);

/** Recognize a complete UTF-8 sequence misread as Latin-1 or Windows-1252. */
export function encodingProblems(bytes) {
	let text;
	try { text = decoder.decode(bytes); }
	catch { return [{ line: 1, reason: 'invalid UTF-8' }]; }
	const hits = [];
	let line = 1;
	for (let at = 0; at < text.length; at++) {
		if (text[at] === '\n') { line++; continue; }
		const first = legacyByte(text.charCodeAt(at));
		if (!markers.has(first)) continue;
		const length = first >= 0xc2 && first <= 0xdf ? 2
			: first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
		if (!length || at + length > text.length) continue;
		const sequence = [first];
		for (let i = 1; i < length; i++) sequence.push(legacyByte(text.charCodeAt(at + i)));
		if (!sequence.slice(1).every(byte => byte >= 0x80 && byte <= 0xbf)) continue;
		// A Scandinavian capital followed by spacing or a mark is ambiguous.
		if (first === 0xc5 && (sequence[1] === 0xa0 || sequence[1] === 0xae)) continue;
		// Reject overlong sequences, surrogate code points and values past U+10FFFF.
		if ((first === 0xe0 && sequence[1] < 0xa0) || (first === 0xed && sequence[1] > 0x9f)
			|| (first === 0xf0 && sequence[1] < 0x90) || (first === 0xf4 && sequence[1] > 0x8f)) continue;
		hits.push({ line, reason: 'possible double-encoded UTF-8; restore the original text using an explicit UTF-8 read and write' });
		if (hits.length === 8) break;
		at += length - 1;
	}
	return hits;
}

/** Check both working files and staged blobs so an unstaged repair cannot hide a bad commit. */
export function findEncodingOffenses(rootDirectory = root, read = file => {
	try { return readFileSync(resolve(rootDirectory, file)); } catch { return null; }
}) {
	const tracked = trackedEol(rootDirectory);
	const attributes = execFileSync('git', ['check-attr', '--cached', '-z', '--stdin', 'text'], {
		cwd: rootDirectory, encoding: 'utf8', input: tracked.map(row => row.path).join('\0') + '\0', maxBuffer: 64 * 1024 * 1024
	}).split('\0');
	const binaryInIndex = new Set();
	for (let i = 0; i + 2 < attributes.length; i += 3) {
		if (attributes[i + 2] === 'unset') binaryInIndex.add(attributes[i]);
	}
	const rows = tracked.filter(row => !declaredBinary(row.attr) || !binaryInIndex.has(row.path));
	if (rows.length === 0) throw new Error('No tracked text files were found; nothing was checked');
	const divergent = divergentPaths(rootDirectory);
	const staged = indexBlobs(rows.filter(row => !binaryInIndex.has(row.path)
		&& (divergent.has(row.path) || declaredBinary(row.attr))).map(row => row.path), rootDirectory);
	const offenses = [];
	for (const row of rows) {
		const disk = declaredBinary(row.attr) ? null : read(row.path);
		if (disk === null && !staged.has(row.path)) offenses.push(`${row.path}: tracked file could not be read`);
		const copies = [];
		if (disk !== null) copies.push(['working copy', disk]);
		if (staged.has(row.path)) {
			const blob = staged.get(row.path);
			if (blob === null) offenses.push(`${row.path}: staged blob could not be read`);
			else copies.push(['staged blob', blob]);
		}
		for (const [where, bytes] of copies) {
			for (const hit of encodingProblems(bytes)) offenses.push(`${row.path}:${hit.line}: ${hit.reason} (${where})`);
		}
	}
	return { offenses, scanned: rows.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { offenses, scanned } = findEncodingOffenses();
		if (offenses.length) {
			for (const offense of offenses) console.error(offense);
			process.exitCode = 1;
		} else console.log(`check-source-encoding: ${scanned} tracked text files checked`);
	} catch (error) {
		console.error('check-source-encoding failed: ' + error.message);
		process.exitCode = 1;
	}
}
