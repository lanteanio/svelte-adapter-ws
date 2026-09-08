# svelte-adapter-ws

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

## Public entry points

This catalog is generated from the package export map by
`node scripts/render-entry-points.js`. Every subpath declares its role,
execution environment, stability and deprecation state, carried from the
lead adapter so the same import means the same thing in either package. The
suite fails if the table drifts from the export map, if a declared subpath
does not resolve, or if this package declares a subpath the lead does not.

<!-- public-entry-points:start -->
| Entry point | Role | Environment | Stability | Deprecation |
|---|---|---|---|---|
| `svelte-adapter-ws` | SvelteKit adapter and build output | Node build | supported | none |
| `svelte-adapter-ws/upgrade-response` | WebSocket 101 response headers | Node runtime | supported | none |
| `svelte-adapter-ws/connection` | Stable connection identity | Node runtime | supported | none |
| `svelte-adapter-ws/client` | Reactive connection and topic stores | Browser | supported | none |
| `svelte-adapter-ws/vite` | Development WebSocket and handler build plugin | Node build/dev | supported | none |
| `svelte-adapter-ws/testing` | In-process handler integration harness | Node test | supported | none |
| `svelte-adapter-ws/sim` | Deterministic network and cluster simulator | Node test | experimental | none |
| `svelte-adapter-ws/safe-url` | Outbound SSRF policy and address classification | Node runtime | supported | none |
| `svelte-adapter-ws/observability` | Signal manifest, diagnostic formatter/parser, and schema validator | Universal | supported | none |
| `svelte-adapter-ws/plugins/replay` | Server replay buffer | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/replay/client` | Browser replay client | Browser | supported | none |
| `svelte-adapter-ws/plugins/presence` | Server presence registry | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/presence/client` | Reactive presence client | Browser | supported | none |
| `svelte-adapter-ws/plugins/channels` | Typed server topics | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/channels/client` | Typed client topics | Browser | supported | none |
| `svelte-adapter-ws/plugins/throttle` | Topic throttle and debounce | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/ratelimit` | Message rate limiting | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/cursor` | Server cursor fan-out | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/cursor/client` | Reactive cursor client | Browser/worker | supported | none |
| `svelte-adapter-ws/plugins/middleware` | Message middleware pipeline | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/queue` | Per-key ordered work queue | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/groups` | Server broadcast groups | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/groups/client` | Reactive group client | Browser | supported | none |
| `svelte-adapter-ws/plugins/lock` | Per-key critical sections | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/session` | In-process session store | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/dedup` | Idempotency window | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/crdt` | CRDT wire codec and authority | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/crdt/client` | Binary CRDT client sink | Browser | supported | none |
| `svelte-adapter-ws/plugins/crdt/replica` | Local CRDT replica primitives | Browser/Node | supported | none |
| `svelte-adapter-ws/plugins/crdt/channel` | Reactive CRDT channel | Browser | supported | none |
| `svelte-adapter-ws/plugins/smooth` | Server prediction authority and codec | Node runtime | supported | none |
| `svelte-adapter-ws/plugins/smooth/client` | Prediction and interpolation client | Browser | supported | none |
| `svelte-adapter-ws/plugins/smooth/random` | Shared deterministic random stream | Browser/Node | supported | none |
| `svelte-adapter-ws/plugins/webhooks` | SSRF-gated webhook delivery | Node runtime | supported | none |
<!-- public-entry-points:end -->

## Install

```sh
npm install svelte-adapter-ws
```

Install it as a regular dependency, not a devDependency. Unlike most SvelteKit
adapters, the built server resolves the `ws` library at runtime through this
package's dependency tree - a production install that prunes devDependencies
would prune the WebSocket transport with it. Everything else the runtime needs
(the `@sveltejs/kit/node` primitives included) is bundled into the build
output.

## Usage

```js
// svelte.config.js
import adapter from 'svelte-adapter-ws';

