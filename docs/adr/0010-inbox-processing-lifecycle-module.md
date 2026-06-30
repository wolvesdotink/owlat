# Inbox processing lifecycle module — single writer of the 12-state inbound pipeline + review machine

**Status:** accepted

## Context

`inboundMessages.processingStatus` is a 12-state column
(`received | security_check | quarantined | classifying | planning |
drafting | draft_ready | approved | sent | rejected | archived | failed`)
tracking each inbound message through the agent pipeline and then the
human draft-review queue. The state machine has **nine writers** across
two driver populations (agent pipeline + cron + human review), and the
machine that owns it is silently joined to two other state machines —
`agentActions.status` (per-step audit log) and
`conversationThreads.latestDraftStatus` (latest-draft projection on the
thread) — neither of which is co-written atomically.

### Writer landscape

| Writer | Driven by | Sets to |
|---|---|---|
| `agent/agentPipeline.ts:updateMessageStatus` | agent steps | any of 12 |
| `agent/agentPipeline.ts:quarantineMessage` | agent (security) | `quarantined` |
| `agent/agentPipeline.ts:archiveMessage` | agent (spam) | `archived` |
| `agent/agentPipeline.ts:retryFailedActions` | cron | `received` (reset) |
| `agent/agentPipeline.ts:sendApprovedReply` | agent (post-approval) | `sent` |
| `inbox/mutations.ts:approveDraft` | human | `approved` |
| `inbox/mutations.ts:rejectDraft` | human | `rejected` |
| `inbox/mutations.ts:releaseFromQuarantine` | human | `received` (reset) |
| `inbox/mutations.ts:blockSender` | human | `archived` |

Five drift signals concentrate.

### 1. `processingStatus` and `agentActions` are written in two separate mutations

The agent pipeline currently advances by:

```ts
await ctx.runMutation(internal.agent.agentPipeline.updateMessageStatus, { ... });
// ... agent work ...
await ctx.runMutation(internal.agent.agentPipeline.createAction, { ... });
// ... step body ...
await ctx.runMutation(internal.agent.agentPipeline.completeAction, { ... });
await ctx.runMutation(internal.agent.agentPipeline.updateMessageStatus, { ... });
```

The `updateMessageStatus` and `createAction` / `completeAction` calls
are **two separate mutations**. A crash, retry, or partial failure
between them leaves the message in an inconsistent state —
`processingStatus: 'classifying'` with no running `agentAction` of type
`'classify'`, or a completed `agentAction` with `processingStatus` still
`'classifying'`. There is no atomic primitive for "advance to the next
step." The deletion test concentrates: deleting `updateMessageStatus`
reveals the same status patch open-coded across `agentSecurityScan.ts`,
`agentContext.ts`, `agentClassifier.ts`, `agentPlanner.ts`,
`agentDrafter.ts`, none of which can guarantee atomicity with the
matching `agentActions` write.

### 2. `latestDraftStatus` is written by three independent paths

`agent/agentPipeline.ts:updateThreadDraftStatus` is the canonical helper.
Two human mutations bypass it:

- `inbox/mutations.ts:approveDraft:35-39` — patches the thread inline
  alongside the `processingStatus` patch (two separate `ctx.db.patch`
  calls in one mutation, no atomicity guarantee against a crash between
  them).
- `inbox/mutations.ts:rejectDraft:77-81` — same pattern, same shape.

