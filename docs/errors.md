# Adapter error reference

Every operator-facing failure the runtime can emit, indexed by its stable
`ADAPTER-ERR-*` id. Generated from `src/runtime/error-registry.js` by
`node scripts/render-error-docs.js`; edit the registry, not this file.

## ADAPTER-ERR-LISTEN

Severity: error

Log line begins:

```
[svelte-adapter-ws] runtime.listen.failed: Failed to bind 
```

**Cause.** The configured address or port could not be bound, or the process lacks permission.

**Consequence.** The process never becomes ready and exits with status 1.

**Automatic recovery.** None inside the process. If a process manager restarts it, the replacement retries the same bind and a persistent conflict fails the same way each time.

**What to do.** Check address availability, port conflicts, and bind permissions, then restart the process.

Further reading: https://svti.me/listen-failed

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

## ADAPTER-ERR-INVARIANT

Log line begins:

```
[lantean/diagnostic source=svelte-adapter-ws component=runtime.assertion event=invariant.violated severity=
```

**Cause.** A framework-internal assertion failed. The message is the assertion category and the severity is chosen by the call site, so both vary.

**Consequence.** Depends on the tier. A recorded violation appears in the platform.assertions map; a development-only assertion is logged and thrown WITHOUT being recorded there, so an empty map does not mean none fired. At the fatal tier the process is scheduled to exit with a dedicated status code.

**Automatic recovery.** None for the condition itself. A fatal-tier violation exits the process; recovery is the process manager restarting it.

**What to do.** Read the severity first, because it selects the tier and therefore the blast radius, then the category and context attributes. These are library-internal invariants, so a violation is an adapter defect rather than an application misconfiguration; report it with both attributes.

## ADAPTER-ERR-WARMUP-RENDER

Severity: warn

Log line begins:

```
[svelte-adapter-ws] runtime.warmup.render-failed: A boot warmup render failed; readiness proceeds without it.
```

**Cause.** Rendering a configured warmup path through the SSR engine during boot threw. The warmup runs the app's own server hooks and load functions for that path, so the throw is almost always in application boot-path code (a load that assumes a real request header, a resource not ready at boot), not in the adapter.

**Consequence.** That path is not pre-warmed, so the first real request to it after readiness pays the cold-render cost the warmup exists to remove. Nothing else is affected: readiness still commits and every other configured path still warms.

**Automatic recovery.** Yes. The first real request renders the path normally and warms it from then on; the warmup does not retry.

**What to do.** Read the attached error and the path it names. If the render depends on request context a warmup cannot supply, guard that code behind platform.isWarmupRequest, or drop the path from the warmup set. A warmup render that fails every boot means the path is not safely renderable without a real client.

## ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER

Severity: warn

Log line begins:

```
[svelte-adapter-ws] pressure.runaway-publisher: A publisher crossed a configured per-topic pressure threshold.
```

**Cause.** One topic exceeded its configured publish pressure threshold. The event is emitted only when no onPublishRate listener is registered, and it is latched per topic: one line when the topic crosses the threshold, re-armed only after the topic stays below it for a minute of consecutive samples.

**Consequence.** Nothing is dropped by this event alone. It is the early signal that one topic is consuming a disproportionate share of outbound capacity.

**Automatic recovery.** None. Nothing throttles the publisher on the strength of this threshold.

**What to do.** Identify the topic from the attributes and decide whether the rate is intended. The line is suppressed entirely while an onPublishRate listener is registered, so its absence is not evidence the condition ended - read platform.pressure for that. Left alone, a runaway publisher is what later produces slow-consumer disconnects on unrelated topics.

## ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY

Severity: warn

Log line begins:

```
[svelte-adapter-ws] the per-topic seq registry reached 
```

**Cause.** The number of distinct topics holding a live seq counter passed the warning threshold.

**Consequence.** Nothing is refused at this threshold. Topic bookkeeping grows with cardinality, so this is the memory-growth signal.

**Automatic recovery.** None. Cardinality is not reduced in response to the threshold.

**What to do.** Check whether topic names embed unbounded identifiers (per-user, per-request). The line fires once per process, so it will not tell you whether cardinality later fell or kept climbing - the naming scheme is what settles that. Unbounded cardinality is a slow leak rather than a spike, so act at the warning rather than at exhaustion.

## ADAPTER-ERR-RESUME-HOOK

Severity: error

Log line begins:

```
[svelte-adapter-ws] the resume hook threw
```

**Cause.** The application resume hook threw while answering a client GAP-FILL request, so some or all of the replay frames it owed were never sent. The same hook failing on the subscribe-time backfill is ADAPTER-ERR-RECOVER-HOOK instead.

