# Agent step module — uniform per-kind compute + routing surface for the agent pipeline

**Status:** proposed

## Context

ADR-0010 deepened `processingStatus + agentActions` writes into the
**Inbox processing lifecycle (module)** — one writer of the message-state
machine. But the *compute* layer remained six bespoke `internalAction`
files at `convex/agent/agent<Kind>.ts`. Each handler rediscovers the
same five concerns (lifecycle bookkeeping, optional LLM call, output
sanitization, routing, next-step scheduling, error → failed transition)
and is glued to its sibling steps by hardcoded
`internal.agent.<next>.fn` references. The pattern that the automation
**Step module / Step walker** family adopted in ADR-0004 — pure modules
behind a typed dispatcher with a thin walker that owns lifecycle plumbing
— is the obvious next move for the agent pipeline. This ADR introduces
it as **Agent step (module)** + **Agent walker**.

### Pipeline-step landscape

| Step file | LOC | Calls LLM? | Records `tokenUsage`? | Sanitizes output? | Routing branches | Scheduled next step |
|---|---|---|---|---|---|---|
| `agent/agentSecurity.ts:120-258` | 288 | ❌ pattern matching | n/a | n/a | 3 (`quarantined / archived / classifying`) | hardcoded `internal.agent.agentContext.retrieveContext` |
| `agent/agentContext.ts:39-176` | 177 | ❌ DB joins + token math | n/a | n/a | 1 (always `classify`) | hardcoded `internal.agent.agentClassifier.classifyMessage` |
| `agent/agentClassifier.ts:36-153` | 154 | ✅ `generateObject` | ✅ (`:72-78`) | ❌ raw output threaded to drafter | 3 (`archived / draft_ready / drafting`) | hardcoded `internal.agent.agentDrafter.generateDraft` |
| `agent/agentDrafter.ts:49-226` | 227 | ✅ `generateText` | ✅ (`:194-198`) | ✅ `safeEnum` allowlists (`:25-44`) | 1 success path + defense-in-depth `failed` on context injection | hardcoded `internal.agent.agentRouter.routeDraft` |
| `agent/agentRouter.ts:20-113` | 114 | ❌ `agentConfig` read + threshold check | n/a | n/a | 2 (`approved / draft_ready`) | terminal |
| `agent/agentPipeline.ts:115-141` (`sendApprovedReply` placeholder) | — | n/a | n/a | n/a | — | terminal (lifecycle transition only) |

Six handlers, five drift signals.

### 1. Token-usage extraction shape duplicated

`agentClassifier.ts:72-78` and `agentDrafter.ts:194-198` both rebuild the
same shape from the AI SDK's `usage` object:

```ts
const tokenUsage = usage
  ? {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    }
  : undefined;
```

No `recordTokenUsage` helper; no shared mapping. When a third LLM step
lands (the moment a real planner ships, or a multi-call drafter, or a
clarification step) it will re-discover the shape — and the field-name
remapping (`inputTokens → promptTokens`, etc.) is exactly the place an
SDK upgrade silently breaks the lifecycle's token-usage validator.

### 2. Routing policy buried inside 50-line `execute` handlers

`agentClassifier.ts:88-139` and `agentSecurity.ts:188-244` mix LLM/compute
with routing. The classifier's logic is:

```ts
if (classification.category === 'spam') { transition({ to: 'archived', ... }); }
else if (classification.category === 'complaint' || classification.priority === 'urgent') {
  transition({ to: 'draft_ready', ... });  // skip drafter, escalate
} else {
  transition({ to: 'drafting', ... });
  scheduler.runAfter(0, internal.agent.agentDrafter.generateDraft, ...);
}
```

Answering "what does the classifier route to?" requires reading both
the LLM-call setup and this trailing branch. No single inspectable
function. A reviewer cannot eyeball the routing graph without reading
~50 lines per step.

### 3. Per-file scheduler-hop coupling