Three paths writing the same projection: drift surface. If the
projection rule changes (e.g., "the thread tracks latest *approved*
draft, not latest draft"), three places need editing.

### 3. The pipeline-phase / human-review split is mediated by shared columns

`releaseFromQuarantine` writes `processingStatus: 'received'` then
schedules `internal.agent.agentContext.retrieveContext`. The human
mutation and the next agent step communicate via the column, not via
the lifecycle. The agent assumes "I see `received` → it must be my
turn"; the human assumes "I wrote `received` → the agent will pick it
up." Any future writer of `received` would silently re-enter the
pipeline.

### 4. `context_retrieval` and `route` step kinds are invisible in `processingStatus`

`agentActions.actionType` has six step kinds:
`security_scan | context_retrieval | classify | plan | draft | route`.
`processingStatus` covers four: `security_check`, `classifying`,
`planning`, `drafting`. `context_retrieval` and `route` create
`agentActions` rows but leave `processingStatus` unchanged. Observers
of the verification queue cannot see "context-retrieval running" or
"routing in progress" — the message appears to be still in its prior
state. Per-step duration / retry counts for those kinds live in
`agentActions` and have to be joined in to surface in any operator UI.

### 5. The retry path resets without coordinating the `agentAction`

`agent/agentPipeline.ts:retryFailedActions:447-460` patches the failed
`agentAction` to `'pending'` and the message's `processingStatus` to
`'received'`. The two patches are in one mutation but on different
rows; a stale read of the message's status by a concurrent mutation
between the two patches could see `processingStatus: 'received'` with
the `agentAction` still `'failed'`, or vice versa. Today this is masked
by Convex's serializable mutations — but it's not enforced by the data
shape; the next refactor could break it silently.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one site's
`processingStatus` write reveals the same patch-then-schedule pattern
re-implemented across the agent pipeline files and the human-review
file. The nine sites have no module; each holds its own slice of the
contract. The 12-state graph itself is implicit — no one place
enumerates "what transitions are legal." The illegal edge check is
absent everywhere.

This is the same structural problem ADR-0006 fixed for Send lifecycle
and Postbox outbound lifecycle: a state column whose writers diverge,
whose effects (next-step scheduling, audit logging, projection
maintenance) are open-coded at each writer. Inbox processing is the
fourth instance of the **Outbound lifecycle**-shaped pattern (Send,
Postbox outbound, DOI, Inbox processing), and the largest by writer
count.

## Decision

One module at `apps/api/convex/inbox/processingLifecycle.ts` owns
transitions of `inboundMessages.processingStatus` and the atomic writes
of `agentActions` and `conversationThreads.latestDraftStatus` that
accompany them. The nine call sites collapse to a single
`transition(...)` call each. No external-key entry point —
`inboundMessages` are identified by their own `Id`; the SMTP
`messageId` is for threading, not transition lookup.

### `Inbox processing lifecycle (module)` shape

```ts
type ProcessingStatus =
  | 'received'
  | 'security_check'
  | 'quarantined'
  | 'classifying'
  | 'planning'
  | 'drafting'
  | 'draft_ready'
  | 'approved'
  | 'sent'
  | 'rejected'
  | 'archived'
  | 'failed';

type ActionType =
  | 'security_scan'
  | 'context_retrieval'
  | 'classify'
  | 'plan'
  | 'draft'
  | 'route';

type TransitionInput =
  // Pipeline-phase start transitions (create matching agentAction)
  | { to: 'security_check'; at: number }
  | { to: 'classifying'; at: number; classifyActionId?: Id<'agentActions'> }
  | { to: 'planning'; at: number; planActionId?: Id<'agentActions'> }
  | { to: 'drafting'; at: number; draftActionId?: Id<'agentActions'> }

  // Pipeline-phase result transitions (complete the running agentAction)
  | { to: 'draft_ready'; at: number; draftResponse: string; draftSubject: string; confidenceScore: number }
  | { to: 'quarantined'; at: number; securityFlags: SecurityFlags }
  | { to: 'archived'; at: number; reason: 'spam' | 'sender_blocked'; securityFlags?: SecurityFlags }

  // Human-driven transitions
  | { to: 'approved'; at: number; source: 'human' | 'auto'; userId?: string }
  | { to: 'sent'; at: number }
  | { to: 'rejected'; at: number; userId: string; reason?: string }

  // Reset transitions
  | { to: 'received'; at: number; source: 'release_quarantine' | 'cron_retry'; userId?: string }

  // Failure (any non-terminal state)
  | { to: 'failed'; at: number; errorMessage: string; failedStep: ActionType };

// Ancillary step recording (not a status transition — for
// context_retrieval and route step kinds, which write agentActions
// without changing processingStatus)
type RecordStepInput =
  | { actionType: 'context_retrieval' | 'route'; at: number }
  | {
      actionType: 'context_retrieval' | 'route';
      at: number;
      completedActionId: Id<'agentActions'>;
      output?: string;
      durationMs?: number;
      modelUsed?: string;
      tokenUsage?: TokenUsage;
    };

type TransitionOutcome =
  | {
      ok: true;
      applied: 'transitioned';
      from: ProcessingStatus;
      to: ProcessingStatus;
    }
  | {
      ok: false;
      reason: 'message_not_found' | 'illegal_edge' | 'terminal';
      from?: ProcessingStatus;
      to?: ProcessingStatus;
    };

export const transition: (
  ctx,
  args: { inboundMessageId: Id<'inboundMessages'>; input: TransitionInput }
) => Promise<TransitionOutcome>;

export const recordStep: (
  ctx,
  args: { inboundMessageId: Id<'inboundMessages'>; input: RecordStepInput }
) => Promise<{ actionId: Id<'agentActions'> }>;
```

### Legal-edges graph

- `received → security_check` (security_scan step starts)
- `security_check → quarantined` (security flag set)
- `security_check → classifying` (no security issue; classify step starts)
- `security_check → archived` (spam caught during scan)
- `classifying → planning`
- `planning → drafting`
- `drafting → draft_ready`
- `draft_ready → approved`
- `approved → sent`
- `draft_ready → rejected`
- `quarantined → received` (release from quarantine)
- `failed → received` (cron retry)
- `* → archived` (block-sender from any non-terminal state)
- `* → failed` (pipeline error from any non-terminal state)

`sent`, `rejected`, `archived` are terminal. Transitions out of them
return `{ ok: false, reason: 'terminal' }`.

### Reducer effects

The reducer returns `{ patch, effects, applied }`. The effect list:

- **`create_agent_action(actionType)`** — fires on transitions *into*
  pipeline-phase states (`security_check`, `classifying`, `planning`,
  `drafting`). Inserts an `agentActions` row with
  `status: 'running'`. Resolves the agentActionId for the next-step's
  `complete_agent_action` effect (passed forward in the message's
  in-memory state).
- **`complete_agent_action(actionId, output?, tokenUsage?, durationMs?,
  modelUsed?)`** — fires on transitions *out* of pipeline-phase states
  on success. Patches the matching `agentActions` row to
  `status: 'completed'`.
- **`fail_agent_action(actionId, errorMessage)`** — fires on
  `to: 'failed'` for any agent-driven failure. Patches the running
  `agentActions` row to `status: 'failed'` and increments
  `retryCount`.
- **`set_thread_draft_status(threadId, draftStatus)`** — fires on
  `to: 'draft_ready' | 'approved' | 'rejected' | 'sent'`. Closes
  drift signal #2 (the open-coded inline patches in
  `inbox/mutations.ts:35-39, 77-81`).