**Consequence.** The client is still sent `resumed`, because that ack is not conditional on the hook. It therefore believes its gap was handled and reports nothing. Whether the history is actually recovered depends on whether the subscribe frames it sends next carry recover offsets; if they do not, the gap is permanent and silent on both sides.

**Automatic recovery.** None for the gap. No fallback subscribe is triggered by this failure - the client simply continues its normal sequence.

**What to do.** Fix the hook if resume coverage matters for these topics, and do not read a `resumed` ack as evidence a gap was filled. Clients that subscribe with recover offsets recover anyway; clients that do not are missing history without any signal.

## ADAPTER-ERR-AUTHENTICATE

Severity: error

Log line begins:

```
[svelte-adapter-ws] runtime.authenticate.failed: The WebSocket authentication endpoint failed.
```

**Cause.** The application `authenticate` export threw or rejected while answering its HTTP POST endpoint, which the client posts to before opening its WebSocket.

**Consequence.** That POST is answered 500. This is an ordinary HTTP route rather than the upgrade path, so no upgrade is refused and established connections are untouched; a client that treats the failed POST as fatal never goes on to open its WebSocket.

**Automatic recovery.** None for the failed request. The client may post again, which runs the hook again.

**What to do.** Read the attached error and requestId and fix the hook. Look at the authentication endpoint and its dependencies, not at the upgrade path: the two are separate routes and this event never comes from an upgrade.

## ADAPTER-ERR-SSR

Severity: error

Log line begins:

```
[svelte-adapter-ws] runtime.ssr.failed: SvelteKit request handling failed.
```

**Cause.** The SvelteKit server handler threw while rendering or handling a request.

**Consequence.** A failure before the response starts is answered with an error response. A response already streaming its body is aborted instead, so the client sees the truncation rather than a clean end that reads as a complete response. Other requests and WebSocket connections are unaffected.

**Automatic recovery.** None for the failed request.

**What to do.** Read the attached error. This is application rendering code rather than adapter transport, so the fault is normally in a route, hook, or load function.

## ADAPTER-ERR-UPGRADE-HOOK

Severity: error

Log line begins:

```
[svelte-adapter-ws] runtime.websocket-upgrade.failed: The WebSocket upgrade hook failed.
```

**Cause.** The application upgrade hook threw while a client was being upgraded.

**Consequence.** That upgrade does not complete and the client cannot open its WebSocket.

**Automatic recovery.** None. The client retries by reconnecting, which runs the hook again.

**What to do.** Read the attached error and fix the hook. Persistent failure presents to users as a connection that never establishes, while HTTP continues to work.

## ADAPTER-ERR-ATTRIBUTION

Severity: error

Log line begins:

```
[svelte-adapter-ws] runtime.websocket-attribution.failed: The WebSocket attribution hook failed; the connection was refused at open.
```

**Cause.** The handler module's `attribution` export threw, returned a promise, returned a misshaped result, or returned an id outside the allowed form (a string of [a-zA-Z0-9_-], at most 64 characters).

**Consequence.** That connection is closed with code 1008 before the application open hook runs. Attribution is fail-closed: a connection that cannot be attributed is refused rather than admitted unattributed, because an unattributed admission would silently stand down every tenant-scoped limit that reads the attribution.

**Automatic recovery.** None for that connection. The client may reconnect, which runs the resolver again against a fresh userData.

**What to do.** Read the attached error and fix the `attribution` export: return { tenantId?, principalId?, entitlement? } synchronously - each present value a string of [a-zA-Z0-9_-] with 1-64 characters - or null/undefined for an unattributed connection. Resolve identity itself in the upgrade hook; attribution only derives from the userData that hook produced.

## ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK

Severity: error

Log line begins:

```
[svelte-adapter-ws] the subscribeBatch hook threw
```

**Cause.** The application subscribeBatch authorization hook threw.

**Consequence.** Every topic in that batch is denied with INTERNAL_ERROR. Authorization is fail-closed, so a throwing hook denies rather than admits.

**Automatic recovery.** None. The client may retry the subscribe, which runs the hook again.

**What to do.** Fix the hook. Because one throw denies the whole batch, a fault touching a single topic presents as a client that can subscribe to nothing.

## ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT

Severity: error

Log line begins:

```
[svelte-adapter-ws] reading the subscribeBatch result threw
```

**Cause.** The subscribeBatch hook returned a value whose properties threw while being read, typically a getter or a proxy.

**Consequence.** Every topic in that batch is denied with INTERNAL_ERROR, exactly as though the hook itself had thrown.

**Automatic recovery.** None. The client may retry the subscribe.

