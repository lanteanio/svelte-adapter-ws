# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Managed WebSocket drain on shutdown: new upgrades are refused the moment
  drain begins, live clients receive the reconnect advisory with the
  `RECONNECT_DISPERSAL_MS` dispersal window (default 5000ms; 0 closes without
  the advisory) and a 1001 close, close handshakes are awaited within the
  shutdown budget, and sockets that ignore the close frame are terminated -
  after which the HTTP listener close can actually complete.

- The JSON realtime lane: WebSocket upgrades over `node:http` with async
  admission, origin policy, per-IP sliding-window rate limits, upgrade
  timeout, and validated custom 101 headers; a socket facade that synthesizes
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
  representations, per-representation weak ETags, single byte ranges,
  If-None-Match/If-Range preconditions, the dotfile refusal with the
  `.well-known` carve-out, and the prerendered trailing-slash rules. SSR flows
  through `getRequest`/`setResponse` with concurrent-request dedup for
  anonymous GET/HEAD, single-chunk dynamic compression (skipped for
  credentialed requests as BREACH defense), a default
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
  changes an observed behavior shows up as a diff. TLS is recorded as manual
  because it needs certs.

- `protocol.schema.json`, vendored byte-identical from svelte-adapter-uws and
  held that way by `.gitattributes`, so the wire this adapter speaks is the wire
  the lead adapter declares.

- The determinism ratchet (`npm run check:determinism`): every clock, RNG and
  timer read under `src/` must go through the injectable runtime module, or the
  scan fails naming the raw call site.

There is no adapter yet. The runtime, the test lanes and the published package
land in the slices listed under Current state in the README.