export default {
	kit: {
		adapter: adapter()
	}
};
```

That serves HTTP, static assets and SSR with zero configuration:
`node build/index.js` listens on `0.0.0.0:3000`. Realtime is one option away:

```js
adapter({
	websocket: {
		handler: './src/lib/server/ws.js',
		allowedOrigins: ['https://app.example.com']
	}
})
```

The handler module exports the family's hook set (`upgrade`, `open`,
`message`, `close`, and the rest); every hook receives the same `platform`
surface the lead adapter exposes - `publish`, `send`, `subscribe`,
`platform.pressure` and the rest - so an app written against
`svelte-adapter-uws` runs unchanged, and the
[svelte-realtime](https://github.com/lanteanio/svelte-realtime) client stores
connect to either. Family options whose lanes have not shipped here refuse
the build loudly rather than silently no-op'ing.

## Configuration

Adapter options (`adapter({ ... })`): `out`, `precompress`, `envPrefix`,
`healthCheckPath`, `readinessCheckPath`, `staticHeaders`,
`staticCacheControl`, `staticDotfiles`, `warmup`, `tracing`, and the
`websocket` block (`handler`, `path`, `authPath`, `adminPath`,
`adminAuthAcknowledged`, `maxPayloadLength`,
`idleTimeout`, `maxBackpressure`, `closeOnBackpressureLimit`, `compression`,
`allowedOrigins`, `upgradeTimeout`, `upgradeRateLimit`, `upgradeAdmission`,
`messageAdmission`, `maxTopicSeqEntries`, `pressure`, `egress`, `protection`,
`postureExport`, `consistencyAuditIntervalMs`,
`resourceGrowthAuditIntervalMs`, `metrics`, `primaryInit`, `workers`, and the
shared policy flags). The typed surface in `src/index.d.ts` is the reference.

`websocket.maxTopicSeqEntries` (default `1000000`) caps the per-topic sequence
registry. Past the cap the least recently published unprotected topic is
evicted and its high-water number carried forward, so a re-published topic
always resumes above what any forgotten topic reached - a counter may skip
numbers, it never repeats one. `0` disables the bound.

`websocket.upgradeAdmission` gates NEW handshakes; an open connection is never
touched. `maxConcurrent` caps upgrades in flight, `maxConnections` caps
reserved-plus-live sockets with a permit held until close, `perTickBudget`
paces how many handshakes complete per event-loop tick behind a finite
`maxDeferred` queue, and `cursorLane.fraction` reserves part of the concurrent
ceiling for the cursor-only lane so a flood of cursor reconnects cannot starve
the main lane. Whenever a ceiling is set the refusal is content-negotiated: a
browser navigation to the WebSocket path (or to `waitingRoom.path`, default
`/__waiting-room`) gets a self-polling holding page that reloads when a slot
frees, polling `waitingRoom.admitCheckPath` (default `/__admit-check`), while
WebSocket clients and non-HTML requests keep `503` with a jittered
`Retry-After`. `waitingRoom: false` drops the polling page and answers an HTML
navigation with a minimal accessible `503` instead. `waitingRoom.template`
takes a full HTML document with `{{token}}` substitution, and
`waitingRoom.renderer` takes a module path that renders per request for
locale-aware pages; the two are mutually exclusive and both are validated when
the adapter is configured.

`websocket.egress` caps publish egress per accounting window: `topic` and
`tenant` ceilings over `messages`, `bytes` and `deliveries`, with `windowMs`,
`maxKeys` and `evictionSample` sizing the ledger. A refused publish returns
`false` (batches refuse atomically), stamps no sequence, and is counted in
`platform.pressure.egress`. Tenants resolve through the WebSocket handler's
`egressTenantOf(topic)` export.

Protocol control frames - `welcome`, subscribe acks and denials, `lease-ok`,
the flow-control window grants, protocol errors - are charged against no
egress budget: those budgets meter application-data fan-out, and charging
control frames to them would let an exhausted tenant budget refuse the very
grant frames that pace a client down. They carry their own ceiling instead,
because the channel amplifies: a client names a topic in a few bytes and is
answered with a whole frame, and one 8 KB `subscribe-batch` comes back as
roughly 97 KB across 1,345 frames. Each connection may be sent 4 MiB of
control frames per 10-second window, after which it is closed with `4429`,
the throttle code the bundled client already reconnects on. The ceiling is
fixed: a client restoring 256 topics is answered with about 15 KB and a
5,000-topic restore costs about 300 KB, so a healthy burst sits far under it.
Application `send` and `publish` traffic is never charged here. See
[`ADAPTER-ERR-CONTROL-EGRESS-EXHAUSTED`](docs/errors.md#adapter-err-control-egress-exhausted).

`websocket.protection` (default `'normal'`) is the graduated protection
posture over the 1 Hz pressure signal, and it governs only the admission of
NEW upgrades - an open connection is never touched at any level. `'auto'`
escalates fast and relaxes slow: `normal -> elevated` after sustained
`pressure.active`, `elevated -> siege` once over-capacity upgrade rejects run
at twice the gate's admit rate, and each step down needs a longer quiet dwell.
`'elevated'` and `'siege'` pin a level for incident response. At `elevated`
every capacity refusal widens its `Retry-After` jitter; at `siege` new
upgrades are refused at static-serve cost, `/__admit-check` always answers
`202` with a doubled `pollAfterMs`, and a browser navigation to the WebSocket
path gets the capacity page rather than `426`. A per-IP `429` never feeds the
escalation - that is an attack signal, not capacity. The live level reads back
as `platform.protection` and layers `'CAPACITY'` onto `platform.pressure`
(`MEMORY` still outranks it). Only the `siege` step needs a ceiling:
escalation to `siege` compares the over-capacity reject rate against the
gate's admit rate, so without `upgradeAdmission.maxConcurrent` or
`maxConnections` there is no rate to compare and `'auto'` stops at
`elevated` - which it still reaches on sustained pressure alone.

`websocket.postureExport` opens a local stream socket - a unix domain socket
path, or a `\\.\pipe\...` named pipe on Windows - and pushes the live posture
to every connected consumer as newline-delimited JSON
(`{"v":1,"posture":"elevated","reason":"PSI","value":0.83,"psi":{...},"cpuThrottle":{...}}`):
once on connect, once per transition, and once per 1 Hz sample, so a consumer
that stops receiving lines knows the adapter is gone. Local-only and
payload-free.

`websocket.consistencyAuditIntervalMs` (default `5000`) runs the shared
invariant predicates against a bounded, structure-only snapshot of live
connections on a slow, jittered, unref'd timer, off the hot path. A violation
logs and increments `platform.assertions`; only a subscription slot that is no
longer a `Set`, persisting across two consecutive audits, escalates to a
deferred worker restart. `0` disables it and schedules no timer.
`websocket.resourceGrowthAuditIntervalMs` (default `0`, off) is the
observe-only counterpart: it trends the SIZE of the live bookkeeping
collections and logs one throttled warning when a series climbs monotonically,
the signature of a close, unsubscribe or eviction path that stopped shedding.

### Metrics

`websocket.metrics` is a **module path**, not a live object - adapter options
are serialized into the build, so a registry constructed in
`svelte.config.js` could never reach the production runtime. Point it at a
module whose default export (or a named `metrics` / `registry` export) is a
Prometheus-shaped registry; the adapter populates it and republishes it as
`platform.metrics`.

```js
// src/lib/server/metrics.js
import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
export const metrics = createMetrics();

