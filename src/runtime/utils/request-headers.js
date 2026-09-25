/**
 * Duplicate-aware request-header collection, shared by every entry point that
 * needs the full header set.
 *
 * Node's own `req.headers` merge is close to - but not - the family policy:
 * it silently keeps the FIRST line of most singleton headers and comma-joins
 * the proxy identity headers, so a two-line `x-forwarded-proto` arrives as
 * "https, https" (which the origin parser rightly refuses) and a duplicated
 * `host` is silently picked between instead of refused. Collection therefore
 * walks `req.rawHeaders` and applies the policy per header CLASS:
 *
 *   - LIST-VALUED, the default. Every header whose grammar is a comma-separated
 *     list - `x-forwarded-for`, `forwarded`, `via`, `accept-encoding`, and the
 *     open-ended set of vendor chains - is joined with ", " in ARRIVAL ORDER,
 *     the form RFC 9110 defines as equivalent to the separate lines. This is
 *     the DEFAULT precisely because the list-header universe cannot be
 *     enumerated: a vendor chain nobody here has heard of must not silently
 *     lose hops.
 *
 *   - `cookie` joins with "; ", not ", ". Several `Cookie` lines are what an
 *     HTTP/2 to HTTP/1.1 downgrade at an edge proxy produces, and a comma join
 *     would fold every cookie after the first into the last cookie's VALUE.
 *
 *   - `set-cookie` is never joined. It is not a list header (a comma is legal
 *     inside an `Expires` date), so joining corrupts the cookies rather than
 *     concatenating them. It carries no meaning on a request in the first
 *     place, so the first line is kept, the rest are dropped, and the request
 *     is still served.
 *
 *   - SINGLE-VALUED PROXY headers keep the LAST line: the well-known spellings
 *     below plus every name this deployment configured, `x-forwarded-for`
 *     excepted. These carry one scheme, one host, one port or one address, and
 *     joining them produces a value that is not any of those things.
 *
 *   - SINGLE-VALUED framing / identity headers REFUSE the request. See the set
 *     below for why merging or picking is the wrong answer for those.
 */

/**
 * Headers where a second line refuses the request rather than being merged or
 * picked between.
 *
 * Deliberately short. Every name here is one where a wrong pick changes how the
 * request is FRAMED, how its body is PARSED, WHO it is from, or WHICH origin it
 * claims - and whichever value this layer picks, the proxy in front may have
 * picked the other, which is the request-smuggling shape. Merging them is
 * meaningless (two `Host` values are not one host) and choosing between them is
 * a security decision this layer must not make silently, so the answer is to
 * refuse and let the ambiguity die at the door.
 *
 * Everything else takes the list-join default or the last-line rule below,
 * including headers no real client repeats: refusing traffic over a header
 * nothing reads is a worse failure than merging it.
 */
const SINGLE_VALUED = new Set([
	'host',
	'content-length',
	'transfer-encoding',
	'content-type',
	'authorization',
	'proxy-authorization',
	'origin'
]);

/**
 * The only Transfer-Encoding a request may carry. RFC 9112 6.1: chunked must
 * be applied at most once and must be the final encoding, so `chunked` alone
 * is the only spelling with one meaning; `chunked, chunked`, `gzip, chunked`
 * and `chunked, gzip` are all refusals, and so is a coding this server cannot
 * decode on its own (`gzip`, `xchunked`).
 *
 * This matters more than conformance. node's parser refuses most of those
 * spellings itself, but it decodes a coding list that ENDS in chunked
 * (`gzip, chunked`) as chunked, and hands a request with an EMPTY
 * Transfer-Encoding to the listener as a bodyless one, whose body bytes it
 * then parses as the next request. A conformant intermediary in front reads
 * both differently, and the two then disagree about where the request ends,
 * which is what a smuggled request is made of.
 */
const CHUNKED = 'chunked';

/**
 * A Content-Length is a bare decimal count, and never empty.
 *
 * @param {string} value
 */
