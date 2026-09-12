# Adapter error reference

Every operator-facing failure the runtime can emit, indexed by its stable
`ADAPTER-ERR-*` id. Generated from `src/runtime/error-registry.js` by
`node scripts/render-error-docs.js`; edit the registry, not this file.

## ADAPTER-ERR-LISTEN

Severity: fatal

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.listener event=runtime.listen.failed severity=fatal] runtime.listen.failed: Could not bind the server listener on
```

**Cause.** The configured address or port could not be bound, or the process lacks permission.

**Consequence.** The process never becomes ready. Single-process, the bind failure exits with status 1. Under CLUSTER_WORKERS only the failing worker exits; the process stays up while the supervisor respawns it.

**Automatic recovery.** None single-process. Under CLUSTER_WORKERS the supervisor respawns the failed worker and the replacement retries the same bind - under a persistent conflict each attempt fails the same way, each is charged against the slot's restart budget, and an exhausted slot takes the whole service down, the outcome ADAPTER-ERR-WORKER-RESTART-LIMIT documents from the other end.

**What to do.** Check address availability, port conflicts, and bind permissions, then restart the process. A repeating restart line for the same worker slot beside this one is the same conflict burning restart budget, not a second fault.

Further reading: https://svti.me/listen-failed

## ADAPTER-ERR-VITE-LOAD

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=vite.websocket event=vite.handler.load-failed severity=error] vite.handler.load-failed: Initial loading of the WebSocket handler
```

**Cause.** The initial development WebSocket handler or one of its imports failed to load.

**Consequence.** The Vite HTTP server stays active, but WebSocket upgrades return HTTP 500 until a handler loads.

**Automatic recovery.** Vite retries the handler when its module graph changes again.

**What to do.** Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.

Further reading: https://svti.me/ws-handler-load

## ADAPTER-ERR-VITE-RELOAD

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=vite.websocket event=vite.handler.reload-failed severity=error] vite.handler.reload-failed: Hot reloading of the WebSocket handler
```

**Cause.** A development handler hot reload failed after an earlier handler had loaded.

**Consequence.** Existing WebSocket connections keep the previous handler, but new upgrades return HTTP 500 until recovery.

**Automatic recovery.** Vite retries the handler when its module graph changes again.

**What to do.** Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.

Further reading: https://svti.me/ws-handler-load

## ADAPTER-ERR-REQUEST-TIMEOUT

Log line begins:

```
request timed out
```

**Cause.** A platform.request reply did not arrive within timeoutMs; the recipient may already have executed the request.

**Consequence.** The caller promise rejects while the remote operation outcome remains unknown.

**Automatic recovery.** None. The adapter does not retry requests because replay may duplicate an operation.

**What to do.** Reconcile application state first, or retry only through an idempotent operation; then investigate the handler, connection, and measured timeout budget.

Further reading: https://svti.me/request-timeout

## ADAPTER-ERR-REQUEST-CLOSED

Log line begins:

```
connection closed
```

**Cause.** The target WebSocket closed around a platform.request - before the request frame could be sent at all, or with the frame already handed to the transport and unanswered.

**Consequence.** The caller promise rejects. The rejection detail names which side of transmission the close landed on: a frame that was never sent leaves the remote outcome known - nothing was requested - while a frame handed to the transport leaves it unknown.

**Automatic recovery.** None. The adapter does not retry requests because replay may duplicate an operation.

**What to do.** Read the rejection detail first. A request whose frame was never sent is safe to retry as-is once the connection recovers; a sent but unanswered request must be reconciled or retried only through an idempotent operation.

Further reading: https://svti.me/request-closed

## ADAPTER-ERR-ADMIN-HANDLER

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.admin event=admin.handler-failed severity=error] The admin handler failed; the request was answered 500.
```

**Cause.** An admin route handler threw or returned a rejected promise.

**Consequence.** That one admin request answered 500. Application traffic and WebSocket delivery are unaffected.

**Automatic recovery.** None for the failed request; the next admin request runs the handler again.

**What to do.** Read the attached error attribute and fix the admin handler. Admin routes are separately gated, so this does not indicate a fault in the serving path.

## ADAPTER-ERR-INVARIANT

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.assertion event=invariant.violated severity=
```

**Cause.** A framework-internal assertion failed. The message is the assertion category and the severity is chosen by the call site, so both vary.

**Consequence.** Depends on the tier. A recorded violation appears in the platform.assertions map; a development-only assertion is logged and thrown WITHOUT being recorded there, so an empty map does not mean none fired. At the fatal tier the process is scheduled to exit with a dedicated status code.

**Automatic recovery.** None for the condition itself. A fatal-tier violation exits the process; recovery is the process manager restarting it.

**What to do.** Read the severity first, because it selects the tier and therefore the blast radius, then the category and context attributes. These are library-internal invariants, so a violation is an adapter defect rather than an application misconfiguration; report it with both attributes.

## ADAPTER-ERR-METRICS-MERGE

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.metrics event=metrics.merge-failed severity=error] The cluster metrics merge failed; this scrape answers with the local worker only.
```

**Cause.** Combining the delivered per-worker snapshots into one cluster answer threw. Every report a primary can deliver is normalized before it is combined - non-object samples are dropped, names outside the manifest are dropped, histogram shapes are validated against their declared buckets, non-numeric values collapse to NaN, label sets are bounded in key count and value length with keys held to the exposition label grammar, the registration inventory is trimmed to a bounded length, and the document seats a bounded number of distinct series - so no message that survives the thread boundary reaches the combine step in a shape it does not handle. A throw here is a defect in the merge itself or a rewrapped runtime built-in underneath it, not bad input. The catch exists because every concurrent scrape on the worker shares one in-flight promise: a throw that escaped it would leave that promise unsettled and hang every later scrape on the worker.

**Consequence.** That scrape reports one worker instead of the cluster, so counters appear to drop sharply for a single interval. A fault that also breaks the local-only fallback - a rewrapped built-in does not un-install itself after one throw - degrades one step further and answers an empty document, so that interval carries no samples at all. The endpoint stays up and the shared in-flight promise settles either way, which is what keeps a failure from hanging every concurrent scrape on the worker rather than degrading one.

**Automatic recovery.** Yes. The next scrape attempts the merge again.

**What to do.** Treat an isolated occurrence as a degraded scrape; alerting on absolute counter values across this interval will produce false alarms. An empty answer for the interval means the fallback failed too, so that interval IS lost data rather than a narrower view of it - a repeating one is an outage of the scrape, not a degradation. Because no deliverable report can reach this line, a repeat is an adapter defect - report it with the attached error rather than hunting for a misbehaving worker.

## ADAPTER-ERR-METRICS-MIRROR-READ

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.metrics event=metrics.mirror-read-failed severity=error] The metrics mirror read failed during cluster collection; this worker reports as a gap between expected and reporting.
```

**Cause.** Reading one worker metrics mirror threw during collection.

**Consequence.** That worker contributes nothing to the scrape and appears as a difference between the expected and reporting worker counts, which is the intended signal rather than a silent omission.

**Automatic recovery.** Yes. The next collection reads the mirror again.

**What to do.** Compare expected against reporting worker counts over time. A persistent gap for the same worker points at that worker rather than at the metrics layer.

## ADAPTER-ERR-WARMUP-RENDER

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.warmup event=runtime.warmup.render-failed severity=warn] A boot warmup render failed; readiness proceeds without it.
```

**Cause.** Rendering a configured warmup path through the SSR engine during boot threw. The warmup runs the app's own server hooks and load functions for that path, so the throw is almost always in application boot-path code (a load that assumes a real request header, a resource not ready at boot), not in the adapter.

**Consequence.** That path is not pre-warmed, so the first real request to it after readiness pays the cold-render cost the warmup exists to remove. Nothing else is affected: readiness still commits and every other configured path still warms.

**Automatic recovery.** Yes. The first real request renders the path normally and warms it from then on; the warmup does not retry.

**What to do.** Read the attached error and the path it names. If the render depends on request context a warmup cannot supply, guard that code behind platform.isWarmupRequest, or drop the path from the warmup set. A warmup render that fails every boot means the path is not safely renderable without a real client.

## ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.metrics event=metrics.primary-unreachable severity=error] The metrics snapshot request could not reach the primary; this scrape answers degraded with the local worker only.
```

**Cause.** Posting the snapshot request to the primary threw. A dead channel does not do this: posting to a closed or torn-down MessagePort is a silent no-op on current Node, and the request itself is a small plain literal that always survives structured clone. The throw comes from whatever wrapped the worker's message port - process-wide instrumentation that rewraps postMessage can make the underlying call throw a DataCloneError the moment its piggybacked context carries a value structured clone refuses, or raise an error of its own.

**Consequence.** The scrape is answered from the local worker and marked degraded rather than failing outright, so the endpoint stays up while the numbers describe one worker.

**Automatic recovery.** Yes. The next scrape posts to the primary again.

**What to do.** Read the attached error and look at whatever instruments the process; a DataCloneError names the wrapper's payload, not the adapter's. A primary that died or a port that closed does NOT emit this event - that posting is a silent no-op and the collection deadline answers degraded without a line - so the absence of this line is not evidence the primary is healthy. Compare the expected and reporting worker counts for that.

## ADAPTER-ERR-SINK-FAILED

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.observability event=operational.sink.failed severity=error] The configured operational event sink failed; console fallback was restored for this event.
```

**Cause.** The application-supplied operational event sink threw while handling an event.

**Consequence.** That event went to the console instead of the sink. If the sink is the only path into log aggregation, events are reaching the process output and nothing else.

**Automatic recovery.** Per event. The sink is attempted again for the next event rather than being disabled.

**What to do.** Fix the sink so it cannot throw; a sink that throws for a class of events loses exactly that class from aggregation while the console keeps them.

## ADAPTER-ERR-PRESSURE-LISTENER

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.pressure event=pressure.listener-failed severity=error] A pressure listener failed.
```

**Cause.** An application listener registered through platform.onPressure for pressure-state notifications threw.

**Consequence.** That listener missed the notification. Pressure accounting itself is unaffected, so shedding and limits still apply.

**Automatic recovery.** Yes. A throwing listener stays registered and is called again on the next notification.

**What to do.** Fix the listener. Application code that reacts to pressure by shedding load is not running while it throws, so the process can stay under pressure longer than intended.

## ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.pressure event=pressure.runaway-publisher severity=warn] A publisher crossed a configured per-topic pressure threshold.
```

**Cause.** One topic exceeded its configured publish pressure threshold. The event is emitted only when no onPublishRate listener is registered, and it is latched per topic: one line when the topic crosses the threshold, re-armed only after the topic stays below it for a minute of consecutive samples.

**Consequence.** Nothing is dropped by this event alone. It is the early signal that one topic is consuming a disproportionate share of outbound capacity.

**Automatic recovery.** None. Nothing throttles the publisher on the strength of this threshold.

**What to do.** Identify the topic from the attributes and decide whether the rate is intended. The line is suppressed entirely while an onPublishRate listener is registered, so its absence is not evidence the condition ended - read platform.pressure for that. Left alone, a runaway publisher is what later produces slow-consumer disconnects on unrelated topics.

## ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.pressure event=pressure.topic-registry-high severity=warn] The topic registry crossed its cardinality warning threshold.
```

**Cause.** The number of distinct live topics passed the configured warning threshold.

**Consequence.** Nothing is refused at this threshold. Topic bookkeeping grows with cardinality, so this is the memory-growth signal.

**Automatic recovery.** None. Cardinality is not reduced in response to the threshold.

**What to do.** Check whether topic names embed unbounded identifiers - the `topPublishers` attribute names the busiest topics at the crossing and `topicCount` carries the count that tripped it. The line fires ONCE per process: it is latched after the first crossing and never repeats, and the runtime publishes no continuous topic-cardinality metric, so neither this line nor the metrics will tell you whether cardinality later fell or kept climbing. The naming scheme is what settles that. Unbounded cardinality is a slow leak rather than a spike, so act at the warning rather than at exhaustion.

## ADAPTER-ERR-PRESSURE-RATE-LISTENER

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.pressure event=pressure.publish-rate-listener-failed severity=error] A publish-rate listener failed.
```

**Cause.** An application listener registered for publish-rate notifications threw.

**Consequence.** That listener missed the notification. Rate accounting is unaffected.

**Automatic recovery.** Yes. The listener stays registered and is called again.

**What to do.** Fix the listener, and check whether it was the component expected to throttle publishing.

## ADAPTER-ERR-EGRESS-REFUSED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.egress event=egress.publish-refused severity=warn] A publish crossed a configured egress ceiling and was refused.
```

**Cause.** A publish-family call would have taken one topic or one tenant past a `websocket.egress` ceiling for the current window, so it was refused before anything was stamped, serialized, or written to a socket. Per (scope, topic) the line is throttled to once a minute through a bounded dedup table, so it reports the condition rather than every refusal; the exact counts are `egress_refused_total{scope}` and the pressure snapshot egress figures.

**Consequence.** The refused publish delivered nothing anywhere: no local subscriber received it, no cross-worker relay fired, and no sequence number was consumed, so subscribers see no gap. The caller received the refusal shape (`false`, a zero count, or `{ seq: null, delivered: 0 }` on the game lane) and owns any retry.

**Automatic recovery.** Yes, by time: the window rotates (default 1000 ms) and publishing under the ceiling resumes on its own. Relayed frames from sibling workers are never refused.

**What to do.** Decide whether the traffic or the ceiling is wrong. The attributes name the scope, the dimension (messages, bytes, or deliveries), and the configured limit; read the topic reference beside your `pressure.topPublishers` deliveries figures to see whether one publisher is spending the budget. Raise the ceiling in `websocket.egress` if the load is intended. On the dev plugin this event is the whole report: dev enforces the ceilings live but registers no metrics and reports its pressure egress figures as zeros, so the counts named above exist only in production and createTestServer.

## ADAPTER-ERR-EGRESS-EVICTED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.egress event=egress.window-evicted severity=warn] The egress ledger dropped a usage window that was still counting, so that key is unmetered for the rest of it.
```

**Cause.** More distinct topics or tenants published inside one window than the ledger can hold, so seating a new key took a live window from another. The ledger reclaims lapsed windows first and only evicts a live one when none is left, which makes this a statement about topic or tenant CARDINALITY rather than about publish volume. Per scope the line is throttled to once a minute, so it reports the condition rather than every eviction - which would fire at the rate of the churn causing it.

**Consequence.** The evicted key starts its next publish from an empty window, so its ceiling cannot refuse anything it already spent: enforcement is not wrong for other keys, it is ABSENT for that one until the window it lost would have rotated. A deployment that evicts steadily is one where the busiest topics are metered and the tail is not.

**Automatic recovery.** Partly, and only by the traffic changing: the ledger holds its bound and keeps serving, and cardinality falling back under the bound restores full enforcement on its own. Nothing raises the bound.

**What to do.** Treat it as a cardinality problem, not a capacity one. Check whether topic names embed unbounded identifiers, and scope tenant ids to the tenants you actually meter. The exact count is `egress_evicted_total{scope}` in production and createTestServer; the dev plugin registers no metrics, so there this line is the whole report.

## ADAPTER-ERR-EGRESS-TENANT-RESOLVER

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.egress event=egress.tenant-resolver-invalid severity=error] The egress tenant resolver returned an unusable id; publishes are charged unattributed.
```

**Cause.** The handler module `egressTenantOf(topic)` export threw, or returned something other than null/undefined or a string of `[a-zA-Z0-9_-]` (1-64 chars) - the same id rule the attribution resolver enforces. The line fires once per worker: the defect repeats on every publish and refusing to attribute is already the fail-closed behavior.

**Consequence.** Publishes on the affected topics are charged as unattributed: the topic-scope ceilings and the worker egress figures still apply, but no tenant window is charged, so a tenant ceiling cannot bound this traffic until the resolver is fixed. Nothing is misattributed - an invalid id is never used as a key.

**Automatic recovery.** None. The resolver stays installed and its valid answers keep working; only invalid results (and thrown calls) stay unattributed.

**What to do.** Fix `egressTenantOf` to return a rule-conforming tenant id or null. The attributes carry the returned value TYPE only; reproduce locally by calling the resolver with the topics your server publishes.

## ADAPTER-ERR-RELAY-GAP

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.relay-gap event=runtime.relay-gap.detected severity=error] This worker is missing relayed state that sibling workers received.
```

**Cause.** A gap was detected in the relayed sequence this worker received from its siblings.

**Consequence.** Clients on this worker are missing events that clients on other workers received, so they disagree about state.

**Automatic recovery.** The lost frames are gone and are never back-filled. Subscribers of a gapped sequence-lane topic that negotiated the relay.resync:1 capability (the bundled client always does) are pushed a gap marker that drops their poisoned resume offset and prompts a re-snapshot; the diagnostic reports them as signalledClients, and a subscriber whose socket refuses even the marker is closed 1013 (closedClients). The topic also gets a freshly minted generation on this worker, so a pre-loss offset presented with its recorded epoch - by a subscriber that disconnected before confirmation, or by a client that never negotiated the capability - cold-rehydrates at its next resume instead of gap-filling past the hole.