**What to do.** Return a plain object keyed by topic from the hook, and keep property reads on it free of side effects. An array is not that shape: its entries are read back under index keys, so its denials name topics like 0 and 1 and every real topic in the batch is silently allowed.

## ADAPTER-ERR-SUBSCRIBE-HOOK

Severity: error

Log line begins:

```
[svelte-adapter-ws] the subscribe hook threw
```

**Cause.** The application subscribe authorization hook threw for a single topic.

**Consequence.** That subscribe is denied with INTERNAL_ERROR. Authorization is fail-closed, and the reason is deliberately distinct: returning false denies with FORBIDDEN, so a throw is reported as a fault rather than as a refusal.

**Automatic recovery.** None. The client may retry the subscribe, which runs the hook again.

**What to do.** Read the attached error and fix the hook. A client seeing INTERNAL_ERROR rather than FORBIDDEN or UNAUTHENTICATED is being told this is a defect, not a permissions decision, so treat it as one and do not go looking at authorization rules first.

## ADAPTER-ERR-TLS-RELOAD-SKIPPED

Severity: warn

Log line begins:

```
[svelte-adapter-ws] [tls] certificate reload failed; serving the previous certificate
```

**Cause.** A certificate change was seen on disk but not applied, usually because the new material was unreadable or incomplete at the moment it was read.

**Consequence.** The server keeps serving the previous certificate. The renewal on disk is not in use, so the served certificate can expire while a valid one sits unread. READINESS PROBES STAY GREEN throughout, which is what makes this quiet.

**Automatic recovery.** The next watcher event retries the reload; a clean read applies the renewal.

**What to do.** Confirm the served certificate matches the one on disk rather than assuming renewal succeeded - the probe cannot see this. Treat the warning as expiry risk, not noise.

## ADAPTER-ERR-TLS-WATCH

Severity: error

Log line begins:

```
[svelte-adapter-ws] [tls] certificate watch 
```

**Cause.** The filesystem watch on a certificate directory could not be established, or errored after arming (directory removed, permissions).

**Consequence.** Certificate hot reload is off until restart; the served certificate stays on its current bytes. A renewal landing later is never picked up, and the failure surfaces much later as an expired certificate.

**Automatic recovery.** None: the watch is not retried, so this does not resolve without a restart.

**What to do.** Fix the path or permissions and restart the process. Until then, treat certificate renewal as requiring a restart, and alert on certificate expiry independently.

## ADAPTER-ERR-CLUSTER-CONFIG-WORKERS

Severity: fatal

Log line begins:

```
[svelte-adapter-ws] CLUSTER_WORKERS is not supported by this adapter.
```

**Cause.** CLUSTER_WORKERS is set, but this adapter ships no in-process supervisor: multi-core runs one process per core under the platform process manager, with cross-instance fan-out through the extensions relay.

**Consequence.** The process exits before listening; the service never comes up. Refusing beats silently running one worker where the deployment expected N.

**Automatic recovery.** None. Startup configuration is validated once, at boot.

**What to do.** Unset CLUSTER_WORKERS and run one process per core under your process manager (systemd template units, PM2, container replicas) behind a load balancer.

## ADAPTER-ERR-SHUTDOWN-LISTENER-THREW

Severity: error

Log line begins:

```
[svelte-adapter-ws] a sveltekit:shutdown listener failed
```

**Cause.** A sveltekit:shutdown listener threw or rejected during shutdown; each listener is awaited, so both land here.

**Consequence.** That listener's cleanup did not complete. The throw is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.

**Automatic recovery.** Not applicable; shutdown proceeds without the failed cleanup.

**What to do.** Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.

## ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED

Severity: error

Log line begins:

```
[svelte-adapter-ws] in-flight requests did not finish within the shutdown budget; closing 
```

**Cause.** In-flight HTTP requests were still open when the configured shutdown budget expired.

**Consequence.** The remaining open requests are dropped as the sockets close; their clients see resets. The drop is bounded and deliberate: the budget exists so a wedged request cannot hold the process open.

**Automatic recovery.** Not applicable; shutdown proceeds by design.

**What to do.** Raise SHUTDOWN_TIMEOUT if legitimate requests need longer to drain, or find the handler that never finished. SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.

## ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED

Severity: error

Log line begins:

```
[svelte-adapter-ws] shutdown cleanup exceeded the budget; draining now
```

**Cause.** sveltekit:shutdown listeners or the ws shutdown hook were still pending when the cleanup budget expired.

**Consequence.** The drain proceeds with that cleanup unfinished: final writes and teardowns still pending did not complete before the exit.

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

**What to do.** Fix the hook, then check whatever it was flushing for state left behind. The hook is awaited with { platform } during the drain and shares the shutdown cleanup budget, so long-running flushes must finish inside it.

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

