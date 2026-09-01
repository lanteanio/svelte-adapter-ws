# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  deep, or the SSL_SNI_HOSTS override), PKCS#12 bundles via
  SSL_PFX/SSL_PFX_PASSPHRASE, OCSP stapling from an externally-maintained DER
  response (SSL_OCSP_FILE, re-read per handshake, with the last good bytes
  age-bounded to an OCSP validity window), and certificate hot-reload on
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
  through `getRequest`/`setResponse` with concurrent-request dedup for
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

### Changed

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

### Fixed

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
  `SSL_SNI_HOSTS` to the first certificate; the override's semicolon groups
  only ever name hosts for the extra certificates.
- A malformed entry anywhere in a cross-worker batched relay frame now
  refuses the whole batch at the hard tier before anything reaches a
  subscriber, matching the single-frame relay lane.

The package is not yet published to npm; this section becomes 0.1.0 at the
first cut.