**What to do.** Treat as a correctness incident. Check for accompanying relay frame or spill events, which usually name the cause of the loss. A signalledClients of 0 with live subscribers means those clients hear nothing until their next resume, where the minted generation repairs any that present epochs; a client that resumes without presenting epochs is the one case nothing repairs. A gap on a topic outside the signal scope (seq: false, or a reserved lane) always reports 0.

## ADAPTER-ERR-DIVERGENCE

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.divergence event=divergence.detected severity=error] Cross-worker state divergence was detected; evidence is retained behind the authenticated diagnostic lookup.
```

**Cause.** Workers that should hold identical state reported different state hashes.

**Consequence.** Clients on different workers can observe different state for the same topic. The log line carries only an opaque diagnostic id, because per-thread hashes and keyed sequence summaries are identifier-bearing.

**Automatic recovery.** None by default: divergence is reported, never silently reconciled. With RESTART_ON_STATE_DIVERGENCE=1 the primary asks each minority worker to exit, and the exit handler respawns it under the same slot restart budget as any other worker exit, so the replacement reconnects and re-converges - automatic per incident, and only when that knob is explicitly on. The quiet lane never restarts anyone (see ADAPTER-ERR-DIVERGENCE-QUIET).

**What to do.** Resolve the diagnosticId attribute to its retained per-worker evidence, then treat it as a correctness incident. In an adapter-only deployment that lookup is `platform.diagnostic(id)`; the authenticated admin HTTP route exists only where the realtime layer is configured to serve one.

## ADAPTER-ERR-DIVERGENCE-QUIET

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.divergence event=divergence.quiet-state severity=warn] Workers disagree about quiet-topic history; this is expected after a worker restart and never triggers a restart.
```

**Cause.** The cross-worker comparison is split by activity: topics whose sequence moved recently carry the restart-authorized vote, while quiet topics ride this log-only lane. A worker that restarted holds none of its siblings' quiet-topic history, and with nobody publishing those topics it can never re-learn it, so the quiet hashes legitimately disagree. The report requires the same disagreement to persist across consecutive comparison epochs, so a one-round classification skew between report phases never logs.

**Consequence.** No effect on current traffic: nothing is being delivered on a quiet topic by definition. The disagreement can also be the trace of a PAST loss - a final frame one worker missed on a topic that then went quiet surfaces here rather than in the restart lane - so it is visibility without kill authority, not proof of health. The record carries only counts and an epoch.

**Automatic recovery.** The disagreement is reported once per distinct constellation (deduplicated), re-arms after agreement, and clears on its own when the quiet topics see traffic again or the cluster recycles together.

**What to do.** Usually nothing: correlate with a recent worker restart. If no worker restarted and the constellation keeps changing, treat it as a lead for the active-lane divergence diagnostics instead.

## ADAPTER-ERR-RESUME-HOOK

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.resume event=resume.hook-failed severity=error] The resume hook threw; the client falls back to a fresh subscribe.
```

**Cause.** The application resume hook threw while answering a client GAP-FILL request, so some or all of the replay frames it owed were never sent. The same hook failing on the subscribe-time backfill is ADAPTER-ERR-RECOVER-HOOK instead.

**Consequence.** The client is still sent `resumed`, because that ack is not conditional on the hook. It therefore believes its gap was handled and reports nothing. Whether the history is actually recovered depends on whether the subscribe frames it sends next carry recover offsets; if they do not, the gap is permanent and silent on both sides.

**Automatic recovery.** None for the gap. Despite the message text, no fallback subscribe is triggered by this failure - the client simply continues its normal sequence.

**What to do.** Fix the hook if resume coverage matters for these topics, and do not read a `resumed` ack as evidence a gap was filled. Clients that subscribe with recover offsets recover anyway; clients that do not are missing history without any signal.

## ADAPTER-ERR-RESUME-HOOK-READ

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.resume event=resume.hook-read-failed severity=error] Reading the resume hook result threw for a topic; that topic is treated as covering nothing.
```

**Cause.** The resume hook returned a value whose properties threw while being read, typically a getter or a proxy.

**Consequence.** That topic loses only the hook's watermark report, not its replay: the hook has already run to completion, so whatever it replayed is on the wire, and the held-frame flush falls back to the pre-window floor and delivers the whole captured window. The client can therefore see duplicates inside that window rather than a gap. Other topics in the same batch are unaffected: the read is guarded here precisely so one unreadable topic cannot abort the loop and leak the rest as permanently in-flight.

**Automatic recovery.** The subscribe completes on the ordinary no-watermark path, the same answer a hook returning a non-number gives. Possible re-delivery inside the captured window is the cost; nothing is silently lost, because an overflowed or refused flush still escalates to the truncation signal like any other.

**What to do.** Return a plain object from the resume hook. Values whose property reads have side effects cannot be read safely on this path.

## ADAPTER-ERR-AUTHENTICATE

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.authenticate event=runtime.authenticate.failed severity=error] The WebSocket authentication endpoint failed.
```

**Cause.** The application `authenticate` export threw or rejected while answering its HTTP POST endpoint, which the client posts to before opening its WebSocket.

**Consequence.** That POST is answered 500. This is an ordinary HTTP route rather than the upgrade path, so no upgrade is refused and established connections are untouched; a client that treats the failed POST as fatal never goes on to open its WebSocket.

**Automatic recovery.** None for the failed request. The client may post again, which runs the hook again.

**What to do.** Read the attached error and requestId and fix the hook. Look at the authentication endpoint and its dependencies, not at the upgrade path: the two are separate routes and this event never comes from an upgrade.

## ADAPTER-ERR-SSR

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.ssr event=runtime.ssr.failed severity=error] SvelteKit request handling failed.
```

**Cause.** The SvelteKit server handler threw while rendering or handling a request.

**Consequence.** A failure before the response starts is answered with an error response. A response already streaming its body is aborted instead, so the client sees the truncation rather than a clean end that reads as a complete response. Other requests and WebSocket connections are unaffected.

**Automatic recovery.** None for the failed request.

**What to do.** Read the attached error. This is application rendering code rather than adapter transport, so the fault is normally in a route, hook, or load function.

## ADAPTER-ERR-UPGRADE-HOOK

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.websocket-upgrade event=runtime.websocket-upgrade.failed severity=error] The WebSocket upgrade hook failed.
```

**Cause.** The application upgrade hook threw while a client was being upgraded.

**Consequence.** That upgrade does not complete and the client cannot open its WebSocket.

**Automatic recovery.** None. The client retries by reconnecting, which runs the hook again.

**What to do.** Read the attached error and fix the hook. Persistent failure presents to users as a connection that never establishes, while HTTP continues to work.

## ADAPTER-ERR-SUBSCRIPTION-SINK-DISPLACED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.subscription-accounting event=runtime.subscription-accounting.sink-displaced severity=warn] A second adapter runtime in this worker took over the subscription accounting sink. One subscription total is now frozen and the other is charged releases it never matched.
```

**Cause.** Two copies of the adapter runtime are loaded in one worker - typically a build that bundles the runtime while a package alongside it resolves its own copy from node_modules. The logical-subscription accounting sink is a single slot shared by every copy, so the second one to evaluate replaces the first one's counter.

**Consequence.** Subscription accounting splits across two counters that each describe only part of the worker. The displaced counter stops moving and drifts below the memberships it is supposed to describe, which the consistency auditor reports as `subs.total-mismatch`; the surviving counter receives releases for memberships it never charged and is driven below zero, which reports as `subs.total-negative` and is clamped back to zero each time. Publish and delivery are unaffected - the counters are accounting, not routing - but every subscription figure the worker reports is describing a fraction of it.

**Automatic recovery.** None. The takeover happens once at module evaluation and holds for the life of the worker.

**What to do.** Make the worker load ONE runtime. Check whether the application bundles the adapter while a plugin or companion package imports it from node_modules, and deduplicate that - a single resolved copy removes the condition. Until then, treat this worker's subscription totals and any alert built on them as unreliable, and read the auditor's mismatch and negative reports as consequences of this line rather than as separate defects.

## ADAPTER-ERR-CONTROL-EGRESS-EXHAUSTED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.control-egress event=control-egress.exhausted severity=warn] A connection exhausted its control-frame egress budget and was closed.
```

**Cause.** The control channel answers what a client asks for - an ack per subscribe, a denial per refused topic - so it amplifies: a few inbound bytes buy a whole frame. One connection drove more control-frame bytes than its window allows. Usually a client in a resubscribe loop, or one sending oversized batches whose topics past the cap are each answered with a denial; occasionally a deliberate amplification attempt.

**Consequence.** That one connection was closed with 4429, which the bundled client and its siblings classify as throttling: they reconnect on an accelerated backoff rather than treating it as terminal. No other connection is affected, and nothing the application published was dropped - the budget covers protocol frames the adapter emits, never application publishes or sends.

**Automatic recovery.** The client reconnects on its own throttle curve. A client whose behavior is unchanged will reach the budget again and be closed again, backing off further each time.

**What to do.** Identify the client. A repeating cycle from one page is usually a resubscribe loop - a store that re-subscribes on every render, or a reconnect handler that restores topics it never released - and fixing that removes the condition. The budget is a fixed ceiling with no option to raise it: about 4 MiB of control frames in ten seconds, and a subscribe ack costs roughly sixty bytes plus the topic name, once per topic whether or not the subscribes were batched. The one legitimate shape that reaches it is a reconnect restoring a topic set whose acks add up to more than the window, and the answer for that connection is to hold fewer topics, or to restore them in slices spread across windows.

## ADAPTER-ERR-ATTRIBUTION

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.websocket-attribution event=runtime.websocket-attribution.failed severity=error] The WebSocket attribution hook failed; the connection was refused at open.
```

