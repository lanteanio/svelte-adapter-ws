# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`event.request.signal` aborts when the client disconnects and when
  shutdown stops waiting.** The Request handed to SvelteKit, and to an
  `admin()` handler, carried no signal, so it never fired. It now aborts
  when the client goes away before its request body has arrived in full -
  always, for a request without one - as under SvelteKit's Node adapter,
  and when the process exits with the request still in flight - the shutdown
  budget runs out, the shutdown sequence itself throws, or `fatal()` or an
  uncaught exception the application does not handle ends a worker - with an
  `AbortError` whose message names the shutdown. A request whose response
  completes never sees it, and neither does one whose client leaves after its
  body arrived, so a form action that has its data finishes what it started.
  `createTestServer`'s admin lane aborts it on a disconnect too.

- **Server entries a Vite plugin adds to the build are bundled and run at
  startup.** A `__`-prefixed `.js` entry in the server build, such as the
  registry `svelte-realtime` emits, is now bundled with the server and
  imported by the generated `index.js` before the server starts, as on the
  family's native tier; the build never picked them up before. Each is
  imported by the file Rollup wrote for it, so a name with a `#`, `%` or an
  apostrophe loads, and in file-name order on every filesystem.
- **`svelte-adapter-ws/subscriptions`: accounted topic membership for
  plugins in other packages.** A plugin that called `ws.subscribe` and wrote
  the connection's subscription registry by hand left the worker's
  accounting behind, which the consistency auditor reports as
  `subs.total-mismatch`. The new entry exports the runtime's own
  `trackedSubscribe(ws, topic)` and `trackedUnsubscribe(ws, topic)`, the
  helpers the bundled plugins use: native membership, the registry, the
  per-connection cap, the shared-codec cohort and the accounting move
  together, and they reach the running app's connection state from any
  module instance.

### Changed

- **A `Host` value that is not an authority is refused with `400`.** With no
  `ORIGIN` set the request URL is the `Host` value plus the target, so
  `Host: a/__realtime/introspect?` had SvelteKit route to a path the request
  line never named, inside the admin prefix. A `Host` that is not
  `host[:port]`, and a configured `HOST_HEADER`, `PORT_HEADER` or
  `PROTOCOL_HEADER` value that is not a host, a port or a scheme, are now
  refused with `400` on the page, admin and auth lanes and in
  `createTestServer`'s admin mirror, as on the family's native tier; pages
  answered them with a `500` and an error event before. A refused configured
  header prints one warning naming the setting.
- **A request target RFC 9112 does not allow is refused with `400`, and so is
  one that resolves onto one of the adapter's own paths.** A `#` in a target
  stayed part of the path, so `/healthz#frag` missed the probe and reached the
  app's router as `/healthz`, as did `/x/../healthz`, `/%68ealthz` and
  `/healthz/__data.json`. Each is now refused with `400`, as on the family's
  native tier, for the probes, the auth path, the waiting-room pages and the
  WebSocket path while a ceiling answers its GETs, and a `#` or a byte outside
  visible ASCII in the WebSocket handshake's query is refused as a malformed
  handshake. A raw non-ASCII byte, which node's parser already refused, now
  gets the same `Bad Request` body as every other refused target, and a HEAD
  its length alone. A static file whose name a browser percent-encodes is
  served for that spelling decoded as `decodeURI` decodes it, so an encoded
  `/` no longer reaches into a directory, and a name written decomposed is
  found for its composed spelling too.
- **The request id and the connection permit cross the upgrade on keys only
  the runtime can name.** `createTestServer` and `vite dev` carried a
  connection's request id to `open` on a string key, and every surface
  carried its `maxConnections` permit on one, so an accessor on
  `Object.prototype` for such a key could take the value. Each now rides a
  private Symbol, as on the family's native tier, and an application's own
  upgrade userData property of the old request-id name reaches its hooks
  unchanged instead of being overwritten and deleted. `WS_REQUEST_ID_KEY` from
  `svelte-adapter-ws/testing` is still exported with the same value and
  marked deprecated: no slot uses it, and the id is read from
  `userData[WS_PLATFORM].requestId`.
- **The flow-control window narrows along a ramp as memory fills, not in one
  step.** Past a `heap_used_ratio` of 0.7 a flow-controlled connection's
  window fell from the full 256 requests to under a third at once; it now
  ramps down linearly, reaching half at the default 0.85 MEMORY threshold
  and a twentieth near the wall, as on the family's native tier. Below 0.7
  every window is the full base, as before, and between 0.7 and 0.985 every
  window is larger than it was. The knee sits below the MEMORY threshold on
  purpose: between the two, windows are already smaller while
  `platform.pressure.reason` still reads `NONE`.
- **Closing a socket refuses a code it cannot send and never splits a
  character in the reason.** `ws.end()` handed its code and reason to the
  `ws` library, which throws for a code outside the sendable ranges and for a
  reason past 123 bytes; that throw was caught as a closed socket, so the
  connection stayed open and nothing said why. One rule now applies on every
  surface, as on the family's native tier: a code outside 1000-1003,
  1007-1014 and 3000-4999, a non-number, a reason without a code, and reason
  bytes that are not UTF-8 throw a `TypeError` and leave the connection open;
  a longer reason is shortened at a character boundary and a lone surrogate
  is sent as U+FFFD. `createTestServer` no longer sends 1000 for an `end()`
  with no code, it sends no status as production does. Under `vite dev` a
  long reason no longer throws, a binary reason is sent as its bytes, and
  `ws.close()` drops the connection without a close frame, so the client
  reads 1006 rather than 1005.
- The `close` hook reads the code and reason the server sent when the close
  was the server's own, and 0 for a close sent with no code, as on the
  family's native tier, where it read the peer's reply (1005 for an empty
  close). In the simulator a close with no code reports 0 to the server and
  1005 to the peer, where it reported 1000 to both.
- On Windows, a request path that does not percent-decode is no longer
  refused by the reserved-character check, which now reads the decoded
  spelling only when there is one. GET and HEAD still get `400` from the
  static lookup; other methods reach the app's router, as they do on every
  other platform and on the family's native tier.
- The SSR lane frames what it writes rather than what the Response declares,
  as the family's native tier does. A body whose end follows its first chunk
  at once - a rendered page, an endpoint's string or buffer - goes out whole
  with its real length; one that keeps streaming goes out
  `Transfer-Encoding: chunked` even when the app declared a
  `Content-Length`, which was written through before. A Transfer-Encoding the
  Response itself carries, as one relayed from `fetch()` does, is dropped
  rather than written beside that length, on the SSR lane, the authenticate
  endpoint, the admin lane and `createTestServer`'s admin mirror alike. A
  stream that enqueues strings or ArrayBuffers is written like one that
  enqueues bytes, except that a whole body of one string chunk goes out
  uncompressed, as the native tier sends it.
- **A malformed WebSocket handshake is refused with `400`, and an unsupported
  version with `426`.** One rule now applies on the runtime, `createTestServer`
  and `vite dev`, as on the family's native tier: `400` unless there is exactly
  one `Upgrade` line naming `websocket`, a `Connection` that lists `upgrade`,
  exactly one key that is the base64 of 16 bytes, and at most one version
  line; `426` with `Sec-WebSocket-Version: 13` for any version but 13. Letter
  case is ignored and only spaces and tabs are trimmed. The refusal comes
  before the capacity, origin, rate-limit and application checks, so it is
  never answered or counted as load; it is counted as
  `upgrade_rejected_total{reason="malformed_handshake"}`. A GET to the
  WebSocket path that carries a key or a websocket `Upgrade` without the rest
  of the handshake is refused the same way. Without an admission ceiling, a
  plain GET to the WebSocket path, and an upgrade to another protocol such as
  `h2c`, now reach the application instead of a `426`; with a ceiling a
  navigation still gets the upgrade hint or the capacity answer.
- **Only a GET to the WebSocket path is taken as a handshake.** A complete
  handshake on any other path or with any other method went to the upgrade
  listener, which answered `404` off the path and `405` to a `POST` on it and
  closed the connection. It is now an ordinary request, answered as it would
  be without the upgrade headers - by the liveness probe, a built asset or the
  application - as on the family's native tier, on the runtime and in
  `createTestServer`. A key that is not 24 bytes long is refused `400` by the
  GET answer on the WebSocket path. The WebSocket path and the waiting room's
  two pages answer GET only: a HEAD to any of them reaches the application,
  and the `426` upgrade hint no longer carries an `Upgrade` header.
- **A second `SIGTERM` or `SIGINT` during shutdown no longer ends the process
  at once.** It exited with status `1` and skipped whatever the shutdown had
  left to do; the shutdown already running now keeps its `SHUTDOWN_TIMEOUT`
  budget, as on the family's native tier, in a single process and on the
  cluster primary alike.
- The `bytesOut` and `bytesIn` a `close` hook reads count a text frame in
  UTF-16 code units, the `length` JavaScript reports, as the family's native
  tier counts them, where they counted UTF-8 bytes; binary frames are still
  counted in bytes. The two agree for ASCII text, and a non-ASCII frame now
  reads lower. An exact UTF-8 count would scan every frame on every send.
- `platform.sendCoalesced` queues under the `key` it is given, as the
  family's native tier does. A call without a key used to queue under its
  topic and event; such calls now share one slot. A socket that closes with
  values queued drops the whole queue at the next flush instead of keeping
  it.
- **Section 15 of `PROTOCOL.md` carries empty messages and WebSocket
  closes.** The WebTransport reliable-stream binding, which this runtime does
  not serve, carries an empty WebSocket message as a zero-length record and a
  close as a close record (`kind` `0x02`) holding the close frame's payload:
  empty, or a code and a UTF-8 reason of at most 123 bytes. A byte after a
  close record is a `PROTOCOL_ERROR`. A well-formed record whose inner
  message is malformed is now handled as on WebSocket instead of resetting
  the lane. A sender holding a message larger than it may emit resets with
  `RECORD_TOO_LARGE`, except a live relayed `game` event, which is not
  delivered, and recovery answers such a message with a truncation. The
  pending bound counts unsent bytes; an endpoint may also cap pending records
  at no fewer than 65,536, and a server bounds bytes sent but not yet
  acknowledged at no less than 1 MiB. A receiver limit is never below 125
  bytes. A client opens the stream only after the successful CONNECT
  response, and a server may refuse with `STREAM_LIMIT` one that arrived
  before it. `NO_ERROR` (`0x00`) joins the stream errors.
  The description and `x-webtransport` block of `protocol.schema.json` and
  `test-vectors/webtransport-stream.json`, now an eight-record transcript
  whose every refusal names its `check`, change with it. The WebSocket wire
  is unchanged, and section 15 stays provisional until its wire-status line
  reads frozen. Appendix D no longer links a separate protocol-compatibility
  page.

### Fixed

- **Under `vite dev` over HTTPS the WebSocket, the auth endpoint and the
  dashboard accept a browser's requests.** Under `server.https` the plugin
  refused the browser's WebSocket, and over HTTP/2, which Vite 7.2 and later
  always speak there, its auth and dashboard requests; the auth hook also got
  `/` as its `url` and ran for `/__WS/AUTH` too. The dev auth lane now writes
  a hook's Response as production does, and the auth and dashboard mounts
  answer only their own paths.
- **A header value past ASCII goes out as its UTF-8 bytes.** node writes a
  header value one byte per character, so `x-note: café` went out as the
  single byte `e9`, and a character past U+00FF was answered with a `500`.
  Every lane that writes an app or configured header - pages, the auth
  endpoint, the admin route, the waiting-room renderer, built assets and
  `createTestServer` - now writes the value's UTF-8 bytes, as the family's
  native tier does, a lone surrogate included. A control character is still
  refused. A Response whose status node cannot write, or that carries a header
  node refuses, is answered as a failure of its lane, with a `500` that
  carries none of its headers or cookies; a page's now carries the request
  id and reports `runtime.ssr.failed`, where it answered with the error's
  text.
- **A static download whose file name is not ASCII is served.** Its
  `content-disposition`, and a `staticHeaders` or `staticCacheControl` value
  past U+00FF, failed the answer with an exception nothing caught, which ended
  the worker on the first request for the file.
- **A failing `open`, `drain` or `close` hook costs one connection, not the
  process.** These hooks are called from a transport callback and never
  awaited. A synchronous throw was caught and printed with a line of this
  adapter's own, but a returned promise that rejected went unhandled, which
  is fatal under node's default policy, and a failing `open` or `drain` left
  its connection open. They now run inside the family's hook boundary: a
  throw or a rejection from `open` or `drain` closes that connection with
  1011 and is printed as `ADAPTER-ERR-OPEN-HOOK` or `ADAPTER-ERR-DRAIN-HOOK`,
  and one from `close` is printed as `ADAPTER-ERR-CLOSE-HOOK` while the
  connection's own teardown still runs. The `then` read sits inside the same
  guard as the call, so a returned value whose `then` getter throws is
  contained too. `createTestServer` and `vite dev` contain `open` and `close`
  the same way; under `vite dev` a throwing close hook also skipped removing
  the connection from the dev server's live maps.
