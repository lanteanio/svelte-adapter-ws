// Substituted by the adapter's build step; free identifiers until then.
/* global PRECOMPRESS */
/* global STATIC_DOTFILES */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, prerendered } from '../manifest-bridge.js';
import { excludedDotPath } from '../utils/dot-path.js';
import { mimeLookup } from '../utils/mime.js';
import { contentDispositionValue, mergeStaticHeaders, resolveStaticCacheControl } from '../utils/static-headers.js';
import { monotonicNow } from '../runtime.js';
import { staticCache, prerenderedDirStyle, decodeCache } from './state.js';
import { send400 } from './http-helpers.js';

// File extensions that browsers cannot render inline. Serving these with
// Content-Disposition: attachment prompts a download dialog instead of
// showing a blank or error page.
const DOWNLOAD_EXTENSIONS = new Set([
	'.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
	'.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
	'.iso', '.img', '.bin'
]);

// Every static representation varies on Accept-Encoding: the coding negotiated
// for one client must never be replayed from a shared cache to another. Also
// written on 304 responses, which update a stored entry and must not erase the
// dimension that entry is keyed on.
const VARY_ON = 'Accept-Encoding';

// This module sits one level below the runtime payload root (in handler/), but
// the client/ and prerendered/ asset directories the build emits live at that
// root next to the entry, so resolve up one level from this file's own location.
const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recursively walk a directory and call fn for each file.
 * @param {string} dir
 * @param {(relPath: string, absPath: string) => void} fn
 * @param {string} prefix
 */
function walk(dir, fn, prefix = '') {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir)) {
		const rel = prefix ? `${prefix}/${entry}` : entry;
		// Dot-segment paths never enter the index, so the request path has
		// nothing to bypass - the cache simply has no entry, and an encoded
		// traversal decodes to a key that is not there. A refused directory is
		// not descended into either, so an unpacked .git is never even read.
		// `.well-known` stays served; excludedDotPath carries the exact rule,
		// and the build warns about every path this skips.
		if (!STATIC_DOTFILES && excludedDotPath(rel)) continue;
		const abs = path.join(dir, entry);
		if (fs.statSync(abs).isDirectory()) {
			walk(abs, fn, rel);
		} else {
			fn(rel, abs);
		}
	}
}

/**
 * The validator for one content-coding of an asset.
 *
 * A content-coding produces a DISTINCT representation, and distinct
 * representations need distinct validators (RFC 9110 8.8). Sharing the identity
 * ETag across codings makes a compressed copy and an uncompressed copy claim to
 * be the same octets, so a client resuming its compressed download with
 * If-Range gets a match and is handed identity bytes at offsets it computed
 * against the compressed stream - a silently corrupt file. Suffixing the coding
 * keeps each representation independently cacheable and turns a
 * cross-representation If-Range into a mismatch, which is the safe outcome.
 * This is the validator half only: what makes the offsets themselves right is
 * serveStatic cutting the range out of the representation it negotiated.
 *
 * The input is always the weak quoted form built in cacheDir, so the coding goes
 * inside the closing quote. Immutable assets carry no validator at all.
 *
 * @param {string} baseEtag - the identity ETag, '' for immutable assets
 * @param {'br' | 'gzip'} encoding
 * @returns {string}
 */
function representationEtag(baseEtag, encoding) {
	if (!baseEtag) return '';
	return `${baseEtag.slice(0, -1)}-${encoding}"`;
}

/**
 * Derive the response headers for one content-coding of an asset, once at index
 * time. Only the validator differs from the identity tuples, plus the
 * Content-Encoding that names the coding.
 *
 * `accept-ranges: bytes` is deliberately kept: a byte range is served from
 * whichever representation the request negotiated, so the coded copy really can
 * satisfy one, in its own coordinates.
 *
 * @param {[string, string][]} base - identity tuples, already merged with staticHeaders
 * @param {string} variantEtag - this coding's validator, '' for immutable assets
 * @param {'br' | 'gzip'} encoding
 * @returns {[string, string][]}
 */
function variantHeaders(base, variantEtag, encoding) {
	/** @type {[string, string][]} */
	const out = [];
	for (let i = 0; i < base.length; i++) {
		if (base[i][0] === 'etag') {
			out.push(['etag', variantEtag]);
			continue;
		}
		out.push([base[i][0], base[i][1]]);
	}
	out.push(['content-encoding', encoding]);
	return out;
}