**Cause.** The handler module's `attribution` export threw, returned a promise, returned a misshaped result, or returned an id outside the allowed form (a string of [a-zA-Z0-9_-], at most 64 characters).

**Consequence.** That connection is closed with code 1008 before the application open hook runs. Attribution is fail-closed: a connection that cannot be attributed is refused rather than admitted unattributed, because an unattributed admission would silently stand down every tenant-scoped limit that reads the attribution.

**Automatic recovery.** None for that connection. The client may reconnect, which runs the resolver again against a fresh userData.

**What to do.** Read the attached error and fix the `attribution` export: return { tenantId?, principalId?, entitlement? } synchronously - each present value a string of [a-zA-Z0-9_-] with 1-64 characters - or null/undefined for an unattributed connection. Resolve identity itself in the upgrade hook; attribution only derives from the userData that hook produced.

## ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.subscribe event=subscribe.batch-hook-failed severity=error] The subscribeBatch hook threw; every topic in the batch was denied INTERNAL_ERROR.
```

**Cause.** The application subscribeBatch authorization hook threw.

**Consequence.** Every topic in that batch is denied with INTERNAL_ERROR. Authorization is fail-closed, so a throwing hook denies rather than admits.

**Automatic recovery.** None. The client may retry the subscribe, which runs the hook again.

**What to do.** Fix the hook. Because one throw denies the whole batch, a fault touching a single topic presents as a client that can subscribe to nothing.

## ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.subscribe event=subscribe.batch-result-read-failed severity=error] Reading the subscribeBatch result threw; every topic in the batch was denied INTERNAL_ERROR.
```

**Cause.** The subscribeBatch hook returned a value whose properties threw while being read, typically a getter or a proxy.

**Consequence.** Every topic in that batch is denied with INTERNAL_ERROR, exactly as though the hook itself had thrown.

**Automatic recovery.** None. The client may retry the subscribe.

**What to do.** Return a plain object keyed by topic from the hook, and keep property reads on it free of side effects. An array is not that shape: its entries are read back under index keys, so its denials name topics like 0 and 1 and every real topic in the batch is silently allowed.

## ADAPTER-ERR-SUBSCRIBE-HOOK

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.subscribe event=subscribe.hook-failed severity=error] The subscribe hook threw; the subscribe was denied INTERNAL_ERROR.
```

**Cause.** The application subscribe authorization hook threw for a single topic.

**Consequence.** That subscribe is denied with INTERNAL_ERROR. Authorization is fail-closed, and the reason is deliberately distinct: returning false denies with FORBIDDEN, so a throw is reported as a fault rather than as a refusal.

**Automatic recovery.** None. The client may retry the subscribe, which runs the hook again.

**What to do.** Read the attached error and fix the hook. A client seeing INTERNAL_ERROR rather than FORBIDDEN or UNAUTHENTICATED is being told this is a defect, not a permissions decision, so treat it as one and do not go looking at authorization rules first.

## ADAPTER-ERR-TLS-RELOAD-SKIPPED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.tls event=tls.reload-skipped severity=warn] A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.
```

**Cause.** A certificate change was seen on disk but not applied, usually because the new material was unreadable or incomplete at the moment it was read.

**Consequence.** The server keeps serving the previous certificate and enters a degraded TLS state. The renewal on disk is not in use, so the served certificate can expire while a valid one sits unread. READINESS PROBES STAY GREEN throughout, which is what makes this quiet.

**Automatic recovery.** The next reload that succeeds applies the certificate and clears the degraded state.

**What to do.** Confirm the served certificate matches the one on disk rather than assuming renewal succeeded, and read the TLS degraded state rather than the probe, which cannot see this. Treat the warning as expiry risk, not noise.

## ADAPTER-ERR-TLS-SWAP

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.tls event=tls.swap-failed severity=error] A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.
```

**Cause.** Applying a new certificate set failed partway through the swap.

**Consequence.** Nothing changed on the wire: every context is built and validated before any is taken, and the staged set is discarded on a throw, so the served certificates - default and every SNI name - are exactly what they were. The renewal on disk is not being served, and the TLS degraded state is set for the duration.

**Automatic recovery.** A one-shot retry is armed from the failure itself, rather than from the next filesystem event, because the throw may have consumed the last event of a renewal burst and the next one could be months away. A persistent fault therefore retries at that cadence instead of spinning.

**What to do.** Read the attached error. An extra pair rewritten between its validation read and the apply read - a certbot burst landing mid-reload - resolves through the armed retry once the write completes; a default context the server refused names the material to fix. Confirm the served certificate afterwards rather than assuming the renewal took.

## ADAPTER-ERR-TLS-WATCH

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.tls event=tls.watch-failed severity=error] The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.
```

**Cause.** The filesystem watch on the certificate directory could not be established.

**Consequence.** Certificate hot reload is off for the process lifetime and the TLS degraded state is set - and stays set, because no later reload can resurrect the watcher. One arm-time catch-up read runs right after this failure, so a renewal already on disk at that moment is still served; nothing that lands afterwards is ever picked up, and the failure surfaces much later as an expired certificate.

**Automatic recovery.** None for the watch itself: it is not retried, so this does not resolve without a restart. The arm-time catch-up may still swap in a renewal that was already on disk when the watch failed; the degraded state and its expiry sentinel survive even that success.

**What to do.** Fix the path or permissions and restart the process. Until then, treat certificate renewal as requiring a restart, and alert on certificate expiry independently. In a clustered deployment the primary reports its own watch failure separately as ADAPTER-ERR-TLS-PRIMARY-WATCH.

## ADAPTER-ERR-TLS-WATCH-LOST

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.tls event=tls.watch-lost severity=error] The certificate directory watch stopped after running; hot reload is disabled and no further renewal will be seen.
```

**Cause.** A watch that started successfully reported a failure later - the certificate directory was removed or replaced, its permissions changed, or the platform's watch resources ran out. This arrives as an event rather than a throw, so it happens while the process is serving rather than at boot.

**Consequence.** Certificate hot reload is off from that moment for the process lifetime, and the TLS degraded state is set and stays set. Unlike a watch that never started, no catch-up read follows this one: whatever was on disk at the moment the watch died is what this instance keeps serving, and the failure surfaces much later as an expired certificate.

**Automatic recovery.** None. The watch is not re-armed, so this does not resolve without a restart.

**What to do.** Find what happened to the certificate directory - a redeployed secret volume that replaced the directory rather than the files in it is the usual cause - and restart the process. Until then, treat certificate renewal as requiring a restart and alert on certificate expiry independently.

## ADAPTER-ERR-CLUSTER-CONFIG-WORKERS

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] Invalid CLUSTER_WORKERS value: '
```

**Cause.** CLUSTER_WORKERS is set to something other than a positive integer or 'auto'.

**Consequence.** The cluster primary exits with status 1 before spawning any worker; the service never comes up.

**Automatic recovery.** None. Startup configuration is validated once, at boot.

**What to do.** Set CLUSTER_WORKERS to a positive integer or 'auto' (or unset it) and restart.

## ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] websocket.workers.compute (
```

**Cause.** websocket.workers.compute is greater than or equal to the total worker count, which would leave no I/O worker to listen.

**Consequence.** The cluster primary exits with status 1 before spawning any worker; the service never comes up.

**Automatic recovery.** None. Startup configuration is validated once, at boot.

**What to do.** Lower websocket.workers.compute or raise CLUSTER_WORKERS so at least one I/O worker remains.

## ADAPTER-ERR-CLUSTER-CONFIG-MODE

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] Invalid CLUSTER_MODE: '
```

**Cause.** CLUSTER_MODE is set to an unknown value.

**Consequence.** The cluster primary exits with status 1 before spawning any worker; the service never comes up.

**Automatic recovery.** None. Startup configuration is validated once, at boot.

**What to do.** Use 'reuseport' (Linux), or unset CLUSTER_MODE - reuseport is also the default and the only mode this runtime has.

