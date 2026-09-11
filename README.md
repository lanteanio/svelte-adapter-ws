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

The registry contract is four methods, two of them optional:

| Method | Required | Returns, and what a registry must get right |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `counter(name, help, labelNames?)` | yes      | `{ inc(labels?, value?) }`. Implement `value`: `ws_publishes_total` is incremented once per pressure sample with the whole window's publish count, so a registry that ignores `value` reports roughly one publish per second on a server doing thousands - a wrong number that looks plausible. The relay-gap counter increments in bulk the same way. |
| `gauge(name, help)`                | yes      | `{ set(value) }`. No label names: every adapter gauge is unlabelled, and `set` receives the bare number.                                                                                                                                                                                                                                               |
| `histogram(name, help, options?)`  | no       | `{ observe(labels?, value?) }`. Takes an **options object** - `{ labelNames, buckets }` - not a positional `labelNames`, because a registry that cannot be told which buckets to use silently falls back to its own.                                                                                                                                   |
| `serialize()`                      | no       | Prometheus text exposition. Any route that renders `platform.metrics` itself needs it, and that is always one worker's view; `platform.metricsSnapshot()` is built from mirrored values and never calls it.                                                                                                                   |

Durations are **seconds with fractional bucket bounds**; sizes are **bytes** with a `_bytes` suffix. That convention matters most for `histogram`: buckets that start at `1` put a 5 ms call and a 900 ms call in the same bucket and measure nothing. **`createMetrics()` defaults to millisecond-shaped buckets beginning at `1`**, so every adapter duration histogram passes an explicit seconds-valued bucket list. A registry may omit the optional `histogram` factory for backward compatibility; counters still register, while duration families are absent and the public manifest says so instead of silently using wrong defaults.

Every metric below declares how it combines across worker threads, and that column is not documentation - it is the law `platform.metricsSnapshot()` executes when it merges the cluster. `sum` means the workers hold disjoint parts of one whole; `max` means they report the same underlying quantity (or the worst one is the useful answer); `min` is freshness, where the stalest worker is the honest cluster-level reading.

No client identity - address or session - ever reaches a label.