/**
 * Read one header value out of a representation's baked tuples. Used on the
 * 304 path only, where the response is assembled field by field rather than by
 * replaying the whole tuple loop.
 *
 * @param {[string, string][]} tuples
 * @param {string} name - lowercase field name
 * @returns {string}
 */
function headerValue(tuples, name) {
	for (let i = 0; i < tuples.length; i++) {
		if (tuples[i][0] === name) return tuples[i][1];
	}
	return '';
}

/**
 * Flatten header tuples plus content-type and content-length into the flat
 * [k1, v1, k2, v2, ...] array node's writeHead accepts. Precomputed once per
 * representation at index time so the per-request 200 path is one writeHead
 * with zero allocation.
 *
 * @param {[string, string][]} tuples
 * @param {string} contentType
 * @param {number} contentLength
 * @returns {(string | number)[]}
 */
function flattenHeaders(tuples, contentType, contentLength) {
	/** @type {(string | number)[]} */
	const flat = ['content-type', contentType, 'content-length', contentLength];
	for (let i = 0; i < tuples.length; i++) {
		flat.push(tuples[i][0], tuples[i][1]);
	}
	return flat;
}

/**
 * Load a directory into the static cache.
 * @param {string} dir
 * @param {string} urlPrefix
 * @param {boolean} immutable
 * @param {Record<string, string> | null} [staticHeaders] - app-configured
 *   headers merged into every static (and prerendered) response. See
 *   `mergeStaticHeaders`; reserved transfer/caching headers are never
 *   overridden.
 * @param {{ pattern: string, cacheControl: string }[] | null} [staticCacheControl]
 *   prevalidated path-specific cache policies, resolved once per file.
 */
export function cacheDir(dir, urlPrefix, immutable, staticHeaders = null, staticCacheControl = null) {
	walk(dir, (relPath, absPath) => {
		if (relPath.endsWith('.br') || relPath.endsWith('.gz')) return;

		const urlPath = `${urlPrefix}/${relPath}`;
		const contentType = mimeLookup(relPath);
		const buffer = fs.readFileSync(absPath);
		const stat = fs.statSync(absPath);

		/** @type {[string, string][]} */
		const headers = [
			['x-content-type-options', 'nosniff'],
			['vary', VARY_ON],
			['accept-ranges', 'bytes']
		];
		let etag = '';
		let lastModifiedMs;
		if (immutable && relPath.startsWith(`${manifest.appPath}/immutable/`)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
			const configuredCacheControl = resolveStaticCacheControl(relPath, staticCacheControl);
			// Last-Modified rides beside the ETag with HTTP-date (whole second)
			// resolution; the parsed millisecond value is kept on the entry so an
			// If-Modified-Since comparison is a number compare, not a re-parse.
			const lastModified = new Date(stat.mtimeMs).toUTCString(); // determinism-allow: converts the file's own mtime, reads no clock
			lastModifiedMs = Date.parse(lastModified);
			headers.push(
				['cache-control', configuredCacheControl || 'no-cache'],
				['etag', etag],
				['last-modified', lastModified]
			);
		}

		const ext = path.extname(relPath).toLowerCase();
		if (DOWNLOAD_EXTENSIONS.has(ext)) {
			// The rule lives in utils/static-headers.js rather than here, so a unit
			// test can drive THIS and not a copy of it: this module imports the
			// build's manifest placeholder and cannot be imported by one.
			headers.push(['content-disposition', contentDispositionValue(path.basename(relPath))]);
		}

		const merged = mergeStaticHeaders(headers, staticHeaders);
		/** @type {import('./state.js').StaticEntry} */
		const entry = {
			buffer,
			contentType,
			etag,
			lastModifiedMs,
			headers: merged,
			headersFlat: flattenHeaders(merged, contentType, buffer.byteLength)
		};

		if (PRECOMPRESS) {
			const brPath = absPath + '.br';
			const gzPath = absPath + '.gz';
			if (fs.existsSync(brPath)) {
				const brBuf = fs.readFileSync(brPath);
				if (brBuf.byteLength < buffer.byteLength) entry.brBuffer = brBuf;
			}
			if (fs.existsSync(gzPath)) {
				const gzBuf = fs.readFileSync(gzPath);
				if (gzBuf.byteLength < buffer.byteLength) entry.gzBuffer = gzBuf;
			}
			// Bake each available coding's validator and headers now, beside the
			// buffer they belong to: serving a coded response then costs the same
			// single writeHead identity costs, and a conditional request compares
			// against a string that already exists.
			if (entry.brBuffer) {
				entry.brEtag = representationEtag(etag, 'br');
				entry.brHeaders = variantHeaders(entry.headers, entry.brEtag, 'br');
				entry.brHeadersFlat = flattenHeaders(entry.brHeaders, contentType, entry.brBuffer.byteLength);
			}
			if (entry.gzBuffer) {
				entry.gzEtag = representationEtag(etag, 'gzip');
				entry.gzHeaders = variantHeaders(entry.headers, entry.gzEtag, 'gzip');
				entry.gzHeadersFlat = flattenHeaders(entry.gzHeaders, contentType, entry.gzBuffer.byteLength);
			}
		}

		staticCache.set(urlPath, entry);

		// Prerendered pages: register clean pathname aliases for the static fast
		// path and tryPrerendered().
		//
		// SvelteKit writes directory-style output (about/index.html) when
		// trailingSlash is 'always', and file-style (about.html) otherwise.
		// builder.prerendered.paths always lists "/about" (no trailing slash).
		//
		// For directory-style pages we register the trailing-slash form in
		// staticCache (served on the fast path) and track the bare path in
		// prerenderedDirStyle so tryPrerendered() can redirect /about -> /about/.
		// For file-style pages we register the bare path (no trailing slash).
		if (!immutable) {
			if (relPath === 'index.html') {
				if (urlPrefix) {
					// Base root with non-empty base: /base/ is canonical
					staticCache.set(urlPrefix + '/', entry);
					prerenderedDirStyle.add(urlPrefix);
				} else {
					// Site root: / is already canonical
					staticCache.set('/', entry);
				}
			} else if (relPath.endsWith('/index.html')) {
				// Directory-style: trailing slash is canonical
				const cleanPath = `${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`;
				staticCache.set(cleanPath + '/', entry);
				prerenderedDirStyle.add(cleanPath);
			} else if (relPath.endsWith('.html')) {
				// File-style: bare path is canonical
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry);
			}
		}
	});
}