- **`schedule_next_step(nextStep)`** — fires on step-completion
  transitions. Replaces the `ctx.scheduler.runAfter` calls scattered
  across `agentSecurityScan.ts`, `agentContext.ts`,
  `agentClassifier.ts`, `agentPlanner.ts`, `agentDrafter.ts`. The
  module knows the pipeline order; the calling code does not.
- **`schedule_send`** — fires on `to: 'approved'`. Replaces the inline
  scheduler call in `inbox/mutations.ts:42-44`.
- **`audit_log(action, resourceId, details?)`** — fires on
  human-driven transitions (`approved`, `rejected`, `archived` via
  block-sender, `received` via release-from-quarantine).
- **`increment_auto_reply_count`** — fires on `to: 'approved'` when
  `source: 'auto'` (auto-approval threshold met).

The reducer is pure-ish: it takes the current message state + input,
returns `{ patch, effects, applied }`. The runner is the only place
that touches `ctx.db` and `ctx.scheduler`.

### Companion-field atomicity

The single `transition` mutation patches `processingStatus`,
`errorMessage`, `processedAt`, `securityFlags`, `classification`,
`draftResponse`, `draftSubject`, `confidenceScore`, and `contextTier`
in **one patch**, alongside the matching `agentActions` write and the
`conversationThreads.latestDraftStatus` write — all in the same Convex
mutation transaction. Today's scatter across `storeClassification`,
`storeDraft`, `updateSecurityFlags`, `updateContextTier`,
`updateMessageStatus` is collapsed: those mutations are deleted, their
payloads become fields on the appropriate `TransitionInput` variant.

### What stays out

- `conversationThreads.status` (`open | waiting | resolved | closed`) —
  independent state machine driven only by
  `inbox/mutations.ts:updateThreadStatus`. Not in scope.
- `agentCircuitBreakers.state` (`closed | open | half_open`) —
  independent state machine; per-breaker safety logic.
- `agentActions` as a *table* — kept. The lifecycle module is the only
  writer; the per-step audit fields (input/output JSON, retry count,
  model used, token usage, duration) stay as they are. The status
  column on `agentActions` has no separate lifecycle module — every
  transition is gated by the inbox-side transition.

### Call-site shape after the cut