Every step imports `internal.agent.<next>.fn` directly:

| File | Imports `internal.agent.…` |
|---|---|
| `inbox/messages.ts:182` | `agentSecurity.runSecurityScan` |
| `agentSecurity.ts:232` | `agentContext.retrieveContext` |
| `agentContext.ts:159` | `agentClassifier.classifyMessage` |
| `agentClassifier.ts:134` | `agentDrafter.generateDraft` |
| `agentDrafter.ts:202` | `agentRouter.routeDraft` |

Adding a step between two existing ones means editing both neighbours.
The pipeline graph is encoded across six files, not in one place.

### 4. Six try/catch → `failed` transition blocks

Every handler ends with the same boilerplate:

```ts
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
    inboundMessageId: args.inboundMessageId,
    input: {
      to: 'failed',
      at: Date.now(),
      errorMessage,
      failingActionId: actionId,
    },
  });
}
```

Six copies. `agentDrafter.ts:207-223` carries a *two-actionId* variant
(it has both `planActionId` and `draftActionId` in scope) — the only
real shape variation across the six.

### 5. Phantom `plan` action type / vestigial `planning` state

The `planning` processingStatus state and `plan` agentActions actionType
both exist in the schema and the lifecycle's `LEGAL_EDGES`
(`classifying → planning → drafting`). But the classifier never
transitions into `planning` — it goes directly `classifying → drafting`
(`agentClassifier.ts:121`). The drafter creates a `plan` agentAction row
(`agentDrafter.ts:60-67`) whose `output` is a JSON object built by
literal construction (`agentDrafter.ts:75-86`):

```ts
const plan = {
  action: 'draft_reply',
  category: classification.category,
  intent: classification.intent,
  reasoning: `Message classified as ${classification.category}/${classification.intent} with ${classification.confidence} confidence. Generating reply draft.`,
};
```

Not a real planning step. Pre-prod, both enum slots can be dropped; a
real planner re-introduces them as a future kind.

### 6. Latent bug: cron-retry and release-from-quarantine don't restart the pipeline

`processingLifecycle.retryFailedActions` (`:874-898`) transitions failed
messages to `received` and resets the action to `pending`. The
lifecycle's reducer for `to: 'received'` (`:585-597`) clears
`errorMessage` and (for release-from-quarantine) `securityFlags`, then
emits a `reset_action_to_pending` effect — and stops. *No effect
schedules a new pipeline run.* `runSecurityScan` is scheduled in
exactly one place (`inbox/messages.ts:182`) — the new-message-arrival
path — and nothing watches `received`-state transitions to fire it
again.

The integration test for the cron
(`__tests__/processingLifecycle.integration.test.ts:692-713`) only
asserts that `processingStatus` ends at `received` and `action.status`
ends at `pending`. It never asserts that the pipeline re-runs. So:

- Cron retries quietly stall failed messages in `received` forever.
- Release-from-quarantine quietly strands released messages in
  `received` forever.

A real bug, fully present in main. The deepening closes it by adding a
`schedule_pipeline_start` lifecycle effect that calls the **Agent
walker**'s `start` entry point.

### Shared framing