export const clientDir = path.join(__dirname, 'client');

export const prerenderedDir = path.join(__dirname, 'prerendered');

export const _t_static = monotonicNow();

/**
 * Parse an HTTP Range header value for a single byte range.
 *
 * @param {string} header - Value of the Range header (e.g. "bytes=0-499")
 * @param {number} fileSize - Total number of bytes in the file
 * @returns {{ start: number, end: number } | null | false}
 */
// parseRange returns:
//   { start, end } - valid range, serve 206
//   null           - syntactically valid but unsatisfiable (start >= fileSize), send 416
//   false          - syntactically invalid, ignore the header and serve full 200
function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	// Multi-range (comma-separated) - not supported; serve full content instead
	if (spec.includes(',')) return false;

	const dash = spec.indexOf('-');
	if (dash < 0) return false;

	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);

	// Reject tokens with non-digit characters (e.g. "1oops"). RFC 7233 requires
	// range values to be pure integers (1*DIGIT grammar production).
	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;

	let start, end;
	if (rawStart === '') {
		// Suffix range: bytes=-N (last N bytes)
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return false;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			// Open-ended: bytes=N- (from N to EOF)
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}

	if (start >= fileSize) return null; // Syntactically valid but unsatisfiable
	end = Math.min(end, fileSize - 1);
	return { start, end };
}

/**
 * Whether a content-coding is acceptable under the request's Accept-Encoding.
 *
 * The common header carries no q-values at all ("gzip, deflate, br, zstd"),
 * and that case stays two substring probes with zero allocation. Only when a
 * q-value is present does the member list get parsed, so an explicit
 * `br;q=0` refusal is honored instead of being read as an offer. An absent
 * coding is acceptable only through a `*` member.
 *
 * @param {string} acceptEncoding
 * @param {'br' | 'gzip'} coding
 * @returns {boolean}
 */
export function acceptsCoding(acceptEncoding, coding) {
	if (acceptEncoding === '') return false;
	if (!acceptEncoding.includes('q=')) {
		return acceptEncoding.includes(coding) || acceptEncoding.includes('*');
	}
	let quality = -1;
	let wildcard = -1;
	let start = 0;
	const len = acceptEncoding.length;
	while (start < len) {
		let end = acceptEncoding.indexOf(',', start);
		if (end === -1) end = len;
		const member = acceptEncoding.slice(start, end).trim();
		start = end + 1;
		if (member === '') continue;
		const semi = member.indexOf(';');
		const name = (semi === -1 ? member : member.slice(0, semi)).trimEnd().toLowerCase();
		let q = 1;
		if (semi !== -1) {
			const match = /;\s*q\s*=\s*([0-9.]+)/i.exec(member.slice(semi));
			if (match) {
				q = parseFloat(match[1]);
				if (!Number.isFinite(q)) q = 0;
			}
		}
		if (name === coding && quality < 0) quality = q;
		else if (name === '*' && wildcard < 0) wildcard = q;
	}
	if (quality >= 0) return quality > 0;
	if (wildcard >= 0) return wildcard > 0;
	return false;
}