```ts
// agent/agentClassifier.ts (was multiple updateMessageStatus + storeClassification + createAction + completeAction calls)
// On step start:
await processingLifecycle.transition(ctx, {
  inboundMessageId,
  input: { to: 'classifying', at: now },
});
// ... LLM call ...
// On step success:
await processingLifecycle.transition(ctx, {
  inboundMessageId,
  input: {
    to: 'planning',
    at: Date.now(),
    classification,
    // The next step's create_agent_action is implicit (transition into planning)
  },
});
```

```ts
// inbox/mutations.ts:approveDraft (was lines 29-44)
const outcome = await processingLifecycle.transition(ctx, {
  inboundMessageId: args.inboundMessageId,
  input: { to: 'approved', at: Date.now(), source: 'human', userId: identity.subject },
});
if (!outcome.ok) throwInvalidState(outcome.reason);
// schedule_send effect fires from inside the lifecycle module — no inline runAfter here.
return { success: true };
```

```ts
// inbox/mutations.ts:releaseFromQuarantine (was lines 180-208)
const outcome = await processingLifecycle.transition(ctx, {
  inboundMessageId: args.inboundMessageId,
  input: { to: 'received', at: Date.now(), source: 'release_quarantine', userId: identity.subject },
});
if (!outcome.ok) throwInvalidState(outcome.reason);
// schedule_next_step effect fires from inside the lifecycle module —
// the explicit `ctx.scheduler.runAfter(0, ...retrieveContext)` call goes away.
return { success: true };
```

```ts
// agent/agentContext.ts (the context_retrieval ancillary step)
const { actionId } = await processingLifecycle.recordStep(ctx, {
  inboundMessageId,
  input: { actionType: 'context_retrieval', at: now },
});
// ... retrieval work ...
await processingLifecycle.recordStep(ctx, {
  inboundMessageId,
  input: {
    actionType: 'context_retrieval',
    at: Date.now(),
    completedActionId: actionId,
    output: JSON.stringify(retrievalSummary),
    durationMs,
    modelUsed,
  },
});
// processingStatus unchanged — context_retrieval is invisible at the
// queue-filter level. The completedActionId surface is asymmetric with
// the pipeline-phase transitions because there's no "out-of-state" to
// move to (drift signal #4 preserved by intent).
```

## Considered options

### Module count

1. **One module covering both agent-driven and human-driven
   transitions** *(chosen)*. The `quarantined → released → received →
   security_check` flow and the `failed → received` cron-retry flow
   both cross the agent/human boundary. Splitting forces handoff
   coordination across modules.
2. **Two modules: Agent pipeline lifecycle + Draft review lifecycle.**
   Conceptually cleaner (machine-driven vs human-driven). Rejected —
   the seam at `quarantined → received` and `failed → received` would
   require either a shared column-write coordination or one module
   calling the other, both of which defeat the deepening.
3. **Three modules: pipeline + review + reset.** The reset paths
   (release, cron retry) become their own module. Speculative; rejected.

### Column representation

1. **Keep `processingStatus` denormalized; lifecycle owns the
   projection from `agentActions`** *(chosen)*. The column stays as
   the queue-filter index (`by_processing_status`,
   `by_assigned_to_and_status`). The lifecycle module writes both the
   column and the `agentActions` row in one mutation, guaranteeing
   consistency.
2. **Drop `processingStatus` entirely; project at read time.**
   Eliminates the denormalization but forces every queue-filter query
   to join `agentActions` and compute the projected status. Convex
   does not have efficient cross-table aggregation; the verification
   queue UI would degrade meaningfully. Rejected.
3. **Add `processingStatusVersion`-style optimistic-concurrency
   token.** Solves a race that the deletion test does not surface (no
   evidence of lost-update bugs today; Convex mutations are
   serializable). Speculative; rejected.

### Step recording for `context_retrieval` and `route`