Every concern above is the same pattern: per-kind ceremony around a
small core of work. The fix is the **Agent step (module)** family —
pure modules behind a typed dispatcher — with a thin **Agent walker**
that owns the ceremony (lifecycle bookkeeping, LLM dispatch + token
extraction, error → `failed`, self-scheduled `runStep` hop). The
automation **Step module / Step walker** pair from ADR-0004 is the
direct template; the agent variant differs only in the per-step
*routing* dimension (today's flow has output-conditional next-states,
which the module's `route` function captures).

## Decision

Introduce **Agent step (module)** at `convex/agent/steps/<kind>/index.ts`
and **Agent walker** at `convex/agent/walker.ts`. Five kinds —
`security_scan | context_retrieval | classify | draft | route` — with
the `plan` kind and `planning` state dropped pre-prod. Modules are pure
compute + routing; walker owns lifecycle plumbing. The vocabulary entry
in CONTEXT.md ships alongside this ADR.

### Module shape

```ts
// convex/agent/steps/types.ts

export type AgentStepKind =
  | 'security_scan'
  | 'context_retrieval'
  | 'classify'
  | 'draft'
  | 'route';

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type AgentStepResult<Out> = {
  output: Out;
  modelUsed?: string;
  tokenUsage?: TokenUsage;
};

export type NextStep = { kind: AgentStepKind; input: unknown };

export type AgentRoute =
  | { kind: 'in_state'; nextStep: NextStep }
  | { kind: 'transition'; transition: TransitionInput; nextStep?: NextStep }
  | { kind: 'done' };

export interface AgentStepModule<K extends AgentStepKind, In, Out> {
  readonly kind: K;
  readonly llm?: { tier: 'fast' | 'capable' };
  execute(ctx: ActionCtx, input: In): Promise<AgentStepResult<Out>>;
  route(output: Out, runCtx: AgentRunContext): AgentRoute;
}
```

Two pure functions per module. `execute` is the per-step compute;
`route` is the per-step policy. Both are individually testable.
`module.llm` is metadata read by the walker to decide whether to wrap
the call in `shared/llm.ts` (which extracts `tokenUsage` and stamps
`modelUsed` uniformly).

`AgentRunContext` is the small read-only bag the route function needs
beyond the step's own output — currently `{ inboundMessageId,
agentConfig?: Doc<'agentConfig'> | null }` so the `route` step can read
auto-reply thresholds. Each entry point that calls `runStep` loads
this once.

### Walker entry points

```ts
// convex/agent/walker.ts (signatures)

export const start: internalAction<{ inboundMessageId: Id<'inboundMessages'> }>;
export const runStep: internalAction<{
  inboundMessageId: Id<'inboundMessages'>;
  kind: AgentStepKind;
  input: unknown;
}>;
```

Two entry points. `start` schedules `runStep` with
`{ kind: 'security_scan', input: { inboundMessageId } }`. `runStep`
does the universal loop:

1. `STEP_MODULES[kind]` lookup (typed `Record<AgentStepKind,
   AgentStepModule>`).
2. `lifecycle.recordStepBegin(kind) → { actionId }`.
3. Try:
   1. `module.execute(ctx, input)` (wrapped in `runLlm` from
      `shared/llm.ts` if `module.llm` is set).
   2. `route = module.route(result.output, runCtx)`.
   3. Apply `route`:
      - `in_state`: `lifecycle.recordStepEnd(actionId, result.output,
        result.tokenUsage, result.modelUsed)`, then
        `scheduler.runAfter(0, runStep, route.nextStep)`.
      - `transition`: `lifecycle.transition(<merged>)`, then if
        `route.nextStep` is set, `scheduler.runAfter(0, runStep,
        route.nextStep)`.
      - `done`: `lifecycle.recordStepEnd(actionId, ...)`. No reschedule.
4. Catch: `lifecycle.transition({ to: 'failed', errorMessage,
   failingActionId: actionId })`. The walker logs but does not retry
   — the cron path is still authoritative for failed-message retries.

### Lifecycle changes

`processingLifecycle.ts` gains one new effect kind and loses one:

| Effect | Change |
|---|---|
| `schedule_pipeline_start` | **New.** Fires on `to: 'received'` from `release_quarantine` or `cron_retry`. Calls `internal.agent.walker.start`. Closes drift bug #6. |
| `schedule_next_step` | **Removed** (was aspirational in ADR-0010, never landed). The **Agent walker** owns step-to-step scheduling. |

The `actionTypeValidator` union drops `plan`. The processingStatus
union drops `planning`. The `LEGAL_EDGES` graph drops
`classifying → planning` and `planning → drafting`, leaving the direct
`classifying → drafting` edge that the code already takes.

`recordStepBegin / recordStepEnd / recordStepFail /
recordContextTier / recordDraftOutput` stay exactly as they are — they
are precisely the primitives the walker needs.

### Per-module sketch (one example)

```ts
// convex/agent/steps/classify/index.ts

