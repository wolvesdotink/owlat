# MTA dispatch modules — pipeline + outcome reducer

**Status:** accepted

## Context

`handleEmailJob` in `apps/mta/src/queue/handler.ts` is one 366-LOC handler
that contains two structurally distinct shapes tangled into one body. Neither
has a module; per-phase and per-outcome details accumulate as ceremony at one
site that grows linearly with every new check or effect.

### Pre-send: comment-delimited check pipeline

Ten phases run in fixed order, each delimited by a `// ── Step Nx ──` comment
(`handler.ts:79-176`):

| # | Phase | Outcome shape |
|---|---|---|
| 0a | Content screening | drop (`return`) on rejection |
| 0b | Suppression list check | drop (`return`) when suppressed |
| 1 | Circuit breaker (per-org) | defer (`throw DeferError`) when open |
| 1b | Org rate limit | defer when over |
| 2 | SMTP intel (domain health) | defer when degraded |
| 2b | Domain backoff | defer when in backoff |
| 3 | Resolve pool routing | always continues; enriches with `poolResult` |
| 4 | Select IP | defer when no IPs; else enriches with `ip` |
| 4b | Domain throttle slot acquire | defer when no slot |
| 4c | Warming cap | defer when reached |

Three things smear across these phases:

1. **State threads forward implicitly.** `domain` (set line 67), `poolResult`
   (line 154), `ip` (line 157) are populated in order and consumed by later
   phases. Reordering phase 4 before phase 3 is a silent runtime bug —
   `poolResult` is `undefined` when phase 4 reads it. The order is encoded
   only in comment numbering and developer memory.
2. **Retry decisions are scattered.** Six hardcoded delay constants
   (`60_000`, `60_000`, `30_000`, `60_000`, `5_000`, `300_000`) are inlined
   at the matching `throw new DeferError(...)` sites. Two phases
   (`circuitBreaker`, `orgLimits`) return their own `retryAfter` which is
   honored via `??`. Adding "jitter the warming defer differently" or
   "double the smtpIntel delay for known-throttling ISPs" means editing the
   handler at the matching site.
3. **`DeferError` is the dispatch mechanism.** Each phase that wants to
   defer throws an `Error` subclass that the GroupMQ adapter catches.
   Throwing is the control-flow primitive that travels with the delay
   — the handler can't return defer information up the stack without
   throwing. Tests that want to assert "phase X deferred for N ms" have
   to use `await expect(...).rejects` rather than assert on a return value.

### Post-send: branching effect reducer

After `sendToMx` returns (`handler.ts:179`), four outcome branches each
fire ~5 parallel side effects (`handler.ts:184-365`):

| Branch | Effects | Final action |
|---|---|---|
| `result.success` | `domainThrottle.recordSuccess`, `circuitBreaker.recordOutcome('delivered')`, `smtpResponse.recordResponse`, `warming.recordSend`, `metrics.record('delivered')`, `clearDomainFailure`, `logDeliveryEvent`, `notifyConvex('sent')` | `return` |
| `result.bounceType === 'hard'` | `circuitBreaker.recordOutcome('bounced')`, `smtpResponse.recordResponse`, `domainThrottle.recordReject`, `warming.recordBounce`, `metrics.record('bounced')`, `logDeliveryEvent`, `notifyConvex('bounced', hard)`, `suppressionList.suppress` | `return` |
| `result.bounceType === 'deferred'` | `domainThrottle.recordDefer`, `smtpResponse.recordResponse`, `warming.recordDeferral`, `metrics.record('deferred')`, `logDeliveryEvent` | `throw DeferError(classifier.suggestedDelayMs)` |
| else (soft bounce) | `circuitBreaker.recordOutcome('bounced')`, `warming.recordBounce`, `recordDomainFailure`, `metrics.record('error')`, `logDeliveryEvent`, `notifyConvex('bounced', soft)` | `throw DeferError(60_000)` |

The four branches overlap heavily: `smtpResponse.recordResponse` fires in
three branches with different argument shapes; `warming.record*` fires in
all four with different sub-method names; `metrics.record` fires in all
four with different outcome strings; `notifyConvex` fires in three with
different event shapes. The deletion test concentrates: deleting any one
branch reveals the same ~5 calls re-implemented at three other sites.