- **A `sendCoalesced` value JSON cannot carry no longer ends the process.**
  Serialization waits for the flush, so a value queued behind backpressure
  was first serialized from the drain callback, where a BigInt, a cycle or a
  throwing `toJSON` was an uncaught exception. Such an entry is now dropped
  and reported as `ADAPTER-ERR-COALESCED-UNSERIALIZABLE` while the rest of
  the queue goes out, and a value that flushes at once still throws to the
  caller, as `send` does. A function or a symbol, which the serializer turns
  into nothing, is refused the same way. An older queued entry that fails no
  longer throws out of a later, unrelated `sendCoalesced` call.
- **`createTestServer` has `sendCoalesced` and runs the `drain` hook.** Its
  platform had no `sendCoalesced` and its sockets never signalled a drain, so
  a suite using either met a missing method or a hook that never ran. It now
  queues and drains on real backpressure the way production does, through
  the outbound chokepoint so chaos scenarios apply, and runs the app's
  `drain` hook inside the lifecycle boundary. `vite dev` still sends each
  coalesced value at once and never calls `drain`.
- **A plugin's tracked join of a shared topic joins its own server's
  cohort.** `trackedSubscribe` and `trackedUnsubscribe` reached the
  shared-fan-out cohort through one process-wide hook that only the
  production runtime installed, so `createTestServer` never cohorted a
  plugin's join of a shared topic, and two servers in one process shared
  whichever hook was installed last. Each surface now carries the join and
  leave on its own platform. A tracked leave that lands after its socket
  closed no longer releases the shared wire-id reference the close already
  released, which dropped the id from under the members that remained.
- **Message data JSON has no form for is refused, never put on the wire.**
  A function or a symbol serialized to `undefined`, and every envelope
  builder concatenated that into the frame as `"data":undefined`, which no
  client can parse. `publish`, `send`, `sendTo`, the batch lanes, the
  `sendWireBatch` JSON envelopes and the game lane now throw a `TypeError` to
  the caller for it, as they already did for a BigInt or a cycle, on the
  runtime, `createTestServer` and `vite dev`.
- **A connection attempt the network never answers is abandoned and
  retried.** A WebSocket handshake or an auth preflight that got no response
  at all - no open, no error, no close - left the bundled client in
  `connecting` indefinitely, as on networks that silently drop traffic
  (captive portals, broken proxies, mobile handovers). Each attempt is now
  bounded at 15 seconds and then handed to the usual reconnect path; the
  bound is internal, and the backoff, `maxReconnectAttempts` and the failure
  classes are unchanged.
- **A rate-limited auth preflight no longer closes the client for good.** The
  bundled client read every 4xx from the preflight as a verdict on the user,
  so a `429`, which clients behind one address earn together, marked them all
  permanently closed until a reload. A `429` now backs off like a throttling
  close: the failure store reads `class: 'THROTTLE'` with
  `kind: 'auth-preflight'`, and the reconnect waits no sooner than the
  `Retry-After` the server sends, capped at five minutes. The preflight's
  `429` now carries `Retry-After` of about one `authPathRateLimitWindow`,
  jittered. Every other 4xx is still terminal and 5xx still retries.
- **The error reference quotes a message prefix that carries backticks
  intact.** `docs/errors.md` put each prefix in a single-backtick code span, so
  a prefix with backticks of its own, as `ADAPTER-ERR-METRICS-MODULE-SHAPE`'s
  has, closed the span early and the rest spilled out as prose. Each span's
  fence is now one backtick longer than the longest run inside it.
- **The control-channel ceiling documents its worst case.** The README
  quoted a subscribe batch of short topics, about twelve times amplified, at
  one frame more than this runtime sends. Filling the 256-topic cap and
  padding with empty entries, each denied on its own, is twenty-one times:
  measured on this runtime at 2,466 frames and 174,956 bytes for an
  8,175-byte request, so the 4 MiB per 10 s ceiling is reached from about
  20 KB/s of inbound rather than 34. The ceiling itself is unchanged.
- **`sendWireBatch` reports a dropped last frame.** When the codec declined
  the batch and the binary frame for the final entry was dropped, the call
  returned 1, as if everything had gone out; it now returns 2, on the
  production runtime and under `createTestServer`. A dropped frame followed by
  entries that fall back to JSON still reports the status of the last send.
- **`platform.assertions` is declared for TypeScript.** The per-category
  invariant-violation counter exists on every surface's platform and is
  documented, but the `Platform` type did not declare it, so a TypeScript app
  reading it failed to compile. It is declared as a read-only `Map`;
  `introspect().assertions` keeps its plain-object type.
- **A long diagnostic message parses back.** A message past 512 characters
  was cut after its whitespace was collapsed and trimmed, so a cut landing
  just past a space left a trailing one, and `parseDiagnostic` from
  `svelte-adapter-ws/observability` refused the line `formatDiagnostic` had
  just written. The message is trimmed again after the cut.
- **`vite dev` no longer withholds an echo that production delivers.** The dev
  plugin read `options.excludeWs` on `platform.publish`, and through it on
  `batch` and on the per-event fall-back `publishBatched` takes for a disjoint
  batch, while production reads no exclusion on any of those. An app developed
  against the dev server saw the sender suppressed and got the echo under
  `npm start`, with nothing to notice in between - and dev was not even
  consistent with itself, since the batched fast path never excluded.
  Exclusion stays declared and implemented on `publishWire` and
  `publishWireBatch`, which honour it in dev exactly as before; in production
  the same option also covers the envelope a codec falls back to when it
  declines a frame, which is the supported way to skip the sender without a
  binary payload.
- **`vite dev` refuses the seq values production refuses.** The dev plugin
  stamps no `seq` and read none on `platform.publish`, so `{ seq: 'x' }`, a
  zero, a negative or a fraction delivered under `vite dev` and threw a
  `TypeError` under `npm start`. Every dev lane now runs the value check
  production runs before it admits - `publish` and the wire lanes through the
  delivery seam, `batch` and `publishBatched` over every message before the
  first goes out - so a bad value throws the same error on both servers, with
  nothing of a batch delivered. The publish lanes in dev still stamp no seq on
  the values they accept; the send lanes carry an explicit one as before.
- **The liveness and readiness probes answer HEAD.** `healthCheckPath` and
  `readinessCheckPath` answered GET only, so a HEAD probe - the default for
  HAProxy's `httpchk` and for most uptime monitors - fell through to the
  app's router and was answered by its 404, which a balancer reads as an
  unhealthy instance. Both probes now answer HEAD with the GET status, the
  body's length and no body; `createTestServer` registers the same pair.
- The runtime's probe answers no longer carry `content-type: text/plain`.
  The length is their only header, as on the family's native tier and in
  `createTestServer`.
