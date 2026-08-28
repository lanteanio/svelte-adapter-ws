// Shared per-worker runtime state. One module so the request handler, the
// static index, and the lifecycle machine read and write the same objects
// without circular imports.

/**
 * @typedef {{
 *   buffer: Buffer,
 *   contentType: string,
 *   etag: string,
 *   headers: [string, string][],
 *   headersFlat: (string | number)[],
 *   brBuffer?: Buffer,
 *   gzBuffer?: Buffer,
 *   brEtag?: string,
 *   gzEtag?: string,
 *   brHeaders?: [string, string][],
 *   gzHeaders?: [string, string][],
 *   brHeadersFlat?: (string | number)[],
 *   gzHeadersFlat?: (string | number)[]
 * }} StaticEntry
 */

/** In-memory static file cache, keyed by exact URL pathname. @type {Map<string, StaticEntry>} */
export const staticCache = new Map();

/**
 * Prerendered pages whose canonical form carries a trailing slash
 * (directory-style output, `trailingSlash: 'always'`), keyed by the bare path.
 * @type {Set<string>}
 */
export const prerenderedDirStyle = new Set();

/** Bounded LRU for decoded URI pathnames. @type {Map<string, string | null>} */
export const decodeCache = new Map();

export const counters = {
	/** HTTP exchanges currently in flight (accepted, response not finished). */
	inFlightCount: 0,
	/** Operations attempted on an already-closed socket, absorbed. */
	closedWsAborts: 0,
	/** Mirrors the lifecycle state for cheap hot-path reads. */
	draining: false
};
