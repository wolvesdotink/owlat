# ADR-0047 — execution plan for ADR-0007 (MTA dispatch modules)

> Companion execution plan for [ADR-0007](./0007-mta-dispatch-modules.md).
> Renumbered from `0007-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the MTA dispatch modules ADR. Each phase is one
shippable PR. Behavior is unchanged at every phase boundary; the cutover
to the new modules happens in phases 4 and 6 with byte-for-byte
preservation of customer-visible behavior, GroupMQ retry shape, Convex
notification payloads, and delivery log shape.

This is a pure refactor — no schema changes, no wire-visible changes, no
feature flags. Tests at every boundary verify the new path is byte-for-
byte identical to the old path.

## Order rationale

**Foundation before phases.** The `Phase` / `PhaseOutcome` /
`PipelineResult` / `DispatchEffect` types and the `compose` / `runPipeline`
/ `applyEffects` runners land first as scaffolding. They have zero
callers in phase 1; the per-phase modules in phase 2 are their first
callers.

**Pipeline before outcome.** The pre-send pipeline is the simpler shape
(linear, three outcomes per phase). Cutting it over first proves the
type-level chaining works against a real codebase before the outcome
reducer (broader effect union, four outcome kinds) lands.

**Each phase is independently revertible.** Phases 2 and 3 build
`dispatch/` alongside the existing handler. The handler isn't touched
until phase 4 (pipeline cutover) and phase 6 (outcome cutover). A revert
of phase 4 leaves the new pipeline modules orphaned but the handler
working as before; the same applies to phase 6.

**Cleanup last.** The `withJitter` helper, the `DeferError` class, and
any now-unused intelligence helpers stay until phase 7, which only
runs grep-verifications against the new state.

---

## Phase 1 — Foundation: types + runners (no callers)

**Changes**

- `apps/mta/src/dispatch/pipeline.ts` (new): `Phase<TIn, TOut>`,
  `PhaseOutcome<TOut>`, `PipelineResult<TOut>`, `BasePhaseCtx`,
  `PhaseDeps`. The `compose(...phases)` helper (typed-tuple-chained) and
  the `runPipeline(deps, ctx, pipeline)` runner. No phases imported yet.
- `apps/mta/src/dispatch/effects.ts` (new): the `DispatchEffect`
  discriminated union (12 kinds matching the ADR table) and the
  `applyEffects(effects, deps)` runner. Each effect-runner branch
  delegates to the existing helpers (`domainThrottle.recordSuccess`,
  `metrics.record`, `logDeliveryEvent`, `notifyConvex`, etc.) —
  imports stay; the runner is a thin dispatch switch.
- `apps/mta/src/dispatch/outcome.ts` (new): the `DispatchOutcome`
  discriminated union, `classifyResult(sendResult, ctx, startTime)`
  helper, and `reduce(outcome, attemptCtx)` pure reducer. No callers
  yet.
- `apps/mta/src/dispatch/types.ts` (new): shared types referenced by all
  three files (`AttemptCtx`, `DeliveryLogEvent`, `ConvexNotificationEvent`,
  `PhaseDeps`). Re-exports from `queue/handler.ts`'s current implicit
  shapes.

**Tests**

- `apps/mta/src/dispatch/__tests__/pipeline.test.ts` (new): the
  `compose` helper enforces input/output chaining at the type level.
  Test cases: a 3-phase pipeline composes; a phase that doesn't match
  the previous phase's output type fails to compile (`@ts-expect-error`
  with the matching diagnostic).
- `apps/mta/src/dispatch/__tests__/effects.test.ts` (new): the `kind`
  discriminator's exhaustiveness is enforced (a switch-without-default
  triggers `never` for an unhandled variant). Unit tests for each
  effect-runner branch using stubbed deps.
- `apps/mta/src/dispatch/__tests__/outcome.test.ts` (new): four
  `reduce(outcome, ctx)` cases — `delivered`, `hard_bounce`, `deferred`,
  `soft_bounce` — each asserts the produced `effects` list matches the
  current handler's behavior for that branch.

**Done when**

- `tsc -p apps/mta/tsconfig.json` clean.
- `rg "dispatch/" apps/mta/src/queue/` → no hits (no cutover yet).
- `npx vitest run apps/mta/src/dispatch/__tests__/` passes.

---

## Phase 2 — Per-phase modules (no callers in the handler)

**Changes**

- `apps/mta/src/dispatch/phases/contentScreening.ts` — wraps
  `screenContent`; returns `{ kind: 'drop', status: 'screened', reason }`
  on rejection.
- `apps/mta/src/dispatch/phases/suppression.ts` — wraps
  `suppressionList.isSuppressed`; returns `{ kind: 'drop',
  status: 'suppressed', reason }`.
- `apps/mta/src/dispatch/phases/circuitBreaker.ts` — wraps
  `circuitBreaker.canSend`; returns `{ kind: 'defer', delayMs,
  reason }`. Defer delay honors the helper's `retryAfter` (falls back
  to `60_000`).
- `apps/mta/src/dispatch/phases/orgLimit.ts` — wraps
  `orgLimits.checkAndIncrement`; same shape.
- `apps/mta/src/dispatch/phases/smtpIntel.ts` — wraps
  `smtpResponse.shouldDefer`; defers when the helper returns >0.
- `apps/mta/src/dispatch/phases/domainBackoff.ts` — wraps
  `shouldBackoffDomain`.
- `apps/mta/src/dispatch/phases/resolvePool.ts` — wraps
  `poolRules.resolvePool`; enriches ctx with `pool` and `dedicatedIp`.
  `Phase<BaseCtx, BaseCtx & { pool, dedicatedIp? }>`.
- `apps/mta/src/dispatch/phases/selectIp.ts` — wraps `selectIp`;
  enriches with `ip`. Defers (`60_000`) when no IP is available.
- `apps/mta/src/dispatch/phases/acquireSlot.ts` — wraps
  `domainThrottle.acquireSlot`; defers (`5_000`) when no slot.
- `apps/mta/src/dispatch/phases/warmingCap.ts` — wraps `warming.checkCap`;
  defers (`300_000`) when the cap is reached.
- `apps/mta/src/dispatch/phases/index.ts` — re-exports each phase by name
  and exports a `mainPipeline = compose(...)` constant that mirrors the
  handler's current order.

**Tests**

- One co-located test file per phase (`phases/__tests__/<name>.test.ts`)
  that exercises each branch (continue / defer / drop) by stubbing the
  underlying helper. Today none of these have unit coverage; this phase
  ships net-new coverage on ten check points.
- `dispatch/__tests__/mainPipeline.test.ts` — assert the composed
  pipeline's input is `BasePhaseCtx` and its output is the enriched ctx
  type carrying `pool`, `dedicatedIp?`, `ip`. Type-level test only.

**Done when**

- All ten phases compile against `compose(...)` without `as` casts.
- `rg "dispatch/phases" apps/mta/src/queue/` → no hits (still not wired).
- All ten phase tests pass.

---

## Phase 3 — Outcome reducer + effect runner (called by no one)

**Changes**

- `apps/mta/src/dispatch/outcome.ts`: full implementation of
  `classifyResult` and `reduce`. The `delivered` branch builds the
  effect list matching `handler.ts:184-227`; `hard_bounce` matches
  `:232-281`; `deferred` matches `:284-322`; `soft_bounce` matches
  `:325-365`. Each effect's argument shape matches the existing helper
  call exactly.
- `apps/mta/src/dispatch/effects.ts`: each effect-kind branch in
  `applyEffects` delegates to the matching existing helper with the
  same arguments the handler currently passes inline.

**Tests**

- `dispatch/__tests__/outcome.test.ts` expanded: for each outcome kind,
  a fixture `SendResult` plus a fixture `DispatchCtx` produces an
  effect list identical to a captured "golden" effect list derived from
  the current handler's behavior. The golden list is recorded once in
  this phase by running the existing handler against the same fixture
  and serializing the imperative call sequence.
- `dispatch/__tests__/effects.test.ts` expanded: integration test
  asserts that applying a captured effect list to a fixture Redis +
  metrics + notifier matches the side effects produced by the current
  handler running against the same fixture.

**Done when**

- `reduce(outcome, ctx).effects` matches a captured golden snapshot for
  each of the four outcome kinds.
- `applyEffects(captured, deps)` produces identical Redis state +
  identical Convex notification payloads + identical delivery log
  entries to the current handler running the same scenario.
- `rg "dispatch/outcome" apps/mta/src/queue/` → no hits (still not
  wired).

---

## Phase 4 — Cut the handler over to the pipeline

**Changes**

- `apps/mta/src/queue/handler.ts`: the ten `// ── Step Nx ──` blocks
  (`handler.ts:79-176`) are replaced with one call:
  ```ts
  const piped = await runPipeline(deps, baseCtx(job), mainPipeline);
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
  // ... existing post-send code stays for now ...
  ```