This shape is structurally identical to the **Send lifecycle (module)**
pattern from CONTEXT.md (typed outcome → typed effect list → runner) —
the difference is the operating substrate (Redis + metrics + cross-
boundary `notifyConvex`, vs Convex DB writes + scheduled fanouts) and the
absence of a state graph (each Dispatch attempt is one-shot; no persisted
status field to transition).

### Shared framing

Adding a new pre-send check or a new post-send effect is a handler edit.
Per LANGUAGE.md's deletion test: deleting the per-branch effect dispatch
reveals the same `Promise.all([…])` shape re-implemented at three other
sites; deleting the comment-delimited check sequence reveals the same
"call helper → check shape → throw if not allowed" pattern re-implemented
ten times. The two shapes have no modules; the handler is the only thing
holding them in place.

The MTA's natural unit of work is one execution of `handleEmailJob` for
one `EmailJob` — a **Dispatch attempt**. A Job has 1..N attempts; retries
(via GroupMQ re-queue) produce additional attempts. This term doesn't
exist in CONTEXT.md today, and neither do the modules that operate on it.

## Decision

Two parallel modules in `apps/mta/src/dispatch/`, sharing the **Dispatch
attempt** vocabulary. The handler keeps the GroupMQ adapter role — the
modules return data, the handler translates to `DeferError` for re-queue.

### Dispatch pipeline (module)

`apps/mta/src/dispatch/pipeline.ts` owns the ordered pre-send check
sequence. Phases compose into a typed tuple:

```ts
interface Phase<TIn extends BasePhaseCtx, TOut extends BasePhaseCtx> {
  readonly name: string;
  run(deps: PhaseDeps, ctx: TIn): Promise<PhaseOutcome<TOut>>;
}

type PhaseOutcome<TOut> =
  | { kind: 'continue'; ctx: TOut }
  | { kind: 'defer'; delayMs: number; reason: string }
  | { kind: 'drop'; status: 'screened' | 'suppressed'; reason: string };
```

A `compose(...phases)` helper produces a `Pipeline<TIn, TOut>` whose
output ctx type is the last phase's `TOut`. The phase tuple's
input/output chain is enforced at compile time: a phase that consumes
`ip` (`Phase<X & { ip: string }, Y>`) cannot be ordered before the phase
that produces it. Reordering is a TypeScript error, not a runtime bug.

Phases live one per file at `dispatch/phases/<phase-name>.ts`. They wrap
the existing intelligence/scaling helpers (`circuitBreaker.canSend`,
`orgLimits.checkAndIncrement`, `selectIp`, etc.) — the helpers stay; the
phase translates per-helper return shapes into the uniform
`PhaseOutcome`. Most phases are `Phase<X, X>` (pure checks); only three
phases enrich the ctx type: `resolvePool` (`+ poolResult`), `selectIp`
(`+ ip`), `acquireSlot` (no type change; declared so reordering is
caught).

The pipeline never imports or throws `DeferError`. The runner returns a
`PipelineResult<TOut>`:

```ts
type PipelineResult<TOut> =
  | { kind: 'continue'; ctx: TOut }
  | { kind: 'defer'; delayMs: number; reason: string }
  | { kind: 'drop'; status: 'screened' | 'suppressed'; reason: string };
```

Drop and defer carry enough information for the caller to emit the
matching `log_delivery_event` effect.

### Dispatch outcome (module)

`apps/mta/src/dispatch/outcome.ts` owns the post-send classification +
effect emission. Pure reducer:

```ts
type DispatchOutcome =
  | { kind: 'delivered'; ip; pool; domain; durationMs;
      smtpCode; smtpResponse?; remoteMessageId?; enhancedCode? }
  | { kind: 'hard_bounce'; ip; pool; domain; durationMs;
      smtpCode; error; enhancedCode? }
  | { kind: 'deferred'; ip; pool; domain; durationMs;
      smtpCode; error; enhancedCode?; classification }
  | { kind: 'soft_bounce'; ip; pool; domain; durationMs; error };

function classifyResult(result: SendResult, ctx: DispatchCtx): DispatchOutcome;

function reduce(outcome: DispatchOutcome, attemptCtx: AttemptCtx):
  { effects: DispatchEffect[]; defer?: { delayMs: number; reason: string } };
```

`reduce` has no `ctx` dependency on Redis or HTTP — it consumes typed
data and returns typed data. Tests assert against the effect list,
without mocking Redis or fetch.