## ADAPTER-ERR-CLUSTER-CONFIG-PORT

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] PORT=0 cannot be combined with CLUSTER_WORKERS (each worker would bind its own kernel-assigned port, so the workers do not share one: 
```

**Cause.** PORT=0 asks the kernel for an ephemeral port, and clustering has every I/O worker call listen() for itself. Each worker is then assigned a DIFFERENT port, so the one thing the shared port exists to provide - many workers behind a single port - does not happen.

**Consequence.** The fleet boots green and serves on ports nobody knows. Nothing routes to it: a load balancer, a health check and the startup log all name the configured port, which is 0, while each worker answers somewhere else.

**Automatic recovery.** None. The primary exits with status 1 before spawning any worker, the way every other capacity misconfiguration in this block does.

**What to do.** Set PORT to a real port when clustering. If an ephemeral port is what you want - a test harness, a sandbox - drop CLUSTER_WORKERS to run single-process, where one bind makes an ephemeral port meaningful again.

Further reading: https://svti.me/cluster-mode

## ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] CLUSTER_WORKERS requires Linux (SO_REUSEPORT accept distribution is not available on 
```

**Cause.** CLUSTER_WORKERS is set on a platform other than Linux. Every io worker binds the shared port itself with SO_REUSEPORT and the kernel distributes accepted connections across the listeners; off Linux the bind fails outright (Windows, macOS) or the kernel routes every accept to one listener.

**Consequence.** The cluster primary exits with status 1 before spawning any worker; the service never comes up. Refusing beats booting a fleet whose extra workers can never take traffic.

**Automatic recovery.** None. Startup configuration is validated once, at boot.

**What to do.** Deploy on Linux to keep the in-process cluster, or unset CLUSTER_WORKERS and run one process per core under your process manager behind a load balancer.

## ADAPTER-ERR-CLUSTER-WORKER-ERROR

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.cluster event=cluster.worker-error severity=error] A worker thread reported an error.
```

**Cause.** A worker thread emitted an error event to the primary, which usually means it threw outside a request or failed during startup.

**Consequence.** That worker is unhealthy. Its connections are lost when it exits, and cluster capacity drops until it is replaced.

**Automatic recovery.** The supervisor replaces an exiting worker; the error itself is reported, not retried. Under a startup or import fault every replacement hits the same error, each attempt is charged against the slot's restart budget, and an exhausted slot takes the whole service down - the outcome ADAPTER-ERR-WORKER-RESTART-LIMIT documents from the other end.

**What to do.** Read the attached error attribute. A repeating worker error at startup usually means a configuration or import fault that every replacement will hit as well.

## ADAPTER-ERR-WORKER-RESTART-LIMIT

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] Worker restart limit reached for 
```

**Cause.** A worker slot crashed and was respawned repeatedly without ever reaching stable uptime, exhausting its restart budget.

**Consequence.** The primary exits - hard-killing if other workers are still alive, so the teardown is clean - and the whole service goes down until an orchestrator respawns the process.

**Automatic recovery.** None inside the process. An orchestrator respawn, where one is configured, is the recovery path.

**What to do.** Read the failing worker crash output above this line: the restart limit is the symptom and the repeated worker crash is the fault. A loop this fast is usually a boot-time error, not load.

Further reading: https://svti.me/worker-restart-limit

## ADAPTER-ERR-WORKER-EXIT-SIGKILL

Severity: error

Log line begins:

```
[primary] worker 
```

**Cause.** A worker was asked to exit and had not done so within the exit grace period, so the primary killed the WHOLE PROCESS with SIGKILL. A wedged worker cannot close itself, and the family resolves a wedged worker by process death rather than by terminating the one thread.

**Consequence.** Every worker dies, not just the wedged one: all connections drop, in-flight requests are lost, and no shutdown hook runs. The process is expected to be respawned by whatever supervises it - systemd, a container runtime, an orchestrator. Without one, the service stays down.

**Automatic recovery.** None inside the process. Recovery is the supervisor restarting it.

**What to do.** Find why the worker would not exit. A blocked event loop is the usual cause - a synchronous hook, an unbounded loop, or a native call that does not return - and it will happen again at the next exit request. Most exit requests print their reason above this line; the one that does not is the shutdown budget expiring, where the request went to every worker at once and this one did not go.

## ADAPTER-ERR-RELAY-SPILL-QUARANTINE

Severity: error

Log line begins:

```
[primary] relay spill quarantining 
```

**Cause.** The primary could not hand relay traffic DOWN to this worker inside the worker's spill ceiling - its ring backlog crossed the byte limit, or the worker stopped making drain progress for longer than the age limit - so the primary quarantined it. This is the opposite direction from ADAPTER-ERR-RELAY-SPILL-OVERFLOW, which is a worker that could not reach the primary.

**Consequence.** The primary stops forwarding relay traffic to that worker and asks it to exit, so its clients are dropped and reconnect onto a sibling. Until they do, that worker's subscribers were already missing whatever the ring could not deliver. Quarantine happens once per worker - the primary does not re-evaluate it - and the line names the reason, the bytes dropped and how long the backlog had been pending.

**Automatic recovery.** The exit is a request, not a guarantee: quarantine posts a terminate message the quarantined worker's own event loop must process, and an AGE quarantine means exactly that loop stopped making progress. A worker that processes the request exits and the primary replaces it; one still wedged when the exit grace expires is resolved by killing the whole process for the orchestrator to respawn - the mechanism ADAPTER-ERR-WORKER-EXIT-SIGKILL documents. Either way the dropped frames are not resent, so a client that was subscribed on that worker has a hole its own resume path must fill when it reconnects.

**What to do.** Read the reason on the line. An AGE spill means that worker stopped draining its ring - a blocked event loop is the usual cause, and it is the worker's own thread to profile, not the primary's. A BYTES spill can mean either: a peer merely behind on a ceiling sized too close to the largest relayed frame, where raising CLUSTER_RELAY_MAX_PENDING_KB to a few times that frame is the fix, or sustained fan-out the relay is undersized for, where a wider ceiling only delays the next spill. The droppedBytes on the line tells you which.

## ADAPTER-ERR-RELAY-SPILL-OVERFLOW

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.cluster-relay event=cluster-relay.up-spill-overflow severity=error] This worker could not hand its relay backlog to the primary within its spill ceiling and is exiting to be replaced.
```

**Cause.** The worker queued more relay bytes, or held them longer, than its spill ceiling allows while waiting on the primary.

**Consequence.** The worker exits deliberately rather than growing an unbounded queue. Connections on it drop and those clients reconnect to whichever workers are still up.

**Automatic recovery.** Within the slot restart budget. The worker exits and the supervisor respawns it, but a slot that keeps exiting without reaching stable uptime exhausts that budget and the primary then exits the whole process (see ADAPTER-ERR-WORKER-RESTART-LIMIT). A blocked primary - the usual cause here - starves every worker at once, so repeated occurrences are the shape that reaches exhaustion rather than a series each worker recovers from.

**What to do.** Read the reason, droppedBytes, and pendingAgeMs attributes. A blocked or slow primary is the usual cause; if the backlog is legitimate peak traffic, raise the relay ring pending ceilings. Check whether siblings are reporting this too - a process-wide cause will not resolve by replacing one worker.

## ADAPTER-ERR-RELAY-FRAME-OVERSIZED

Severity: error

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.cluster-relay event=cluster-relay.frame-oversized severity=error] A worker sent a relay frame larger than this process will reassemble; its relay stream was stopped.
```

**Cause.** A worker declared a relay frame above the reassembly ceiling, which is four times the configured relay frame ceiling. Either the ceiling is set far below real payloads, or the stream is corrupt.

**Consequence.** That worker relay stream is stopped, so its cross-worker publishes no longer reach this process. Local delivery on the sending worker continues, which is what makes the split silent.

**Automatic recovery.** None for the stopped stream itself. The sending worker is expected to retire through its own spill overflow and be replaced, which is the path that actually restores its relay.

**What to do.** Compare the declaredBytes and maxFrameBytes attributes. If the payload is legitimate, raise the relay frame ceiling; otherwise treat the stream as corrupt and replace the worker.

## ADAPTER-ERR-RELAY-FRAME-REFUSED