1. **Separate `recordStep` operation that writes agentActions without
   changing `processingStatus`** *(chosen)*. Preserves today's queue
   semantics (those step kinds are invisible at the filter level
   — drift signal #4 by intent, not by accident). The two surfaces
   (`transition` and `recordStep`) are named distinctly so callers
   know which one to reach for.
2. **Add `processingStatus` values for `context_retrieval` and `route`.**
   Schema change; queue UI gains new filterable states; the
   verification queue's "anything pre-draft" filter becomes less
   precise. Rejected for blast radius; revisit if operator UI needs
   per-step visibility.
3. **One unified `transition` operation that also accepts
   "agent-action-only" inputs.** Smushes two semantics into one
   surface. Rejected — the caller needs to know whether they're
   changing status or not.

### Reducer purity

1. **Reducer is pure-ish: takes message + input, returns
   `{ patch, effects, applied }`. Runner does DB writes + scheduling**
   *(chosen)*. Mirrors the Send lifecycle template. Tests target the
   reducer directly without database fixtures.
2. **Reducer reaches into `ctx.db`.** Matches today's open-coded
   pattern but defeats the test-surface property. Rejected.
3. **Reducer is fully pure (no `ctx` at all).** Forces the runner to
   pre-load every related row (contact, thread, latest agentAction).
   Heavier wire for marginal isolation gain. Rejected — pure-ish is
   the working compromise from Send lifecycle.

### Failure recording

1. **`fail_agent_action` effect carries the running action's id from
   the message's in-memory state** *(chosen)*. The reducer reads
   `message.processingStatus` to know which step is in flight, then
   queries the latest matching `agentAction` to get the id. Effect
   payload includes the id; runner applies the patch.
2. **`fail_agent_action` walks `agentActions` at runner time.**
   Couples runner to DB semantics that should be reducer-decided.
   Rejected.
3. **No `fail_agent_action` effect; failure leaves the action row
   stale.** Drift surface. Rejected.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/agent/agentPipeline.ts` — `updateMessageStatus`,
  `quarantineMessage`, `archiveMessage`, `updateSecurityFlags`,
  `storeClassification`, `storeDraft`, `updateContextTier`,
  `updateThreadDraftStatus`, `createAction`, `completeAction`,
  `failAction`, `incrementAutoReplyCount` — all become internal
  helpers inside `processingLifecycle.ts` or get deleted (their
  callers now go through `transition`). The file shrinks from ~465
  LOC to ~120 LOC (helpers query layer only).
- `apps/api/convex/agent/agentSecurityScan.ts`,
  `agentContext.ts`, `agentClassifier.ts`, `agentPlanner.ts`,
  `agentDrafter.ts` — the per-step files lose their
  `updateMessageStatus` + `createAction` + `completeAction` calls
  (~6-10 LOC per file) and their `ctx.scheduler.runAfter` calls for
  the next step (~3-5 LOC per file). They keep their actual work
  (LLM call, vector search, etc.) and call `transition` once at
  start and once at end.
- `apps/api/convex/agent/agentPipeline.ts:retryFailedActions` — the
  two-row reset pattern (lines 447-460) collapses to one
  `transition({to: 'received', source: 'cron_retry'})` call per
  failed action.
- `apps/api/convex/inbox/mutations.ts:approveDraft` — the
  `processingStatus` patch + `latestDraftStatus` patch + scheduler
  call (~14 LOC) collapse to one `transition` call.
- `apps/api/convex/inbox/mutations.ts:rejectDraft` — same pattern
  collapses.
- `apps/api/convex/inbox/mutations.ts:releaseFromQuarantine` — the
  status-reset + scheduler call collapses.
- `apps/api/convex/inbox/mutations.ts:blockSender` — the archive
  patch collapses (the blockedEmails insert stays as a separate
  concern; the lifecycle's transition is the status write).

### Files that grow

- `apps/api/convex/inbox/processingLifecycle.ts` (new, ~540 LOC).
  Exports the `ProcessingStatus` literal tuple and validator, the
  `TransitionInput` / `RecordStepInput` / `TransitionOutcome` types
  and validators, the `transition` `internalMutation`, the
  `recordStep` `internalMutation`, the `LEGAL_EDGES` graph, and
  per-transition reducers.
- `apps/api/convex/schema/inbox.ts` — no schema change. The 12-state
  validator on `inboundMessages.processingStatus` already matches the
  module's `ProcessingStatus` union (the module is the canonical source).

Net LOC change is roughly balanced (~470 LOC down across the agent
files + inbox mutations, ~540 LOC up in the new module). The value is
locality, typed contract, and the deletion of five drift bugs plus
the elimination of the non-atomic
`processingStatus`/`agentActions`/`latestDraftStatus` triplet.

### Migration

Pre-production: no data backfill required. The
`inboundMessages.processingStatus` column and the `agentActions` table
are unchanged at the schema level. Tests that today set
`processingStatus` directly via `updateMessageStatus` switch to
calling `transition`.

### Test surface

- `apps/api/convex/__tests__/inboxProcessingLifecycle.integration.test.ts`
  (new, ~20 tests) — table-driven per
  `from-state × transition × idempotency`. Covers the full 12-state
  graph, illegal-edge refusals, terminal-state refusals, the
  `quarantined → received → security_check` release flow, the
  `failed → received` retry flow, the `* → archived` block-sender
  flow from multiple sources, the `latestDraftStatus` projection
  effect for all four draft-bearing states, the
  `create_agent_action` / `complete_agent_action` / `fail_agent_action`
  effects across all four pipeline-phase kinds, the
  `auto-approval source` increments `dailyAutoReplyCount`, and the
  `recordStep` ancillary path for `context_retrieval` and `route`.
- The existing integration tests
  (`__tests__/agentPipeline.integration.test.ts`,
  `__tests__/inboundMutations.integration.test.ts`,
  `__tests__/inboundQueries.integration.test.ts`) stay, with
  assertions shifted from "the message's `processingStatus` is X" to
  "the lifecycle returned `applied: 'transitioned'` with `to: X`."

### Behavior

All nine caller-visible behaviors are preserved:

- The agent pipeline still advances through `received →
  security_check → classifying → planning → drafting → draft_ready`,
  with each step writing an `agentAction` row.
- Quarantine still works (security flags → `quarantined`).
- Spam still works (security scan caught → `archived`).
- Human approve / reject / block-sender / release still work.
- The cron retry path still resets failed messages to `received`.

Five drift signals are fixed opportunistically:

1. `processingStatus` and `agentActions` are now written **atomically**
   in one mutation — drift signal #1.
2. `latestDraftStatus` is now written via the same code path from all
   four draft-bearing transitions — drift signal #2.
3. The `quarantined → received` and `failed → received` reset paths
   now schedule the next step via the lifecycle's
   `schedule_next_step` effect — drift signal #3.
4. `context_retrieval` and `route` are still queue-invisible (by
   intent), but their `agentActions` writes are now atomic with
   their per-step output recording — drift signal #4 (mitigated, not
   resolved; revisit if operator UI needs visibility).
5. The retry path's two-row reset is now atomic via the single
   `transition` mutation — drift signal #5.

### Vocabulary

CONTEXT.md gains a new **Inbox processing** section between
**Webhook events** and **Automations**, with three entries:
**Inbox processing status**, **Agent action**, and
**Inbox processing lifecycle (module)**. A relationships paragraph
links the two producer populations (agent + human) to the single
lifecycle module and notes that thread state and circuit breakers
stay independent.

## Follow-up work

1. **Lifecycle factor (`Lifecycle<S, T, E>`).** Fifth instance of the
   shape after Send, Postbox outbound, DOI, Inbox processing, Abuse
   status. See ADR-0009's follow-up #1 — same question, same hold-off.
2. **`context_retrieval` / `route` queue visibility.** If/when the
   verification-queue UI needs to surface "in-flight retrieval" or
   "routing decision pending" as filterable states, add them to
   `processingStatus` and migrate `recordStep` callers for those kinds
   to `transition`. Schema change; out of scope here.
3. **Thread-state lifecycle module.** `conversationThreads.status`
   (`open | waiting | resolved | closed`) is its own state machine
   with one writer today. If/when more writers arrive (e.g.,
   auto-resolve cron, auto-close on send), the same deepening applies.
   Out of scope.
4. **Agent circuit-breaker lifecycle module.**
   `agentCircuitBreakers.state` is a 3-state per-breaker machine;
   today's writers are scattered across `agentHealth.ts` and the
   pipeline reducer. Separate deepening candidate; orthogonal scope.
5. **`agentActions` retention.** Today every step run produces a
   permanent row. A future cron could archive `agentActions` older
   than N days for messages in terminal states. Not blocking on this
   ADR.

## Execution

Implemented in a single pre-production pass — no separate execution
plan, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/inbox/processingLifecycle.ts` — new module.
- `apps/api/convex/agent/agentPipeline.ts` — twelve helpers removed
  / collapsed.
- Five per-step files migrated
  (`agentSecurityScan.ts`, `agentContext.ts`, `agentClassifier.ts`,
  `agentPlanner.ts`, `agentDrafter.ts`).
- `apps/api/convex/inbox/mutations.ts` — four mutations migrated.
- `apps/api/convex/__tests__/inboxProcessingLifecycle.integration.test.ts`
  — new.
- Three pre-existing test files amended to call `transition` instead
  of `updateMessageStatus`.

CONTEXT.md is updated in the same pass (Inbox processing section +
Relationships paragraph). The MEMORY.md "Auth System" entry's note
about combined-query patterns is unrelated.
