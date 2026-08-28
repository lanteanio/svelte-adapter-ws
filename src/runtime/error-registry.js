/**
 * Stable search keys for operator-facing adapter failures. Keep messagePrefix
 * equal to the invariant beginning of the emitted text; dynamic host, path,
 * timeout, or native-loader details follow it at runtime.
 *
 * `emission` says which shape the runtime actually produces, because they differ
 * and a prefix that never appears in a log is worse than no prefix:
 *
 * - `thrown`   - an Error message with no diagnostic line around it.
 * - `composed` - emitOperationalDiagnostic(), whose message reads
 *                `<event>: <problem>` inside the diagnostic line.
 * - `direct`   - emitOperationalEvent() with a literal message, so the line
 *                carries the message with no event repetition.
 * - `head`     - only the line head is invariant; severity and message vary by
 *                call site, so the prefix stops where the variation begins.
 * - `console`  - a plain console line with no diagnostic head, printed through
 *                adapterConsoleLine() so the emitted text IS the registry's
 *                prefix plus the call-site detail and the stable ID tag. These
 *                are the consequential failures that never enter the
 *                diagnostic-event pipeline (primary-thread and once-per-worker
 *                guidance lines), indexed so the text an operator saw resolves
 *                here like every other failure.
 */
export const ADAPTER_ERROR_IDS = Object.freeze({
	LISTEN: 'ADAPTER-ERR-LISTEN',
	REQUEST_TIMEOUT: 'ADAPTER-ERR-REQUEST-TIMEOUT',
	REQUEST_CLOSED: 'ADAPTER-ERR-REQUEST-CLOSED',
	INVARIANT: 'ADAPTER-ERR-INVARIANT',
	WARMUP_RENDER: 'ADAPTER-ERR-WARMUP-RENDER',
	PRESSURE_RUNAWAY_PUBLISHER: 'ADAPTER-ERR-PRESSURE-RUNAWAY-PUBLISHER',
	PRESSURE_TOPIC_REGISTRY: 'ADAPTER-ERR-PRESSURE-TOPIC-REGISTRY',
	RESUME_HOOK: 'ADAPTER-ERR-RESUME-HOOK',
	AUTHENTICATE: 'ADAPTER-ERR-AUTHENTICATE',
	SSR: 'ADAPTER-ERR-SSR',
	UPGRADE_HOOK: 'ADAPTER-ERR-UPGRADE-HOOK',
	ATTRIBUTION_HOOK: 'ADAPTER-ERR-ATTRIBUTION',
	SUBSCRIBE_BATCH_HOOK: 'ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK',
	SUBSCRIBE_BATCH_RESULT: 'ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT',
	SUBSCRIBE_HOOK: 'ADAPTER-ERR-SUBSCRIBE-HOOK',
	TLS_RELOAD_SKIPPED: 'ADAPTER-ERR-TLS-RELOAD-SKIPPED',
	TLS_WATCH: 'ADAPTER-ERR-TLS-WATCH',
	CLUSTER_CONFIG_WORKERS: 'ADAPTER-ERR-CLUSTER-CONFIG-WORKERS',
	SHUTDOWN_LISTENER_THREW: 'ADAPTER-ERR-SHUTDOWN-LISTENER-THREW',
	SHUTDOWN_REQUESTS_DROPPED: 'ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED',
	SHUTDOWN_LISTENERS_UNSETTLED: 'ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED',
	SHUTDOWN_FAILED: 'ADAPTER-ERR-SHUTDOWN-FAILED',
	SENDTO_ASYNC_FILTER: 'ADAPTER-ERR-SENDTO-ASYNC-FILTER',
	WS_SHUTDOWN_HOOK_THREW: 'ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW',
	MESSAGE_HOOK: 'ADAPTER-ERR-MESSAGE-HOOK',
	RECOVER_HOOK: 'ADAPTER-ERR-RECOVER-HOOK',
	POSTURE_OBSERVER: 'ADAPTER-ERR-POSTURE-OBSERVER'
});

const HEAD = '[lantean/diagnostic source=svelte-adapter-ws component=';

/** Builds the invariant head of a directly-emitted diagnostic line. */
function direct(component, event, severity, message) {
	return HEAD + component + ' event=' + event + ' severity=' + severity + '] ' + message;
}