Severity: warn

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.cluster-relay event=cluster-relay.frame-refused severity=warn] A publish was too large for the cluster relay and was not sent to other workers. Local subscribers received it.
```

**Cause.** A publish exceeded the configured relay frame ceiling for cross-worker delivery.

**Consequence.** Subscribers on this worker received the message and subscribers on every other worker did not. Clients therefore disagree about state depending on which worker they landed on.

**Automatic recovery.** None. The refused publish is not retried or fragmented.

**What to do.** Reduce the payload size, or raise the relay frame ceiling to cover it. Treat repeated occurrences as a correctness problem rather than a capacity warning, because the split is invisible to clients.

## ADAPTER-ERR-TLS-PRIMARY-BOOT-READ

Severity: error

Log line begins:

```
[tls] boot certificate unreadable on the primary (hot-reload broadcast stays armed)
```

**Cause.** The cluster primary could not read or parse the boot certificate while arming the hot-reload watch.

**Consequence.** Primary-side expiry observability starts blind: no baseline identity or expiry is recorded, so a later reload failure is reported without the number that says how urgent it is. Workers gate on their own certificate reads and keep serving; the reload broadcast stays armed.

**Automatic recovery.** The next reload that reads cleanly records identity and expiry.

**What to do.** Verify the certificate path and PEM contents on the primary host.

## ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ

Severity: error

Log line begins:

```
[tls] renewed certificate unreadable on the primary (workers gate on their own reads)
```

**Cause.** A certificate change was seen on disk but the renewed material was unreadable or incomplete when the primary read it.

**Consequence.** The reload broadcast still goes out and every worker gates on its OWN read, so a primary-local failure (a read racing the renewal writer at the primary debounce instant) can leave the workers correctly swapped while only the primary is blind. What certainly failed is the primary side: no renewed identity or expiry is recorded, the primary enters the degraded TLS state with its expiry sentinel armed, and READINESS PROBES STAY GREEN. When the renewal itself is broken, every worker read fails the same way and the fleet keeps the previous certificate.

**Automatic recovery.** Every certificate change broadcasts again; the next change the primary reads cleanly records identity and expiry and clears the degraded state.

**What to do.** Check whether the workers actually swapped (compare the served certificate against the renewal on disk) before assuming the fleet is stale, then fix the certificate material or the primary-host read.

## ADAPTER-ERR-TLS-PRIMARY-WATCH

Severity: error

Log line begins:

```
[tls] primary cert watch failed to start, cluster hot-reload disabled (server keeps running)
```

**Cause.** The filesystem watch on the certificate directory could not start on the cluster primary, commonly a not-yet-mounted secret volume or a mistyped path.

**Consequence.** Cluster-wide certificate hot reload is off for the process lifetime: with no watcher on the primary, no worker is ever told to reload, so the whole fleet serves its current certificate until it expires. The primary enters the degraded TLS state; readiness probes stay green throughout.

**Automatic recovery.** None. The watch is not retried, so this does not resolve without a restart.

**What to do.** Fix the path or permissions and restart the primary. Until then, treat certificate renewal as requiring a restart and alert on certificate expiry independently.

## ADAPTER-ERR-TLS-PRIMARY-WATCH-LOST

Severity: error

Log line begins:

```
[tls] primary cert watch stopped after running, cluster hot-reload disabled (server keeps running)
```

**Cause.** A watch that started successfully on the cluster primary reported a failure later - the certificate directory was removed or replaced, its permissions changed, or the platform's watch resources ran out. A redeployed secret volume that replaces the directory rather than the files in it is the usual cause.

**Consequence.** Cluster-wide certificate hot reload is off from that moment: with no watcher on the primary, no worker is ever told to reload, so the whole fleet serves its current certificate until it expires. The primary enters the degraded TLS state and stays there; readiness probes stay green throughout.

**Automatic recovery.** None. The watch is not re-armed, so this does not resolve without a restart.

**What to do.** Find what happened to the certificate directory and restart the primary. Until then, treat certificate renewal as requiring a restart and alert on certificate expiry independently. A watch that never started at all is reported separately as ADAPTER-ERR-TLS-PRIMARY-WATCH.

## ADAPTER-ERR-TLS-DEGRADED-EXPIRY

Severity: error

Log line begins:

```
[svelte-adapter-ws] [tls] certificate hot-reload is DEGRADED (
```

**Cause.** TLS hot-reload is in the degraded state on the cluster primary and the recorded certificate expiry is inside the alert window.

**Consequence.** The figure is the last certificate the primary read cleanly, not necessarily what the workers serve - after a primary-local reload-read failure this alarm can count down against a certificate the fleet already replaced. When the renewal itself is broken the countdown is real: handshakes fail at the printed expiry while readiness probes stay green.

**Automatic recovery.** The alert re-checks hourly while degraded. A reload that succeeds clears the degraded state and silences it.

**What to do.** Verify the served certificate against the renewal on disk first (see ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ). If the fleet is genuinely stale, fix the certificate files now and restart the instance if the reload cannot be repaired before the printed expiry.

## ADAPTER-ERR-SHUTDOWN-LISTENER-REJECTED

Severity: error

Log line begins:

```
[svelte-adapter-ws] a sveltekit:shutdown listener rejected
```

**Cause.** An async sveltekit:shutdown listener's promise rejected during shutdown.

**Consequence.** That listener's cleanup did not complete. The rejection is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.

**Automatic recovery.** Not applicable; shutdown proceeds without the failed cleanup.

**What to do.** Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.

## ADAPTER-ERR-SHUTDOWN-LISTENER-THREW

Severity: error

Log line begins:

```
[svelte-adapter-ws] a sveltekit:shutdown listener threw
```

**Cause.** A sveltekit:shutdown listener threw synchronously during shutdown.

**Consequence.** That listener's cleanup did not complete. The throw is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.

**Automatic recovery.** Not applicable; shutdown proceeds without the failed cleanup.

**What to do.** Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.

## ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED

Severity: error

Log line begins:

```
[svelte-adapter-ws] in-flight requests did not finish within the shutdown budget (
```

**Cause.** In-flight HTTP requests were still open when the configured shutdown budget expired.

**Consequence.** The remaining open requests are dropped as the sockets close; their clients see resets. The drop is bounded and deliberate: the budget exists so a wedged request cannot hold the process open.

**Automatic recovery.** Not applicable; shutdown proceeds by design.

**What to do.** Raise SHUTDOWN_TIMEOUT if legitimate requests need longer to drain, or find the handler that never finished. SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.

## ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED

Severity: error

Log line begins:

```
[svelte-adapter-ws] sveltekit:shutdown listeners did not settle within the shutdown budget (
```

**Cause.** One or more sveltekit:shutdown listeners were still pending when the shutdown budget expired.

**Consequence.** The process exits with that cleanup unfinished: final writes and teardowns those listeners were performing did not complete.

**Automatic recovery.** Not applicable; the budget exists so a wedged listener cannot hold the exit.

**What to do.** Make the listener finish within the budget or raise SHUTDOWN_TIMEOUT; SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.

## ADAPTER-ERR-SHUTDOWN-FAILED

Severity: error

Log line begins:

```
[svelte-adapter-ws] graceful shutdown failed
```

**Cause.** The graceful shutdown sequence itself threw. Every application-supplied input is contained behind its own entry (a throwing ws shutdown hook, a rejecting or wedged sveltekit:shutdown listener, an overrunning drain), so this line means the sequence's own machinery raised - an adapter defect, or an application-side patch of a global the sequence reads, such as an instrumentation layer's rewrap of process or EventEmitter internals throwing when the listener list is read.

**Consequence.** The orderly steps after the throw were skipped, so the shutdown was not clean; the process still exits rather than hanging.

**Automatic recovery.** Not applicable.

**What to do.** Read the attached error. A stack through application instrumentation points at a broken global patch; anything else is adapter-owned and worth reporting with the attached error.

## ADAPTER-ERR-SENDTO-ASYNC-FILTER

Severity: error

Log line begins:

```
[ws] platform.sendTo filter returned a Promise; treating as fail-closed.
```

**Cause.** A platform.sendTo filter returned a Promise. The filter must be synchronous, because sendTo iterates every active connection in one pass.

**Consequence.** Every connection whose filter returns a Promise is skipped - fail-closed - on this and every later sendTo call, so the targeted delivery silently reaches nobody the filter cannot answer synchronously. The warning prints once per process.

**Automatic recovery.** None. The filter stays fail-closed until the code is fixed.

**What to do.** Resolve the fields the filter needs into userData in your upgrade hook so the filter can read them synchronously.

Further reading: https://svti.me/sendto-async

## ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW

Severity: error

Log line begins:

```
[ws] the WebSocket shutdown hook threw
```

**Cause.** The `shutdown` export of the WebSocket handler threw synchronously or rejected while the server was closing.

**Consequence.** Whatever that hook was flushing did not finish - final writes, external deregistration, or draining a queue. The throw is contained and the teardown carries on regardless, so the loss is silent unless this line is read.

**Automatic recovery.** None. Shutdown is best-effort and proceeds without the hook.

**What to do.** Fix the hook, then check whatever it was flushing for state left behind. The hook is awaited with { platform, signal, deadline } during the drain and shares the shutdown cleanup budget, so long-running flushes must finish inside it.

## ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED

Severity: error

Log line begins:

```
[ws] the WebSocket shutdown hook has not settled after 
```

**Cause.** The `shutdown` export of the WebSocket handler was still running when the shutdown budget expired.

**Consequence.** The close path stops waiting and the drain proceeds anyway. The hook keeps running - user code cannot be interrupted - but nothing awaits it any more, so whether it finishes is a race against whatever ends the process next. It may well complete: under `createTestServer` the process often continues afterwards and the flush lands. What is gone is the guarantee, so a hook that prints this is one deploy timing away from losing whatever it was flushing. createTestServer prints the same line for the same hook.

**Automatic recovery.** None by design: the budget exists so a wedged hook cannot hold the process open.

**What to do.** Make the hook finish inside the budget, or raise SHUTDOWN_TIMEOUT. The hook receives a `signal` that aborts when the budget expires - honoring it turns this into a clean early return.

## ADAPTER-ERR-MESSAGE-HOOK

Severity: error

Log line begins:

```
[ws] the message hook threw
```

**Cause.** The application or plugin `message` hook threw or rejected while handling a client frame.

**Consequence.** That client's connection is closed with code 1011 and the reason `Message handler error`; the cause stays server-side and is not sent to the client. Other connections are unaffected. A client that reconnects and replays the same frame is closed again.

**Automatic recovery.** None for the frame. The client sees a close, and reconnection is the client library's own resume path.

**What to do.** Fix the hook, or catch inside it and answer the client deliberately. The error printed with this line is the original throw.

## ADAPTER-ERR-RECOVER-HOOK

Severity: error

Log line begins:

```
[ws] the recover-on-subscribe hook threw
```

**Cause.** The `resume` hook threw on the RECOVER-ON-SUBSCRIBE path - a client subscribing to a topic the server was asked to backfill - so the backlog that subscription should have replayed could not be produced. The same hook failing on a client resume frame is ADAPTER-ERR-RESUME-HOOK instead.

**Consequence.** The subscription itself still completes: the client is subscribed and receives live frames from that moment on, but the events it missed before subscribing are not delivered and no gap is reported to it. It looks like a working subscription with a hole at the start.

**Automatic recovery.** None. Live delivery continues; the missed range is not retried.

**What to do.** Fix the hook or make it fail closed for the topics it cannot serve. A hook that throws for a topic it does not own should return an empty result for it instead.

## ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE

Severity: error

Log line begins:

```
[ws] operational event dropped, invalid record shape
```

**Cause.** Something emitted an operational diagnostic the runtime could not build a record from - a malformed event name, an unknown severity or data class, or a bad timestamp. A field that cannot be SERIALIZED is a different, quieter failure: the renderer absorbs it by printing the envelope with the attributes stripped, so the event still appears minus its attributes and no error line prints - the render path reports only its own total collapse (see ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE).

**Consequence.** That diagnostic is DROPPED: it reaches neither the configured sink nor the log, so the failure it was reporting leaves no structured trace. Everything else keeps emitting normally.

**Automatic recovery.** None for the dropped record. Telemetry deliberately never throws, so the emitting path continued as if it had been reported.

**What to do.** Read the event name printed with this line and fix the emitter. If it is application or plugin code calling the diagnostic surface, check the record against the documented shape.

## ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE

Severity: error

Log line begins:

```
[ws] diagnostic render failed: 
```

**Cause.** Formatting an operational diagnostic threw, and formatting it again with the attributes stripped threw as well. That SECOND failure is what makes this environmental rather than a bad record: the strip leaves only fields createDiagnostic produced and validated itself, every one a bounded string or number - the message is cut to 512 characters at creation - so no record this runtime accepted can fail the retry. What can fail it is the JSON serialization the format is built on: a replaced or wrapped `JSON.stringify`, a `toJSON` added to `Object.prototype`, an instrumentation agent that patched either. A value in the ATTRIBUTES that cannot be serialized is absorbed by the retry and never reaches this line, and a console that refuses the finished text prints the diagnostic-console-write line instead.

**Consequence.** That diagnostic is lost. How much goes with it depends on what the serialization refuses: one that fails outright takes the whole operational stream, and one that refuses only certain shapes - a wrapper scrubbing a field, a size ceiling - takes every diagnostic matching that shape and lets the rest through. So a log that still carries other events does NOT mean this was isolated to the record named here; it means the refusal is selective. The request path is unaffected either way: the failure is contained so telemetry cannot take a worker down with it.

**Automatic recovery.** None for the lost record, and a later diagnostic printing normally is not recovery - under a selective refusal the ones that do not match keep working throughout, which is exactly what makes the gap easy to miss. Nothing is retried and nothing is unregistered; each event is formatted independently and meets the same serialization.

**What to do.** Do not start at the emitter or the record - neither can produce this line. Look for what changed this process's JSON serialization: an APM or instrumentation agent, a polyfill, a test harness stubbing `JSON.stringify`, or a dependency that added `toJSON` to `Object.prototype`. Do NOT clear it on `JSON.stringify({})` alone: a selective wrapper returns `{}` for that and still refuses the shape that produced this line. Serialize a record of the shape the RETRY formats - the diagnostic envelope with no attributes, every field a bounded string or number - and compare that with the trivial case; a difference between them IS the wrapper. Do not test the event's own attributes: an attribute that cannot be serialized is absorbed by the retry and never produces this line, so a throw from serializing them proves nothing about this failure and reads as a wrapper that is not there. The event name on the line is what was in flight, not a suspect.

## ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE

Severity: error

Log line begins:

```
[ws] diagnostic rendered but the console refused it: 
```

**Cause.** The diagnostic formatted correctly and the console method carrying its severity threw when handed the finished line. The record is not the suspect here: a console replaced or wrapped by the host, or one whose write end has gone, refuses a well-formed string exactly the same way.

**Consequence.** That one diagnostic is lost, and so is every later one carried by the SAME console method for as long as it keeps throwing - this is a broken channel rather than a bad value, so it does not stop at the record that revealed it. The mapping is not one method per severity: debug, info, and warn ride their own methods, while error and fatal share console.error, so a broken error channel loses both and a fatal line missing from the log means console.error is broken. Severities riding other methods are unaffected, and this line itself is written through console.error, which is a different method in every case but a failing error or fatal channel.

**Automatic recovery.** None, and none is attempted: nothing re-routes a severity to another method, because silently moving warnings into the error stream would corrupt the log an operator reads.

**What to do.** Look at the console rather than the emitter - specifically anything in the deployment that replaces, wraps, or proxies it (a log shipper, an APM agent, a test harness stub). The event name on the line says what was being reported when it went; the severity that is missing from the log tells you which method is broken. If nothing wraps the console, check whether its destination still exists - a closed pipe or a full stream refuses writes the same way.

## ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE

Severity: error

Log line begins:

```
[ws] operational sink failed and its failure notice could not be built: 
```

**Cause.** A configured operational event sink threw, the console fallback printed the original event in its place, and then BUILDING the record that announces the sink failure threw. Only the wall clock the notice stamps can do that: every other field is a constant or a value read off the already-validated original record, and a clock either throws or returns a timestamp the shape accepts - no clock RETURN value can be rejected. The console is not implicated: this very line is written through it.

**Consequence.** One record is lost, and it is the notice, not the event. The event named on this line was printed by the console fallback immediately above it, so the telemetry the sink was carrying is in the log; what is missing is the machine-readable statement that the sink is broken, which is what a collector watching for sink health would have keyed on.

**Automatic recovery.** None for the lost notice. The sink is not unregistered and is called again for the next event. This line is inherently intermittent: it needs the same clock to succeed for the event's own record and then fail for the notice moments later, so a clock broken outright does not keep printing it - the next emission dies earlier, at record construction, and prints the record-shape line instead.

**What to do.** Two independent things failed and both are worth a look. The sink is the deployment-supplied component that failed first, and the event name on the line says what it was carrying. The notice failure is separate and is the adapter-side wall clock - an injected clock that throws intermittently, or an async sink rejection settling after the clock broke. A deployment that has not injected a clock should treat this half as a defect worth reporting.

## ADAPTER-ERR-METRICS-MODULE-SHAPE

Severity: error

Log line begins:

```
[ws] the metrics module must export a registry object as `default`, `metrics` or `registry`; got 
```

**Cause.** The export the build SELECTED from the module named by `websocket.metrics` cannot carry instrument factories. This is a statement about that one value, not about the module: the build takes the first of `default`, `metrics` and `registry` that is not nullish and forwards it without validating its shape, so a module carrying a perfectly good `metrics` registry prints this line whenever a primitive `default` sits in front of it.

**Consequence.** Metrics are disabled for the whole worker: no instrument is ever created, so the adapter series are ABSENT from the scrape rather than present at zero. Dashboards read as no data and alerts that fire on a threshold never fire at all.

**Automatic recovery.** None. The runtime keeps serving traffic with metrics off - the alternative is a boot failure naming neither metrics nor the option that caused it.

**What to do.** The guard accepts any object or function, so what printed this is a PRIMITIVE - the `got` value on the line says which type. Export the registry itself under any one of the three names the build reads, which it tries in order: `default`, then `metrics`, then `registry`. The first one that is not nullish wins, so a primitive `default` masks a perfectly good named `metrics` beside it and is worth ruling out first.

## ADAPTER-ERR-METRICS-INSTRUMENT

Severity: error

Log line begins:

```
[ws] a metrics instrument threw; further errors from it are suppressed
```

**Cause.** Recording a value threw. The containment wraps the adapter's own mirror of the instrument, so the throw is usually from the registry module the `websocket.metrics` option names, but adapter code runs first on that path and a failure there surfaces the same way.

**Consequence.** Where the value ends up depends on which side threw. The adapter records into its own mirror BEFORE delegating, so a throw from the configured registry loses the value only from that registry's scrape - `metricsSnapshot()` still has it. Every later call is attempted again, the containment being per call, so an instrument that throws for one label set or one transient keeps recording the rest; but the failures are printed once and then suppressed, so nothing tells you whether it kept failing. A series that stops moving reads as an idle server rather than a broken instrument.

**Automatic recovery.** The throw is contained per call, so the request or frame that triggered it completes normally, and a transient failure self-heals on the next call.

**What to do.** Read the error printed with this line - it is the original throw, and its stack says which side failed. Label cardinality and type mismatches in the registry module are the usual causes.

## ADAPTER-ERR-POSTURE-EXPORT-DISABLED

Severity: warn

Log line begins:

```
[ws] posture export disabled: 
```

**Cause.** The posture export socket could not listen on its configured path, or its socket failed later in its life; the line says which. A stale socket file is removed automatically before every listen attempt, so the listen shape means a permission denial (including a stale path the process could not remove), a missing parent directory, or a Windows named pipe already taken.

**Consequence.** The worker keeps serving traffic, but nothing can read its live pressure posture over that socket: an external supervisor watching it sees a connection failure rather than a posture, and any shedding decision built on it stops updating. A failed listen never had readers to lose; a later socket error drops whichever readers were connected.

**Automatic recovery.** None. The export is not retried for the life of the worker.

**What to do.** Read the shape on the line. For a failed listen, fix the directory permissions, create the missing parent directory, or point the export at a free path, then restart the worker - removing a stale socket file by hand is not the repair, because the runtime already removes one before every listen. For a later socket error the export is down until restart; its consumers key on the 1 Hz cadence stopping either way.

## ADAPTER-ERR-POSTURE-OBSERVER

Severity: error

Log line begins:

```
[ws] a posture transition handler threw
```

**Cause.** The adapter's own protection-posture transition handler threw. It prints the posture line, then pushes the new posture to the export socket. The export push contains its own failures, so what remains is the console write.

**Consequence.** The posture CHANGED and the runtime is shedding or recovering as configured, but the record of it did not finish. What went missing is the posture log line, and with it the IMMEDIATE export push that follows it - a defense daemon reacting to the change does not get it at the instant of transition. The staleness that leaves is shorter than a sample, not longer: the posture advances from inside the 1 Hz pressure sampler, and that same sampler run pushes the ordinary posture heartbeat a few statements later, so an export reader carries the true posture before the tick that raised it has finished.

**Automatic recovery.** The heartbeat later in the SAME sampler run carries the new posture, so no export reader waits for another transition or another second; the next transition runs the handler again, since a throw does not unregister it. Only the incident-timeline console line for this transition is gone for good.

**What to do.** This is an adapter-internal failure - report it with the error printed beside it. The console write is the candidate to look at first: the export push after it contains its own failures (a non-serializable snapshot and a slow client are both handled inside it).

## ADAPTER-ERR-POSTURE-TRANSITION

Severity: warn

Log line begins:

```
[ws] protection posture 
```

**Cause.** The worker moved between protection postures - normal, elevated and siege. Normal to elevated is decided by sampled pressure holding over a configured threshold (memory, CPU quota, kernel stall time, publish rate or subscriber ratio). Elevated to siege is decided instead by the rate of capacity rejections crossing the siege rate, independently of those signals. Both directions relax after a run of quiet samples, and siege steps down to elevated rather than straight to normal. The line names the posture it left, the posture it entered, the rejection rate at that moment and the highest pressure signal.

**Consequence.** What the posture changes depends on which one it entered. At ELEVATED nothing is refused - the admission effect is only a wider Retry-After jitter on capacity responses that were already going out - so this line is a warning rather than an outage. It does change what the worker REPORTS, though: from here a sample reads its pressure state as active, and its reason as CAPACITY unless the underlying signal is MEMORY, which is preserved and reported as itself - so `platform.pressure`, the posture export and any onPressure listener follow the posture rather than the underlying signal, except for the one signal you would least want masked. At SIEGE the worker additionally refuses EVERY new upgrade at static-serve cost, and clients see a capacity refusal rather than an error. A worker that settles at either is running at its ceiling.

**Automatic recovery.** Yes, and a de-escalation prints this same line: the posture steps back down after a run of quiet samples, and both directions are dwell-gated so it cannot flap.

**What to do.** Read the two numbers together, because which one decided depends on the edge. Entering elevated is decided by the pressure signal named on the line. Entering siege is decided by rejected/s crossing the siege rate and can print pressure=NONE - that is a capacity-reject storm rather than a resource problem, so read rejected/s there. A relaxation always prints pressure=NONE, because a run of quiet samples is what causes it. A posture that returns to normal on its own needs nothing; one that stays raised means the worker is undersized for the load or something is not shedding - the resource-growth line and the per-topic pressure entries cover that side.

## ADAPTER-ERR-RESOURCE-GROWTH

Severity: warn

Log line begins:

```
[ws] resource-growth auditor: 
```

**Cause.** A runtime structure the growth auditor samples has been trending upward across consecutive samples without shedding. The auditor is opt-in and off unless an audit interval is configured, so silence here means it is disabled just as often as it means nothing is growing.

**Consequence.** Nothing is refused - this is the early warning, and it is printed once per worker lifetime, so a trend that continues after it says nothing more. What the auditor has is a DIRECTION across consecutive samples, not a prediction: a trend that continues ends in memory pressure and eventually exhausts the heap, and one that levels off or starts shedding later never gets there. If it does continue, whether anything sheds before the end depends on configuration - the protection posture is opt-in, so on a default deployment there is no posture to raise. No worker is restarted on account of memory either, so what follows an exhausted heap is the process aborting rather than one thread being replaced.

**Automatic recovery.** None. The auditor observes; it does not evict.

**What to do.** The line names the structure. Find the path that stopped shedding for it - a close, unsubscribe or eviction that no longer runs - rather than raising a limit.

## ADAPTER-ERR-UPGRADE-DEFERRED

Severity: error

Log line begins:

```
[ws] a deferred upgrade failed
```

**Cause.** A WebSocket upgrade held back by the admission queue threw when it was finally completed, after the client had already passed admission.

**Consequence.** That one client never connects. Its response is left unfinished rather than refused, so it typically waits out its own timeout instead of seeing an error, and it retries as if the server were briefly unavailable. The admission slot it held is released, and the other upgrades in the same drain still run.

**Automatic recovery.** None for that connection; the client reconnects on its own schedule.

**What to do.** Read the error printed with this line. Its source cannot be your upgrade hook - the hook had already resolved before the completion was deferred; what runs here is the socket write, the upgrade handshake, the permit bookkeeping, and, on the fast path, the tracing hook. A repeated throw usually means sockets are dying in the queue before their turn comes - the admission backlog is holding upgrades longer than clients wait.

## ADAPTER-ERR-WAITING-ROOM-FALLBACK

Severity: error

Log line begins:

```
[svelte-adapter-ws] the waiting-room renderer failed; serving the built-in English page instead
```

**Cause.** The module named by `waitingRoom.renderer` threw, or returned a result the runtime could not accept, while rendering the over-capacity page.

**Consequence.** The visitor turned away by that request receives the built-in English page instead of the rendered one, so localization, branding and any per-request content are lost for it. The capacity decision itself is unaffected. The line prints once per worker, so a renderer that keeps failing reports only the first one.

**Automatic recovery.** The renderer is called again on the next request, so a failure that depends on the request self-heals; a renderer that always throws serves the built-in page every time.

**What to do.** Fix the renderer and redeploy. A renderer must return a complete document meeting the accessible baseline, which is validated on the first successful render rather than at build time; when the baseline is what failed the error printed with this line names the requirement, and for any other throw it is the renderer's own error.