/**
 * The 304 response for a validated representation. A 304 updates a stored
 * response, so it names WHICH stored representation was validated (its ETag),
 * what that entry varies on, the freshness policy it is stored under, and its
 * date validator. Without them a shared cache can attach it to the wrong
 * variant and hand a coded body to a client that asked for identity.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} repEtag
 * @param {[string, string][]} headers - the representation's baked tuples
 */
function sendNotModified(res, repEtag, headers) {
	/** @type {Record<string, string>} */
	const notModified = { vary: VARY_ON };
	if (repEtag) notModified.etag = repEtag;
	const cacheControl = headerValue(headers, 'cache-control');
	if (cacheControl) notModified['cache-control'] = cacheControl;
	const lastModified = headerValue(headers, 'last-modified');
	if (lastModified) notModified['last-modified'] = lastModified;
	res.writeHead(304, notModified);
	res.end();
}

/**
 * Whether an ETag list header names `tag`, by OPAQUE EQUALITY. `*` matches any
 * existing representation. Opaque rather than RFC strong comparison is a
 * design position, not an oversight: every validator this lane issues is weak
 * by construction (mtime plus size), and strict strong comparison would answer
 * 412 to a client echoing the exact validator the server handed it. The list
 * splits on commas, which no validator this lane issues can contain.
 *
 * @param {string} header
 * @param {string} tag - a non-empty validator this lane issued
 * @returns {boolean}
 */
function etagListHas(header, tag) {
	if (header === '*') return true;
	let start = 0;
	while (start < header.length) {
		let comma = header.indexOf(',', start);
		if (comma === -1) comma = header.length;
		if (header.slice(start, comma).trim() === tag) return true;
		start = comma + 1;
	}
	return false;
}

/**
 * Evaluate the request's preconditions against a mutable entry, in the RFC's
 * order (RFC 9110 13.2.2): If-Match first, If-Unmodified-Since only in its
 * absence, then If-None-Match, then If-Modified-Since only when no entity
 * validator was sent - so a failed If-Match is never converted into a 304 by
 * a validator later in the chain.
 *
 * If-Match compares against ANY validator the lane issued for this asset
 * (identity, br, gzip): the client may hold whichever representation an
 * earlier negotiation gave it, and which one this request would select is a
 * property of today's Accept-Encoding, not of what the client holds.
 * If-None-Match compares against the SELECTED representation's validator: a
 * 304 says "what you hold is current", and that is only true of the bytes
 * this request would otherwise receive.
 *
 * The date validators use the entry's stored whole-second time, so `<=` and
 * `>` are exact against the HTTP-date the client echoes; an unparseable date
 * is an ignored header, never a refusal.
 *
 * Pure and exported for the case table; the caller guards on the entry
 * carrying a validator at all (immutable assets carry none - their versioned
 * filename is the validator - and skip evaluation entirely).
 *
 * @param {import('./state.js').StaticEntry} entry
 * @param {string} repEtag - the selected representation's validator
 * @param {string} ifMatch
 * @param {string} ifUnmodifiedSince
 * @param {string} ifNoneMatch
 * @param {string} ifModifiedSince
 * @returns {0 | 304 | 412} 0 = serve
 */