export const ADAPTER_ERROR_REGISTRY = Object.freeze([
	Object.freeze({
		id: ADAPTER_ERROR_IDS.LISTEN,
		code: 'LISTEN_FAILED',
		event: 'runtime.listen.failed',
		component: 'runtime.listener',
		severity: 'fatal',
		emission: 'composed',
		problemPrefix: 'Could not bind the server listener on',
		messagePrefix: '[lantean/diagnostic source=svelte-adapter-ws component=runtime.listener event=runtime.listen.failed severity=fatal] runtime.listen.failed: Could not bind the server listener on',
		cause: 'The configured address or port could not be bound, or the process lacks permission.',
		consequence: 'The process never becomes ready and exits with status 1.',
		automaticRecovery: 'None inside the process. If a process manager restarts it, the replacement retries the same bind and a persistent conflict fails the same way each time.',
		nextAction: 'Check address availability, port conflicts, and bind permissions, then restart the process.',
		sources: Object.freeze(['src/runtime/index.js', 'src/runtime/handler/lifecycle.js']),
		anchor: 'adapter-err-listen',
		help: 'docs/errors.md#adapter-err-listen',
		link: 'https://svti.me/listen-failed'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.REQUEST_TIMEOUT,
		code: null,
		event: 'websocket.request.timeout',
		component: null,
		severity: null,
		emission: 'thrown',
		problemPrefix: null,
		messagePrefix: 'request timed out',
		cause: 'A platform.request reply did not arrive within timeoutMs; the recipient may already have executed the request.',
		consequence: 'The caller promise rejects while the remote operation outcome remains unknown.',
		automaticRecovery: 'None. The adapter does not retry requests because replay may duplicate an operation.',
		nextAction: 'Reconcile application state first, or retry only through an idempotent operation; then investigate the handler, connection, and measured timeout budget.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-request-timeout',
		help: 'docs/errors.md#adapter-err-request-timeout',
		link: 'https://svti.me/request-timeout'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.REQUEST_CLOSED,
		code: null,
		event: 'websocket.request.connection-closed',
		component: null,
		severity: null,
		emission: 'thrown',
		problemPrefix: null,
		messagePrefix: 'connection closed',
		cause: 'The target WebSocket closed around a platform.request - before the request frame could be sent at all, or with the frame already handed to the transport and unanswered.',
		consequence: 'The caller promise rejects. The rejection detail names which side of transmission the close landed on: a frame that was never sent leaves the remote outcome known - nothing was requested - while a frame handed to the transport leaves it unknown.',
		automaticRecovery: 'None. The adapter does not retry requests because replay may duplicate an operation.',
		nextAction: 'Read the rejection detail first. A request whose frame was never sent is safe to retry as-is once the connection recovers; a sent but unanswered request must be reconciled or retried only through an idempotent operation.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-request-closed',
		help: 'docs/errors.md#adapter-err-request-closed',
		link: 'https://svti.me/request-closed'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.INVARIANT,
		code: null,
		event: 'invariant.violated',
		component: 'runtime.assertion',
		severity: null,
		emission: 'head',
		problemPrefix: null,
		messagePrefix: HEAD + 'runtime.assertion event=invariant.violated severity=',
		cause: 'A framework-internal assertion failed. The message is the assertion category and the severity is chosen by the call site, so both vary.',
		consequence: 'Depends on the tier. A recorded violation appears in the platform.assertions map; a development-only assertion is logged and thrown WITHOUT being recorded there, so an empty map does not mean none fired. At the fatal tier the process is scheduled to exit with a dedicated status code.',
		automaticRecovery: 'None for the condition itself. A fatal-tier violation exits the process; recovery is the process manager restarting it.',
		nextAction: 'Read the severity first, because it selects the tier and therefore the blast radius, then the category and context attributes. These are library-internal invariants, so a violation is an adapter defect rather than an application misconfiguration; report it with both attributes.',
		sources: Object.freeze(['src/runtime/utils/assertions.js']),
		anchor: 'adapter-err-invariant',
		help: 'docs/errors.md#adapter-err-invariant'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.WARMUP_RENDER,
		code: null,
		event: 'runtime.warmup.render-failed',
		component: 'runtime.warmup',
		severity: 'warn',
		emission: 'direct',
		problemPrefix: 'A boot warmup render failed; readiness proceeds without it.',
		messagePrefix: direct('runtime.warmup', 'runtime.warmup.render-failed', 'warn', 'A boot warmup render failed; readiness proceeds without it.'),
		cause: 'Rendering a configured warmup path through the SSR engine during boot threw. The warmup runs the app\'s own server hooks and load functions for that path, so the throw is almost always in application boot-path code (a load that assumes a real request header, a resource not ready at boot), not in the adapter.',
		consequence: 'That path is not pre-warmed, so the first real request to it after readiness pays the cold-render cost the warmup exists to remove. Nothing else is affected: readiness still commits and every other configured path still warms.',
		automaticRecovery: 'Yes. The first real request renders the path normally and warms it from then on; the warmup does not retry.',
		nextAction: 'Read the attached error and the path it names. If the render depends on request context a warmup cannot supply, guard that code behind platform.isWarmupRequest, or drop the path from the warmup set. A warmup render that fails every boot means the path is not safely renderable without a real client.',
		sources: Object.freeze(['src/runtime/handler/warmup.js']),
		anchor: 'adapter-err-warmup-render',
		help: 'docs/errors.md#adapter-err-warmup-render'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.PRESSURE_RUNAWAY_PUBLISHER,
		code: null,
		event: 'pressure.runaway-publisher',
		component: 'runtime.pressure',
		severity: 'warn',
		emission: 'direct',
		problemPrefix: 'A publisher crossed a configured per-topic pressure threshold.',
		messagePrefix: direct('runtime.pressure', 'pressure.runaway-publisher', 'warn', 'A publisher crossed a configured per-topic pressure threshold.'),
		cause: 'One topic exceeded its configured publish pressure threshold. The event is emitted only when no onPublishRate listener is registered, and it is latched per topic: one line when the topic crosses the threshold, re-armed only after that topic falls back below it.',
		consequence: 'Nothing is dropped by this event alone. It is the early signal that one topic is consuming a disproportionate share of outbound capacity.',
		automaticRecovery: 'None. Nothing throttles the publisher on the strength of this threshold.',
		nextAction: 'Identify the topic from the attributes and decide whether the rate is intended. The line is suppressed entirely while an onPublishRate listener is registered, so its absence is not evidence the condition ended - read platform.pressure for that. Left alone, a runaway publisher is what later produces slow-consumer disconnects on unrelated topics.',
		sources: Object.freeze(['src/runtime/handler/pressure.js']),
		anchor: 'adapter-err-pressure-runaway-publisher',
		help: 'docs/errors.md#adapter-err-pressure-runaway-publisher'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.PRESSURE_TOPIC_REGISTRY,
		code: null,
		event: 'pressure.topic-registry-high',
		component: null,
		severity: 'warn',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] the per-topic seq registry reached ',
		cause: 'The number of distinct topics holding a live seq counter passed the warning threshold.',
		consequence: 'Nothing is refused at this threshold. Topic bookkeeping grows with cardinality, so this is the memory-growth signal.',
		automaticRecovery: 'None. Cardinality is not reduced in response to the threshold.',
		nextAction: 'Check whether topic names embed unbounded identifiers (per-user, per-request). The line fires once per process, so it will not tell you whether cardinality later fell or kept climbing - the naming scheme is what settles that. Unbounded cardinality is a slow leak rather than a spike, so act at the warning rather than at exhaustion.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-pressure-topic-registry',
		help: 'docs/errors.md#adapter-err-pressure-topic-registry'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.RESUME_HOOK,
		code: null,
		event: 'resume.hook-failed',
		component: 'runtime.resume',
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] the resume hook threw',
		cause: 'The application resume hook threw while answering a client GAP-FILL request, so some or all of the replay frames it owed were never sent. The same hook failing on the subscribe-time backfill is ADAPTER-ERR-RECOVER-HOOK instead.',
		consequence: 'The client is still sent `resumed`, because that ack is not conditional on the hook. It therefore believes its gap was handled and reports nothing. Whether the history is actually recovered depends on whether the subscribe frames it sends next carry recover offsets; if they do not, the gap is permanent and silent on both sides.',
		automaticRecovery: 'None for the gap. No fallback subscribe is triggered by this failure - the client simply continues its normal sequence.',
		nextAction: 'Fix the hook if resume coverage matters for these topics, and do not read a `resumed` ack as evidence a gap was filled. Clients that subscribe with recover offsets recover anyway; clients that do not are missing history without any signal.',
		sources: Object.freeze(['src/runtime/handler/realtime.js']),
		anchor: 'adapter-err-resume-hook',
		help: 'docs/errors.md#adapter-err-resume-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.AUTHENTICATE,
		code: null,
		event: 'runtime.authenticate.failed',
		component: 'runtime.authenticate',
		severity: 'error',
		emission: 'direct',
		problemPrefix: 'The WebSocket authentication endpoint failed.',
		messagePrefix: direct('runtime.authenticate', 'runtime.authenticate.failed', 'error', 'The WebSocket authentication endpoint failed.'),
		cause: 'The application `authenticate` export threw or rejected while answering its HTTP POST endpoint, which the client posts to before opening its WebSocket.',
		consequence: 'That POST is answered 500. This is an ordinary HTTP route rather than the upgrade path, so no upgrade is refused and established connections are untouched; a client that treats the failed POST as fatal never goes on to open its WebSocket.',
		automaticRecovery: 'None for the failed request. The client may post again, which runs the hook again.',
		nextAction: 'Read the attached error and requestId and fix the hook. Look at the authentication endpoint and its dependencies, not at the upgrade path: the two are separate routes and this event never comes from an upgrade.',
		sources: Object.freeze(['src/runtime/handler.js']),
		anchor: 'adapter-err-authenticate',
		help: 'docs/errors.md#adapter-err-authenticate'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SSR,
		code: null,
		event: 'runtime.ssr.failed',
		component: 'runtime.ssr',
		severity: 'error',
		emission: 'direct',
		problemPrefix: 'SvelteKit request handling failed.',
		messagePrefix: direct('runtime.ssr', 'runtime.ssr.failed', 'error', 'SvelteKit request handling failed.'),
		cause: 'The SvelteKit server handler threw while rendering or handling a request.',
		consequence: 'A failure before the response starts is answered with an error response. A response already streaming its body is aborted instead, so the client sees the truncation rather than a clean end that reads as a complete response. Other requests and WebSocket connections are unaffected.',
		automaticRecovery: 'None for the failed request.',
		nextAction: 'Read the attached error. This is application rendering code rather than adapter transport, so the fault is normally in a route, hook, or load function.',
		sources: Object.freeze(['src/runtime/handler/ssr.js']),
		anchor: 'adapter-err-ssr',
		help: 'docs/errors.md#adapter-err-ssr'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.UPGRADE_HOOK,
		code: null,
		event: 'runtime.websocket-upgrade.failed',
		component: 'runtime.websocket-upgrade',
		severity: 'error',
		emission: 'direct',
		problemPrefix: 'The WebSocket upgrade hook failed.',
		messagePrefix: direct('runtime.websocket-upgrade', 'runtime.websocket-upgrade.failed', 'error', 'The WebSocket upgrade hook failed.'),
		cause: 'The application upgrade hook threw while a client was being upgraded.',
		consequence: 'That upgrade does not complete and the client cannot open its WebSocket.',
		automaticRecovery: 'None. The client retries by reconnecting, which runs the hook again.',
		nextAction: 'Read the attached error and fix the hook. Persistent failure presents to users as a connection that never establishes, while HTTP continues to work.',
		sources: Object.freeze(['src/runtime/handler.js']),
		anchor: 'adapter-err-upgrade-hook',
		help: 'docs/errors.md#adapter-err-upgrade-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.ATTRIBUTION_HOOK,
		code: null,
		event: 'runtime.websocket-attribution.failed',
		component: 'runtime.websocket-attribution',
		severity: 'error',
		emission: 'direct',
		problemPrefix: 'The WebSocket attribution hook failed; the connection was refused at open.',
		messagePrefix: direct('runtime.websocket-attribution', 'runtime.websocket-attribution.failed', 'error', 'The WebSocket attribution hook failed; the connection was refused at open.'),
		cause: 'The handler module\'s `attribution` export threw, returned a promise, returned a misshaped result, or returned an id outside the allowed form (a string of [a-zA-Z0-9_-], at most 64 characters).',
		consequence: 'That connection is closed with code 1008 before the application open hook runs. Attribution is fail-closed: a connection that cannot be attributed is refused rather than admitted unattributed, because an unattributed admission would silently stand down every tenant-scoped limit that reads the attribution.',
		automaticRecovery: 'None for that connection. The client may reconnect, which runs the resolver again against a fresh userData.',
		nextAction: 'Read the attached error and fix the `attribution` export: return { tenantId?, principalId?, entitlement? } synchronously - each present value a string of [a-zA-Z0-9_-] with 1-64 characters - or null/undefined for an unattributed connection. Resolve identity itself in the upgrade hook; attribution only derives from the userData that hook produced.',
		sources: Object.freeze(['src/runtime/handler.js']),
		anchor: 'adapter-err-attribution',
		help: 'docs/errors.md#adapter-err-attribution'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_HOOK,
		code: null,
		event: 'subscribe.batch-hook-failed',
		component: 'runtime.subscribe',
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] the subscribeBatch hook threw',
		cause: 'The application subscribeBatch authorization hook threw.',
		consequence: 'Every topic in that batch is denied with INTERNAL_ERROR. Authorization is fail-closed, so a throwing hook denies rather than admits.',
		automaticRecovery: 'None. The client may retry the subscribe, which runs the hook again.',
		nextAction: 'Fix the hook. Because one throw denies the whole batch, a fault touching a single topic presents as a client that can subscribe to nothing.',
		sources: Object.freeze(['src/runtime/handler/platform.js', 'src/runtime/handler/realtime.js']),
		anchor: 'adapter-err-subscribe-batch-hook',
		help: 'docs/errors.md#adapter-err-subscribe-batch-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_RESULT,
		code: null,
		event: 'subscribe.batch-result-read-failed',
		component: 'runtime.subscribe',
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] reading the subscribeBatch result threw',
		cause: 'The subscribeBatch hook returned a value whose properties threw while being read, typically a getter or a proxy.',
		consequence: 'Every topic in that batch is denied with INTERNAL_ERROR, exactly as though the hook itself had thrown.',
		automaticRecovery: 'None. The client may retry the subscribe.',
		nextAction: 'Return a plain object keyed by topic from the hook, and keep property reads on it free of side effects. An array is not that shape: its entries are read back under index keys, so its denials name topics like 0 and 1 and every real topic in the batch is silently allowed.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-subscribe-batch-result',
		help: 'docs/errors.md#adapter-err-subscribe-batch-result'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SUBSCRIBE_HOOK,
		code: null,
		event: 'subscribe.hook-failed',
		component: 'runtime.subscribe',
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] the subscribe hook threw',
		cause: 'The application subscribe authorization hook threw for a single topic.',
		consequence: 'That subscribe is denied with INTERNAL_ERROR. Authorization is fail-closed, and the reason is deliberately distinct: returning false denies with FORBIDDEN, so a throw is reported as a fault rather than as a refusal.',
		automaticRecovery: 'None. The client may retry the subscribe, which runs the hook again.',
		nextAction: 'Read the attached error and fix the hook. A client seeing INTERNAL_ERROR rather than FORBIDDEN or UNAUTHENTICATED is being told this is a defect, not a permissions decision, so treat it as one and do not go looking at authorization rules first.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-subscribe-hook',
		help: 'docs/errors.md#adapter-err-subscribe-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.TLS_RELOAD_SKIPPED,
		code: null,
		event: 'tls.reload-skipped',
		component: 'runtime.tls',
		severity: 'warn',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] [tls] certificate reload failed; serving the previous certificate',
		cause: 'A certificate change was seen on disk but not applied, usually because the new material was unreadable or incomplete at the moment it was read.',
		consequence: 'The server keeps serving the previous certificate. The renewal on disk is not in use, so the served certificate can expire while a valid one sits unread. READINESS PROBES STAY GREEN throughout, which is what makes this quiet.',
		automaticRecovery: 'The next watcher event retries the reload; a clean read applies the renewal.',
		nextAction: 'Confirm the served certificate matches the one on disk rather than assuming renewal succeeded - the probe cannot see this. Treat the warning as expiry risk, not noise.',
		sources: Object.freeze(['src/runtime/handler/tls.js']),
		anchor: 'adapter-err-tls-reload-skipped',
		help: 'docs/errors.md#adapter-err-tls-reload-skipped'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.TLS_WATCH,
		code: null,
		event: 'tls.watch-failed',
		component: 'runtime.tls',
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] [tls] certificate watch ',
		cause: 'The filesystem watch on a certificate directory could not be established, or errored after arming (directory removed, permissions).',
		consequence: 'Certificate hot reload is off until restart; the served certificate stays on its current bytes. A renewal landing later is never picked up, and the failure surfaces much later as an expired certificate.',
		automaticRecovery: 'None: the watch is not retried, so this does not resolve without a restart.',
		nextAction: 'Fix the path or permissions and restart the process. Until then, treat certificate renewal as requiring a restart, and alert on certificate expiry independently.',
		sources: Object.freeze(['src/runtime/handler/tls.js']),
		anchor: 'adapter-err-tls-watch',
		help: 'docs/errors.md#adapter-err-tls-watch'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.CLUSTER_CONFIG_WORKERS,
		code: null,
		event: 'cluster.config.unsupported',
		component: null,
		severity: 'fatal',
		emission: 'thrown',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] CLUSTER_WORKERS is not supported by this adapter.',
		cause: 'CLUSTER_WORKERS is set, but this adapter ships no in-process supervisor: multi-core runs one process per core under the platform process manager, with cross-instance fan-out through the extensions relay.',
		consequence: 'The process exits before listening; the service never comes up. Refusing beats silently running one worker where the deployment expected N.',
		automaticRecovery: 'None. Startup configuration is validated once, at boot.',
		nextAction: 'Unset CLUSTER_WORKERS and run one process per core under your process manager (systemd template units, PM2, container replicas) behind a load balancer.',
		sources: Object.freeze(['src/runtime/index.js']),
		anchor: 'adapter-err-cluster-config-workers',
		help: 'docs/errors.md#adapter-err-cluster-config-workers'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SHUTDOWN_LISTENER_THREW,
		code: null,
		event: 'shutdown.listener-threw',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] a sveltekit:shutdown listener failed',
		cause: 'A sveltekit:shutdown listener threw or rejected during shutdown; each listener is awaited, so both land here.',
		consequence: "That listener's cleanup did not complete. The throw is contained: remaining listeners still run, shutdown proceeds, and the exit is not held.",
		automaticRecovery: 'Not applicable; shutdown proceeds without the failed cleanup.',
		nextAction: 'Fix the listener, and check whatever it was tearing down (pools, final writes) for leaked state, because that teardown did not happen.',
		sources: Object.freeze(['src/runtime/index.js']),
		anchor: 'adapter-err-shutdown-listener-threw',
		help: 'docs/errors.md#adapter-err-shutdown-listener-threw'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SHUTDOWN_REQUESTS_DROPPED,
		code: null,
		event: 'shutdown.requests-dropped',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] in-flight requests did not finish within the shutdown budget; closing ',
		cause: 'In-flight HTTP requests were still open when the configured shutdown budget expired.',
		consequence: 'The remaining open requests are dropped as the sockets close; their clients see resets. The drop is bounded and deliberate: the budget exists so a wedged request cannot hold the process open.',
		automaticRecovery: 'Not applicable; shutdown proceeds by design.',
		nextAction: 'Raise SHUTDOWN_TIMEOUT if legitimate requests need longer to drain, or find the handler that never finished. SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.',
		sources: Object.freeze(['src/runtime/handler/lifecycle.js']),
		anchor: 'adapter-err-shutdown-requests-dropped',
		help: 'docs/errors.md#adapter-err-shutdown-requests-dropped'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SHUTDOWN_LISTENERS_UNSETTLED,
		code: null,
		event: 'shutdown.listeners-unsettled',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] shutdown cleanup exceeded the budget; draining now',
		cause: 'sveltekit:shutdown listeners or the ws shutdown hook were still pending when the cleanup budget expired.',
		consequence: 'The drain proceeds with that cleanup unfinished: final writes and teardowns still pending did not complete before the exit.',
		automaticRecovery: 'Not applicable; the budget exists so a wedged listener cannot hold the exit.',
		nextAction: 'Make the listener finish within the budget or raise SHUTDOWN_TIMEOUT; SHUTDOWN_TIMEOUT=0 removes the budget entirely and waits forever.',
		sources: Object.freeze(['src/runtime/index.js']),
		anchor: 'adapter-err-shutdown-listeners-unsettled',
		help: 'docs/errors.md#adapter-err-shutdown-listeners-unsettled'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SHUTDOWN_FAILED,
		code: null,
		event: 'shutdown.failed',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[svelte-adapter-ws] graceful shutdown failed',
		cause: 'The graceful shutdown sequence itself threw. Every application-supplied input is contained behind its own entry (a throwing ws shutdown hook, a rejecting or wedged sveltekit:shutdown listener, an overrunning drain), so this line means the sequence\'s own machinery raised - an adapter defect, or an application-side patch of a global the sequence reads, such as an instrumentation layer\'s rewrap of process or EventEmitter internals throwing when the listener list is read.',
		consequence: 'The orderly steps after the throw were skipped, so the shutdown was not clean; the process still exits rather than hanging.',
		automaticRecovery: 'Not applicable.',
		nextAction: 'Read the attached error. A stack through application instrumentation points at a broken global patch; anything else is adapter-owned and worth reporting with the attached error.',
		sources: Object.freeze(['src/runtime/index.js']),
		anchor: 'adapter-err-shutdown-failed',
		help: 'docs/errors.md#adapter-err-shutdown-failed'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.SENDTO_ASYNC_FILTER,
		code: null,
		event: 'ws.sendto.async-filter-refused',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[ws] platform.sendTo filter returned a Promise; treating as fail-closed.',
		cause: 'A platform.sendTo filter returned a Promise. The filter must be synchronous, because sendTo iterates every active connection in one pass.',
		consequence: 'Every connection whose filter returns a Promise is skipped - fail-closed - on this and every later sendTo call, so the targeted delivery silently reaches nobody the filter cannot answer synchronously. The warning prints once per process.',
		automaticRecovery: 'None. The filter stays fail-closed until the code is fixed.',
		nextAction: 'Resolve the fields the filter needs into userData in your upgrade hook so the filter can read them synchronously.',
		sources: Object.freeze(['src/runtime/handler/platform.js']),
		anchor: 'adapter-err-sendto-async-filter',
		help: 'docs/errors.md#adapter-err-sendto-async-filter',
		link: 'https://svti.me/sendto-async'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_THREW,
		code: null,
		event: 'ws.shutdown-hook.threw',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[ws] the WebSocket shutdown hook threw',
		cause: 'The `shutdown` export of the WebSocket handler threw synchronously or rejected while the server was closing.',
		consequence: "Whatever that hook was flushing did not finish - final writes, external deregistration, or draining a queue. The throw is contained and the teardown carries on regardless, so the loss is silent unless this line is read. The same line prints for the same hook on all three surfaces: under the production runtime and createTestServer the listen socket closes after the hook, and on the dev server the hook runs from the server's own close event, so the socket is already gone by then.",
		automaticRecovery: 'None. Shutdown is best-effort and proceeds without the hook.',
		nextAction: "Fix the hook, then check whatever it was flushing for state left behind. Under the production runtime and createTestServer the hook is handed a `signal` it can watch to give up cleanly instead of throwing - but only when a shutdown budget is configured, and it is null without one. The dev server passes no such field at all, so a hook that reads it must tolerate undefined.",
		sources: Object.freeze(['src/runtime/handler/lifecycle.js']),
		anchor: 'adapter-err-ws-shutdown-hook-threw',
		help: 'docs/errors.md#adapter-err-ws-shutdown-hook-threw'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.MESSAGE_HOOK,
		code: null,
		event: 'ws.message-hook.threw',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[ws] the message hook threw',
		cause: 'The application or plugin `message` hook threw or rejected while handling a client frame.',
		consequence: "That client's connection is closed with code 1011 and the reason `Message handler error`; the cause stays server-side and is not sent to the client. Other connections are unaffected. A client that reconnects and replays the same frame is closed again.",
		automaticRecovery: 'None for the frame. The client sees a close, and reconnection is the client library\'s own resume path.',
		nextAction: 'Fix the hook, or catch inside it and answer the client deliberately. The error printed with this line is the original throw.',
		sources: Object.freeze(['src/runtime/utils/hook-boundary.js']),
		anchor: 'adapter-err-message-hook',
		help: 'docs/errors.md#adapter-err-message-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.RECOVER_HOOK,
		code: null,
		event: 'ws.recover-hook.threw',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[ws] the recover-on-subscribe hook threw',
		cause: 'The `resume` hook threw on the RECOVER-ON-SUBSCRIBE path - a client subscribing to a topic the server was asked to backfill - so the backlog that subscription should have replayed could not be produced. The same hook failing on a client resume frame is ADAPTER-ERR-RESUME-HOOK instead.',
		consequence: "The subscription itself still completes: the client is subscribed and receives live frames from that moment on, but the events it missed before subscribing are not delivered and no gap is reported to it. It looks like a working subscription with a hole at the start.",
		automaticRecovery: 'None. Live delivery continues; the missed range is not retried.',
		nextAction: 'Fix the hook or make it fail closed for the topics it cannot serve. A hook that throws for a topic it does not own should return an empty result for it instead.',
		sources: Object.freeze(['src/runtime/handler.js']),
		anchor: 'adapter-err-recover-hook',
		help: 'docs/errors.md#adapter-err-recover-hook'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.POSTURE_OBSERVER,
		code: null,
		event: 'ws.posture-observer.threw',
		component: null,
		severity: 'error',
		emission: 'console',
		problemPrefix: null,
		messagePrefix: '[ws] a posture transition handler threw',
		cause: "The adapter's own protection-posture transition handler threw. It records the transition metric, prints the posture line, then pushes the new posture to the export socket. The metric is contained and the export push contains its own failures, so what remains is the console write.",
		consequence: "The posture CHANGED and the runtime is shedding or recovering as configured, but the record of it did not finish. What went missing is the posture log line, and with it the IMMEDIATE export push that follows it - a defense daemon reacting to the change does not get it at the instant of transition. The staleness that leaves is shorter than a sample, not longer: the posture advances from inside the 1 Hz pressure sampler, and that same sampler run pushes the ordinary posture heartbeat a few statements later, so an export reader carries the true posture before the tick that raised it has finished.",
		automaticRecovery: "The heartbeat later in the SAME sampler run carries the new posture, so no export reader waits for another transition or another second; the next transition runs the handler again, since a throw does not unregister it. Only the incident-timeline console line for this transition is gone for good.",
		nextAction: "This is an adapter-internal failure - report it with the error printed beside it. The console write is the candidate to look at first: the transition metric is recorded before it and is contained, and the export push after it contains its own failures (a non-serializable snapshot and a slow client are both handled inside it). A configured metrics registry is NOT a candidate - an instrument that throws is contained and prints ADAPTER-ERR-METRICS-INSTRUMENT instead of reaching this handler.",
		sources: Object.freeze(['src/runtime/utils/pressure.js']),
		anchor: 'adapter-err-posture-observer',
		help: 'docs/errors.md#adapter-err-posture-observer'
	})
]);