// svelte.config.js
adapter({ websocket: { metrics: './src/lib/server/metrics.js' } })
```

The adapter serves no scrape route of its own - write an ordinary one:

```js
// src/routes/metrics/+server.js
export const GET = ({ platform }) =>
	new Response(platform.metrics.serialize(), {
		headers: { 'content-type': 'text/plain; version=0.0.4' }
	});
```

The registry only needs `counter(name, help, labelNames?)` and
`gauge(name, help)`, each returning `{ inc }` / `{ set }`; `histogram` and
`serialize` are optional. No client identity - address or session - ever
reaches a label.

`await platform.metricsSnapshot()` is the cluster-wide read. It is built from
the values the adapter wrote rather than from rendered text, so it needs no
`serialize()` and stays on canonical unprefixed manifest names however the
registry renders its own output. Under `CLUSTER_WORKERS` the primary collects
every worker and merges.

Two different things can go wrong, and they are reported by different signals.
A worker that misses the primary's deadline is simply absent from the merge:
the document renders what arrived and `metrics_snapshot_workers_reporting`
falls below `..._expected`, with `metrics_snapshot_degraded` still `0`. A
scrape that never hears back from the primary at all answers with the
requesting worker ALONE and sets `metrics_snapshot_degraded 1` - the
expected/reporting pair cannot say so, because a worker that got no answer
does not know how many siblings it has. Alert on both: degraded means the
collection failed, a reporting shortfall means it succeeded and someone was
missing.

`metrics_snapshot_workers_expected` and `..._reporting` are how you tell a
healthy fleet from a partial one - a worker counts as reporting only once it
has registered every required counter family and sampled every required
gauge.

With the Vite plugin installed - the standard setup - the registry is bundled
into the app's own server graph and deduplicated with every route that imports
it, so `platform.metrics` and a direct import read the same object. Without
it the adapter falls back to a standalone bundle, which instantiates the
module twice: adapter counters land on a copy only `platform.metrics` reaches
and an app-graph import reads the other, empty one. The build warns when it
takes that fallback.

### The reserved `/__realtime/*` admin route

When your WebSocket handler exports an `admin(request)` function -
`svelte-realtime`'s auth-gated observability handler is the canonical one - the
adapter mounts it at the reserved `/__realtime/*` path, matched **before** the
static and SSR lanes. The match reads the request target as sent: a target that
resolves outside the prefix is refused `400` rather than rewritten, and one
whose raw form lies outside the prefix takes the ordinary static and SSR lanes
even where it would resolve inside it. The adapter bridges the `node:http`
request to the framework-agnostic Web `Request` -> `Response` contract the
handler speaks and writes the response back; it is pure
transport plumbing, so **all** authorization lives in your handler (the adapter
never inspects or short-circuits the decision). A handler that throws, rejects,
or returns a non-`Response` yields a generic `500` with no detail leaked. The
route is a no-op unless the handler exports `admin`, so existing apps are
unaffected.

Configure the prefix with `websocket.adminPath`:

```js
// vite.config.ts - inside sveltekit({ adapter: ... })
adapter({
  websocket: {
    adminPath: "/__ops", // relocate it (default '/__realtime')
    // adminPath: false    // OR disable the auto-mount entirely
  },
});
```

Set a **string** to relocate the route (defense-in-depth, or to avoid colliding
with an app route), or **`false`** to disable the auto-mount entirely - for apps
that mount the `admin` handler themselves through a SvelteKit `+server.js` route
(with their own middleware), so there is no second adapter-owned mount point. It
must be an absolute path differing from `websocket.path` and
`websocket.authPath`; an invalid value fails the build. The `svelte-realtime`
admin handler is mount-prefix agnostic, so the path is configured here in one
place.

Because the adapter cannot see whether your handler gates its own requests, it
warns once at boot that the mounted route carries no adapter-level
authentication. Set `websocket.adminAuthAcknowledged: true` once the handler
validates a session cookie, bearer token or equivalent and that line stops
appearing; it changes nothing about routing or authorization.

Tracing is opt-in and vendor-neutral: point `tracing` at a server module whose
default (or named `tracing`/`provider`) export implements
`startSpan(name, options)` - an OpenTelemetry adapter fits in a dozen lines.
With a provider configured, the runtime opens spans for SSR, static and
prerendered serving, WebSocket upgrades and per-message hooks, propagates W3C
`traceparent`/`tracestate` from the request into the connection, and exposes
the active context as `platform.trace` / `platform.traceContext`. Without the
option the tracing paths cost one boolean test.

Runtime environment (prefix configurable via the `envPrefix` option):

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address. |
| `ORIGIN` | - | The app's public origin (behind a TLS-terminating proxy). |
| `PROTOCOL_HEADER` / `HOST_HEADER` / `PORT_HEADER` | - | Proxy identity headers when `ORIGIN` is not pinned. |
| `ADDRESS_HEADER` / `XFF_DEPTH` | - / `1` | Client IP resolution behind proxies. |
| `TRUSTED_PROXIES` | - | CIDR allowlist; identity headers from peers outside it are ignored. |
| `BODY_SIZE_LIMIT` | `512K` | Request body cap (413 above it). |
| `SHUTDOWN_TIMEOUT` | `30` | Seconds for the WHOLE teardown sequence - app shutdown hooks, the WebSocket drain, then the HTTP in-flight drain share this one budget; `0` removes it (live WebSockets still drain within 30s - a socket never ends on its own). |
| `SHUTDOWN_DELAY_MS` | `0` | Readiness-flip lead time for balancers that poll. |
| `RECONNECT_DISPERSAL_MS` | `5000` | Reconnect-advisory window at drain; `0` disables the advisory. |
| `SSL_CERT` / `SSL_KEY` | - | PEM pair; comma-separated lists serve extra certs per SNI name (wildcard SANs included). |
| `SSL_SNI_HOSTS` | - | Per-cert SNI name override, semicolon-grouped. |
| `SSL_PFX` / `SSL_PFX_PASSPHRASE` | - | PKCS#12 bundle instead of the PEM pair. |
| `SSL_OCSP_FILE` | - | Externally-maintained DER OCSP response to staple. |
| `SSL_WATCH` / `SSL_RELOAD_DEBOUNCE_MS` | `1` / `500` | Certificate hot-reload watch. |
| `CLUSTER_WORKERS` | - | In-process cluster: worker-thread count or `auto` (Linux; see Deployment). |
| `CLUSTER_MODE` | `reuseport` | The one mode this runtime has; `acceptor` refuses with the reason. |
| `CLUSTER_RELAY_RING_KB` | `256` | Shared-memory relay ring per direction per worker; `0` = postMessage only. |
| `CLUSTER_RELAY_MAX_PENDING_KB` / `_MAX_PENDING_MS` | `4096` / `5000` | Per-peer relay spill ceilings; a worker past them is quarantined and replaced. |
| `CLUSTER_RELAY_MAX_FRAME_KB` | pending KB | Sender-side ceiling on one relayed envelope; `0` disables. |
| `WORKER_BOOT_TIMEOUT_MS` | `60000` | Boot deadline for a worker that stops acking liveness mid-init; `0` disables. |

A second `SIGTERM`/`SIGINT` during a drain exits immediately - the operator's
"now". `PROXY_PROTOCOL` refuses the boot loudly rather than half-working, and
so does every invalid cluster configuration (see Deployment).

What the portability tier gives up is throughput, not features: peak HTTP and
socket rate, idle-connection density, and large-topic JSON fan-out. What it does
not give up is capability. In-process TLS is first class through `node:https`,
and it is a superset of what the native tier offers - SNI, multiple certs, PFX,
OCSP stapling. Node also brings HTTP/2 and the entire observability ecosystem
(APM agents, OpenTelemetry auto-instrumentation, `AsyncLocalStorage`,
`--inspect`), none of which hooks a native addon.

## What ships, mechanically

1. **API probe**: `probe/ws-api-facts.mjs` empirically verifies every
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
   - `server.listen({ reusePort: true })` is `ENOTSUP` on Windows, which is
     why the in-process cluster requires Linux and refuses everywhere else
     instead of booting workers whose binds fail.
   - The public `@sveltejs/kit/node` primitives (`getRequest`, `setResponse`,
     `createReadableStream`) are all present, which is what the HTTP half is
     built on - never adapter-node's private handler.

2. **HTTP half**: a built SvelteKit app serves over `node:http` - or
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
   If-None-Match/If-Modified-Since/If-Range preconditions, the dotfile refusal with its
   `.well-known` carve-out, and the prerendered trailing-slash alias and 308
   rules. SSR gets concurrent-request dedup for anonymous GET/HEAD,
   single-chunk dynamic compression with the BREACH-defense credential skip, a
   default `x-content-type-options: nosniff` fill, and the family
   duplicate-header policy (repeated singleton headers are refused, proxy
   identity headers keep their last line). Health and readiness probes,
   readiness-gated SSR warmup, `ADDRESS_HEADER`/`TRUSTED_PROXIES` client-IP
   resolution and a managed drain of in-flight requests are in.
   `PROXY_PROTOCOL` refuses the boot loudly rather than half-working.

3. **JSON realtime**: the upgrade path with async admission, origin
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
   before readiness, shutdown inside the drain budget). Every `websocket.*`
   option the family declares ships here. The per-connection caps are the
   family's: 1,000,000 for the large retained-state maps, 65,536 for
   subscriptions per connection (a landed subscription is a topic-registry
   entry as well as a Set entry, so one connection must not be able to hold
   hundreds of megabytes the connection ceiling cannot see), and the small
   fixed ones for pending subscribes and ingress bindings; the 65,537th
   subscribe is answered `subscribe-denied` with `RATE_LIMITED` and
   everything held stays.
   Graceful shutdown drains live sockets itself (`http.close()` never
   completes while one is open): new upgrades are refused the moment drain
   begins, every client gets the reconnect advisory with the
   `RECONNECT_DISPERSAL_MS` window (default 5000, 0 disables the advisory)
   and a 1001 close, and whatever ignores the close frame past the budget is
   terminated.

4. **Binary wire**: the `0x03` frame fan-out for capability-advertising
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

5. **Pressure**: the 1 Hz sampler behind `platform.pressure` mutates
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

6. **In-process cluster**: `CLUSTER_WORKERS=<n|auto>` turns the process
   entry into a primary that runs the app's `websocket.primaryInit` once
   (its return value - SharedArrayBuffers included - replays as
   `workerData.app` to every worker and respawn) and spawns one worker
   thread per slot. Each io worker binds the shared port itself with
   SO_REUSEPORT and the kernel distributes accepts; `websocket.workers`
   `{ compute }` slots boot the full app without a listen socket for
   app-driven shared-memory work. Cross-worker publish fan-out rides two
   SharedArrayBuffer rings per worker (encode once, primary forwards bytes
   verbatim, only receivers decode) with postMessage as the fallback and
   control lane; per-peer spill ceilings quarantine a worker that stops
   draining, and a sender-side frame ceiling refuses the pathological
   publish at its source. The primary heartbeats the fleet, escalates a
   wedged worker through the clean-exit protocol (terminating just that
   thread after the grace), respawns crashed slots under per-slot
   exponential backoff with a stable-uptime budget reset, owns the TLS
   cert-directory watch (workers swap their own contexts on its
   broadcast), and drains readiness fleet-wide before the shutdown delay.
   Every invalid configuration refuses before a worker spawns, through
   the error catalog. In a multi-worker topology sequenced publishes
   require an explicit external authority (`{ seq: <n>, relay: false }`)
   or `{ seq: false }` - per-worker counters cannot preserve one
   monotonic topic sequence, and the refusal says so at the publish site.

7. **Golden gate**: the platform-surface parity site reads both
   adapters' platform object literals by AST and fails when a key the lead
   carries is missing here - and it fails loudly when the lead checkout is
   absent, because a gate that skips is not a gate (`UWS_SRC` names the
   checkout). The wire revision is pinned byte-identical against the lead's
   `protocol.schema.json`, and the frame layout against the family
   conformance vector. The deterministic golden trace runs the REAL built
   runtime platform under a seeded seam and a virtual clock over scripted
   connections and pins every emitted frame - JSON envelopes, batch frames,
   wire-id announces, 0x03 bytes, seq continuity across lanes - against a
   committed corpus, byte-for-byte (`test/dst-goldens/`; regenerate
   deliberately with `UPDATE_GOLDENS=1` and review the diff).

## Deployment

One process serves one core well. On a multi-core Linux host, set
`CLUSTER_WORKERS=<n|auto>` and the built server runs the family's in-process
cluster: a primary thread supervises one worker thread per slot, every io
worker binds the shared port itself with SO_REUSEPORT so the kernel
distributes accepts (no acceptor bottleneck, no single point of failure), and
publishes fan out across workers over shared-memory relay rings. Same env,
same options, same behavior as the native-tier adapter: `websocket.primaryInit`
seeds shared memory once in the primary, `websocket.workers.compute` carves
out compute workers that boot the app without a socket, crashed workers
respawn into their slot under a backoff budget, and one SIGTERM drains the
whole fleet through the ordinary readiness-flip/hook/drain sequence.

The cluster is Linux-only because it stands on SO_REUSEPORT accept
distribution, which is a Linux kernel behavior; anywhere else the boot
refuses loudly. The dev loop does not need it - a single process is the
default and serves development fine - and multi-HOST scale-out is unchanged:
one instance per host (or per core, where the cluster is not in play) under
the platform process manager behind a load balancer, with
[svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions)
providing the cross-instance relay, presence and clustering primitives over
Redis. Container fleets that scale by replicas need neither `reusePort` nor
`CLUSTER_WORKERS` - the balancer already spreads connections across replicas.

**systemd integration** is automatic under a `Type=notify` unit and a no-op
everywhere else: the runtime detects `NOTIFY_SOCKET` and sends `READY` once
the service accepts traffic (after the app's `init` hook resolves in
single-process mode; on first listen in clustered mode), `STOPPING` when a
graceful shutdown begins, and, when `WatchdogSec=` is set, a `WATCHDOG` ping
at half the timeout from a main-loop timer. `Type=notify` is the readiness
gate: systemd does not consider the unit started before `READY=1`, and a
frozen event loop stops the watchdog pings. The messages go through the
`systemd-notify` helper, which on systemd 246 and later waits until the
manager has processed each one before it exits; an older manager may fail to
attribute a datagram whose sender has already exited and silently drop it,
so below systemd 246 run the unit as `Type=simple` without `WatchdogSec=`.

## License

MIT