The `DispatchEffect` union, declared in `dispatch/effects.ts`:

```ts
type DispatchEffect =
  | { kind: 'domain_throttle_success'; ip; domain }
  | { kind: 'domain_throttle_reject'; ip; domain }
  | { kind: 'domain_throttle_defer'; ip; domain }
  | { kind: 'smtp_response'; domain; smtpCode; enhancedCode? }
  | { kind: 'circuit_breaker_outcome';
      orgId; outcome: 'delivered' | 'bounced' }
  | { kind: 'warming_record';
      ip; result: 'send' | 'bounce' | 'deferral' }
  | { kind: 'metrics_record'; domain; ip; pool;
      outcome: 'delivered' | 'bounced' | 'deferred' | 'error';
      durationMs }
  | { kind: 'log_delivery_event'; event: DeliveryLogEvent }
  | { kind: 'notify_convex'; event: ConvexNotificationEvent }
  | { kind: 'suppress_recipient'; address; reason: 'hard_bounce' }
  | { kind: 'domain_failure_clear'; domain }
  | { kind: 'domain_failure_record'; domain };
```

The runner `applyEffects(effects, deps)` switches on `kind` and dispatches
to the matching helper, preserving the current parallelism (single
`Promise.all` over the effect list). The runner is the only place that
imports the Redis client, metrics collector, Convex notifier, and
delivery logger — every other piece of the dispatch path stays substrate-
agnostic.

### Handler shape after the cut

`apps/mta/src/queue/handler.ts` shrinks to the GroupMQ adapter:

```ts
export async function handleEmailJob(
  job: EmailJob, redis: Redis, config: MtaConfig
): Promise<void> {
  const deps = makeDeps(redis, config);
  recordWorkerHeartbeat(redis, config.serverId).catch(() => {});

  const piped = await runPipeline(deps, baseCtx(job));

  if (piped.kind === 'drop') {
    await applyEffects(
      [{ kind: 'log_delivery_event', event: dropEvent(job, piped) }],
      deps,
    );
    return;
  }

  if (piped.kind === 'defer') {
    throw new DeferError(piped.reason, piped.delayMs);
  }

  const startTime = Date.now();
  const result = await sendToMx(job, config, redis, piped.ctx.ip);
  const outcome = classifyResult(result, piped.ctx, startTime);

  const { effects, defer } = reduce(outcome, attemptCtx(job, piped.ctx));
  await applyEffects(effects, deps);

  if (defer) throw new DeferError(defer.reason, defer.delayMs);
}
```

The handler reads top-to-bottom as the lifecycle of one **Dispatch
attempt**: pipeline → send → outcome. Every word in it appears in
CONTEXT.md.

## Considered options

### Scope

1. **One pipeline covering both shapes.** Treat the post-send branches as
   "effect phases" inside the same pipeline that runs the pre-send checks.
   Conflates linear-short-circuit semantics with branching-reducer
   semantics — the post-send isn't ordered (each outcome fires independent
   effects), and the pre-send doesn't have outcome variants. The shared
   `Phase` interface would have to carry both shapes, defeating the
   typing. Rejected.
2. **Pre-send only — leave outcome recording alone.** The larger source
   of duplication (post-send effect smear across four branches) stays. The
   `notify_convex` and `metrics.record` and `warming.record*` patterns
   stay smeared. The deletion test still fails on the outcome side.
   Rejected.
3. **Two sibling modules** *(chosen)*. Each module owns the shape it
   actually has. The vocabulary keeps the two distinct: pipeline is for
   the ordered, short-circuiting check sequence; outcome reducer is for
   the typed branching with effect emission.

### Phase signature

1. **Shared `PipelineCtx` with optional fields.** All phases receive the
   same struct with progressively-filled `poolResult?`, `ip?`. Later
   phases narrow at runtime via assertions. A reordering bug surfaces at
   runtime, not compile time. The typed ctx is the load-bearing invariant
   of the pipeline — losing it removes most of the deepening's value.
   Rejected.
2. **Bare function, pipeline = array.** Each phase is just
   `async (deps, ctx) → PhaseOutcome`. Pipeline is a literal array.
   Phases mutate a shared ctx. Lightest shape, no `compose` machinery, no
   type-level chaining. Same compile-time-safety loss as option 1.
   Rejected.