import { z } from 'zod';
import type { AgentStepModule } from '../types';

const classificationSchema = z.object({
  category: z.enum([...]),
  priority: z.enum(['urgent', 'normal', 'low']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  intent: z.enum([...]),
  confidence: z.number().min(0).max(1),
});

export type ClassifyInput = { inboundMessageId: Id<'inboundMessages'>; context: string };
export type ClassifyOutput = z.infer<typeof classificationSchema>;

export const classifyStep: AgentStepModule<'classify', ClassifyInput, ClassifyOutput> = {
  kind: 'classify',
  llm: { tier: 'fast' },

  async execute(ctx, input) {
    // The walker has already wrapped this call in runLlm if module.llm is set.
    // For typed-object kinds (generateObject), the module exposes its schema
    // through shared/llm.ts's options. Stub for the ADR — see implementation.
    return await runLlmObject({
      schema: classificationSchema,
      prompt: buildClassifyPrompt(input.context),
      temperature: 0.2,
    });
  },

  route(output, _runCtx) {
    if (output.category === 'spam') {
      return { kind: 'transition', transition: { to: 'archived', reason: 'classifier_spam' } };
    }
    if (output.category === 'complaint' || output.priority === 'urgent') {
      return {
        kind: 'transition',
        transition: { to: 'draft_ready', classification: output, modelUsed: 'fast' },
      };
    }
    return {
      kind: 'transition',
      transition: { to: 'drafting', classification: output, modelUsed: 'fast' },
      nextStep: {
        kind: 'draft',
        input: { inboundMessageId: ???, context: ???, classification: output },
      },
    };
  },
};
```

The `???` placeholders are the **pass-through input** question: per the
locked Choice D1, `route` builds the next step's input directly. The
context and message-id thread through the run via the walker's
`runStep` arg (the walker passes `input.inboundMessageId` and
`input.context` into `runCtx` so `route` can compose them).

### Shared LLM helper

```ts
// convex/agent/steps/shared/llm.ts

import { generateText, generateObject } from 'ai';
import type { TokenUsage } from '../types';

function normalizeUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

export async function runLlmText(opts: { model: LanguageModel; messages: Message[]; temperature?: number }) {
  const { text, usage } = await generateText(opts);
  return { output: text, tokenUsage: normalizeUsage(usage), modelUsed: opts.model.modelId };
}

export async function runLlmObject<S extends z.ZodTypeAny>(opts: { model: LanguageModel; schema: S; prompt: string; temperature?: number }) {
  const { object, usage } = await generateObject(opts);
  return { output: object, tokenUsage: normalizeUsage(usage), modelUsed: opts.model.modelId };
}
```

One mapping site for `inputTokens → promptTokens`. SDK upgrades touch
one file. Closes drift bug #1.

## Considered options

### Module shape — uniform vs split LLM/compute

**Chosen: uniform `AgentStepModule` with optional `llm?` metadata.**

The five kinds split 3-vs-2 on whether they call an LLM. Splitting into
`AgentLLMStepModule` and `AgentComputeStepModule` would centralize the
LLM-dispatch ceremony but at the cost of two parallel families, two
dispatch tables, and a discriminated union at every walker call. The
walker handles both shapes cleanly via the `llm?` flag; the per-LLM
boilerplate (`runLlmText`, `runLlmObject`) lives as plain helpers in
`shared/llm.ts` that LLM modules call inside their own `execute`. This
keeps modules locally readable — a reviewer sees the prompt next to
the model call — while still giving one mapping site for the SDK
shape.

### Routing policy — inside `execute` vs separate `route` vs global table

**Chosen: per-module `route(output, runCtx)` function.**

(a) Routing inside `execute` is today's shape; the policy is invisible
without reading the whole handler. (b) A per-module `route` function
makes the policy a single inspectable surface — `expect(classify.route(
{ category: 'spam', ... })).toEqual({ kind: 'transition', transition:
{ to: 'archived', ... } })`. (c) A global routing table keyed by
`(kind, outputDigest)` died on its own complexity: predicates would
embed step-specific output shapes (`output.category === 'complaint' ||
output.priority === 'urgent'`), so the "table" would be a switch with
each row's body knowing the step's output type — no locality win over
per-module `route`.

### Plan step / planning state

**Chosen: drop both pre-prod. Future planner re-adds as a new kind.**

Today's `plan` agentAction row is JSON literal construction, not a
plan. The `planning` processingStatus state is unreachable. Pre-prod is
the time to cut. The CONTEXT.md and ADR text both note re-introduction
as a clean add (one new module + one walker registry entry + one
actionType enum addition + one `LEGAL_EDGES` re-addition).

### Input passing — pass-through vs accumulator

**Chosen: pass-through (D1).**

The accumulator pattern (a typed `AgentRunContext` keyed by
inboundMessageId, persisted on the row, with each module declaring its
input dependencies) is cleaner for late-arriving step additions but
requires schema, serialization contracts, and debugging surface that
today's args don't. The pipeline is 5 steps; today's args are already
mostly typed; the cost outweighs the flexibility. If a 6th step lands
that needs distant data, we revisit.

### Walker location — sibling file vs merged into lifecycle

**Chosen: sibling file at `convex/agent/walker.ts` (E1).**

The lifecycle's discipline (ADR-0010) is that it is the only writer of
`processingStatus + agentActions`. The walker is a *consumer* that
calls into the lifecycle's primitives. Merging the walker into the
lifecycle dilutes the "only writer" rule and conflates the
state-machine surface (transitions + reducer) with the orchestration
surface (dispatch + retry + scheduling).

### Next-step reference — by kind vs by Convex API path

**Chosen: by `AgentStepKind` (F1).**

The whole point of the deepening is that the kind is the addressing
unit. Sticking with `internal.agent.<file>.fn` keeps per-file API
knowledge spread across modules. The walker's `STEP_MODULES` registry
becomes the single place that knows the kind → module mapping.

### Walker retry semantics — whole-pipeline vs per-step resumption

**Chosen: whole-pipeline restart (same as today's reducer intent).**

Per-step resumption would require persisting each step's input so the
retry can re-enter at the failed kind without re-running upstream
steps. The benefit is real (don't re-run security scan + context +
classify if the failure was in `draft`) but the cost is non-trivial:
input persistence, accumulator-or-equivalent, retry-input validation
on schema drift. Defer until a real "drafts are expensive and
classifiers are cheap" use case shows up. Until then, the cron path
calls `walker.start` which re-runs from `security_scan`.

## Consequences

### Files that collapse / disappear

| File | What happens |
|---|---|
| `convex/agent/agentSecurity.ts` | Module body moves to `convex/agent/steps/security_scan/index.ts`; pattern helpers (`INJECTION_PATTERNS`, `detectInjection`, `detectSmuggling`, `calculateSpamScore`) move to `convex/agent/steps/security_scan/patterns.ts` (still exported — the **Agent step (module)** for `draft` re-uses `detectInjection` for defense-in-depth context scanning). The file is deleted. |
| `convex/agent/agentContext.ts` | Module body → `convex/agent/steps/context_retrieval/index.ts`. Token-budget constants stay in the module file. File deleted. |
| `convex/agent/agentClassifier.ts` | → `convex/agent/steps/classify/index.ts`. Zod schema stays in the module file. Deleted. |
| `convex/agent/agentDrafter.ts` | → `convex/agent/steps/draft/index.ts`. `ALLOWED_*` sets + `safeEnum` → `convex/agent/steps/draft/sanitize.ts`. The `plan` row + `recordStepBegin('plan')` calls vanish entirely (per the dropped kind). Deleted. |
| `convex/agent/agentRouter.ts` | → `convex/agent/steps/route/index.ts`. The auto-reply rate-limit math stays in the module's `route` function. Deleted. |
| `convex/agent/agentPipeline.ts` `sendApprovedReply` placeholder (`:115-141`) | The walker's `runStep` handles the `route` step's `done` path; the lifecycle's `schedule_send_approved` effect calls `internal.emails.sendAgentReply` directly. The placeholder file deletes. |

### Files that grow

| File | What it gains |
|---|---|
| `convex/agent/steps/types.ts` (new) | `AgentStepKind`, `AgentStepResult`, `AgentRoute`, `NextStep`, `AgentStepModule<K, In, Out>`, `AgentRunContext`. |
| `convex/agent/steps/shared/llm.ts` (new) | `runLlmText`, `runLlmObject`, `normalizeUsage`. Single mapping site for the AI SDK `usage` shape. |
| `convex/agent/steps/index.ts` (new) | `STEP_MODULES: Record<AgentStepKind, AgentStepModule>` registry; `stepModuleFor(kind)` typed lookup. |
| `convex/agent/walker.ts` (new) | `start`, `runStep`. ~150 LOC. |
| `convex/agent/steps/<kind>/index.ts` (5 new) | Each ~80-150 LOC — `execute` + `route` + per-kind types. Drafter is larger because of sanitization helpers. |
| `convex/agent/agentPipeline.ts` | Stays — the shared helper queries (`getMessage`, `getContact`, `getRecentActivities`, `getThreadMessages`, `getAgentConfig`, `isAgentEnabled`) remain. Module files call them via `ctx.runQuery(internal.agent.agentPipeline.getXxx, ...)`. |
| `convex/inbox/processingLifecycle.ts` | Gains the `schedule_pipeline_start` effect; loses `'plan'` from `actionTypeValidator`; loses `'planning'` from the processingStatus union + `LEGAL_EDGES`. The `case 'received'` reducer pushes `schedule_pipeline_start` when `source ∈ { 'release_quarantine', 'cron_retry' }`. |
| `convex/inbox/messages.ts:182` | One-line edit: `internal.agent.agentSecurity.runSecurityScan` → `internal.agent.walker.start`. |

### Migration

Pre-prod. One-shot:

1. Drop `'plan'` from `actionTypeValidator`. Schema migration: no rows
   to backfill — the `plan` agentActions written today are inert
   bookkeeping; no consumer reads them. Dev-environment data can be
   purged.
2. Drop `'planning'` from the processingStatus union. No rows in
   `'planning'` exist (the state is unreachable).
3. Remove `classifying → planning` and `planning → drafting` edges
   from `LEGAL_EDGES`. Add nothing — `classifying → drafting` already
   exists.
4. Add the `schedule_pipeline_start` effect and the new module/walker
   files.
5. Wire `inbox/messages.ts:182` to `walker.start`.
6. Delete the six `agent<Kind>.ts` files.
7. Verify the `__tests__/agentPipeline.integration.test.ts` still
   passes against `walker.start`.

No back-compat shims. No deprecation period. Pre-prod cut.

### Test surface

| Surface | Before | After |
|---|---|---|
| Per-step routing logic ("complaints → draft_ready, spam → archived, else → drafting") | Required running the full classifier through an LLM mock and asserting the resulting `lifecycle.transition` call. ~30 LOC per test. | Pure function call. `expect(classify.route({ category: 'complaint', ... }, runCtx)).toEqual({ kind: 'transition', transition: { to: 'draft_ready', ... } })`. ~3 LOC per test. |
| Per-step LLM dispatch (prompt construction, model choice) | Tested inline against mocked `getLLMProvider`. | Tested per-module via `runLlmText` / `runLlmObject` injection in `execute`. Shared LLM-wrapping tested once at the walker level. |
| Token-usage extraction | Implicit — asserted via mock LLM provider receipts. | One walker test: `runLlmText({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })` → `tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }`. Every LLM step is covered transitively. |
| Pipeline-restart-after-failure | Untestable today — bug #6 means it doesn't happen. Test asserts only the state reset. | New integration test: trigger cron retry, assert `walker.start` is scheduled (mock the scheduler), assert the message ends up in `security_check` after the scheduled action runs. Same test for `release_quarantine → received`. |
| Adding a new step kind | Touch ~3 files (the new step file + the two neighbours that schedule each other). | Touch ~2 files (the new step file + the `STEP_MODULES` registry entry). |
| End-to-end pipeline integration | `__tests__/agentPipeline.integration.test.ts` exists today; tests the full flow with mocked LLMs and asserts on `processingStatus` + `agentActions` + final draft. | Stays as-is; the entry point becomes `walker.start`. |

### Behavior

Identical to today except for two cases:

1. **Cron-retry actually re-runs the pipeline.** Today: state reset to
   `received`, action reset to `pending`, message stalls indefinitely.
   After: `schedule_pipeline_start` effect runs, `walker.start`
   schedules `runStep` for `security_scan`, pipeline replays from the
   top. Behavior change is observable: a failed message that the cron
   touches will end up in `draft_ready` (or further) within seconds
   instead of remaining in `received` until the next manual touch.
2. **Release-from-quarantine actually re-runs the pipeline.** Same
   fix, same mechanism. Today: state reset, no re-run. After:
   `schedule_pipeline_start` effect, pipeline replays.

The `plan` agentAction row is no longer written. UI that listed agent
actions for a message will see 4 rows for the happy path
(`security_scan, context_retrieval, classify, draft, route` — wait,
that's 5; ✗ the `plan` row drops, so it's the same count as today
minus one). Today's happy-path row count was 6 (`security_scan,
context_retrieval, classify, plan, draft, route`); after, it's 5. The
UI that renders agent action traces — `apps/web/app/pages/dashboard/
inbox/[id]/agent-trace.vue` (if it exists) — needs no change; the
`plan` row simply no longer appears.

### Vocabulary

Adds two terms to CONTEXT.md (already landed alongside this ADR):

- **Agent step (module)** — per-kind compute + routing module
- **Agent walker** — dispatcher

Updates one existing entry (**Agent action**) to drop the `plan`
actionType reference and to note the kind union ↔ actionType enum
correspondence. Updates the **Inbox processing lifecycle (module)**
effects list (drops `'planning'` from the pipeline-phase-states list,
removes the `schedule_next_step` aspirational effect, notes the new
`schedule_pipeline_start` effect). Updates one Relationships bullet.

## Follow-up work

- **Per-step retry resumption.** When a step is known-expensive (the
  draft step costs real tokens; the security scan is free), per-step
  resumption avoids re-running upstream cheap steps on retry. Requires
  persisting each step's input or reconstructing it from prior outputs
  on the message. Deferred until the cost case is concrete.
- **Real planning step.** Re-introduces the `plan` kind: a new
  `convex/agent/steps/plan/index.ts` module, `'plan'` re-added to
  `actionTypeValidator`, `'planning'` re-added to the processingStatus
  union + `LEGAL_EDGES`, a `STEP_MODULES['plan']` entry. The walker
  needs no changes.
- **Multi-call drafter.** If the drafter splits into retrieval + write
  (RAG-style), the second LLM call inside `draft.execute` Just Works —
  the walker's `runStep` boundary is one call; multiple LLM
  invocations inside the same `execute` are bundled into one
  agentAction row. If they need separate observability, split into
  two kinds.
- **Per-tenant model overrides.** `module.llm.tier` is global today
  (`getLLMProvider('classify' | 'draft')`). A per-org override layer
  would slot into the `shared/llm.ts` resolution path — the modules
  don't change.
- **Streaming output.** Would need walker accommodation (today's
  `execute` returns a final `Out`). Not in scope.

## Execution

### Steps

1. **Schema cut.** Drop `'plan'` from `actionTypeValidator` in
   `processingLifecycle.ts`; drop `'planning'` from the
   processingStatus union (in `schema.ts` and the lifecycle's
   `TransitionInput` types). Remove the corresponding edges from
   `LEGAL_EDGES`.
2. **Lifecycle effect.** Add `schedule_pipeline_start` effect to the
   lifecycle's effect union + runner. Wire it from the `case
   'received'` reducer when `source ∈ { 'release_quarantine',
   'cron_retry' }`.
3. **Types + helpers.** Create `convex/agent/steps/types.ts` and
   `convex/agent/steps/shared/llm.ts`.
4. **Per-kind modules.** Create five `convex/agent/steps/<kind>/
   index.ts` files. Port each handler's `execute` body (minus
   lifecycle calls) and write the `route` function. Drafter's
   `ALLOWED_*` sets move to `steps/draft/sanitize.ts`.
5. **Registry + walker.** Create `convex/agent/steps/index.ts` with
   `STEP_MODULES` and `stepModuleFor(kind)`. Create
   `convex/agent/walker.ts` with `start` + `runStep`.
6. **Rewire entry point.** Change `inbox/messages.ts:182` to
   `internal.agent.walker.start`.
7. **Delete the six agent<Kind>.ts files.** `agentPipeline.ts` stays
   (helper queries kept).
8. **Tests.** Add the per-module `route` unit tests. Add the
   `walker.start` integration test (replaces / extends the existing
   `agentPipeline.integration.test.ts`). Add the cron-retry
   restart-asserting test.

### Verification greps

After execution, these should return zero matches:

```sh
# No file should reference the old per-step actions
rg 'internal\.agent\.(agentSecurity|agentContext|agentClassifier|agentDrafter|agentRouter)\.' apps/api/convex/