| Metric | Type | Across workers | What it charts |
| --------------------------------------------------------- | --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_requests_total{method,outcome}`                     | counter   | sum            | Completed HTTP requests. `method` is a bounded verb or `other`; `outcome` is `ok`, `client_error`, `server_error`, or `aborted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `http_request_duration_seconds{method,outcome}`           | histogram | sum            | HTTP completion duration, with explicit fractional-second buckets from 1 ms through 10 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `upgrade_admitted_total`                                  | counter   | sum            | Upgrades accepted (the `res.upgrade()` actually ran).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `upgrade_rejected_total{reason}`                          | counter   | sum            | Upgrades rejected before open. Reasons, in the order the upgrade path can reach them: `siege`, `over_capacity`, `cursor_lane`, `connection_capacity`, `duplicate_header` (a repeated framing / identity header, which cannot be given one reading), `ip_rate_limit`, `bad_origin`, `deferred_overflow`, `auth_timeout`, `auth_rejected`, `hook_error`. One more, `auth_rate_limit`, is emitted on the auth preflight POST rather than on an upgrade - it shares this counter because it refuses the same client at the door in front of the handshake. That preflight also answers a repeated framing header with a `400`, and that rejection is counted on no series, so a dashboard built on this counter sees duplicate-header refusals from the upgrade path only. |
| `upgrade_duration_seconds{outcome}`                       | histogram | sum            | Time from upgrade callback entry to admit, reject, abort, or error, with explicit 1 ms through 10 s buckets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `upgrade_rate_map_evicted_total{door}`                    | counter   | sum            | Rate-limit entries evicted to make room at the map cap. `door` is `upgrade` or `auth` - a sustained rate on either door means rotating client identities are churning that limiter's map faster than the periodic sweep reclaims it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `upgrade_inflight`                                        | gauge     | sum            | Upgrades currently between admission and open (sampled once per pressure interval).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `upgrade_deferred_depth`                                  | gauge     | sum            | Upgrade callbacks retained by the bounded per-worker pacing queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `upgrade_deferred_oldest_age_seconds`                     | gauge     | max            | Age of the oldest callback retained by any worker's pacing queue; `0` when empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `upgrade_deferred_rejected_total`                         | counter   | sum            | Upgrade callbacks shed because the bounded pacing queue was full. The same decisions also increment `upgrade_rejected_total{reason="deferred_overflow"}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ws_connection_headroom`                                  | gauge     | sum            | Remaining per-worker `maxConnections` permits across reserved upgrades and live sockets. Registered only when the finite ceiling is enabled and updated on every acquire/release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `waiting_room_queue_depth`                                | gauge     | sum            | Clients currently polling the waiting room (sampled; `0` with the room off).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `protection_posture_state`                                | gauge     | max            | The live posture: `0` normal, `1` elevated, `2` siege (sampled). Levels are severity-ordered, so the cluster reads as the most defensive posture any worker has engaged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `protection_posture_transitions_total{from,to}`           | counter   | sum            | Posture level changes - chart it next to the rejected reasons for an incident timeline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ws_connections`                                          | gauge     | sum            | Live WebSocket connections on this worker (sampled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ws_connection_duration_seconds{outcome}`                 | histogram | sum            | Connection lifetime, split into `clean` (1000/1001) and `abnormal` closure, with explicit 1 s through 24 h buckets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ws_messages_total{kind,outcome}`                         | counter   | sum            | Completed inbound text/binary messages, split into successful and throwing handler outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ws_message_admission_rejected_total{reason,scope}`       | counter   | sum            | Application messages shed before app-hook, binary-ingress, or game-publish work by established-message admission. `reason` is `rate_limit`, `concurrency_limit`, or `queue_full`; `scope` is `connection` or `global`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ws_message_duration_seconds{kind,outcome}`               | histogram | sum            | End-to-end inbound message handling duration, including awaited hooks, with explicit 100 us through 1 s buckets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ws_subscriptions`                                        | gauge     | sum            | Live topic subscriptions across this worker's connections (sampled). Divide by `ws_connections` for the subscriber ratio - the two are exported separately rather than as a precomputed ratio, because averaging per-worker ratios is not the cluster ratio, while summing numerator and denominator is.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ws_publishes_total`                                      | counter   | sum            | Publish calls made on this worker. Counts publishes, never per-recipient deliveries: a publish is one logical event however many subscribers it reaches, and what each one cost is the egress ledger's business. A counter rather than the sampler's precomputed rate, so the query picks its own window.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ws_publish_outcomes_total{outcome}`                      | counter   | sum            | Every fan-out one publish call hands to the transport, classified as `delivered` or `no_subscribers`; aggregate only, never a per-recipient breakdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ws_backpressure_max_bytes`                               | gauge     | max            | Worst per-connection outbound buffered bytes over the sampled connection set (`0` when healthy). Compare against `maxBackpressure` for headroom before the send lane sheds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ws_backpressure_connections`                             | gauge     | sum            | Sampled connections holding a backpressured outbound queue (`0` when healthy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ws_dropped_frames_total`                                 | counter   | sum            | Exact outbound frames the send lane shed at the configured backpressure limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ws_dropped_bytes_total`                                  | counter   | sum            | Exact payload bytes in outbound frames the send lane shed at the configured backpressure limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `egress_refused_total{scope}`                             | counter   | sum            | Publishes refused pre-hoc by a configured `websocket.egress` ceiling: nothing was delivered, relayed, or sequence-stamped for them, unlike the backpressure drops above, which shed frames already accepted for delivery. `scope` is `topic` or `tenant`; per-window figures ride `platform.pressure.egress`.                                                                                                                                                                                                                                                                                                                                                                      |
| `egress_window_evicted_total{scope}`                      | counter   | sum            | Live usage windows dropped at the egress ledger key cap, one per evicted key. The evicted key stops being held to its ceiling for the rest of its window, and because the symptom is FEWER refusals, this is the only signal that distinguishes a budget out of ledger room from traffic that simply fits. `scope` is `topic` or `tenant`.                                                                                                                                                                                                                                                                                                                                     |
| `pressure_saturation`                                     | gauge     | max            | Worker saturation scalar, `0` healthy to `1` at the configured thresholds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pressure_reason`                                         | gauge     | max            | The live pressure reason as a severity-ordered code: `0` none, `1` subscribers, `2` publish rate, `3` psi, `4` cpu quota, `5` capacity, `6` memory. Ordered so the cluster reads as the worst reason any worker reported, matching the precedence the sampler itself applies.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pressure_reason_transitions_total{from,to}`              | counter   | sum            | Pressure reason changes, including both incident entry and recovery. The bounded reason vocabulary keeps the transition matrix low-cardinality, and the counter preserves a brief incident that starts and recovers between scrapes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pressure_sample_timestamp_seconds`                       | gauge     | min            | Unix time of the most recent completed pressure sample. The sampling timer is `unref`'d; if it ever stops, every sampled gauge above keeps serving its last value while the target still reports up. **Alert on the age of this timestamp** - it is the only thing that separates healthy-and-steady from frozen.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `resident_memory_bytes`                                   | gauge     | max            | Resident set size of the process. Worker threads share one address space, so every worker reports the same value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `heap_used_ratio`                                         | gauge     | max            | Used fraction of the nearest memory wall: heap against the V8 `heap_size_limit`, resident set against the cgroup memory limit, worst-of. The heap arm is per-isolate; the rss arm is process-wide, so workers converge when the container wall dominates. The worst worker is the one nearest a wall.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `psi_cpu_some_avg10`                                      | gauge     | max            | Kernel pressure-stall CPU `some` avg10: percent of the last 10s any task was stalled on CPU. Registered only where the kernel exposes PSI, probed once at startup, so absent elsewhere rather than reporting a zero that reads as "no pressure". After registration, a transient read failure emits `NaN` for that sample instead of serving a stale value beside a fresh generic timestamp.                                                                                                                                                                                                                                                                                                                               |
| `psi_memory_full_avg10`                                   | gauge     | max            | Kernel pressure-stall memory `full` avg10. Same startup availability and transient-`NaN` semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `psi_io_full_avg10`                                       | gauge     | max            | Kernel pressure-stall IO `full` avg10. Same startup availability and transient-`NaN` semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cpu_throttled_ratio`                                     | gauge     | max            | Fraction of the sampled window the cgroup CPU quota held this process suspended. Registered only where a cgroup CPU stat is readable, probed once at startup. A transient failure emits `NaN`; recovery establishes a new delta baseline so a multi-window gap cannot fabricate a throttle spike.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `state_divergence_total{role}`                            | counter   | sum            | Cross-worker state-hash divergence detections (clustered mode, when `stateHashIntervalMs` is set). `role` is `majority` or `minority`. No topic strings or client identity - the hash is structure-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `relay_gap_frames_total`                                  | counter   | sum            | Relayed frames proven lost to this worker (interior relay gaps). Counts frames, not incidents, so one lost burst reads as the burst it was. A lower bound: losses inside an already-reported window fold into that report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `relay_spill_quarantines_total{reason}`                   | counter   | sum            | Lagging cross-worker relay peers quarantined at the finite spill ceiling. `reason` is `bytes` or `age`; the normal clean-exit supervisor replaces the worker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `relay_spill_dropped_bytes_total`                         | counter   | sum            | Pending relay bytes discarded when the lagging peer is quarantined. Counts only producer spill already outside the shared ring, not an inferred application-delivery total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `relay_spill_pending_age_seconds`                         | gauge     | max            | Worst oldest-pending relay spill age observed at quarantine; `0` until a worker has seen one, so healthy is queryable as zero rather than absent. The age measures time since the peer last made drain progress - a stall detector - not how long a backlog has merely existed, so a peer draining steadily while behind never accrues it. A peer that has not yet attached its relay reader is handed no frames at all, so it never accrues one either. Compare with `CLUSTER_RELAY_MAX_PENDING_MS`; no topic or client identity is exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `relay_frame_refused_total{lane}`                         | counter   | sum            | Publishes refused by this worker's sender-side relay frame ceiling (`CLUSTER_RELAY_MAX_FRAME_KB`): local subscribers received them, only the cross-worker copy was dropped. `lane` is `publish` or `batched`; a `batched` refusal is wholesale, because the whole `publishBatched` array travels as one frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `relay_frame_oversized_total`                             | counter   | sum            | Relay frames the primary refused to reassemble, decided from the length prefix before allocating for the frame. A frame this far past the sender ceiling means a peer not applying it, or a corrupt stream; the sender's relay stream is stopped and its own spill ceiling then retires it. A primary-side incident, attributed once to a surviving worker's registry like the quarantines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `open_fds`                                                | gauge     | max            | File descriptors currently open by the process (sampled every ~5 pressure intervals). Registered only where an fd directory exists (Linux, macOS). Worker threads share one process-wide table, so every worker reports the same whole-process value - `max()`, never `sum()`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fd_soft_limit`                                           | gauge     | max            | The soft file-descriptor limit; new sockets fail with `EMFILE` at this count. Chart `open_fds` against it for connection headroom. Registered only where the limit is readable. Same whole-process note as `open_fds`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `framework_assertion_violations_total{category,severity}` | counter   | sum            | Framework invariant violations, mirroring the queryable `platform.assertions` Map. `severity` is `soft` (a recoverable `assert`) or `fatal` (a hard-tier termination). Category cardinality is bounded by the source-declared categories - never user input.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `framework_resource_growth_suspected_total{resource}`     | counter   | sum            | Sustained-growth suspicions raised by the optional resource-growth auditor. Registered only when `resourceGrowthAuditIntervalMs` is set (off by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `metrics_snapshot_workers_expected`                       | gauge     | max            | Workers a `metricsSnapshot()` asked for a report. Present only in a snapshot document; no worker registers it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `metrics_snapshot_workers_reporting`                      | gauge     | max            | Workers that answered before the deadline with every required counter registered and every required worker gauge sampled. Below `_expected` means the merged document is partial - every summed series may be understated, and a dip must not be read as a real drop in traffic.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `metrics_snapshot_degraded`                               | gauge     | max            | `1` when the collection did not complete at all - the primary could not be reached, or the deadline expired - so the document is one worker rather than the cluster. A worker that never heard back cannot know how many siblings it has, so `_expected` and `_reporting` would agree with each other and the document would read as complete. **This is the flag to alert on**; the expected/reporting difference catches the partial case, this catches the total one.                                                                                                                                                                                                                                                   |