3. **Typed `Phase<TIn, TOut>` with accumulating ctx** *(chosen)*.
   `compose(...phases)` chains the output ctx of each phase into the input
   of the next. Reordering bugs are TypeScript errors. Cost: a `compose`
   helper with N overloads (or a recursive conditional type) — paid once
   per module, not per phase.

### Outcome reducer shape

1. **Methods on the outcome union.** Each `DispatchOutcome` variant has a
   `.apply(deps)` method that imperatively fires its side effects. Loses
   the pure-reducer-testable-without-deps property. Tests have to mock
   Redis, metrics, logger again. Rejected.
2. **Bare reducer function, no effect union.** A single
   `applyDispatchOutcome(outcome, deps)` that branches on `outcome.kind`
   and runs the right calls. Gives the concept a name but doesn't yield
   a typed effect surface for testing. Closest to today's code; smallest
   blast radius; weakest test improvement. Rejected.
3. **Pure reducer + typed `DispatchEffect` union + runner** *(chosen)*.
   Mirrors Send lifecycle's shape from ADR-0006 precisely. Tests assert
   against the effect list as a pure data structure; only the runner
   needs deps. The MTA gets the same testing pattern Convex-side
   lifecycle modules already have.

### File layout

1. **Phases next to their existing intelligence/scaling modules.**
   `intelligence/circuitBreaker.ts` exports a `phase` constant alongside
   `canSend`. Less file churn; trade-off: the pipeline's shape isn't
   browsable in one place — reading the pipeline means walking
   `intelligence/`, `scaling/`, `monitoring/`. Rejected for browsability.
2. **Flat single file.** `pipeline.ts` holds all ten phases inline.
   Reordering is local; pipeline.ts becomes ~400 LOC; per-phase tests are
   harder to colocate. Rejected.
3. **One `dispatch/` folder** *(chosen)*. Mirrors ADR-0001's
   `email-renderer/src/blocks/<type>/` and ADR-0004's
   `automations/steps/<kind>/`. Phases live one per file under
   `dispatch/phases/`; the runner, reducer, and effects each get one file
   at the folder root.

### `DeferError` boundary

1. **Pipeline runner throws.** `runPipeline` itself throws `DeferError`
   when a phase returns defer. Handler is a 3-liner. Modules now know
   about `DeferError`; tests use `await expect(...).rejects`. Couples
   modules to the GroupMQ-specific control-flow primitive. Rejected.
2. **Handler owns translation** *(chosen)*. Both modules return defer
   data; `handler.ts` is the only place that throws. Modules don't import
   `DeferError`. Tests assert
   `expect(reduce(outcome).defer?.delayMs).toBe(60_000)` — no try-catch,
   no GroupMQ context, no throwing.

## Consequences

### Files that collapse / disappear

- `apps/mta/src/queue/handler.ts` shrinks from 366 LOC to ~40 LOC. The
  ten comment-delimited check blocks, the four-branch outcome switch, and
  all six inline `throw new DeferError(...)` sites are gone. The file
  becomes the GroupMQ adapter and nothing else.
- The local `withJitter` helper and `DeferError` class either stay in
  `handler.ts` (last caller) or move to `apps/mta/src/queue/deferError.ts`
  if a sibling adapter wants them. Scoped to the queue boundary either
  way.
- Six hardcoded delay constants (`60_000`, `60_000`, `30_000`, `60_000`,
  `5_000`, `300_000`) move into the phase files that own them. Reading
  "what's the warming-cap defer interval" becomes opening `phases/
  warmingCap.ts`, not searching `handler.ts`.

### Files that grow

- `apps/mta/src/dispatch/pipeline.ts` (new, ~80 LOC). The `compose`
  helper + `runPipeline` + `PipelineResult` / `PhaseOutcome` / `Phase`
  types.
- `apps/mta/src/dispatch/phases/<name>.ts` × 10 (new, each ~30–60 LOC):
  `contentScreening`, `suppression`, `circuitBreaker`, `orgLimit`,
  `smtpIntel`, `domainBackoff`, `resolvePool`, `selectIp`, `acquireSlot`,
  `warmingCap`.
- `apps/mta/src/dispatch/outcome.ts` (new, ~120 LOC). The `classifyResult`
  helper, the `DispatchOutcome` union, and the pure `reduce` reducer
  (four cases, each constructing the matching effect list).