- **`bytes=-0` is answered 416, not with the whole body.** The range parser
  read a zero-length suffix as malformed, and a malformed Range is ignored, so
  a request for the last zero bytes got a 200 with everything. RFC 9110 14.2
  makes a suffix range satisfiable only with a non-zero length; the parser
  (`utils/byte-range.js`, the family's own) now reports it unsatisfiable, and
  the static lane answers `416` with `Content-Range: bytes */N` against the
  negotiated representation's length. `bytes=-` stays malformed and ignored.
- **A 304 carries the app's configured headers.** The revalidation response
  was assembled from four named fields (`ETag`, `Vary`, `Cache-Control`,
  `Last-Modified`), so every `staticHeaders` entry - HSTS, CSP, frame and
  referrer policy - was absent on every revalidation, and a client that
  revalidates on each navigation saw its security policy once. The 304 now
  writes the representation's 200 header tuples - validators, caching
  directives and every configured entry; `Content-Type` and `Content-Length`
  are written only beside a body - less the fields that describe the body it
  does not carry
  (`Content-Encoding`, `Content-Disposition`; RFC 9110 15.4.5), baked per
  representation at index time so the revalidation path stays one
  `writeHead`.
- **Accept-Encoding is negotiated by its weights.** The static lane and the
  single-chunk SSR lane honoured a `q=0` refusal but did not rank the rest,
  so `gzip;q=1, br;q=0.5` got brotli, and a header without weights was
  matched by substring, so `BR` got identity and `x-gzip` got gzip.
  `utils/content-coding.js`, the family's own, reads the list as RFC 9110
  12.5.3 does: coding names are whole tokens compared case-insensitively, an
  unlisted coding is acceptable only through `*`, `q=0` refuses, the highest
  weight wins and brotli breaks a tie; identity stays the fallback even under
  `identity;q=0`.
- **A prerendered trailing-slash redirect is percent-encoded, and a route
  named past Latin-1 no longer takes the process down.** The lookup matches
  the DECODED path and wrote it verbatim into `Location`. node writes a header
  value as Latin-1, so a route named `café` redirected with the raw byte
  `0xE9` in the header rather than a request target, and it refuses a
  character past Latin-1 outright, so a trailing-slash request to a route
  named `łódź`, or a bare request to a directory-style route named `żółw`,
  threw `ERR_INVALID_CHAR` out of the request listener, where nothing caught
  it. The target is now spelled as a request target
  (`utils/location-target.js`, the family's own), path segments and query
  alike, so the redirect lands on the lookup that issued it.
- The static lane's empty answers - the 412, the 416 and both prerendered
  trailing-slash 308s - carry `Content-Length: 0`. node builds the header
  block at `writeHead`, so without the length a GET got them
  `Transfer-Encoding: chunked` with a terminating empty chunk and a HEAD got
  no length at all, where the family's native tier writes the zero length.
- **Every generated answer is length-framed.** The authenticate endpoint's
  401, 403, 413, 429 and 500, a Response its hook returns, the socket path's
  capacity 503, the waiting room's poll answers, the SSR lane's two
  generated 500s (a header node refuses to write, a body already read) and a
  whole SSR body with no declared length (most endpoint Responses)
  went out `Transfer-Encoding: chunked`, since node frames a `writeHead`
  that names no length that way. Each now carries its length, as the
  family's native tier derives it from the body.
- **A 204, 304 or HEAD says only what it may about its length.** RFC 9110
  8.6 forbids `Content-Length` on a 204 and allows it on a 304 only when it
  names the 200's content length, and a HEAD's may only name the GET's. The
  SSR lane, the admin lane, the authenticate endpoint and `createTestServer`'s
  admin mirror now apply one rule: a 204 reports none (an app's own
  `content-length: 0` was written through), a 304 or a HEAD reports the
  length the app declared or none (the admin lane answered a HEAD with `0`
  and dropped a 304's declared length), and every other bodyless answer
  reports zero. A credentialed HEAD to a page or endpoint no longer reads
  the body SvelteKit renders for it: the headers go out with the declared
  length and the body is cancelled unread. An anonymous one still passes
  through the request-dedup leader, which buffers a render it may share, as
  the native tier's does.
- **An uncredentialed page that streams strings or ArrayBuffers is no longer
  corrupted.** The request-dedup leader, which buffers an anonymous GET or
  HEAD render it may share, copied an ArrayBuffer or a DataView into its
  buffer as zeros and a wider typed array as the wrong bytes, answered a
  string chunk `500`, and never counted a string toward its 512 KiB sharing
  cap, so a long string stream was held whole before failing. It now reads
  every chunk the way the response writer does, and hands a body past the
  cap to the writer as the chunks it read, so a body of one string chunk goes
  out uncompressed on every path, as the writer sends it.
- **A header node refuses to write is answered `500` on every lane, framed
  for the body it carries.** An SSR Response carrying such a `Set-Cookie`
  value got no answer at all and the connection waited for the client to give
  up; so did a waiting-room page whose renderer returned such a header, in
  the runtime and in `createTestServer`. A relayed `204` or `304` from the
  authenticate hook or the admin handler, and the authenticate endpoint's
  implicit `204` carrying a cookie set with a name or domain past U+00FF,
  were answered with a `500` whose declared body never came, because node
  had already settled that no body follows, and a relayed
  `connection: close` beside the refused header dropped a pipelined request
  behind it. Headers are now checked whole, then set, before the status is
  written, so a refusal commits nothing, and the answer is the lane's own
  `500`; `createTestServer`'s admin mirror and waiting room answer the same
  way. A relayed `Trailer`, which node refuses on an answer it does not
  stream chunked, is dropped there with the other framing headers the writer
  owns, and kept on an SSR answer node streams chunked. An HTTP/1.0 request
  without `TE: chunked` is answered close-delimited, so the Trailer is
  dropped for it too.
- A `413` the adapter writes reads `Content Too Large`, as RFC 9110 and the
  family's native tier name it, where node's default wrote `Payload Too
  Large`, and the `500` that follows a relayed header node refuses reads
  `Internal Server Error` rather than `OK`.
- **The authenticate endpoint answers as the family's does.** The URL handed
  to the hook is built on `ORIGIN`, or on the configured `PROTOCOL_HEADER`,
  `HOST_HEADER` and `PORT_HEADER`, where it was the raw Host, and carries a
  query only when there is one (a bare trailing `?` is dropped); a header value
  no origin can be made of, or a Host the URL parser cannot read, is refused
  400 where the second was a 500. A declared body past the 64 KiB cap is
  refused 413 before any of it is read, and the body now streams into the
  Request, so an undeclared oversized one is refused only when the hook reads
  past the cap. A rate-limited preflight says `Too many authentication
  requests`, and the `adapter.http.websocket-authenticate` span opens when
  the hook runs rather than for every request to the path.
- A realtime build prints the family's endpoint lines at boot, ahead of the
  admin route's: `WebSocket auth endpoint registered at <authPath>` when the
  app exports `authenticate`, `WebSocket endpoint registered at <path>`, and
  `Client must match: connect({ path: '<path>' })` when the path is not
  `/ws`.
- **A request that frames its body two ways is refused, and its connection
  ends.** node's parser refuses most ambiguous framing itself, but it
  decodes a Transfer-Encoding list that ends in chunked (`gzip, chunked`)
  as chunked and hands a request with an empty Transfer-Encoding to the app
  as a bodyless one, where a conformant proxy in front reads both
  differently - the disagreement request smuggling is made of. A
  Transfer-Encoding other than exactly `chunked` is now refused `400` in
  front of every lane, the probes, built assets and realtime routes
  included, and every lane that builds a header set (SSR, the authenticate
  endpoint, the admin lane, the WebSocket handshake, and `createTestServer`'s
  mirrors of them) refuses an empty one. These refusals write
  `connection: close` and end the connection; a repeated `Authorization` or
  `Origin` is still refused `400` on a connection that stays open. The
  handshake counts them as `upgrade_rejected_total{reason="ambiguous_framing"}`,
  ahead of every capacity answer.
- **An app that stops reading a request body no longer takes the process
  down.** The body stream fed from node's request kept pushing the bytes
  still arriving into a stream the app had let go of - `request.body.cancel()`,
  breaking out of `for await`, or cancelling a reader after a read - and the
  push threw inside the request's event listener, where nothing catches it.
  The rest of the body is now discarded and the connection reaches its next
  request. SSR routes and the authenticate hook share this stream.
- A WebSocket handshake refused before its header set is read - under
  siege, at a full handshake gate or connection ceiling - opens its
  `adapter.websocket.admission` span under the trace context the client
  sent, where it opened a root span; a deferred-overflow refusal is
  parented on the collected headers.
- **A throwing or rejecting `unsubscribe` hook no longer takes the
  connection or the process down.** The hook was called bare, so a
  synchronous throw escaped the message handler and an async hook's
  rejection went unhandled, which is fatal under node's default policy. It
  now runs behind a guard that catches the throw and attaches a rejection
  handler to a returned thenable, reporting either once as
  `ADAPTER-ERR-UNSUBSCRIBE-HOOK` with the topic and the connection's request
  id; the hook is still not awaited, and the `unsubscribe` type admits a
  promise return. `createTestServer` and the dev plugin run their hook the
  same way.
- **A shared cohort join holds one reference and leaves the connection in one
  cohort.** A socket that rejoins a shared cohort it already holds - a
  plugin's `trackedSubscribe` of a topic the client subscribed over the
  wire - no longer takes a second shared wire-id reference, which kept the
  id alive after its last member left. The same call could also leave a
  connection on BOTH cohorts: its own first announce refused past the
  backpressure limit put it on the JSON cohort, and a later successful join
  added the binary one without removing that, so it received every shared
  publish twice, as the frame and as the envelope. The successful join now
  moves the connection rather than adding to it, and a join that finds the
  capability gone - a re-sent `hello` replaces the set, a refused
  per-connection announce poisons the wire state - moves it the other way,
  out of the binary cohort and off its reference. Both in the runtime and in
  `createTestServer`. `ws_publish_outcomes_total` stays one outcome per
  cohort fan-out, so a `no_subscribers` on a shared topic answers for one
  cohort and not for the publish; the README and the type documentation now
  say so.
- The conformance-index links in `PROTOCOL.md` appendix F and in
  `test-vectors/README.md` open the page on svelte-adapter-uws. They pointed
  at `docs/protocol-conformance.md`, which this package does not ship. The
  protocol contract test the vectors README names now runs in this
  repository too, and the README links it on this repository's `main`
  branch rather than a `dev` branch it does not have.

## [0.0.1] - 2026-09-22

### Added

- `docs/errors.md` opens with the two indexes an operator reads it for: a
  row per stable id carrying the code or event and the start of the printed
  line, and a list keyed the other way round, by the event name a sink
  reports or by the printed prefix for the lines that never enter the
  diagnostic pipeline. Both are rendered from the registry, so an entry
  cannot appear in one and be missing from the other. The page also names
  the sibling packages that ship their own references, so a line from the
  client or the extensions package leads somewhere instead of reading as
  undocumented.

- The README documents the observability contract in three tables the build
  now gates: the registry contract method by method with its signature and
  whether it is required, every signal with its type and how it merges across
  workers, and a canonical row per signal carrying labels, unit, scope,
  aggregate, origin, formula and help. The `websocket.metrics` JSDoc lists
  every signal the adapter registers. A signal added to the manifest without a
  matching row, a registry method documented in a stale signature, or a help
  string that drifts from the manifest now fails the suite.

- The resume gap-fill flush knows when the socket refuses: it stops at the
  first frame shed past the backpressure ceiling instead of pushing the rest
  into the void, sends the client a `truncated` marker on the replay channel
  so it drops its stale offset and cold-resyncs, closes with 1013 when even
  the marker is refused, and reports that close to the subscribe lane so no
  ack or cohort join is attempted on a connection that is gone. A resume
  hook may report the watermark it covered, per topic or as a bare number on
  the single lane, and the flush skips what the hook already delivered.

- `ADAPTER-ERR-RESUME-HOOK-READ` (`resume.hook-read-failed`): reading a
  resume hook's returned value threw for a topic, which is treated as covering
  nothing for that topic alone.

- Static assets and prerendered pages evaluate `If-Match` and
  `If-Unmodified-Since`, in the RFC 9110 order ahead of `If-None-Match` and
  `If-Modified-Since`, and answer `412 Precondition Failed` when the
  precondition does not hold; a failed `If-Match` is never converted into a
  304 by a validator later in the chain. `If-None-Match` and `If-Match` take
  the list form and `*`. `staticPreconditions` is the exported pure planner
  the case table pins.

- Shared binary fan-out by cohort in production: a stateless wire codec marked
  `shared: true` announces one server-wide wire id to every binary-capable
  subscriber and delivers the byte-identical `0x03` frame to the binary cohort
  and the JSON envelope to the JSON cohort. The first shared publish migrates a
  topic's current subscribers into cohorts; later joiners are cohorted on the
  wire, batch and programmatic subscribe landings and on the tracked-subscribe
  primitive; an unsubscribe leaves; a publish with `excludeWs` or a declined
  encode takes the per-connection walk. The test server mirrored this lane
  already; production now does the same.

- `TRACE`, `TRACK` and `CONNECT` are answered `405 Method Not Allowed` with
  an `Allow` header on every lane, including the two node's parser never hands
  to a request listener: `TRACK` is not a method it knows and `CONNECT` is
  routed to the `connect` event. The test server's admin lane refuses them
  before building a `Request`, as the production admin route does.

- `platform.bumpTopicEpoch(topic)` on the test server, minting through the
  same epoch module as production; its `topicEpoch(topic)` now reads the
  per-topic generation instead of answering the process generation for every
  topic.

- `ADAPTER-ERR-SUBSCRIPTION-SINK-DISPLACED` names a second adapter runtime in
  one worker taking over the subscription accounting sink, the topology
  behind a subscription total frozen under its summed bookkeeping on one side
  and driven negative by unmatched releases on the other. The install reports
  whether it displaced a different sink; clearing the slot and reinstalling
  the same function are not displacements.

- `ADAPTER-ERR-CLUSTER-CONFIG-PORT` indexes the refusal of `PORT=0` under
  `CLUSTER_WORKERS`, which already exited before any worker spawned but did
  so on an unindexed line.

- `ADAPTER-ERR-TLS-WATCH-LOST` and `ADAPTER-ERR-TLS-PRIMARY-WATCH-LOST` report
  a certificate-directory watch that died after it had started, which arrives
  as an event rather than a throw. Their own ids rather than the existing
  watch ids, because that text promises a failure at start plus an arm-time
  catch-up read, and a post-arm loss gets neither: whatever was on disk when
  the watch died is what the instance keeps serving. The state is sticky on
  both the single-process server and the cluster primary, which now reads its
  degraded-state policy from the same ledger the worker half uses instead of
  clearing the state by hand on any successful read. Reachable here because
  the certificate and key directories are watched separately, so a renewal
  seen in the live one could clear a degradation the dead one caused.

- The control/ack channel is bounded per connection. Protocol frames the
  server sends because a client asked for them - subscribe acks and denials,
  `welcome`, `lease-ok`, window grants, protocol errors - are charged against
  a budget of 4 MiB per 10-second window on the production handler, the test
  server and the dev plugin alike, and a connection past it is closed with
  `4429`, which the bundled client classes as throttling and reconnects on.
  The channel amplifies: one legal 8 KB `subscribe-batch` is answered with
  about 97 KB across 1,345 frames, and nothing else bounded the rate because
  every `messageAdmission` ceiling is disabled until configured. Nothing new
  goes on the wire but the close; the operator gets
  `ADAPTER-ERR-CONTROL-EGRESS-EXHAUSTED` on the diagnostic channel.
  Application `publish` and `send` traffic is never charged.

- Every per-connection slot the runtime writes onto a connection's userData is
  declared as an own property at open. A plain assignment walks the prototype
  chain, so an accessor an application installed for one of the `Symbol.for`
  keys took the write and left no property behind - and because every slot
  site is a lazy init behind a falsy guard, the lane then redid its work on
  every pass instead of failing once. The declaration makes each later write
  an own-property write that never consults the chain. The same rule covers
  the process-global registries and the hook markers, which are published
  with `defineProperty` for the same reason.

- `tlsReloadState()` on the built handler reports the certificate reload path:
  whether this process is watching the certificate directory, why renewals
  would not be picked up if they would not, how many in-place swaps it has
  done, how many reloads failed and when, and the expiry of the certificate
  being served. Counts and reasons only - no key material and no certificate
  bytes. A fleet whose workers disagree on `generation` has a worker that
  missed a renewal. It answers on a plain-HTTP build too, with a zeroed
  record, and returns a snapshot rather than the live object.

  A degradation caused by a dead certificate-directory watch now survives a
  later reload that succeeds. Nothing restarts a watch, so a process whose
  watch died will not see the next renewal however well the current one
  swapped; reporting healthy there hid the one condition an operator needed.
  A reload that merely failed to validate is still cleared by the next
  success.

  The certificate-directory watch is armed once the listen socket is bound
  rather than while the module is still evaluating, so a certificate
  directory that disappears during boot is reported as the dead watch it is
  instead of as a live one.

- `platform.send()` and `platform.sendWire()` take an explicit `seq`. It is the
  channel a resume hook gap-fills history through, and it rides the JSON
  envelope and the binary frame's seq slot identically, so a client keys one
  watermark whichever form its connection negotiated - a capable subscriber and
  a degraded one no longer disagree about where a replay resumed. Both lanes
  previously dropped the option: `send()` built its envelope without a seq
  field, and `sendWire()` wrote a literal `0` into the frame's slot.

  Number and bigint stamp the exact value, under the same validation and
  safe-integer range the publish lanes apply to an explicit authority.
  `false`, `null` and absent mean no seq and emit the previous frame
  byte-identically. `true` throws rather than drawing the in-memory counter,
  because a single-target send has none to draw.

  A seq'd send stays side-effect-free: no counter advances, no max-seen is
  recorded, and an open resume capture does not receive the frame. Gap-fill
  replays history that is already accounted, so a second accounting would move
  the very watermarks the replay is reconstructing.

- Relay-gap detection rides the same reporter. A per-topic maximum only ever
  reveals a lost TAIL: two workers, one that received [2,3] of a stream and one
  that received [1,2,3], both report 3 and hash identically. The per-origin
  relay ordinal is dense by construction, so a hole in it is a dropped frame and
  nothing else, and the worker that finds one already knows it lost them - there
  is no majority to weigh, so a gap is REPORTED rather than voted on.

  Subscribers hear too. A client whose resume offset has already stepped past
  the hole would gap-fill straight over it, so every gapped topic gets a marker
  pushed to each subscriber that negotiated `relay.resync:1` (the bundled client
  always does) and a freshly minted topic generation on this worker, so a client
  that was not reachable cold-rehydrates at its next resume instead. A socket
  that cannot take even the marker is closed 1013. Reserved lanes and topics
  outside the sequence registry carry no offset to poison and are skipped.

- `websocket.stateHashIntervalMs`: the cross-worker state-hash reporter, which
  the build previously refused. Above `0` and under `CLUSTER_WORKERS`, each
  worker folds a structure-only projection of its per-topic delivered-sequence
  map into one 32-bit hash on a fixed period and reports it inward; the primary
  buckets the reports by an epoch it assigns itself and judges a bucket once
  every live worker has reported into it. A disagreement means a publish reached
  some workers and not another - a relay drop, a partial fan-out, a frame one
  worker failed to apply - which a single-process deployment cannot have.

  Only the two integers and a thread id cross the thread boundary: no topic
  strings, no payloads, no client identity. The log line names an opaque
  diagnostic id and nothing else; the per-worker evidence behind it is a keyed
  high-water summary, collected only after the aggregate fires and readable
  through `platform.diagnostic(id)`, whose topic identifiers are HMACs under a
  key that lives for one primary lifetime and never enters a log, a metric or a
  response.

  The comparison is split by activity. Topics whose sequence moved recently
  carry the restart-authorized vote; quiet topics ride a separate log-only hash,
  because a respawned worker legitimately holds none of its siblings' quiet
  history and, with nobody publishing those topics, can never re-learn it.
  Detection is observe-only by default: `RESTART_ON_STATE_DIVERGENCE=1` is a
  separate primary-level switch that asks each minority worker to exit so its
  replacement re-converges, and the quiet lane never restarts anyone whatever it
  is set to. `STATE_HASH_EPOCH_MS` optionally overrides the bucket width, which
  otherwise follows the period each worker advertises.

  Off by default (`0`): no timer is scheduled and the path costs nothing. Each
  worker jitters its FIRST report and then holds a fixed period, so the fleet is
  spread without drifting out of the shared bucket.

- `websocket.metrics`: transport, admission and posture observability, which
  the build previously refused. A module path (not a live object - adapter
  options are serialized into the build) whose default, `metrics` or
  `registry` export is a Prometheus-shaped registry; the adapter registers the
  manifest's worker signals into it and emits them from the request, upgrade,
  message and publish paths, with gauges riding the existing 1 Hz pressure
  sampler. It is republished as `platform.metrics`, and
  `platform.metricsSnapshot()` merges the whole cluster from the values the
  adapter wrote rather than from rendered text, so it needs no `serialize()`
  and keeps canonical unprefixed names whatever the registry renders. No
  client identity reaches a label. The adapter serves no scrape route: the app
  writes its own `+server.js`. A worker counts toward
  `metrics_snapshot_workers_reporting` only once it has registered every
  required counter family and sampled every required gauge. A worker missing
  from a merge and a scrape that never reached the primary are reported apart:
  the first shows as a reporting shortfall, the second sets
  `metrics_snapshot_degraded` and answers with the requesting worker alone.

- `websocket.protection`: the graduated protection posture over the 1 Hz
  pressure signal, which the build previously refused. It governs the admission
  of NEW upgrades only - an open connection is never touched at any level.
  `'auto'` escalates fast and relaxes slow (`normal -> elevated` on sustained
  pressure, `elevated -> siege` when over-capacity upgrade rejects run at twice
  the gate's admit rate, each step down behind a longer quiet dwell);
  `'elevated'` and `'siege'` pin a level. At `elevated` every capacity refusal
  widens its `Retry-After` jitter; at `siege` new upgrades are refused at
  static-serve cost, a browser navigation to the WebSocket path gets the
  capacity page instead of `426`, and `/__admit-check` always answers `202`
  with a doubled `pollAfterMs`. A per-IP `429` is counted apart and never
  escalates the posture. The live level reads back as `platform.protection`
  (also in `platform.introspect()`) and layers `'CAPACITY'` onto
  `platform.pressure`, behind `MEMORY`. Each level change prints
  `ADAPTER-ERR-POSTURE-TRANSITION` with the rejection rate and the base
  pressure reason.

- `websocket.postureExport`: a local stream socket - a unix domain socket path,
  or a `\\.\pipe\...` named pipe on Windows - that pushes the live posture to
  every connected consumer as newline-delimited JSON, once on connect, once per
  transition, and once per 1 Hz sample. The steady cadence is the liveness
  signal: silence means the adapter is gone. Local-only and payload-free
  (posture, reason and kernel pressure numbers). A listen that fails, or a
  socket that fails later, disables the export with
  `ADAPTER-ERR-POSTURE-EXPORT-DISABLED` and never touches the server it
  reports on. Takes a path string or `{ path }`.

- `websocket.consistencyAuditIntervalMs` (default `5000`): the per-worker
  consistency auditor, running the shared invariant predicates against a
  bounded, structure-only snapshot of live connections on a slow, jittered,
  unref'd timer. It never runs on the hot path. A violation logs and increments
  `platform.assertions`; only a subscription slot that is no longer a `Set`,
  persisting across two consecutive audits, escalates to a deferred worker
  restart. Set `0` to disable it and schedule no timer.

- `websocket.resourceGrowthAuditIntervalMs` (default `0`, off): the
  observe-only resource-growth trend auditor. It samples the SIZE of the live
  bookkeeping collections and logs one throttled
  `ADAPTER-ERR-RESOURCE-GROWTH` per worker when a series climbs monotonically -
  the signature of a close, unsubscribe or eviction path that stopped shedding.
  It never asserts, throws or terminates.

- The auto-mounted admin route and `websocket.adminPath`, which the build
  previously refused. When the WebSocket handler exports `admin(request)`, the
  adapter mounts it under a reserved prefix (default `/__realtime`) ahead of the
  static and SSR lanes, bridges the request to the Web `Request` -> `Response`
  contract the handler speaks, and writes the response back verbatim. All
  authorization lives in the app handler; the adapter's own answers are the
  transport failures alone - `405` for a fetch-forbidden method, `400` for an
  ambiguous header, an unusable Host, or a target that resolves outside the
  mount prefix, `413` for a declared body over `BODY_SIZE_LIMIT`, and `500` for
  a handler that throws, rejects or returns a non-`Response`. A throw or a
  rejection also emits
  `ADAPTER-ERR-ADMIN-HANDLER`, carrying the error; a returned non-`Response`
  is answered `500` without one, because there is no error to carry. Set a
  string to
  relocate the prefix or `false` to disable the mount; a value that is not an
  absolute path, or that collides with `websocket.path` or `websocket.authPath`,
  fails the build.

- `websocket.adminAuthAcknowledged`: silences the boot warning that the mounted
  admin route carries no adapter-level authentication. The adapter cannot see
  whether the app's `admin()` handler gates its own requests, so it says so once
  at startup; set this to `true` after confirming it does. It changes nothing
  about routing or authorization.

- `websocket.upgradeAdmission`: the upgrade gate, which the build previously
  refused. `maxConcurrent` caps handshakes in flight, `maxConnections` caps
  reserved-plus-live sockets with a permit held for the socket's lifetime and
  handed back on close, `perTickBudget` paces completions per event-loop tick
  behind a finite `maxDeferred` queue, and `cursorLane.fraction` carves a
  reserved sub-budget for the cursor-only lane so cursor reconnects cannot
  starve main admission. Refusals are content-negotiated: a browser navigation
  gets a self-polling holding page at `/__waiting-room` backed by the
  `/__admit-check` poll endpoint, WebSocket and non-HTML clients keep `503`
  with a jittered `Retry-After`, and `waitingRoom: false` answers an HTML
  navigation with a minimal accessible `503`. The page takes a
  `waitingRoom.template` document with `{{token}}` substitution or a
  `waitingRoom.renderer` module path for per-request localization, both
  validated when the adapter is configured. A typo one level down
  (`upgradeAdmission.maxConcurent`) is now named by the build warning rather
  than dropped in silence.

- The `./vite` subpath: the dev-server plugin, so `vite dev` serves WebSockets
  against the same protocol the built runtime serves. Dev applies the
  `upgradeResponse` contract's custom 101 headers the way production does,
  validated through the same snapshot, rather than declining to emit them.
  The subscribe, publish, batch and recover lanes answer through the shared
  policy modules, so a call dev accepts is a call production accepts. Two
  operator diagnostics ride with it, `ADAPTER-ERR-VITE-LOAD` and
  `ADAPTER-ERR-VITE-RELOAD`, for a handler that fails its first load and one
  that fails a hot reload, both documented in the error reference. With it the
  package declares all 34 of the lead adapter's export subpaths.

- A public entry-point catalog in the README, rendered from the export map by
  `node scripts/render-entry-points.js`. Each subpath lists its
  role, execution environment, stability and deprecation state, carried from
  the lead adapter so the same import reads the same in either package. The
  table, the declarations and the export map are gated against each other and
  against the lead.

- The `./testing` and `./sim` subpaths: the in-process handler harness and
  the deterministic network/cluster simulator, both running against this
  runtime's own in-memory double, so a suite that imports them needs no
  native package. An export-subpath gate holds the declared surface inside
  the lead adapter's - a subpath declared only here fails the suite, because
  an app that imports it could not move back - and checks that every declared
  types and default target exists and imports.

- The in-process cluster: `CLUSTER_WORKERS=<n|auto>` runs a supervising
  primary thread with one worker thread per slot on Linux, io workers
  binding the shared port themselves via SO_REUSEPORT and compute workers
  (`websocket.workers.compute`) booting the app without a socket.
  `websocket.primaryInit` runs once in the primary and its return value
  (SharedArrayBuffers included) replays as `workerData.app` to every worker
  and respawn. Cross-worker publish fan-out rides one shared-memory ring per
  direction per worker (`CLUSTER_RELAY_RING_KB`, encode-once with the primary
  forwarding bytes verbatim) with postMessage as the fallback/control lane,
  bounded by per-peer spill ceilings (`CLUSTER_RELAY_MAX_PENDING_KB/_MS`,
  quarantine-and-replace) and a sender-side frame ceiling
  (`CLUSTER_RELAY_MAX_FRAME_KB`). The primary heartbeats the fleet with a
  separate boot deadline (`WORKER_BOOT_TIMEOUT_MS`), escalates wedged workers
  through the clean-exit protocol and terminates only the stuck thread,
  respawns crashed slots under per-slot exponential backoff with a
  stable-uptime budget reset, owns the TLS cert-directory watch (workers swap
  contexts on its broadcast; single-process keeps its own watch), and drains
  readiness fleet-wide ahead of the shutdown delay. Invalid configurations -
  bad worker count, compute >= total, unknown or acceptor mode, a non-Linux
  host - refuse before any worker spawns, through the error catalog. In a
  multi-worker topology, sequenced publishes require an external authority
  (`{ seq: <n>, relay: false }`) or `{ seq: false }`, batches vet their
  options and entry seqs atomically before stamping, and the game lane
  refuses topologies where sockets can land on more than one io worker.
  systemd `Type=notify` readiness/watchdog integration and the low
  file-descriptor-limit boot advisory ride along on every mode.

- Typed public entry points: AdapterOptions/WebSocketOptions/Platform/
  PressureSnapshot/Attribution in index.d.ts, plus typed upgrade-response and
  connection subpaths (resolving clean under `skipLibCheck: false`); the
  exports map carries types conditions and the publish gate (publint + attw,
  ESM-only profile) passes clean.

- The operator error reference: docs/errors.md, generated from the runtime's
  error catalog by `node scripts/render-error-docs.js`, so every stable
  ADAPTER-ERR-* id's help link resolves to its cause, consequence and next
  action. The catalog carries exactly the failures this runtime can emit -
  every entry has a live emit site, every hook-failure and TLS/shutdown
  console line prints through the catalog so the logged text and the indexed
  prefix cannot drift, a runaway publisher is reported (latched per topic)
  when no onPublishRate listener is registered, still-open requests are
  counted when the shutdown budget closes them, and a throw out of the
  shutdown sequence itself exits with status 1 instead of leaving a
  half-drained server running. A test pins all of it: emit sites, source
  paths, anchors and the rendered docs.

- The golden gate: an AST platform-surface parity test against the lead
  adapter (fails on a missing key AND on a missing oracle checkout), the wire
  revision pinned byte-identical to the lead protocol.schema.json, and a
  deterministic golden trace - the real built runtime platform under a seeded
  seam and virtual clock, every emitted frame pinned byte-for-byte against a
  committed corpus under test/dst-goldens/. A missing corpus fails loud
  (UPDATE_GOLDENS=1 is the only write path), the corpus and conformance
  vectors are pinned against line-ending smudge in .gitattributes, and CI
  runs the whole suite with the lead checkout provided as the oracle.

- First-class in-process TLS: PEM pairs with comma-separated multi-cert SNI
  (per-name contexts from each cert SAN, wildcard SANs matched one label
  deep, or the SSL_SNI_HOSTS override) and certificate hot-reload on
  SSL_WATCH (default on) that applies setSecureContext to new connections
  without re-binding the listener and re-derives the SNI name set from the
  reloaded certificates, so a renewal that changes SANs serves the new names
  and drops the old. The
  probe TLS section now runs unattended against committed test fixtures
  instead of being recorded as manual.

- The pressure lane: a 1 Hz sampler behind `platform.pressure` (publish rate,
  subscriber ratio, memory-wall ratio, the bounded bufferedAmount walk, the
  exact backpressure-shed window, PSI/CFS signals on Linux, top publishers),
  `onPressure` transition callbacks, `onPublishRate` window callbacks,
  pressure-sized lease grants, `websocket.pressure` threshold overrides, and
  the slow-consumer bench (`npm run bench:slow-consumer`) that fails unless
  flow control demonstrably engages and recovers. Realtime-lane hardening in
  the same lane: the origin gate honors
  HOST_HEADER/PROTOCOL_HEADER/PORT_HEADER on both doors, the authenticate
  door checks origin before spending rate-limit budget, connection setup
  failures tear the socket down instead of leaking a half-registered
  connection, app open/drain hook throws are contained, resume gap-fill
  flushes detect shed frames and signal resync (closing 1013 when even the
  marker is shed), socket-level publish routes through peer facades so the
  backpressure ceiling applies, custom 101 headers write one line per array
  element, batched publish takes a batch-level compression decision, idle
  deadlines and close durations use the monotonic clock, and the per-topic
  seq registry warns at the family cardinality threshold.

- The binary wire: `0x03` frames for capability-advertising subscribers with
  the `wire-id` announce ordered before the first frame, per-connection topic
  ids and codec state, the stateful-drop poison rule (backpressure-shed
  stateful frames degrade that capability to JSON until reconnect), batch
  encode with per-entry fallback, the `wire.ingress:1` client-to-server lane
  with the `game:1` twin and compact `game.fanout:1` egress, and live
  per-capability connection counts so a binary publish skips the walk when
  nobody advertises the codec. The frame layout is pinned against the family
  conformance vector in `test-vectors/binary.json`.

- Managed WebSocket drain on shutdown: new upgrades are refused the moment
  drain begins, live clients receive the reconnect advisory with the
  `RECONNECT_DISPERSAL_MS` dispersal window (default 5000ms; 0 closes without
  the advisory) and a 1001 close, close handshakes are awaited within the
  shutdown budget, and sockets that ignore the close frame are terminated -
  after which the HTTP listener close can actually complete. App cleanup
  hooks run under a budget of the same length, concurrent shutdown calls
  share one drain, and a second SIGTERM/SIGINT exits immediately.

- The JSON realtime lane: WebSocket upgrades over `node:http` with async
  admission, origin policy, per-IP sliding-window rate limits, upgrade
  timeout, and validated custom 101 headers; the runtime owns the upgrade
  socket's error event for the whole admission window, so a client that
  resets mid-hook is a destroyed socket, never an uncaught exception; a socket facade that synthesizes
  the family tri-state send result from `bufferedAmount` plus the
  backpressure ceiling (shedding past it, optionally terminating the pinned
  consumer) and throws on closed sockets for the accessors sibling packages
  reap through; a topic registry with a per-topic reverse index; the full
  `platform` surface over JSON delivery - seq-stamped publish, batched
  publishing with the shared batch frame, send/sendTo/sendCoalesced with a
  drain pump, request/reply, the subscribe authorization machinery on the
  family's shared policy predicates and `Symbol.for` slots, the game lane,
  adviseReconnect, hlc - and the control-frame set: welcome, hello with the
  lease grant, subscribe and subscribe-batch with resume-on-subscribe
  gap-fill, unsubscribe, resume, reply, request-n, game, and the oversized
  control-frame refusal. The `authenticate` preflight endpoint ships with
  CSRF defense and rate limiting; idle connections are reaped by ping/pong
  with `idleTimeout`; app hooks (`init`, `shutdown`, `open`, `message`,
  `close`, `drain`, `upgrade`, `subscribe`, `subscribeBatch`, `unsubscribe`,
  `resume`, `authenticate`, `attribution`) run with the lead adapter's
  semantics. `svelte-adapter-ws/upgrade-response` and
  `svelte-adapter-ws/connection` are exported. Family websocket options whose
  lanes have not shipped here refuse the build instead of silently no-op'ing.

- The HTTP half: the `adapter()` build (rollup-bundled server output, the
  public `@sveltejs/kit/node` primitives bundled in as `server/kit-node.js`)
  and the `node:http`/`node:https` runtime. Static and prerendered assets are
  served from an in-memory index with negotiated precompressed
  representations (q-values honored, so `br;q=0` is a refusal and `*` an
  offer), per-representation weak ETags, single byte ranges,
  If-None-Match/If-Modified-Since/If-Range preconditions with Last-Modified
  beside each ETag, the dotfile refusal with the `.well-known` carve-out, and
  the prerendered trailing-slash rules. A name the raw fast path cannot hold
  (spaces, non-ASCII) gets one decoded lookup, so every indexed file is
  reachable; dot-segment paths still have no key to hit. SSR flows
  through the runtime's own request reader and response writer (every
  non-GET/HEAD body is read here, whether or not the client named a
  Content-Type, and the response is streamed here, a mid-body failure
  aborting the exchange) with concurrent-request dedup for
  anonymous GET/HEAD (bodies buffer only up to the 512K share cap - a larger
  render streams and is never shared), single-chunk dynamic compression
  (skipped for credentialed requests as BREACH defense), a default
  `x-content-type-options: nosniff`, and a duplicate-header policy that
  refuses repeated singleton headers and keeps the last line of proxy identity
  headers. Health and readiness probes, readiness-gated SSR warmup,
  `ADDRESS_HEADER`/`TRUSTED_PROXIES` client-IP resolution, and graceful
  shutdown that drains in-flight requests. The `websocket` and `tracing`
  options, `PROXY_PROTOCOL=1` and `CLUSTER_WORKERS` refuse loudly instead of
  silently doing nothing.

- The repository, its conventions, and the API probe. `probe/ws-api-facts.mjs`
  measures every `node:http` and `ws` behavior the adapter design depends on -
  send results, backpressure and drain signals, closed-socket behavior, the
  upgrade flow, payload limits, compression negotiation, ping and idle
  handling, message buffer lifetime, prototype patchability, shutdown drain,
  listen options, and the availability of the public `@sveltejs/kit/node`
  primitives - and writes a committed report so a Node or `ws` upgrade that
  changes an observed behavior shows up as a diff. The TLS section runs
  unattended against committed test fixtures.

- `protocol.schema.json`, vendored byte-identical from svelte-adapter-uws and
  held that way by `.gitattributes`, so the wire this adapter speaks is the wire
  the lead adapter declares.

- The determinism ratchet (`npm run check:determinism`): every clock, RNG and
  timer read under `src/` must go through the injectable runtime module, or the
  scan fails naming the raw call site.

- The `tracing` adapter option: point it at a server module exporting a
  vendor-neutral `startSpan(name, options)` provider and the runtime opens
  spans for SSR, static and prerendered serving, WebSocket upgrades (with
  per-rejection admission spans) and per-message hooks, threads the W3C
  context from the upgrade request into the connection, and serves it back
  through `platform.trace` / `platform.traceContext`. The provider module is
  bundled at build time behind a shape validator; without the option every
  tracing path costs one boolean test.

- The `./safe-url` subpath: the family SSRF validator, carried verbatim with
  its test suite.

- The `./client` subpath: the browser realtime client, carried verbatim from
  the family source with its store bindings and test suite.

- The full `./plugins/*` surface: replay, presence, channels, throttle,
  ratelimit, cursor, middleware, queue, groups, lock, session, dedup, crdt
  (with `/replica` and `/channel`), smooth (with `/random`) and webhooks -
  25 subpaths, server and client halves, carried verbatim with their test
  suites (~1400 tests). The crdt plugin brings `yjs` into dependencies.
  Shipped plugin type files spell the socket parameter `object`, matching
  this adapter's platform types.

- The `websocket.maxTopicSeqEntries` option: a bound on the per-topic
  sequence registry, evicting quiet topics once the cap is crossed so
  high-cardinality topic names cannot grow it without limit. Topics with live
  subscribers or an open resume barrier are never evicted, and a probe that
  throws protects rather than authorizes. Omitted, the registry keeps its
  warn-threshold default, so zero-config behavior is unchanged.

- `platform.bumpTopicEpoch(topic)`: mint a topic a fresh seq-space generation
  on this worker, so offsets recorded under the old one cold-rehydrate at
  their next resume instead of gap-filling. The escape hatch for moving a
  topic between sequence authorities.

- The `websocket.egress` option: publish-egress ceilings per topic and per
  tenant over messages, bytes and deliveries, enforced before anything is
  stamped so a refused publish (return `false`; batches refuse atomically)
  leaves no sequence gap. Every publish lane charges one shared ledger, the
  pressure snapshot carries the window's deliveries, bytes and refusals, and
  tenants resolve through the handler's `egressTenantOf(topic)` export.

- The `./observability` subpath: the observability manifest and contract,
  the canonical diagnostic record surface (`createDiagnostic`,
  `parseDiagnostic`, `formatDiagnostic`, `setOperationalEventSink`) and the
  W3C trace-context helpers.

- The root type declarations now cover the whole surface the package exports.
  `WebSocketHandler`, `MetricsRegistry`, `Platform`'s companions
  (`TopicHelper`, `TopicPublishRate`, `RuntimeVersionInfo`), every hook context
  (`UpgradeContext`, `AuthenticateContext`, `AuthenticateCookies`,
  `CookieSerializeOptions`, `OpenContext`, `MessageContext`, `CloseContext`,
  `SubscribeContext`, `SubscribeDenialReason`, `ResumeContext`), the game-lane
  frames (`GameFrame`, `GameDenialReason`, `GameDeniedFrame`), the shed-message
  frames (`MessageOverloadReason`, `MessageOverloadedFrame`), the egress
  sections (`EgressOptions`, `EgressCeilings`) and a `WebSocket` handle typed
  for this transport are all declared and exported. `svelte-adapter-ws/testing`
  imports four of these from the root, so that subpath now type-checks.

- `WebSocketOptions` declares `maxTopicSeqEntries` and `egress`, which the build
  already threaded into the runtime payload, and `compression` accepts
  `boolean | number` to match the value the config guard already admits.

- `node scripts/check-types.js` (`npm run check:types`): every subpath's runtime
  target is parsed for its export names and held against the declaration file
  its `types` condition points at, so an export that ships without a
  declaration - which degrades a consumer to `any` - fails before the tests do.
  The suite runs it too.

- The export-parity suite compares NAME SETS with the lead in both directions
  for all 34 subpaths, runtime and declaration alike, resolving
  `export * from` chains. A name only this package exposes is as much of a
  break as one it is missing, and neither can pass now.

- `svelte-adapter-ws/sim` exports `createInMemoryUwsHelpers` and its
  `InMemoryUwsHelpers` type. A composer that builds its own in-memory server
  can hand the helper bundle to `createTestServer`, so the simulator and a
  downstream harness drive the same listen seam.

- `node scripts/check-declarations.js` (`npm run check:declarations`): every
  declaration file the exports map publishes is compiled under strict
  `nodenext`. The name check reads declarations as text and cannot see whether
  they compile, and neither publint nor attw lib-checks them, so a declaration
  surface could be broken in every consumer with all other checks green.

### Changed

- The `ADAPTER-ERR-CONTROL-EGRESS-EXHAUSTED` next-action names what the window
  holds, about 4 MiB of control frames in ten seconds with a subscribe ack
  costing roughly sixty bytes plus the topic name once per topic, and says
  that batching the subscribes changes nothing. The legitimate shape that
  reaches it is a reconnect whose acks add up to more than the window, and
  the remedy is fewer topics per connection or a restore sliced across
  windows.

- A certificate hot-reload serves the renewed certificate to handshakes that
  name one of its SNI hosts and leaves the server's own context on the boot
  certificate, so a client that sends no servername, or one the renewal does
  not name, keeps the boot certificate until a restart. This is the family's
  reload contract; the default context is no longer replaced in place. With
  a single certificate, `SSL_SNI_HOSTS` names what its renewal is served
  under, in place of SAN discovery, as it does across the family. The reload
  log line names the hosts, the expiry and the generation.

- A worker still alive when its exit grace expires takes the process down
  with a self-SIGKILL for the orchestrator to respawn, under
  `ADAPTER-ERR-WORKER-EXIT-SIGKILL` (`cluster.worker-exit-sigkill`), and an
  exhausted restart budget hard-exits the same way while other workers are
  alive. The family resolves a wedged worker by process death; the thread is
  no longer terminated in place with its slot respawned.

- `ws_publish_outcomes_total` counts fan-outs, not logical publishes, at the
  sites where the family's native tier hands one publish to its transport:
  one per publish, one per entry on the wire batch lane's JSON fast path,
  one per cohort of a shared publish, one per batched fast-path frame, and
  one per relay receiver's own fan-out. An excluding publish, a stateful or
  capable wire delivery and the game lane are per-connection walks and
  report none. The family no longer sums to `ws_publishes_total`; it reads
  the same on both adapters for the same traffic.

- `publishBatched` takes its per-event slow path whenever an interested
  subscriber has not advertised the `batch` capability, on the origin and on
  every relay receiver, so a mixed room receives per-event envelopes
  throughout rather than a shared frame beside them. A room where every
  interested subscriber is capable still receives one shared frame.

- The `Platform` declaration carries the full signatures: typed wire codec
  objects on the wire lanes, `coalesceKey` and the per-message `relay` and
  `seq` options on `publishBatched`, `seq?: boolean | number | bigint | null`
  on a `publishWireBatch` entry, generic `request<TReply>` and
  `requestTopic<TReply>` with the discriminated reply union, a required
  `key` on `sendCoalesced`, `senderWs: WebSocket | null` and optional `data`
  on `publishGame`, both `authorizeWireSubscribe` overloads, and the shaped
  `introspect()`, `diagnostic()` and `topic()` results in place of `object`
  and `unknown`. `PressureSnapshot`'s top-level fields are `readonly` and
  `topPublishers` is `TopicPublishRate[]`.

- `sendWireBatch` takes `options?: { compress?: boolean }` and no per-entry
  `seq`: the binary batch frame's seq slot is always 0, whatever an entry
  carries, and a codec without per-connection state sends the per-entry
  JSON envelopes rather than a binary frame. Those envelopes are the
  FALLBACK and are built only on the paths that send them, so a payload the
  codec carries and `JSON.stringify` cannot (a BigInt, a circular structure)
  still reaches the wire as its binary frame.

- Subscriptions per connection are capped at 65,536 (was 1,000,000): a landed
  subscription is a topic-registry entry as well as a Set entry, so one
  admitted connection must not be able to hold hundreds of megabytes the
  connection ceiling cannot see. The refusal (`subscribe-denied` with
  `RATE_LIMITED`) and everything the client already holds are unchanged.

- A stateless wire codec's `publishWireBatch` is rerouted through
  `publishWire` entry by entry after one egress admission for the whole
  batch, so a capable subscriber receives one `0x03` frame per entry rather
  than a single batch frame; a stateful codec keeps the batched walk.

- SSR dedup decides sharing before the body is held: a declared
  `Content-Length` past the 512 KB cap streams without reading a byte, and an
  undeclared body is read only up to the cap, then streamed on from where the
  read stopped.

- Control frames are charged to the control-egress budget at their UTF-8 size
  rather than their string length, the game lane's denial and the wire-id
  announces are charged like every other control frame, and the budget
  exhaustion event carries the connection's request id. A route registered
  through `registerIngress` receives the calling surface's budgeted control
  sender as its sixth argument for its own denials.

- The cluster primary stamps a worker's restart budget on its relay attach
  rather than on ready, so a worker the attach regime keeps killing is charged
  as a flapper and reaches the restart limit; its posture aggregate is keyed
  on the spawn-time thread id.

- `ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY` describes the operational event the
  pressure sampler emits (with `topPublishers` and `topicCount`); the publish
  path no longer prints a second console line at the threshold.

- The relay frame ceiling is measured in encoded bytes: code units times three
  decide the certain-under case for free, only the band above walks the string.

- An extra TLS certificate is selected by SNI under the names the family's one
  host discovery finds: the SAN DNS entries, then the subject CN of a legacy
  single-name certificate. Boot and reload discover the same names; a
  certificate with neither is still refused.

- The README states the systemd floor for the notify transport: below systemd
  246 run the unit as `Type=simple` without `WatchdogSec=`.

- Vendored from the lead at 6175223 (was 7c3da35): the cohort announce through
  the budgeted sender, the process-wide dashboard and warning slots defined
  rather than assigned, the dev plugin's sender threading, the cluster sim's
  shared health sweep and attach fault, the byte and import check scripts, the
  handshake vectors and the goldens.

- A certificate hot-reload reconciles each additional SNI certificate against
  what that certificate was already serving, instead of rebuilding every SNI
  context from scratch. An extra certificate whose bytes did not change is
  left alone rather than re-read and re-built on every reload, so a renewal of
  one certificate in a multi-certificate deployment no longer churns the
  others. Hosts a renewal dropped are removed, shared hosts are reloaded so
  the new bytes take effect, and new hosts are added - the served result is
  what it was before.

  Host discovery is unchanged: names still come from the certificate's DNS
  subjectAltName or the `SSL_SNI_HOSTS` group for that certificate, and an
  extra certificate carrying neither is still refused.

- The adapter's own fixed-shape answers declare a `Content-Length` instead of
  falling back to chunked transfer encoding. This covers the shared `405`,
  `400`, `413` and `500` writers, every answer the admin route produces
  including the empty-bodied ones, the `/healthz` and `/readyz` probes, the
  WebSocket-path `426` and the waiting-room refusals, and the authenticate
  route's own copies of `405` and `400`. Only the adapter's own answers are
  affected; anything your app returns is written back as it always was. A
  `HEAD` now carries the size a `GET` would have returned rather than no
  framing at all, which is what a load balancer probing with `HEAD` reads.
  `createTestServer` frames the same way, so a test written against the harness
  sees what the built server produces.

- Metric `# HELP` sentences say what a number measures rather than which
  runtime produced it. `ws_publishes_total`, `ws_publish_outcomes_total`,
  `ws_dropped_frames_total` and `ws_dropped_bytes_total` no longer credit C++
  fan-out or a native backpressure limit, neither of which exists on this
  backend: this adapter fans out in JS over `node:http` and `ws`. Metric names,
  types and labels are unchanged, so dashboards, recording rules and alerts
  keep working.

- `websocket.handler` is checked against the module the Vite plugin actually
  bundled. The plugin records which module became `ws-handler.js`; the build now
  reads that record, refuses when the two name different modules, and names the
  bundled module in the build log instead of only reporting that a handler was
  built. Which module wins decides which authorization hooks the server has, so
  a silent substitution can stand a gate down.

- Operational log lines now print the family's canonical diagnostic shape
  (`[lantean/diagnostic source=... component=... event=... severity=...]`
  followed by the message and the full JSON record) instead of the shorter
  `[svelte-adapter-ws] <event>: <message>` form, so one collector rule
  parses both adapters and `parseDiagnostic` round-trips this adapter's own
  output. A process-wide operational event sink (`setOperationalEventSink`)
  can capture the structured records before they reach the console.

- `SHUTDOWN_TIMEOUT` bounds the whole teardown sequence - app shutdown hooks,
  the WebSocket drain and the HTTP in-flight drain now share the one budget
  instead of each spending it in full, so the process is down when the
  configured number says it is. `0` still means no budget anywhere. In cluster
  mode the primary's force-exit fires one worker-exit grace after the budget,
  so a worker inside its own bound never loses the race to its supervisor.

### Removed

- `ADAPTER-ERR-WORKER-EXIT-FORCED` (`cluster.worker-exit-forced`). The family
  declares one id for a worker that misses its exit grace,
  `ADAPTER-ERR-WORKER-EXIT-SIGKILL`, and this adapter now raises that one.

- `SSL_PFX`, `SSL_PFX_PASSPHRASE` and `SSL_OCSP_FILE`. The family's TLS
  surface is the PEM pair, per-name extra pairs and the hot reload; a
  PKCS#12 bundle and OCSP stapling were knobs only this adapter read, and a
  deployment configured with them could not move back.

- `options.excludeWs` on `platform.publish`, `platform.batch` and
  `platform.publishBatched`. The family's JSON lanes read `seq`, `relay`,
  `compress` and `jitterMs` and nothing else; sender exclusion is a wire-lane
  option, on `publishWire` and per entry or per call on `publishWireBatch`,
  and that is where it stays. The `Platform.publish` declaration no longer
  names it.

- `Platform.assertions` from the declarations. The runtime member stays; the
  family's declaration does not name it.

- `ADAPTER-ERR-CLUSTER-CONFIG-NODE` and `ADAPTER-ERR-CLUSTER-CONFIG-ACCEPTOR`:
  the family's catalog declares neither, and an operator whose runbook keys on
  an id only this adapter mints finds nothing on the lead. Both refusals keep
  their prose as plain console lines and still exit 1.

- `runAppShutdownHook` is no longer exported from the built handler. The lead
  adapter declares no such name and runs the app's hook inside `shutdown()`,
  which is now what this adapter does too - so the export named a step that is
  no longer separable, and an app reaching for it could not move back. Call
  `shutdown()`; the hook runs as part of it.

- The `PressureThresholds` type is no longer exported. The lead adapter
  declares no such name and inlines the same shape on `WebSocketOptions`, so
  exporting it here made an app annotated with it unable to move back. The
  option's shape is unchanged; only the exported name is gone. Replace an
  annotation with the inline shape, or read it through
  `WebSocketOptions['pressure']`.

### Fixed

- Every envelope the runtime's publish and send lanes build takes its prefix
  from the envelope prefix cache, as the family's native tier does. The growth
  auditor's `envelopePrefixCache` probe, one of the `resource` values on
  `framework_resource_growth_suspected_total`, now reads the live size; on a
  worker with the auditor enabled it read 0 every time, because the module
  that fills the cache was never called. The bytes on the wire are
  unchanged.

- **A JSON array no longer reaches the app hook as a pre-parsed envelope.**
  `MessageContext.msg` is declared to carry a plain object envelope and to be
  absent for null, an array and a primitive, but the runtime tested
  `parsed === null || typeof parsed !== 'object'` and `typeof [] === 'object'`:
  a frame such as `[{"y":1}]` parsed, matched no control type, and arrived at
  the app hook as `msg`. `createTestServer` and `vite dev` already excluded
  arrays by name, so an app saw one envelope shape in development and another
  in production. The runtime now excludes it the same way; the frame still
  reaches the hook, as raw `data` with no envelope beside it.

- A connection's `messagesOut` and `bytesOut` count direct sends only, as
  the `CloseContext` declaration says: `publish`, `batch`, `publishBatched`,
  `publishWire`, `publishWireBatch` and the relay receive half no longer
  charge every subscriber they reach, so an app reading its close context
  gets the same figures on this adapter as on the family's native tier,
  where the fan-out has no per-connection hook. `send`, `sendWire`,
  `sendWireBatch`, `sendTo`, `adviseReconnect`, the request lane's outbound
  frame, coalesced sends once accepted, every control frame (the welcome,
  acks and wire-id announces among them), the resume gap-fill and its marker
  still count, and so does `publishGame`, which is a per-viewer walk on both
  adapters and charges for the same reason a direct send does. A binary
  frame counts the bytes on the socket, header included, rather than the
  codec payload inside it: this raises what a wire-capable or game-capable
  connection reports by the frame header of each binary frame it took.

- `ws_publish_outcomes_total` classifies every fan-out from the walk that
  delivered it. `publish`, a declined wire frame with no exclusion, and each
  entry of a wire batch on its JSON fast path read the registry's subscriber
  count before their walk, so a registered socket with no facade, a socket
  whose send threw, and a socket closed between the count and the walk were
  reported as reached on those three lanes and as reaching nobody on every
  other. The declined frame with no exclusion now runs the same fan-out
  primitive `publish` runs, on the relay path too, and reports whether a
  send was accepted, as `publish` does. On the wire batch's JSON fast path
  a connection whose transport throws is charged one closed-socket abort per
  entry, as N `publishWire` calls would be.

- The single subscribe lane consults its post-await gates in the order the
  lead's single lane uses. The subscription cap answers before the wire
  authorization landing, so a connection that is both full and unauthorized
  hears `RATE_LIMITED` there, and the landing runs after the resume await, so
  a gate armed while the subscribe was parked in its hook or its resume
  refuses the install and closes the resume buffer the lane opened. The batch
  lane's revocation check in front of the resume hook reads the gate fresh
  rather than from its pre-await snapshot, so a gate armed while the batch
  was parked no longer serves the denied topic's replay history in the same
  frame that denies the subscription.

- `publishWireBatch` on the stateful lane resolves the exclusion per entry:
  the call-level `excludeWs` is the default and an entry carrying its own
  overrides it, so the author hears the entry that names someone else. The
  lane skipped the call-level socket for the whole batch.

- `publishGame` charges the SENDER's frozen attribution tenant, never the
  topic resolver's: the client relaying through the game lane is the party
  whose budget the fan-out spends.

- A throwing resume hook is reported as the `resume.hook-failed` operational
  event, and a certificate renewal that does not validate as
  `tls.reload-skipped`; both were console lines. A default-context swap that
  fails mid-apply is `tls.swap-failed` and arms its own one-shot retry, which
  the server's close clears and which fires only for the server that armed
  it. The registry carries `ADAPTER-ERR-TLS-SWAP`, `ADAPTER-ERR-SINK-FAILED`,
  `ADAPTER-ERR-PRESSURE-LISTENER` and `ADAPTER-ERR-EGRESS-EVICTED` for the
  events the runtime already emitted without an entry.

- A closed socket still answers `getUserData()`, on the production facade and
  on the test server's: the userData object outlives the handle, as the
  family's socket keeps it, and a send or request on the closed socket refuses
  at the send. `platform.request` on a peer-closed socket therefore reports
  that the frame could not be sent rather than that it was never sent.

- The `Platform` declaration carries `trace`, `bumpTopicEpoch`, a typed
  `traceContext` and a readonly `requestId`, the way the family declares
  them; `publish` accepts the same `seq` values as the runtime (`bigint` and
  `null` included).

- A custom 101 header named `Connection`, `Upgrade`, `Sec-WebSocket-Accept`,
  `Sec-WebSocket-Extensions` or `Sec-WebSocket-Protocol` is refused by
  `upgradeResponse()` in any letter case; it went out beside the server's own
  line and a conforming client refused the handshake with nothing logged.

- A removed or replaced certificate directory no longer spins the watcher: an
  event naming the watched directory itself triggers an identity check, a
  removed directory closes the watch and reports once, a replaced one reports
  once and gets one final debounced read. The primary keeps the reference so a
  shutdown inside that window still clears the timer.

- The cohort-hook and settled-registry slots on `globalThis` are defined rather
  than assigned, so an accessor on either key can no longer swallow the
  publication.

- A frame that parses to a JSON array, a primitive or `null` reaches the app
  message hook at once, with `msg` set to what parsed.

- The test server charges its wire-id announces to the control budget, and a
  cohort announce the socket refused past its backpressure limit hands the
  shared id back and serves the joiner JSON.

- The test server resolves a batch entry's `seq: true` to its own counter draw
  and `seq: false` to no seq on the stateful lane, as production does.

- A resume flush that closed the connection stops the subscribe landing there
  instead of cohorting and acking a socket the runtime just closed.

- A request body sent without a Content-Type reaches the application on the
  SSR and admin lanes; the runtime reads every non-GET/HEAD body itself, where
  the previous reader handed the app a null body for exactly that request.

- The shutdown cleanup listeners run only after the in-flight requests have
  drained, so a listener that closes a pool cannot pull it out from under a
  request still being served.

- The cluster primary escalates a worker that reported ready and never
  reported its relay reader live, down the same request-exit and respawn
  path as an unresponsive one. The primary hands an unattached worker no
  relay frames, so no spill accumulates and it keeps acking heartbeats while
  missing every cross-worker publish its subscribers are owed. Judged
  against the steady timeout, since a healthy worker attaches in the tick it
  goes ready, and deliberately not tied to the boot deadline.

- The main request edge answers 400 for a target that ARRIVES inside the
  reserved admin prefix while its raw spelling was outside it, whether by
  resolution (`/foo/../__realtime/introspect`) or by percent-encoding
  (`/%5f%5frealtime/introspect`). The admin route matches the target as sent
  while the prerendered lookup and SvelteKit's router resolve and decode it,
  so both spellings skipped the admin lane and reached the app's own routing
  inside the namespace the adapter reserves. Refused rather than rerouted,
  because routing on the resolved path would let a caller reach the admin
  lane through a spelling a fronting proxy's ACL does not read as admin. The
  check runs ahead of the prerendered lookup, which decodes too, and only
  while the admin route is mounted: with no `admin()` export both spellings
  reach the app anyway.

- `If-Range` is evaluated with the strong comparison RFC 9110 requires. Every
  validator the static lane issues is weak by construction, so an `If-Range`
  carrying one now falls through to the full representation instead of
  authorising a splice onto bytes it does not vouch for. A plain `Range` is
  unaffected.

- A closing connection leaves the live set before any other release runs, so
  a throw in the unguarded teardown after it can no longer strand the entry
  in every publish walk and in the auditor's bookkeeping.

- A certificate reload validates every pair before it swaps any. The default
  context was taken the moment its own pair read cleanly, so a renewal that
  rewrote the default fully and left an extra pair's key half-written put the
  new default in front of clients while the failure line said the previous
  certificate was still being served. Nothing is swapped now until the
  default and every extra pair have built, and the failure line is true of
  the whole set.

- The SNI map is rebuilt from every extra certificate's final host list after
  a reload, in pair order, the same rule boot applies. Reconciling pair by
  pair over one shared map deleted a host an earlier pair still carried
  whenever a later pair dropped it, and clients of that host fell through to
  the default certificate with a valid one still loaded.

- Every thread that serves TLS runs one catch-up read once its listen socket
  is bound, so a renewal that landed between the boot read and the bind is
  served instead of waiting for the next event in its directory or, on a
  cluster worker, for the primary's next broadcast. A PKCS#12 bundle is gated
  on a digest of its bytes, so an unchanged bundle is no swap and records no
  generation. A certificate that does not parse is reported as the torn read
  it is rather than as one missing its subjectAltName. The expiry sentinel is
  disarmed with the watchers when the server closes.

- The graceful shutdown sequence runs in the documented order on every path.
  The app's `shutdown` hook runs first, while the listen socket is still bound
  and every WebSocket is still open, so a hook flushing a last frame has
  clients to flush it to; then the listener closes, WebSocket clients get their
  1001, in-flight requests drain, and the `sveltekit:shutdown` listeners run
  LAST, after the drain, so a listener closing a pool sees no request still
  using it. The hook previously ran after the WebSocket drain had already
  kicked every client, and the cleanup listeners ran before the drain.

- One budget bounds the whole sequence. The hook, the WebSocket drain and the
  HTTP drain race the same abort signal, so a hook that spends most of the
  budget leaves the drains only the remainder rather than a fresh allowance;
  a consumer calling the built handler's `shutdown({ timeoutMs })` directly
  gets the same bound derived from its number. The `deadline` handed to the
  hook and the cleanup listeners is a wall-clock epoch, as documented. A
  throw inside the sequence's own machinery no longer skips the close path,
  because the cleanup step it can come from is now the last one. The wait on
  the listener's own close is bounded by the same signal, with a cap when
  there is none: a socket whose upgrade was still inside the app's hook when
  the drain swept the live set is refused rather than opened if its hook
  resolves under a closing server, and a connection still held when that
  bound expires is reported as dropped and ends the shutdown as not clean.

- The dropped-requests line names the budget the operator configured, on the
  signal path as well as the direct one, and reads as the lead spells it. The
  `sveltekit:shutdown` listener entries in the catalog carry the lead's
  wording and order.

- A signal taken while the server module is still evaluating leaves the
  rotation before boot can announce readiness. The readiness flip previously
  reached only a signal that arrived after the module had loaded, so a
  `Ready for traffic` line could still follow a stop signal on the longer
  half of the boot window. The single-process path also announces the
  signal it received and the load-balancer delay it is waiting out, as the
  cluster paths already did, and the exit waits for stderr as well as stdout
  to take the final line.

- A resume frame's `lastSeenEpochs` map takes the same grant filter as its
  `lastSeenSeqs` map. The two arrive on one frame keyed the same way and the
  hook reads them together, so a topic dropped from the seqs and left in the
  epochs reached the hook by the other hand, carrying its generation as well as
  its name.

- The boot banner renders an adapter version or protocol revision it could not
  read as `unreadable` rather than `not installed`. Neither is an optional
  sibling: the adapter is what prints the line and the schema ships beside it,
  so a null there means its own packaged metadata was unreadable, and the old
  wording pointed an operator the opposite way.

- The readiness mirror on the shared counters agrees with the lifecycle state
  during boot. It began life reporting a server that was taking traffic while
  the lifecycle said `starting` and `/readyz` correctly refused, so a
  diagnostics surface reading the mirror and a load balancer reading the probe
  disagreed for the whole of startup - the one window where the socket is
  already bound but the instance must not be routed to.

- `beginDrain()` reports whether it was the call that began the drain. The
  signal handler and `shutdown()` both call it, so a caller that announces the
  drain had no way to avoid saying it twice.

- A throw from the shutdown sequence's own machinery is reported through
  `ADAPTER-ERR-SHUTDOWN-FAILED` with the error attached, and the sequence still
  finishes and exits. It was being caught and printed as an unindexed line, so
  an operator who searched for the documented id found nothing.

- A single-process server no longer shuts down silently. It announces that it
  has begun draining, and ends with whether the stop was clean - `Shutdown
  complete in Xms.`, or a line naming it as not clean when requests were
  dropped or cleanup did not finish. Previously it flipped readiness, ran the
  hooks, drained and exited without printing anything, so the only evidence a
  shutdown had happened was that the process was gone. The clustered paths
  already reported both.

  `SHUTDOWN_TIMEOUT=0` now says so on the way down. An unbounded shutdown is a
  real trade rather than a default, and the operator who chose it should be
  able to see that nothing will cut a wedged hook off.

  A `SIGTERM` that arrives while the server is still booting no longer lets it
  announce `Ready for traffic` on the way out. Readiness moves off `starting`
  when the signal is taken, not when the doomed boot finishes - an instance
  that reports itself ready one tick before it exits is how a rolling deploy
  convinces itself the replacement came up healthy.

- `sveltekit:shutdown` listeners run concurrently and are bounded as a group,
  rather than being awaited one after another. One slow listener no longer
  consumes the budget the rest were meant to share, and a listener that never
  settles no longer denies every later one its turn. Each listener also
  receives a context object - `{ reason, signal, deadline }` - alongside the
  reason it already got.

  A listener that rejects and one that throws synchronously are now reported
  as two different things, because they fail at different points and usually
  for different reasons.

- The dropped-requests line names the budget that was actually configured. It
  was reporting whatever the HTTP drain had left after the WebSocket drain took
  its share - neither the number anyone set nor a whole one.

- The app's WebSocket `shutdown` hook runs on every close path, not only when
  the adapter's own entry drives the shutdown. It is now invoked from
  `shutdown()` itself, so a consumer that imports the built handler and closes
  the server directly gets the hook it was promised; previously that path ran
  no hook at all, and the budget the hook is bounded by was therefore in force
  only for a shutdown the entry started.

  The hook's context also carries `reason` again - the signal name that started
  the shutdown. Without it a hook cannot tell a rolling restart from a
  crash-loop kill, or decide how much of its flush it still has time for. It
  was being dropped between the entry and the hook.

- The app's WebSocket `shutdown` hook runs under the shutdown budget and is
  handed a `signal` and a `deadline` to honour. It was awaited outright with
  nothing but `{ platform }`, so a hook that never settled held the close path
  open for as long as the process lived, and nothing was printed to say why the
  shutdown had stopped making progress.

  The hook is now raced against the budget. When it loses,
  `ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED` reports how long it ran and that
  whatever it was flushing did not finish, and the drain proceeds. The hook is
  not interrupted - user code cannot be - but it no longer holds the close path,
  and `signal` is how a hook that wants to give up cleanly can. A hook that
  finishes inside the budget is silent, as before.

- Three failures the runtime already reports are in the error catalog:
  `ADAPTER-ERR-EGRESS-REFUSED`, `ADAPTER-ERR-EGRESS-TENANT-RESOLVER` and
  `ADAPTER-ERR-PRESSURE-RATE-LISTENER`. The lines were being printed with no
  indexed entry behind them, so an operator who pasted one into `docs/errors.md`
  found nothing - which is the one moment the catalog exists for.

- A handler module can be started again after it has been shut down. The drain
  latch and the lifecycle state belong to one lifecycle, but both were
  module-scope and neither was ever cleared, so a second `start()` ran against a
  state left at `closed`. Since draining means "not ready", that boot bound its
  port, answered HTTP, and refused every WebSocket upgrade with 503 - reachable
  and useless for the thing the adapter is for. A third reached `listen()` on a
  server that was never unbound.

  Both are re-armed at the top of a new `start()` rather than by relaxing the
  readiness flip, which stays guarded on `starting` so that a stop signal
  arriving during a boot still wins over it. Within a single lifecycle the drain
  latch is untouched, so two concurrent callers still share one run and live
  sockets get one advisory and one close frame.

- A failed bind says which address failed and why. It printed neither: the emit
  built a record with a `dataClass` the observability schema does not declare,
  so the record was rejected, the rejection was swallowed (telemetry must not
  turn the failure it reports into a crash), and the last line before
  `exit(1)` was a complaint about an invalid record shape. The catalog entry
  could not have rescued it either - its problem prefix was null, which makes
  the registry-built diagnostic unbuildable.

  `ADAPTER-ERR-LISTEN` is now a composed fatal on `runtime.listener`, emitted
  through the registry so the printed line and the catalog entry an operator
  looks the ID up in are the same bytes, and it carries the real `errno`:
  a port conflict reports `EADDRINUSE` against the host and port that failed.
  Its consequence and recovery text describes the two modes this adapter has -
  single-process, and a respawned worker under `CLUSTER_WORKERS`.

- The built config module reports the resolved `PROXY_PROTOCOL` value. It read
  the variable only to refuse `PROXY_PROTOCOL=1` and exported nothing, so the
  one eval-time knob every other one exposes was absent from the config
  surface, and a reader could not tell an adapter that declines the flag from
  one that ignores it. The refusal is unchanged: `PROXY_PROTOCOL=1` is still
  fatal at boot, so the value a built module carries is always `false`.

- The server says when it is ready for traffic. It announced the bind and then
  went quiet, and "Listening" is not the same claim: the socket is bound before
  the app's init hook and before warmup, so an operator reading only that line
  cannot tell a server that is taking requests from one still rendering its
  warmup paths. The line reports elapsed boot time and is printed only by a
  worker that serves traffic.

- `warmSSR`, `runWarmup` and `isWarmupRequest` are re-exported from the runtime
  handler, where the rest of the lifecycle surface already lives.

- The boot banner names this adapter, reports its own version, and is printed
  at all. It read the packaged metadata from `meta/svelte-adapter-uws/` while
  the build writes `meta/svelte-adapter-ws/`, so a production build found
  nothing there and fell back to a repository path a build does not contain -
  announcing itself under the wrong package name and its own version as "not
  installed". Nothing called the formatter either, so no build printed the line.

- The batch-admitted marker is written with a property definition rather than
  an assignment. A plain assignment walks the prototype chain, and every lane
  marks a fresh object literal, so an accessor installed on `Object.prototype`
  intercepted the write: it was handed the private token, and no own property
  was created at all. The second half needed no attacker - with any such
  accessor present, every entry of a batch re-took the decision its batch had
  already made, and the batch delivered a prefix and dropped its tail. The
  property stays own and enumerable, which is what the per-entry copies carry it
  by.

- The `tracing` adapter option is declared. The build validated it, serialized
  it and listed it among the known keys, but the published `AdapterOptions`
  never named it, so configuring the option the documentation describes was a
  type error.

- `websocket.compressCredentialedResponses` is read the way every other option
  is. The SSR lane reached it through a `typeof` guard rather than the plain
  read the rest of the runtime uses; the option worked, but a contract that
  follows option reads from the serialized payload could not see it, which is
  what such a contract exists to do.

- The posture export describes the deployment when CLUSTER_WORKERS is set. It
  is one socket path and the option is a build-time constant, so every worker
  evaluated the same install: each unlinked the previous owner's socket and
  bound its own, leaving only the last to bind reachable while the rest
  listened on orphaned inodes, and the first worker to shut down removed
  whichever socket was live at that moment. A consumer read one
  bind-order-chosen thread's posture and believed it was the server's - worse
  than reading none, since the export exists so an edge-defense daemon can act
  on it, and it would have acted on a quiet worker while a sibling was under
  siege. The primary owns the socket now. Each worker reports its posture
  inward on the same two occasions it used to push locally - every transition
  and every 1 Hz sample - and the primary serves the aggregate: the highest
  posture any worker is in, carrying THAT worker's own `reason` and pressure
  numbers so the line stays internally consistent, plus a `workers` count of
  the threads it summarizes. A worker that exits is dropped rather than
  remembered, because the aggregate is the worst worker and a thread that died
  in siege would otherwise pin the deployment there for as long as the primary
  ran. The 1 Hz cadence is driven by the primary at a fixed rate rather than by
  the workers' samples, which would have made it a function of the worker
  count; when no worker has reported, the cadence stops, which is what the
  contract already means by silence. Single-process deployments are untouched:
  the worker still binds its own socket and its line carries no `workers`
  field. The path travels to the primary with the first report rather than
  through the environment, so the option stays the one place it is configured.

- A publish can no longer talk its way past the cluster sequence authority by
  claiming to be a relayed frame. `publishWire` has an origin side and a relay
  receive side, and one boolean picks between them: the relay side skips the
  clustered sequence-authority rule, skips the seq value check, skips the
  egress decision, skips the publish counter, stamps the number it was handed
  instead of drawing the topic counter, and does not relay onward. That boolean
  was read from two ordinary string properties on the caller's own options
  object, and an application reaches `publishWire` with an options object of its
  own: spelling them let the caller put any number on a topic's sequence, off
  the publish ledger and past an armed egress ceiling. Naming the key with a
  symbol does not settle it on its own, because a caller never has to name a
  key - only to pass an object that answers for every key, which a `Proxy` or an
  inherited getter does. So the marker is not a key at all: it is an argument
  compared by identity against a token the runtime never hands out, and the
  relay decision reads that same token rather than a `relay: false` the internal
  caller had to remember to pass beside it. The forged keys are not refused,
  they are ignored: the call becomes an ordinary origin publish. Off-cluster
  that publishes normally with a locally-stamped sequence. In a multi-worker
  runtime it is then the cluster sequence authority that turns it away, because
  an ordinary publish carrying no `{ seq, relay }` pair is exactly what that
  check refuses - so a clustered app that was relying on the old keys sees a
  throw where it previously saw a publish. `svelte-adapter-ws/testing` carries
  its own copy of this lane and decides the same way; the dev plugin has no
  cross-worker relay to re-enter at all.

- The marker a batch uses to say "this call's egress decision is already taken"
  is compared by identity too. A batch is admitted whole or not at all, so its
  per-entry lanes carry a marker that stops an entry re-deciding; an options
  object that answered for every key satisfied that test and published past a
  ceiling the batch had never been admitted through. Making the value a symbol
  is not enough either, because a `get` trap is handed the key it is asked for
  and can echo it back. The marker's value is now something no caller is ever
  handed, and writing it and reading it go through one pair of helpers, so no
  lane can be left holding an older test.

- A handshake that never becomes a connection returns its upgrade permit. The
  permit was marked as transferred to the connection around the accept call,
  which is sound on the lead's transport because its accept either opens or
  throws. The `ws` library has a third outcome: for a non-GET, a missing or
  malformed `Sec-WebSocket-Key`, a version other than 8 or 13, a rejected
  `shouldHandle`, an unparseable subprotocol or a bad permessage-deflate offer,
  it answers the peer itself and returns, calling nothing and throwing nothing.
  Each of those took a permit nothing could hand back, so two unauthenticated
  packets per permit walked `upgradeAdmission.maxConnections` down to zero and
  left the server refusing every client until it was restarted. The transfer is
  now marked where the accept actually lands, in both the built runtime and
  `svelte-adapter-ws/testing`.
- A refusal page's headers accumulate on a null-prototype object, so a header
  named `__proto__` can no longer hit `Object.prototype`'s setter and vanish
  with no own property and no error.
- `upgradeAdmission.waitingRoom.template` given a function warns at build time
  instead of being dropped in silence. A function cannot be serialized into the
  build, so the operator was served the built-in page believing theirs was in
  use; the template is an HTML string with `{{token}}` placeholders.
- The waiting-room renderer types the family declares - `WaitingRoomRenderer`
  and the context and result shapes around it - are exported. The harness's own
  type declarations already imported `WaitingRoomRenderer`, so
  `svelte-adapter-ws/testing` did not type-check.

- A `seq` the wire cannot carry is refused before the egress ceiling answers.
  The publish lanes validated the value as a side effect of stamping it, and
  the stamp is the last thing they do, so under an armed ceiling whose window
  had been crossed `publish(topic, event, data, { seq: '5' })` returned `false`
  - the same answer an ordinary shed gives - and raised the TypeError only once
  load dropped. A programming error must not surface on a schedule set by
  traffic. The check now runs first on `publish`, on `publishWire` for a frame
  this worker originates, and at the batch call gate, which also puts it ahead
  of the empty-entries return so an empty batch refuses what a full one
  refuses.

- A batch entry's `seq` is judged through the shared resolver, in the pass that
  runs before anything is stamped, admitted or delivered. Production and the
  in-process harness each restated the table with a number-only check, which
  accepted a positive integer above the wire's safe-integer range and left the
  refusal to the stamping loop - by which point earlier entries of the same
  batch had already been stamped and the egress ceiling had already answered,
  so a batch that never went out whole still moved the topic sequence and put
  frames on the wire. The entry lane now takes bigint, `true` and `null` the
  way the options lane does, and a refusal names the position of the entry that
  carried the bad value.

- `PORT=0` with `CLUSTER_WORKERS` set refuses the boot. Every io worker binds
  the shared port itself, so an ephemeral port hands each worker a different
  kernel-assigned one: the fleet came up green, logged success, and served on
  as many ports as it had workers, none of which anything upstream knew to
  reach. Refused with the other value contradictions, ahead of the platform
  checks, because it holds on every platform.

- The cluster sequence gate takes every spelling the stamp takes. `seq: null`
  and a bigint authority reached the stamp as legal values but were refused by
  the clustered gate, which answered a topology error about relay settings and
  worker counters for a value the publish contract documents as fine. Worse on
  the batch surface: the refusal that stops one `options.seq` from numbering
  many entries only tested the number spelling, so a bigint slipped past it and
  stamped the same sequence onto every entry of the batch. That is not a
  failure a caller can see - it is a batch whose entries all claim one seq,
  which collapses a subscriber's watermark and makes resume discard the rest.
- The relay ring refuses a length prefix at or above 2^31 instead of decoding
  it negative. The unsign was applied to the top byte alone rather than to the
  whole or-chain, so the result came back as a signed integer: a negative
  length is not greater than the frame ceiling and not longer than the bytes in
  hand, so it passed both guards, then drove the parse offset deeply negative
  and span the reader through half a billion empty frames. That is exactly the
  corrupt stream the ceiling exists to refuse.

- A `subscribe` that asks to recover from an offset without carrying a `ref`
  is refused with an `error` frame carrying `RECOVER_REQUIRES_REF`, rather
  than being dropped in silence. Every other refusal on the subscribe path
  answers nothing when the frame carries no ref, which is the documented ack
  policy, but it left a client replaying history unable to tell a served
  resume from a swallowed one, so it carried on from an offset whose gap
  nothing had reported. The refusal runs before the topic checks and the
  authorization hooks, so nothing can eat it first, and the built runtime and
  `svelte-adapter-ws/testing` answer it alike. On the built runtime the
  `subscribe-batch` form refuses the whole frame with a null topic, because
  one ref covers every history request its recover map names.

- Publish `seq` resolution accepts the values the lead adapter accepts and
  refuses the ones it refuses. `seq: null` means no seq instead of quietly
  drawing the in-memory counter, so a nullable column that arrives empty no
  longer marks the topic authoritative behind the caller's back. A bigint
  stamps as the explicit authority it spells rather than falling through to
  the counter. A string or an object throws instead of degrading resume
  dedup with nothing on the wire to notice by. A value above the
  safe-integer range is refused rather than stamped onto a space that cannot
  keep it distinct from its neighbour, which would strand a client watermark
  that only ever advances on a strict greater-than.

- A cert-directory watcher error after arming (a renewal's symlink swap
  removing the watched directory, EPERM on teardown) no longer crashes the
  cluster primary; the watcher closes itself and the degraded state is
  reported, matching the single-process watch.
- The primary's certificate identity record no longer misapplies
  `SSL_SNI_HOSTS` to the first certificate when extra certificates are
  configured; the override's semicolon groups then name hosts for the extra
  certificates, and with a single certificate the override names its own
  renewal hosts.
- A malformed entry anywhere in a cross-worker batched relay frame now
  refuses the whole batch at the hard tier before anything reaches a
  subscriber, matching the single-frame relay lane.