- The pre-send section's six `throw new DeferError(...)` sites are
  removed.
- `screenContent`, `suppressionList.isSuppressed` direct calls are
  removed from `handler.ts`.
- The post-send section (lines 184-365) stays imperative for one more
  phase. The handler imports `runPipeline`, `mainPipeline`,
  `applyEffects` from `dispatch/`.

**Tests**

- Existing integration tests in `queue/__tests__/` pass unchanged. The
  test suite exercises end-to-end scenarios (success, hard bounce, soft
  bounce, deferral, screened, suppressed) and should be byte-identical
  to before — same Redis writes, same Convex calls, same metrics, same
  delivery logs.
- New: `queue/__tests__/handler.pipelineCutover.test.ts` — record the
  `applyEffects` argument lists during a run against each scenario and
  assert equality against a snapshot captured pre-cutover.

**Done when**

- `rg "throw new DeferError" apps/mta/src/queue/handler.ts` → at most
  two hits (the two post-send defer paths, removed in phase 6).
- `rg "screenContent\\|suppressionList.isSuppressed" apps/mta/src/queue/handler.ts`
  → no hits.
- All existing integration tests pass byte-identically.

---

## Phase 5 — Wire the outcome reducer into the handler (still imperative effects)

**Changes**

- `apps/mta/src/queue/handler.ts`: the post-send classification (the
  `if (result.success) … else if (result.bounceType === 'hard') … else
  if (result.bounceType === 'deferred') … else …` chain at lines
  184-365) is replaced by:
  ```ts
  const outcome = classifyResult(result, piped.ctx, startTime);
  const { effects, defer } = reduce(outcome, attemptCtx(job, piped.ctx));
  // ... apply effects imperatively for one phase, then phase 6 swaps
  //     to the runner ...
  ```
