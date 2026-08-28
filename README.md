# svelte-adapter-ws

> **Status: under construction, functionally broad.** The HTTP half, the JSON
> realtime lane, the 0x03 binary wire, the pressure sampler and the managed
> drain are built and tested against the family contracts. Not yet published
> to npm; the remaining lanes are listed under Current state. Family options
> whose lanes have not shipped here refuse the build rather than silently
> no-op'ing.

A SvelteKit adapter on Node's own `http`/`https` server plus the
[ws](https://github.com/websockets/ws) library: it follows
[svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws) and is
meant to work with the same ecosystem around it -
[svelte-realtime](https://github.com/lanteanio/svelte-realtime) for the client
stores and
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
for clustering, presence and cursors. Same `platform.*` surface, same plugins,
same client. The adapter swap is one line in `svelte.config.js`; app code is
unchanged.

## Why this exists

`svelte-adapter-uws` rides uWebSockets.js, a native N-API addon. It installs
from a `github:` URL and needs a prebuild for the host platform, and some teams
will not take a native dependency into their deployment no matter how
straightforward it is in practice. This adapter is for them: the same realtime
DX on nothing but Node core and a pure-JS WebSocket library, at the cost of peak
throughput.

The family, by tier:

| package | transport | tier |
|---|---|---|
| `svelte-adapter-uws` | uWebSockets.js on Node | maximum performance |
| `svelte-adapter-ws` (this repo) | node:http + ws | maximum portability |
| `svelte-adapter-bunserve` | Bun.serve | Bun, natively |

The suffix names the transport, like every member of the family: `uws` is
uWebSockets.js, `ws` is the ws library, `bunserve` is `Bun.serve`.

What the portability tier gives up is throughput, not features: peak HTTP and
socket rate, idle-connection density, and large-topic JSON fan-out. What it does
not give up is capability. In-process TLS is first class through `node:https`,
and it is a superset of what the native tier offers - SNI, multiple certs, PFX,
OCSP stapling. Node also brings HTTP/2 and the entire observability ecosystem
(APM agents, OpenTelemetry auto-instrumentation, `AsyncLocalStorage`,
`--inspect`), none of which hooks a native addon.

## Current state

1. **API probe** (done): `probe/ws-api-facts.mjs` empirically verifies every
   `node:http` and `ws` behavior the adapter design relies on - send results and
   backpressure signals, closed-socket behavior, the upgrade flow, payload
   limits, compression, shutdown drain, listen options - and writes a committed
   facts report. The adapter is built against what these libraries were measured
   to do, not against what their documentation says. Run it with `npm run probe`
   after any Node or `ws` upgrade and review the diff.

   What the first run established, and what each fact costs:

   - `send()` returns nothing and never throws, on an open or a closed socket.
     The uWS-shaped tri-state return has to be synthesized by the facade from
     `bufferedAmount` plus the send callback, which does report
     `WebSocket is not open: readyState 3 (CLOSED)` for a dead socket.
   - Nothing on a `ws` socket throws when it is closed - not `send`, not `ping`,
     not `close`. The throw-on-closed contract that drives dead-connection
     cleanup in the extensions package is entirely facade work here.
   - There is no native pub/sub: none of `subscribe`, `unsubscribe`, `publish`,
     `isSubscribed`, `getTopics`, `cork` or `getBufferedAmount` exists on a
     socket, and `WebSocketServer` has no `publish`. Topic fan-out is a JS
     registry walk.
   - `bufferedAmount` is in bytes and grows under a slow consumer; the send
     callback fires once the peer drains, which is the drain signal the
     backpressure pump needs.
   - The handshake survives an `await` before `handleUpgrade`, so async
     admission before completing the upgrade works; destroying the socket
     mid-upgrade refuses the client cleanly.
   - `http.close()` does not call back while a WebSocket is open, and live
     sockets keep working after it. A managed drain is required equipment.
   - `server.listen({ reusePort: true })` is `ENOTSUP` on Windows, so the
     single-host multi-core story cannot assume it; `node:cluster` is the
     portable path.
   - The public `@sveltejs/kit/node` primitives (`getRequest`, `setResponse`,
     `createReadableStream`) are all present, which is what the HTTP half is
     built on - never adapter-node's private handler.

2. **HTTP half** (done): a built SvelteKit app serves over `node:http` - or
   `node:https` with first-class in-process TLS: a PEM pair (`SSL_CERT`/
   `SSL_KEY`, comma-separated lists for multiple certificates - the first
   pair is the default context, every further pair serves the SNI names its
   cert carries or the `SSL_SNI_HOSTS` override), a PKCS#12 bundle
   (`SSL_PFX`/`SSL_PFX_PASSPHRASE`), OCSP stapling from an
   externally-maintained response file (`SSL_OCSP_FILE`), and certificate
   hot-reload (`SSL_WATCH`, default on; `SSL_RELOAD_DEBOUNCE_MS`) that swaps
   the secure context in place so a certbot renewal never drops a live
   connection. The probe TLS section runs unattended against committed
   fixtures. HTTP serving goes through the public
   `@sveltejs/kit/node` primitives - `getRequest`, `setResponse`,
   `createReadableStream` - bundled into the build output so a production
   install needs no devDependencies. The in-memory static cache answers with
   negotiated precompressed representations (per-representation weak ETags),
   single byte ranges cut in the negotiated representation's coordinates,
   If-None-Match/If-Range preconditions, the dotfile refusal with its
   `.well-known` carve-out, and the prerendered trailing-slash alias and 308
   rules. SSR gets concurrent-request dedup for anonymous GET/HEAD,
   single-chunk dynamic compression with the BREACH-defense credential skip, a
   default `x-content-type-options: nosniff` fill, and the family
   duplicate-header policy (repeated singleton headers are refused, proxy
   identity headers keep their last line). Health and readiness probes,
   readiness-gated SSR warmup, `ADDRESS_HEADER`/`TRUSTED_PROXIES` client-IP
   resolution and a managed drain of in-flight requests are in. `PROXY_PROTOCOL`
   and `CLUSTER_WORKERS` refuse the boot loudly rather than half-working.

3. **JSON realtime** (done): the upgrade path with async admission, origin
   policy, per-IP rate limiting, upgrade timeout and validated custom 101
   headers; the socket facade that synthesizes the family tri-state send
   result (0 enqueued / 1 sent / 2 dropped) from `bufferedAmount` plus the
   backpressure ceiling and throws on closed sockets exactly where the
   sibling packages' liveness sweeps expect it; the JS topic registry with a
   per-topic reverse index so a publish walks subscribers, not connections;
   and the full `platform` surface - publish (seq-stamped per topic),
   publishBatched with the shared batch frame for cap-holders, send, sendTo,
   sendCoalesced with the drain pump, request/requestTopic over reply frames,
   subscribe/checkSubscribe/unsubscribe with the shared authorization-policy
   predicates and pending-subscribe revocation machinery, the game lane
   (grantPublish/publishGame), adviseReconnect, hlc, and the extensions-facing
   symbol slots under the family's shared `Symbol.for` keys. Control frames:
   welcome, hello/caps with the lease grant, subscribe and subscribe-batch
   with resume-on-subscribe gap-fill barriers, unsubscribe, resume, reply,
   request-n, game, and the oversized-control-frame refusal. The
   `authenticate` preflight endpoint with CSRF defense and rate limiting is
   in; app hooks fire through the same lifecycle as the lead adapter (init
   before readiness, shutdown inside the drain budget). The `websocket.*`
   options whose lanes have not shipped here (admin, metrics, workers,
   admission ceilings, egress, posture) refuse the build loudly.
   Graceful shutdown drains live sockets itself (`http.close()` never
   completes while one is open): new upgrades are refused the moment drain
   begins, every client gets the reconnect advisory with the
   `RECONNECT_DISPERSAL_MS` window (default 5000, 0 disables the advisory)
   and a 1001 close, and whatever ignores the close frame past the budget is
   terminated.

4. **Binary wire** (done): the `0x03` frame fan-out for capability-advertising
   subscribers with the `wire-id` announce ordered on the same socket before
   the first frame, per-connection topic ids (monotonic from 1, never
   reclaimed), per-connection codec state attached once per capability and
   detached on close, the stateful-drop poison rule (a frame shed past
   `maxBackpressure` degrades that capability to JSON until reconnect - a
   stateful decoder cannot resync in-band), the shared batch encode with
   per-entry JSON fallback, the client-to-server ingress lane
   (`wire.ingress:1`, `ingress-bind`/`ingress-bound`, the `game:1` twin
   routed through the publish grant) and the compact `game.fanout:1` egress.
   The frame layout is pinned against the family conformance vector
   (`test-vectors/binary.json`), varints decoded with division so shared ids
   above 2^32 survive. Seq values ride both representations from one stamp.

5. **Pressure** (done): the 1 Hz sampler behind `platform.pressure` mutates
   one stable snapshot in place - publish rate, subscriber ratio, the
   memory-wall ratio (distance to the nearest of the V8 heap limit and the
   cgroup limit, never arena fullness), the bounded `bufferedAmount` walk
   (1024-connection cap, 64 KiB threshold), the exact shed window, kernel PSI
   and CFS-throttle signals where Linux provides them, and the top publishers
   by rate. `platform.onPressure` fires on reason transitions,
   `platform.onPublishRate` once per window; lease grants are sized from the
   live heap ratio and subscriber ratio, and the client-reported send-gate
   backlog folds into the headline `value`. `websocket.pressure` thresholds
   are honored. `npm run bench:slow-consumer` proves engagement end to end: a
   TCP-paused consumer must appear in the sampler, shed at the
   `maxBackpressure` ceiling, and recover to a clean snapshot - a zero stub
   fails the bench.

6. **Golden gate** (not started): the transport-independent DST goldens
   reproduced under this backend, and the `PLATFORM_KEYS` parity site added.
   Same trace, same wire revision, or it does not ship.

## Deployment

One process serves one core well; scale out by running one instance per core
under the platform process manager (systemd template units, PM2, container
replicas) behind a load balancer, with
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
providing the cross-instance relay, presence and clustering primitives over
Redis. `server.listen({ reusePort: true })` is platform-dependent (`ENOTSUP`
on Windows, measured by the probe), so nothing here assumes it; `node:cluster`
remains the portable single-host alternative for a process manager, but the
adapter does not supervise workers itself - the topic registry is per-process,
and cross-worker fan-out belongs to the extensions relay rather than a
second, in-process relay implementation. `CLUSTER_WORKERS` therefore refuses
the boot instead of half-working.

## License

MIT