/**
 * Compare two validators with RFC 9110's STRONG comparison function: equal,
 * and neither one weak.
 *
 * `If-Range` is the one precondition that requires it. The client is asking to
 * splice bytes onto a prefix it already holds, so the question is not 'is this
 * the same resource' but 'is this the same OCTETS' - and a weak validator
 * answers only the first. Two representations that differ can legitimately
 * share one, which is what makes weak tags right for cache revalidation and
 * unusable here: splicing across a weak match produces a corrupt body under a
 * 206 that says it is fine.
 *
 * Every validator this lane issues is weak by construction (mtime and size,
 * spelled W/"..."), so an `If-Range` carrying one falls through to the full
 * representation - the same fallback a malformed or multi-range header takes.
 * A plain `Range` with no `If-Range` is unaffected: it makes no consistency
 * claim to break, and it is what a resuming download manager actually sends.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function strongMatch(a, b) {
	if (!a || !b) return false;
	if (a.startsWith('W/') || b.startsWith('W/')) return false;
	return a === b;
}

export function staticPreconditions(entry, repEtag, ifMatch, ifUnmodifiedSince, ifNoneMatch, ifModifiedSince) {
	if (ifMatch !== '') {
		const held = etagListHas(ifMatch, entry.etag) ||
			(entry.brEtag !== undefined && etagListHas(ifMatch, entry.brEtag)) ||
			(entry.gzEtag !== undefined && etagListHas(ifMatch, entry.gzEtag));
		if (!held) return 412;
	} else if (ifUnmodifiedSince !== '' && entry.lastModifiedMs !== undefined) {
		const t = Date.parse(ifUnmodifiedSince);
		if (!Number.isNaN(t) && entry.lastModifiedMs > t) return 412;
	}
	if (ifNoneMatch !== '') {
		if (etagListHas(ifNoneMatch, repEtag)) return 304;
	} else if (ifModifiedSince !== '' && entry.lastModifiedMs !== undefined) {
		const t = Date.parse(ifModifiedSince);
		if (!Number.isNaN(t) && entry.lastModifiedMs <= t) return 304;
	}
	return 0;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('./state.js').StaticEntry} entry
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 * @param {string} [ifMatch]
 * @param {string} [ifUnmodifiedSince]
 * @param {string} [ifModifiedSince]
 */
export function serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '', ifMatch = '', ifUnmodifiedSince = '', ifModifiedSince = '') {
	// Negotiation runs FIRST and everything downstream is expressed in the
	// chosen representation's own terms. A content-coding is a distinct
	// representation with its own octet sequence, so the validator compared, the
	// offsets a range names, the total length quoted in Content-Range and the
	// bytes written all have to come from the same one. Measuring a range
	// against the identity file while a coded body was negotiated - which is
	// what a resuming download manager asks for, usually without If-Range -
	// hands back a slice of a representation the client never held: no status
	// code reports it and nothing on the wire catches it, the saved file is just
	// wrong.
	let headers = entry.headers;
	let headersFlat = entry.headersFlat;
	let body = entry.buffer;
	let repEtag = entry.etag;
	if (entry.brBuffer && acceptsCoding(acceptEncoding, 'br')) {
		headers = /** @type {[string, string][]} */ (entry.brHeaders);
		headersFlat = /** @type {(string | number)[]} */ (entry.brHeadersFlat);
		body = entry.brBuffer;
		repEtag = /** @type {string} */ (entry.brEtag);
	} else if (entry.gzBuffer && acceptsCoding(acceptEncoding, 'gzip')) {
		headers = /** @type {[string, string][]} */ (entry.gzHeaders);
		headersFlat = /** @type {(string | number)[]} */ (entry.gzHeadersFlat);
		body = entry.gzBuffer;
		repEtag = /** @type {string} */ (entry.gzEtag);
	}

	// Preconditions are evaluated before Range (RFC 9110 13.2.1), in the
	// RFC's own order and against the validator of the representation this
	// request would actually receive - matching the identity ETag for a
	// client that negotiated brotli would answer 304 for bytes that client
	// never held. Only entries carrying validators evaluate; immutable
	// assets carry none, their versioned filename is the validator.
	if (repEtag && (ifNoneMatch !== '' || ifMatch !== '' || ifUnmodifiedSince !== '' || ifModifiedSince !== '')) {
		const verdict = staticPreconditions(entry, repEtag, ifMatch, ifUnmodifiedSince, ifNoneMatch, ifModifiedSince);
		if (verdict === 412) {
			// The precondition the caller staked the request on does not hold.
			// Minimal on purpose: a 412 updates no stored response.
			res.writeHead(412);
			res.end();
			return;
		}
		if (verdict === 304) {
			sendNotModified(res, repEtag, headers);
			return;
		}
	}

	// Ranges are only offered for representations that carry a validator
	// (mutable assets); immutable versioned assets (_app/immutable/*) never need
	// them, and without a validator a client cannot tell a resume apart from a
	// changed file. Multi-range (bytes=0-499,600-700) is not supported - RFC 9110
	// lets a server ignore multiple ranges and respond with the full content. A
	// Range header that cannot be honoured (malformed, multi-range, stale
	// If-Range) falls through to a normal negotiated 200 rather than costing the
	// client its compression.
	/** @type {{ start: number, end: number } | null | false} */
	let range = false;
	if (rangeHeader && repEtag && (!ifRangeHeader || strongMatch(ifRangeHeader, repEtag)) && !rangeHeader.includes(',')) {
		range = parseRange(rangeHeader, body.byteLength);
	}

	if (range === null) {
		// Syntactically valid but the start position is beyond the end of the
		// representation this request selected, so that is the length to quote.
		res.writeHead(416, { 'content-range': `bytes */${body.byteLength}` });
		res.end();
		return;
	}

	if (range !== false) {
		// Valid range - partial content cut from the selected representation, in
		// that representation's coordinates. `headers` already carries its
		// validator and, for a coded one, its content-encoding, so the client can
		// see which octet sequence these offsets belong to.
		const { start, end } = range;
		const slice = body.subarray(start, end + 1);
		/** @type {(string | number)[]} */
		const flat = [
			'content-type', entry.contentType,
			'content-range', `bytes ${start}-${end}/${body.byteLength}`,
			'content-length', slice.byteLength
		];
		for (let i = 0; i < headers.length; i++) {
			flat.push(headers[i][0], headers[i][1]);
		}
		res.writeHead(206, flat);
		// node suppresses the body for HEAD requests on its own, but skipping
		// the write avoids copying the slice into the socket buffers at all.
		if (headOnly) res.end();
		else res.end(slice);
		return;
	}

	// Pre-computed flat header array for the representation being served - one
	// writeHead, no per-request allocation, and the validator written here is
	// that representation's own. Node adds the Date header itself (cached
	// per-second internally).
	res.writeHead(200, headersFlat);
	if (headOnly) {
		res.end();
	} else {
		res.end(body);
	}
}