- `apps/mta/src/dispatch/effects.ts` (new, ~150 LOC). The
  `DispatchEffect` union (12 kinds) and `applyEffects` runner that
  switches on kind.

Net LOC change is roughly flat: the handler shed ~310 LOC; the dispatch
folder gains ~450 LOC. The value is locality and typing, not line count.

### Test surface

Co-located unit tests + thin integration smoke:

- `apps/mta/src/dispatch/phases/__tests__/<name>.test.ts` per phase —
  test each phase as a pure function with a stubbed `PhaseDeps`. Today
  none of the inline blocks have unit tests; the only test path is the
  full handler integration suite.
- `apps/mta/src/dispatch/__tests__/outcome.test.ts` — assert `reduce`
  for each of the four outcome kinds produces the expected
  `DispatchEffect[]` and optional `defer`. No mocks; pure data
  assertions.
- `apps/mta/src/dispatch/__tests__/effects.test.ts` — type-level
  assertion that the effect union is exhaustively handled by the
  runner; integration that each effect-kind dispatches to the matching
  helper (this is the only test that touches Redis / fetch / metrics).
- `apps/mta/src/queue/__tests__/handler.integration.test.ts` — one
  end-to-end test per outcome class: success, hard, deferred, soft,
  pipeline-drop (screened), pipeline-drop (suppressed), pipeline-defer.
  Existing integration tests against real SMTP stay.

### Behavior

This is a pure refactor. No wire-visible behavior changes, no schema
changes, no public-API changes. Customer-visible behavior, GroupMQ retry
shape, Convex webhook payloads, and delivery log shape are all preserved
byte-for-byte.

Three things are *opportunistically* fixed in passing because the new
shape makes them obvious; each is scoped to its own PR (see execution
plan):

- The slot acquired in `acquireSlot` is released by the matching
  `domain_throttle_*` effect. Today's code relies on the slot expiring
  naturally if the warming phase defers after acquire; the new shape
  makes the missing release a one-line addition.
- The `circuitBreaker.recordOutcome` calls in the soft-bounce branch
  pass `'bounced'` for both hard and soft — preserved verbatim, but the
  shape makes the asymmetry visible and trackable.
- Defer reasons currently lose the per-phase delay rationale by the time
  they hit GroupMQ; the new `defer.reason` string carries the phase name
  to delivery logs (currently lost).

### Vocabulary

CONTEXT.md gains an **MTA dispatch** section between **Outbound lifecycle**
and **Webhook events**. Five new terms — **Dispatch attempt**, **Dispatch
pipeline (module)**, **Phase**, **Dispatch outcome (module)**, **Dispatch
effect** — pin the language used in this ADR and in subsequent reviews.
Relationships section gains one paragraph linking the Dispatch chain to
the Send lifecycle chain via `notify_convex`.

## Follow-up work

1. **`notify_convex` payload as a typed contract.** Today the MTA
   constructs `{ event, messageId, organizationId, ... }` inline in
   `notifyConvex`. The matching adapter on the Convex side
   (`webhooks/adapters/mta.ts`, ADR-0003) declares the parse shape. The
   `notify_convex` effect's payload type could be derived from the
   Convex-side `InboundEvent['email.*']` union — sharing one type across
   the wire boundary. Out of scope here; tracked.
2. **Per-phase telemetry.** With phases named, emitting a per-phase
   defer counter (`mta_pipeline_defers{phase="warming_cap"}`) becomes a
   one-line metric add. Useful for tracking which phase causes most
   re-queues. Defer.
3. **Phase composition for sibling pipelines.** A future "preview
   dispatch" path (dry-run for content screening only) could compose a
   subset of phases. The `compose` helper supports this trivially; no
   work to do now, but the seam is ready.
4. **MTA bounce intake module (parallel deepening).** The bounce server
   in `apps/mta/src/bounce/server.ts` runs a similar implicit pipeline
   (DSN/ARF parse → dedup → classify → notify). It produces
   `InboundEvent`s the same way the dispatch pipeline produces them via
   `notify_convex`. The same module pattern applies but is out of scope
   for this ADR (see candidate #8 in the architecture review that
   surfaced this work).

## Execution

See `docs/adr/0047-execution-plan.md`.