- The handler still calls the imperative helpers (`domainThrottle.
  recordSuccess`, etc.), but the call sequence is now driven by the
  `effects` array, not by inline branches. This is a load-bearing
  intermediate state: the *order* of calls is now data, not code, but
  the *site* of calls is still inline. This phase exists to prove the
  effect list is correct against the current handler before swapping
  the runner.

**Tests**

- `queue/__tests__/handler.outcomeCutover.test.ts`: capture the
  imperative call sequence in this phase and assert it matches the
  pre-phase-5 snapshot from phase 4. Byte-for-byte identical call
  ordering.

**Done when**

- `rg "if \\(result\\.bounceType" apps/mta/src/queue/handler.ts` → no
  hits.
- Pre- and post-phase-5 snapshots in
  `handler.outcomeCutover.test.ts` match.

---

## Phase 6 — Replace imperative dispatch with `applyEffects`

**Changes**

- `apps/mta/src/queue/handler.ts`: the inline imperative calls in the
  post-send section are deleted. The handler's post-send becomes:
  ```ts
  await applyEffects(effects, deps);
  if (defer) throw new DeferError(defer.reason, defer.delayMs);
  ```
- The handler now reads as the GroupMQ adapter: `pipeline → send →
  outcome → effects`. Ten lines of substance.
- `apps/mta/src/queue/handler.ts` imports trim accordingly — the
  intelligence/scaling helpers' direct calls drop; only `DeferError` and
  `withJitter` (and `recordWorkerHeartbeat`) remain.

**Tests**

- All integration tests pass byte-identically against the
  phase-4-captured snapshots.
- `handler.integration.test.ts`: shortened. The four-outcome × two-drop
  matrix is now better-tested at the unit level
  (`dispatch/__tests__/outcome.test.ts`).

**Done when**