// Bounded cache for decoded URI pathnames. Avoids repeated decodeURIComponent
// calls for the same encoded path. Uses Map insertion order for LRU eviction.
export const DECODE_CACHE_MAX = 256;

/**
 * Decode a URI-encoded pathname, returning a cached result when available.
 * Returns null if the pathname is malformed (invalid percent-encoding).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePath(pathname) {
	if (!pathname.includes('%')) return pathname;
	let result = decodeCache.get(pathname);
	if (result !== undefined) return result;
	try {
		result = decodeURIComponent(pathname);
	} catch {
		result = null;
	}
	if (decodeCache.size >= DECODE_CACHE_MAX) {
		decodeCache.delete(decodeCache.keys().next().value);
	}
	decodeCache.set(pathname, result);
	return result;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {string} search
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 * @param {string} [ifMatch]
 * @param {string} [ifUnmodifiedSince]
 * @param {string} [ifModifiedSince]
 * @returns {boolean}
 */
export function tryPrerendered(res, pathname, search, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '', ifMatch = '', ifUnmodifiedSince = '', ifModifiedSince = '') {
	const decoded = decodePath(pathname);
	if (decoded === null) {
		send400(res);
		return true;
	}

	// Static assets whose on-disk names have no unencoded URL spelling (spaces,
	// umlauts, any non-ASCII byte) are indexed under the decoded name, so the
	// raw fast path misses them by construction. One decoded lookup gives them
	// their representation. Traversal cannot ride this: dot-segment paths never
	// enter the index, so a decoded `/../` has no key to hit.
	if (decoded !== pathname) {
		const entry = staticCache.get(decoded);
		if (entry) {
			serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader, ifMatch, ifUnmodifiedSince, ifModifiedSince);
			return true;
		}
	}

	if (prerendered.has(decoded)) {
		// Directory-style page: bare path is not canonical, redirect to trailing slash
		if (prerenderedDirStyle.has(decoded)) {
			res.writeHead(308, { location: decoded + '/' + search });
			res.end();
			return true;
		}
		const entry = staticCache.get(decoded);
		if (entry) {
			serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader, ifMatch, ifUnmodifiedSince, ifModifiedSince);
			return true;
		}
	}

	// Check the alternate trailing-slash form
	const alt = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded + '/';
	if (prerendered.has(alt)) {
		// Request has trailing slash, prerendered path doesn't - if the prerendered
		// path is directory-style, the trailing-slash form is canonical: serve it
		if (prerenderedDirStyle.has(alt) && decoded.endsWith('/')) {
			const entry = staticCache.get(decoded);
			if (entry) {
				serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader, ifMatch, ifUnmodifiedSince, ifModifiedSince);
				return true;
			}
		}
		// Otherwise redirect to the prerendered path (the canonical form)
		res.writeHead(308, { location: alt + search });
		res.end();
		return true;
	}

	return false;
}