The compact table below is the canonical machine-checked contract behind the operator notes above. `count` maps to the manifest's dimensionless `null` unit; `worker` and `merge` in Origin distinguish factories the runtime calls from families written only by `metricsSnapshot()`. A dash means no labels or no derived formula.

| Metric | Factory/type | Labels | Unit | Scope | Aggregate | Origin | Formula | Help |
| ------------------------------------------- | ------------ | ----------------- | ------- | ------- | --------- | ------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `http_requests_total`                       | counter      | method,outcome    | count   | worker  | sum       | worker | -                                             | Completed HTTP requests by bounded method and outcome                                   |
| `http_request_duration_seconds`             | histogram    | method,outcome    | seconds | worker  | sum       | worker | -                                             | HTTP request completion duration in seconds                                             |
| `upgrade_admitted_total`                    | counter      | -                 | count   | worker  | sum       | worker | -                                             | WebSocket upgrades accepted                                                             |
| `upgrade_rejected_total`                    | counter      | reason            | count   | worker  | sum       | worker | -                                             | WebSocket upgrades rejected before open                                                 |
| `upgrade_duration_seconds`                  | histogram    | outcome           | seconds | worker  | sum       | worker | -                                             | WebSocket upgrade decision duration in seconds                                          |
| `upgrade_rate_map_evicted_total`            | counter      | door              | count   | worker  | sum       | worker | -                                             | Rate-limit entries evicted at the map cap                                               |
| `upgrade_inflight`                          | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Upgrades currently between admission and open                                           |
| `upgrade_deferred_depth`                    | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Upgrade callbacks waiting in the bounded pacing queue                                   |
| `upgrade_deferred_oldest_age_seconds`       | gauge        | -                 | seconds | worker  | max       | worker | -                                             | Age of the oldest callback in the bounded upgrade pacing queue                          |
| `upgrade_deferred_rejected_total`           | counter      | -                 | count   | worker  | sum       | worker | -                                             | Upgrade callbacks shed because the bounded deferral queue was full                      |
| `ws_connection_headroom`                    | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Remaining reserved-or-live WebSocket connection permits                                 |
| `waiting_room_queue_depth`                  | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Clients currently polling the waiting room                                              |
| `protection_posture_transitions_total`      | counter      | from,to           | count   | worker  | sum       | worker | -                                             | Protection posture level changes                                                        |
| `protection_posture_state`                  | gauge        | -                 | enum    | worker  | max       | worker | -                                             | Current protection posture (0 normal, 1 elevated, 2 siege)                              |
| `ws_connections`                            | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Live WebSocket connections                                                              |
| `ws_connection_duration_seconds`            | histogram    | outcome           | seconds | worker  | sum       | worker | -                                             | WebSocket connection lifetime in seconds                                                |
| `ws_messages_total`                         | counter      | kind,outcome      | count   | worker  | sum       | worker | -                                             | Completed inbound WebSocket messages by kind and outcome                                |
| `ws_message_admission_rejected_total`       | counter      | reason,scope      | count   | worker  | sum       | worker | -                                             | Application WebSocket messages shed by established-message admission                    |
| `ws_message_duration_seconds`               | histogram    | kind,outcome      | seconds | worker  | sum       | worker | -                                             | Inbound WebSocket message handling duration in seconds                                  |
| `ws_subscriptions`                          | gauge        | -                 | count   | worker  | sum       | worker | `sum(ws_subscriptions) / sum(ws_connections)` | Live topic subscriptions; divide by ws_connections for the subscriber ratio             |
| `ws_publishes_total`                        | counter      | -                 | count   | worker  | sum       | worker | -                                             | Publish calls made, never per-recipient deliveries               |
| `ws_publish_outcomes_total`                 | counter      | outcome           | count   | worker  | sum       | worker | -                                             | Publish calls by aggregate delivery outcome                                      |
| `ws_backpressure_max_bytes`                 | gauge        | -                 | bytes   | worker  | max       | worker | -                                             | Worst per-connection outbound buffered bytes over the sampled set                       |
| `ws_backpressure_connections`               | gauge        | -                 | count   | worker  | sum       | worker | -                                             | Sampled connections holding a backpressured outbound queue                              |
| `ws_dropped_frames_total`                   | counter      | -                 | count   | worker  | sum       | worker | -                                             | Outbound WebSocket frames dropped under backpressure                      |
| `ws_dropped_bytes_total`                    | counter      | -                 | bytes   | worker  | sum       | worker | -                                             | Outbound WebSocket payload bytes dropped under backpressure               |
| `egress_refused_total`                      | counter      | scope             | count   | worker  | sum       | worker | -                                             | Publishes refused by a configured egress ceiling; nothing was delivered or relayed for them |
| `egress_window_evicted_total`               | counter      | scope             | count   | worker  | sum       | worker | -                                             | Live usage windows evicted at the ledger cap; each one stops enforcing its ceiling for the rest of its window |
| `pressure_saturation`                       | gauge        | -                 | ratio   | worker  | max       | worker | -                                             | Worker saturation, 0 healthy to 1 at the configured thresholds                          |
| `pressure_reason`                           | gauge        | -                 | enum    | worker  | max       | worker | -                                             | Pressure reason as a severity-ordered code (0 none to 6 memory)                         |
| `pressure_reason_transitions_total`         | counter      | from,to           | count   | worker  | sum       | worker | -                                             | Pressure reason changes, including incidents and recoveries                             |
| `pressure_sample_timestamp_seconds`         | gauge        | -                 | seconds | worker  | min       | worker | -                                             | Unix time of the most recent pressure sample; alert on its age                          |
| `resident_memory_bytes`                     | gauge        | -                 | bytes   | process | max       | worker | -                                             | Resident set size of the process                                                        |
| `heap_used_ratio`                           | gauge        | -                 | ratio   | worker  | max       | worker | -                                             | Used fraction of the nearest memory wall (heap vs the V8 limit, resident set vs the cgroup memory limit, worst-of) |
| `psi_cpu_some_avg10`                        | gauge        | -                 | percent | process | max       | worker | -                                             | Kernel pressure-stall CPU some avg10                                                    |
| `psi_memory_full_avg10`                     | gauge        | -                 | percent | process | max       | worker | -                                             | Kernel pressure-stall memory full avg10                                                 |
| `psi_io_full_avg10`                         | gauge        | -                 | percent | process | max       | worker | -                                             | Kernel pressure-stall IO full avg10                                                     |
| `cpu_throttled_ratio`                       | gauge        | -                 | ratio   | process | max       | worker | -                                             | Fraction of the window the cgroup CPU quota held the process suspended                  |
| `open_fds`                                  | gauge        | -                 | count   | process | max       | worker | -                                             | File descriptors currently open by the process                                          |
| `fd_soft_limit`                             | gauge        | -                 | count   | process | max       | worker | -                                             | Soft file-descriptor limit; new sockets fail with EMFILE at this count                  |
| `state_divergence_total`                    | counter      | role              | count   | worker  | sum       | worker | -                                             | Cross-worker state hash divergence detections                                           |
| `relay_gap_frames_total`                    | counter      | -                 | count   | worker  | sum       | worker | -                                             | Relayed frames proven lost to this worker                                               |
| `relay_spill_quarantines_total`             | counter      | reason            | count   | worker  | sum       | worker | -                                             | Workers quarantined after a relay spill ceiling                                         |
| `relay_spill_dropped_bytes_total`           | counter      | -                 | bytes   | worker  | sum       | worker | -                                             | Pending relay bytes discarded when a lagging worker was quarantined                     |
| `relay_spill_pending_age_seconds`           | gauge        | -                 | seconds | worker  | max       | worker | -                                             | Worst oldest-pending age observed at relay spill quarantine                             |
| `relay_frame_refused_total`                 | counter      | lane              | count   | worker  | sum       | worker | -                                             | Publishes refused by the sender-side relay frame ceiling; local subscribers still received them |
| `relay_frame_oversized_total`               | counter      | -                 | count   | worker  | sum       | worker | -                                             | Relay frames refused at the reassembly ceiling; the sending worker relay stream was stopped |
| `framework_assertion_violations_total`      | counter      | category,severity | count   | worker  | sum       | worker | -                                             | Framework production-assertion violations by category and severity                      |
| `framework_resource_growth_suspected_total` | counter      | resource          | count   | worker  | sum       | worker | -                                             | Sustained resource-growth suspicions raised by the optional auditor                     |
| `metrics_snapshot_workers_expected`         | gauge        | -                 | count   | process | max       | merge  | -                                             | Workers the cluster metrics snapshot asked for a report                                 |
| `metrics_snapshot_workers_reporting`        | gauge        | -                 | count   | process | max       | merge  | -                                             | Workers with complete metric reports before the deadline                                |
| `metrics_snapshot_degraded`                 | gauge        | -                 | count   | process | max       | merge  | -                                             | 1 when the collection did not complete and this document is one worker, not the cluster |

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
with the family's surface - SNI, multiple certs, hot reload. Node also brings
HTTP/2 and the entire observability ecosystem
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
   cert carries or the `SSL_SNI_HOSTS` override) and certificate
   hot-reload (`SSL_WATCH`, default on; `SSL_RELOAD_DEBOUNCE_MS`) that swaps
   the secure context in place so a certbot renewal never drops a live
   connection. The probe TLS section runs unattended against committed
   fixtures. HTTP serving goes through the public
   `@sveltejs/kit/node` primitives - `getRequest`, `setResponse`,
   `createReadableStream` - bundled into the build output so a production
   install needs no devDependencies. The in-memory static cache answers with
   negotiated precompressed representations (per-representation weak ETags),
   single byte ranges cut in the negotiated representation's coordinates,
   If-Match/If-Unmodified-Since/If-None-Match/If-Modified-Since/If-Range preconditions, the dotfile refusal with its
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
   publishBatched with the shared batch frame when every interested
   subscriber can decode it, send, sendTo, sendCoalesced with the drain pump,
   request/requestTopic over reply frames,
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
