import { isAscii } from 'node:buffer';

/**
 * The native parser trims signed bytes below 33 at both ends of header values,
 * including bytes above 127. Replace those high edge bytes with spaces before
 * node parses framing and upgrade headers. Preserve byte offsets and leave
 * interior bytes, invalid controls and field names for the parser to validate.
 * Ordinary ASCII heads keep their original buffer without a header scan.
 *
 * @param {Buffer} head - One complete request head, including its request line.
 * @param {boolean} [ascii] - Whether the complete head contains only ASCII bytes.
 * @returns {Buffer}
 */
export function normalizeHeaderEdges(head, ascii = isAscii(head)) {
	if (ascii) return head;
	let result = head;
	let start = head.indexOf('\r\n') + 2;
	if (start < 2) return head;
	while (start < head.length) {
		const end = head.indexOf('\r\n', start);
		if (end <= start) break;
		const colon = head.indexOf(58, start);
		if (colon > start && colon < end) {
			let left = colon + 1;
			let right = end - 1;
			while (left <= right && edge(head[left])) {
				if (head[left] >= 128) {
					if (result === head) result = Buffer.from(head);
					result[left] = 32;
				}
				left++;
			}
			while (right >= left && edge(head[right])) {
				if (head[right] >= 128) {
					if (result === head) result = Buffer.from(head);
					result[right] = 32;
				}
				right--;
			}
		}
		start = end + 2;
	}
	return result;
}

/** @param {number} byte */
function edge(byte) {
	return byte === 32 || byte === 9 || byte >= 128;
}

/**
 * Preserve DEL bytes accepted in native header values while keeping node's
 * strict parser for field names, control bytes, framing and upgrade syntax.
 * The same-width stand-in leaves parser offsets and head limits unchanged.
 * @param {Buffer} head
 * @returns {{ head: Buffer, values: Array<[number, string]> } | null}
 */
export function normalizeHeaderDel(head) {
	if (!head.includes(127)) return null;
	let result = head;
	const values = [];
	let start = head.indexOf('\r\n') + 2;
	let index = 1;
	if (start < 2) return null;
	while (start < head.length) {
		const end = head.indexOf('\r\n', start);
		if (end <= start) break;
		// Folded fields remain a parser refusal, including on older nodes.
		if (head[start] === 32 || head[start] === 9) return null;
		const colon = head.indexOf(58, start);
		if (colon > start && colon < end) {
			let left = colon + 1, right = end - 1;
			while (left <= right && (head[left] === 32 || head[left] === 9)) left++;
			while (right >= left && (head[right] === 32 || head[right] === 9)) right--;
			const del = head.indexOf(127, left);
			if (del >= left && del <= right) {
				if (result === head) result = Buffer.from(head);
				values.push([index, head.toString('latin1', left, right + 1)]);
				for (let i = del; i <= right; i++) if (result[i] === 127) result[i] = 126;
			}
			index += 2;
		}
		start = end + 2;
	}
	return values.length ? { head: result, values } : null;
}

/** Keep llhttp's close flag from ending a read before its later requests. */
export function normalizeConnectionClose(head) {
	const text = head.toString('latin1');
	if (!/\r\nconnection:[^\r\n]*(?:\r\n[\t ][^\r\n]*)*close/i.test(text)) return null;
	const pattern = /\r\nconnection:([^\r\n]*(?:\r\n[\t ][^\r\n]*)*)/gi;
	let result = head;
	const values = [];
	let ordinal = 0;
	for (const match of text.matchAll(pattern)) {
		const index = ordinal++;
		const value = match[1];
		if (!/close/i.test(value)) continue;
		const start = match.index + match[0].length - value.length;
		const tokens = [...value.matchAll(/cl[o0]se/gi)];
		values.push([index, tokens.map(token => token[0])]);
		if (result === head) result = Buffer.from(head);
		for (const token of tokens) if (/close/i.test(token[0])) result[start + token.index + 2] = 48;
	}
	return result === head ? null : { head: result, values };
}

/** Restore token spelling independently of llhttp's header whitespace folding. */
export function restoreConnectionClose(req, values) {
	let ordinal = 0;
	let next = 0;
	for (let i = 0; i < req.rawHeaders.length && next < values.length; i += 2) {
		if (req.rawHeaders[i].toLowerCase() !== 'connection') continue;
		if (ordinal++ !== values[next][0]) continue;
		const tokens = values[next++][1];
		let token = 0;
		req.rawHeaders[i + 1] = req.rawHeaders[i + 1].replace(/cl[o0]se/gi, value => tokens[token++] ?? value);
	}
	req.headers = null;
	req.headersDistinct = null;
}