function isDecimalCount(value) {
	if (value.length === 0) return false;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

/**
 * Does this request frame its body two ways at once? Returns the header to
 * name in the refusal, or null when the framing has one reading.
 *
 * `undefined` is an ABSENT header and the empty string is one sent with
 * nothing after the colon. The two are not the same answer: an empty
 * Transfer-Encoding names no coding at all, and an empty Content-Length is a
 * body length that does not say how long. Values arrive trimmed of
 * surrounding whitespace by the parser.
 *
 * Asked two ways. Every lane that builds a header set asks it of the whole
 * set, where an empty value and a repeat are both visible for free. The
 * request edge asks it of ONE lookup, `transfer-encoding`, ahead of the lanes
 * that answer without building a set - see `handleRequest` for what that
 * covers and what it cannot.
 *
 * @param {string | undefined} transferEncoding
 * @param {string | undefined} contentLength
 * @returns {'transfer-encoding' | 'content-length' | null}
 */
export function framingRefusal(transferEncoding, contentLength) {
	if (transferEncoding !== undefined) {
		if (transferEncoding.toLowerCase() !== CHUNKED) return 'transfer-encoding';
		// Both headers, each naming a different end to the same body. RFC 9112
		// 6.3 says the chunked framing wins and that the message may be a
		// smuggling attempt; node's parser answers this one before any of this
		// runs, so the rule is here to own it rather than to rely on that
		// staying true.
		if (contentLength !== undefined) return 'transfer-encoding';
	}
	if (contentLength !== undefined && !isDecimalCount(contentLength)) return 'content-length';
	return null;
}

/**
 * Is this the name of a header that says where the request body ends? A
 * refusal naming one of these cannot be answered on a connection that stays
 * open: the bytes after the response are whatever the sender's own reading of
 * the framing put there.
 *
 * @param {string | null} header
 */
export function isFramingHeader(header) {
	return header === 'content-length' || header === 'transfer-encoding';
}

/**
 * The value of a header's FIRST line, or the empty string when the request
 * carries none: the answer a single header lookup gives, where an absent
 * header and one sent empty read the same and a repeat reads as its first
 * line. For the one-lookup question the request edge asks ahead of the lanes
 * that never build a header set.
 *
 * @param {string[]} rawHeaders node's IncomingMessage.rawHeaders
 * @param {string} name lowercase
 * @returns {string}
 */
export function firstHeaderValue(rawHeaders, name) {
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const key = rawHeaders[i];
		if (key.length === name.length && key.toLowerCase() === name) return rawHeaders[i + 1];
	}
	return '';
}

/**
 * Headers this runtime, or the app in front of it, reads as ONE value, where
 * the last line is the one to keep.
 *
 * These are the headers a reverse proxy writes about the connection it
 * accepted: one scheme, one external host, one external port, one client
 * address. A join does not produce a longer version of any of those, it
 * produces a value of the wrong SHAPE - and the shape is load-bearing here,
 * because the runtime parses each of them: the origin parser rejects a
 * protocol that is not exactly "http" or "https", and the client-IP
 * resolver's non-chain branch takes the value verbatim and, over its length
 * bound, truncates KEEPING THE LEADING bytes - the proxy's for a single line,
 * the CLIENT'S for a joined one.
 *
 * Last line rather than first, and rather than a refusal: the hop in front
 * APPENDS (the same appending behavior that makes the list-join default
 * necessary), so the last line is the proxy's and any earlier one is whatever
 * the client sent.
 */
const WELL_KNOWN_PROXY_SINGLE_VALUED = [
	'x-forwarded-proto',
	'x-forwarded-protocol',
	'x-forwarded-scheme',
	'x-forwarded-host',
	'x-forwarded-port',
	'x-real-ip',
	'cf-connecting-ip',
	'true-client-ip',
	'x-client-ip',
	'fly-client-ip'
];

/**
 * The one header name a declaration cannot move into the last-line class.
 *
 * `ADDRESS_HEADER=x-forwarded-for` is the documented configuration and the
 * whole reason the join exists. It stays joined ONLY because the resolver has
 * a matching branch: `createClientIpResolver` (utils/trusted-proxies.js)
 * compares the configured name against this exact string and, on a match,
 * counts hops from the RIGHT and truncates from the HEAD, so a joined chain
 * still resolves to the hop the depth names and an over-long one keeps the
 * proxy-authored tail. Every OTHER configured name reaches the resolver's
 * single-address branch, which truncates keeping the LEADING bytes - the
 * proxy's bytes for a single line, the CLIENT'S for a joined one. A second
 * name may only be added here in the same change that widens that comparison
 * in trusted-proxies.js: the two are one policy.
 */
const RESOLVER_CHAIN_HEADER = 'x-forwarded-for';

/** @type {Set<string>} */
let proxySingleValued = new Set(WELL_KNOWN_PROXY_SINGLE_VALUED);

/**
 * Declare the header names THIS deployment reads as a single value, on top of
 * the well-known spellings.
 *
 * `PROTOCOL_HEADER` / `HOST_HEADER` / `PORT_HEADER` / `ADDRESS_HEADER` are
 * operator-chosen names, so the class a repeated line belongs to cannot be
 * known from the name alone. The runtime declares them once at boot, before it
 * listens, and every collection site in the process then agrees.
 *
 * REPLACES the previous declaration rather than adding to it, so a caller can
 * put the policy back by declaring nothing. `x-forwarded-for` is the one name
 * a declaration cannot move: see RESOLVER_CHAIN_HEADER.
 *
 * @param {Array<string | undefined | null>} names - configured header names,
 *   empty entries allowed (an unset knob reads back as '')
 */
