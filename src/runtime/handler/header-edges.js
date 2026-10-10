import { isAscii } from 'node:buffer';

/**
 * The native parser trims signed bytes below 33 at both ends of header values,
 * including bytes above 127. Replace those high edge bytes with spaces before
 * node parses framing and upgrade headers. Preserve byte offsets and leave
 * interior bytes, invalid controls and field names for the parser to validate.
 * Ordinary ASCII heads keep their original buffer without a header scan.
 *
 * @param {Buffer} head - One complete request head, including its request line.
 * @returns {Buffer}
 */
export function normalizeHeaderEdges(head) {
	if (isAscii(head)) return head;
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