const ERROR_BY_ID = new Map(ADAPTER_ERROR_REGISTRY.map((entry) => [entry.id, entry]));

export function adapterErrorDefinition(id) {
	const entry = ERROR_BY_ID.get(id);
	if (!entry) throw new TypeError('Unknown svelte-adapter-ws error id: ' + id);
	return entry;
}

export function adapterErrorHelpSuffix(id) {
	const entry = adapterErrorDefinition(id);
	// A dev console cannot resolve a repo-relative path; entries that
	// carry an absolute link render it instead of the packaged doc route.
	return ' [' + entry.id + '] See: ' + (entry.link ?? entry.help);
}

/**
 * Rejection details for ADAPTER-ERR-REQUEST-CLOSED, shared by every runtime
 * twin so the three transmission-side statements cannot drift apart. The
 * close sweep picks by the recorded send outcome: a frame the transport
 * dropped - or that a non-open dev socket never carried - is NEVER_SENT even
 * though the caller's send call returned, and UNANSWERED deliberately claims
 * a hand-off to the transport rather than delivery to the peer, which is all
 * a returned send can stand behind.
 */
export const REQUEST_CLOSED_DETAIL = Object.freeze({
	NEVER_SENT: '; the request frame was never sent',
	SEND_FAILED: '; the request frame could not be sent',
	UNANSWERED: '; the request frame was handed to the transport and no reply had arrived'
});

export function adapterErrorMessage(id, detail = '') {
	const entry = adapterErrorDefinition(id);
	return entry.messagePrefix + detail + adapterErrorHelpSuffix(id);
}

export function adapterErrorProblem(id, detail = '') {
	const entry = adapterErrorDefinition(id);
	if (entry.problemPrefix === null) throw new TypeError('Adapter error id has no operational problem prefix: ' + id);
	return entry.problemPrefix + detail + adapterErrorHelpSuffix(id);
}

/**
 * The full text of a console-emitted failure line: the registry's prefix, the
 * call-site detail, the stable ID tag, and the shortlink when the entry has
 * one. Printing THROUGH the registry is what keeps the emitted line and the
 * indexed prefix the same bytes - a call site cannot reword one without the
 * other. No repo-relative help route is appended: a console cannot resolve
 * one, and the stable ID already finds the entry.
 */
export function adapterConsoleLine(id, detail = '') {
	const entry = adapterErrorDefinition(id);
	if (entry.emission !== 'console') throw new TypeError('Adapter error id is not console-emitted: ' + id);
	return entry.messagePrefix + detail + ' [' + entry.id + ']' + (entry.link ? ' See: ' + entry.link : '');
}
