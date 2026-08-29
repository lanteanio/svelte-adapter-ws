# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- `SHUTDOWN_TIMEOUT` bounds the whole teardown sequence - app shutdown hooks,
  the WebSocket drain and the HTTP in-flight drain now share the one budget
  instead of each spending it in full, so the process is down when the
  configured number says it is. `0` still means no budget anywhere. In cluster
  mode the primary's force-exit fires one worker-exit grace after the budget,
  so a worker inside its own bound never loses the race to its supervisor.

### Fixed

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