export function declareSingleValuedProxyHeaders(names) {
	const declared = new Set(WELL_KNOWN_PROXY_SINGLE_VALUED);
	for (const raw of names) {
		const name = String(raw || '').toLowerCase();
		if (!name || name === RESOLVER_CHAIN_HEADER) continue;
		declared.add(name);
	}
	proxySingleValued = declared;
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Collect every header line of a node request into `headers`, applying the
 * per-class duplicate policy above. Walks `rawHeaders` (the [name, value,
 * name, value, ...] flat array, case preserved, repeats preserved) because
 * node's pre-merged `req.headers` has already applied its own policy.
 *
 * Fills a caller-supplied object rather than returning one; the return value
 * is the FINDING, not the result. Callers must treat a non-null return as
 * fatal for that request (400). Collection still completes under the same
 * policy it started with: a refusal names ONE header - a framing one where the
 * request has one, else the first offender - without changing what any other
 * header collects to.
 *
 * `hasOwn` guards the names that live on `Object.prototype`: a header may
 * legally be called `constructor` or `valueOf`, and those read back as an
 * inherited function rather than `undefined`, so the cheap check alone would
 * report a first sighting as a duplicate.
 *
 * Two source shapes reach this, and both are real: node's flat `rawHeaders`
 * pair array is what every HTTP and upgrade exchange here carries, while the
 * family's request objects expose their lines through a `forEach(name, value)`
 * visitor. Same policy either way - one collection point means a correction
 * lands on both.
 *
 * @param {string[] | { forEach(visitor: (name: string, value: string) => void): void }} source -
 *   node's IncomingMessage.rawHeaders, or a request exposing a header visitor
 * @param {Record<string, string>} headers - filled in place, lowercase keys
 * @returns {string | null} the header to name in a refusal - one that frames
 *   the body two ways, or the first single-valued header that arrived more than
 *   once - or null when the request has a single reading
 */
export function collectRequestHeaders(source, headers) {
	/** @type {string | null} */
	let ambiguous = null;
	/** @type {string | null} */
	let framingRepeat = null;
	/**
	 * @param {string} key
	 * @param {string} value
	 */
	const take = (key, value) => {
		const refused = takeHeaderLine(headers, key, value);
		if (refused === null) return;
		// Name the FIRST offender and keep walking. Stopping the merge here
		// would make every later repeated header first-wins, which is neither
		// the documented contract nor a policy anything asked for.
		if (ambiguous === null) ambiguous = refused;
		// A repeated FRAMING header is remembered separately, because the two
		// answers do different things for the caller and the first offender is
		// whichever line the sender chose to put first. Two Origin lines say
		// the request is ambiguous; two Content-Length lines say the sender
		// and this server may not agree where it ENDS, and only that answer
		// makes the caller close the connection.
		if (framingRepeat === null && isFramingHeader(refused)) framingRepeat = refused;
	};
	if (Array.isArray(source)) {
		// node keeps the sender's spelling in rawHeaders; the visitor shape
		// below already speaks lowercase, as the family's request objects do,
		// and its names are stored exactly as given.
		for (let i = 0; i < source.length; i += 2) {
			const refused = takeHeaderLine(headers, source[i].toLowerCase(), source[i + 1]);
			if (refused === null) continue;
			if (ambiguous === null) ambiguous = refused;
			if (framingRepeat === null && isFramingHeader(refused)) framingRepeat = refused;
		}
	} else {
		source.forEach(take);
	}
	// A framing answer comes FIRST, ahead of any other repeat the walk found.
	// Both name a header the caller refuses, but only a framing one tells it the
	// connection can no longer be read, and any other repeated single-valued
	// header would otherwise mask it - two Origin lines in front of two
	// Content-Length lines would answer `origin`, and the refusal would keep a
	// connection whose remaining bytes are exactly what the two readings
	// disagree about.
	//
	// Both dimensions, because they hide from each other: the VALUE question
	// below reads the header the walk kept, which is the FIRST of a repeated
	// pair, so a repeat whose first value is a usable one answers null there and
	// is caught only by `framingRepeat`.
	//
	// Free here, where every header has just been read anyway, and reading the
	// object keeps an absent header apart from one sent empty.
	const framing = framingRefusal(headers['transfer-encoding'], headers['content-length']);
	if (framing !== null) return framing;
	if (framingRepeat !== null) return framingRepeat;
	return ambiguous;
}

/**
 * Apply the policy to one header line. Returns the header's name when the line
 * is a refused duplicate, null otherwise.
 *
 * @param {Record<string, string>} headers - filled in place, lowercase keys
 * @param {string} key - lowercase header name
 * @param {string} value
 * @returns {string | null}
 */
function takeHeaderLine(headers, key, value) {
	const previous = headers[key];
	if (previous === undefined || !hasOwn.call(headers, key)) {
		headers[key] = value;
		return null;
	}
	if (SINGLE_VALUED.has(key)) return key;
	if (key === 'set-cookie') return null;
	if (proxySingleValued.has(key)) {
		headers[key] = value;
		return null;
	}
	headers[key] = key === 'cookie'
		? previous + '; ' + value
		: previous + ', ' + value;
	return null;
}