- `apps/mta/src/queue/handler.ts` is ~40-50 LOC.
- `rg "domainThrottle\\.|warming\\.|smtpResponse\\.|circuitBreaker\\.|metrics\\.record\\|notifyConvex\\|logDeliveryEvent\\|suppressionList\\.suppress\\|clearDomainFailure\\|recordDomainFailure" apps/mta/src/queue/handler.ts`
  → no hits.
- All integration snapshots match.

---

## Phase 7 — Cleanup + drift verification

**Changes**

- The `withJitter` helper and `DeferError` class stay in `handler.ts`
  (or move to `apps/mta/src/queue/deferError.ts` if a sibling adapter
  in this folder wants them — leave in place if no sibling exists).
- Delete any imports in `handler.ts` no longer referenced.
- Ensure `apps/mta/src/dispatch/phases/index.ts` exports the
  `mainPipeline` and that nothing else in the codebase imports the raw
  phases (they're internal to the pipeline's composition).
- Verify `apps/mta/src/intelligence/*` and `apps/mta/src/scaling/*` are
  unchanged except for any helpers that became dead post-cutover.

**Verification greps**

- `rg "throw new DeferError" apps/mta/src/` → exactly one match in
  `queue/handler.ts` (the GroupMQ boundary), and zero matches in
  `dispatch/`.
- `rg "Step 0a\\|Step 0b\\|Step 1\\|Step 2\\|Step 3\\|Step 4\\|Step 5\\|Step 6\\|Step 7" apps/mta/src/queue/handler.ts`
  → no hits (the comment-numbered checklist is gone).
- `rg "dispatch/" apps/mta/src/queue/handler.ts` → exactly four imports
  (`runPipeline`, `mainPipeline`, `classifyResult` / `reduce`,
  `applyEffects`).
- `rg "DispatchEffect" apps/mta/src/dispatch/` → declared in
  `effects.ts`, consumed by `outcome.ts` (in `reduce`'s return type)
  and by `effects.ts` (in `applyEffects`'s arg type).
- `rg "Phase<" apps/mta/src/dispatch/` → exactly ten declarations
  (one per phase file) plus the type definition in `pipeline.ts`.

**Tests**

- Full test suite green: `cd apps/mta && npx vitest run`.
- `tsc -p apps/mta/tsconfig.json` clean.

**Done when**

- All verification greps return the expected counts.
- The MTA dispatch vocabulary in CONTEXT.md matches the code: five
  terms, one module each, one folder, one composed `mainPipeline`, one
  pure `reduce`, one effect runner.

---

## Phase summary

| Phase | What | Files touched | Risk |
|---|---|---|---|
| 1 | Foundation: types + runners + scaffolds for `dispatch/` | 4 new files, 0 modified | None — no callers |
| 2 | Ten per-phase modules wrapping existing helpers | 10 new phase files + index | None — still no callers in handler |
| 3 | Outcome reducer + effect runner full implementation | 2 files expanded, golden snapshots captured | None — still no callers in handler |
| 4 | Cutover: handler uses `runPipeline` for pre-send | 1 modified (`handler.ts`); pre-send halved | **Cutover risk** — guarded by snapshot equality |
| 5 | Cutover intermediate: outcome reducer drives call order | 1 modified | **Cutover risk** — guarded by call-order snapshot |
| 6 | Cutover final: `applyEffects` replaces imperative dispatch | 1 modified | **Cutover risk** — guarded by integration snapshots |
| 7 | Cleanup + drift verification | greps, no functional changes | None |

Estimated 7 PRs.

## Verification checkpoints

- After phase 1: type-level cleanliness; no runtime callers; existing
  integration tests untouched and passing.
- After phase 2: ten phases composed; type-tuple chaining works
  (compose tests pass); handler unchanged.
- After phase 3: golden snapshots captured against the current handler;
  `reduce` produces matching effect lists for all four outcome kinds.
- After phase 4: handler integration tests pass against the new
  pre-send path; pre-cutover snapshot matches post-cutover snapshot.
- After phase 5: post-send call ordering driven by the effect list is
  byte-identical to pre-phase-5 behavior.
- After phase 6: handler is ~40 LOC; no per-helper imports remain; full
  integration suite green.
- After phase 7: greps confirm clean state; CONTEXT.md vocabulary
  matches code 1:1.