# No file should reference the dropped enum slots
rg "'plan'|'planning'" apps/api/convex/inbox/ apps/api/convex/agent/ apps/api/convex/schema/

# Token-usage shape should appear only in shared/llm.ts
rg 'promptTokens:.*inputTokens|completionTokens:.*outputTokens' apps/api/convex/ -g '!**/shared/llm.ts'
```

These should return matches:

```sh
# Every step is registered
rg "kind: '(security_scan|context_retrieval|classify|draft|route)'" apps/api/convex/agent/steps/

# The new lifecycle effect is wired
rg 'schedule_pipeline_start' apps/api/convex/inbox/processingLifecycle.ts apps/api/convex/agent/walker.ts
```

### Done when

- The six `agent<Kind>.ts` files are deleted; their bodies live in
  `convex/agent/steps/<kind>/index.ts`.
- `convex/agent/walker.ts` exists with `start` + `runStep`; both have
  integration tests.
- `inbox/messages.ts:receiveMessage` calls `walker.start` instead of
  `runSecurityScan`.
- The lifecycle's `'plan'` actionType and `'planning'`
  processingStatus state are gone from the schema and the
  `LEGAL_EDGES` graph.
- The `schedule_pipeline_start` effect is wired and tested for both
  `cron_retry` and `release_quarantine` paths — the cron retry
  integration test now asserts that the pipeline actually re-runs.
- Every per-step `route` function has a pure-input unit test.
- One walker test covers token-usage extraction across the shared
  `runLlmText` / `runLlmObject` boundary.
- The existing `agentPipeline.integration.test.ts` end-to-end flow
  passes against the new entry point with no behavior change in the
  happy path.
- CONTEXT.md entries for **Agent step (module)**, **Agent walker**,
  **Agent action**, **Inbox processing lifecycle (module)**, and the
  Relationships bullet match this ADR.
