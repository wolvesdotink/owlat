# LLM dispatch module — lift the agent-internal SDK-shape seam to a shared one

**Status:** proposed

## Context

The codebase has one cross-cutting concern that crosses five files but
sits behind two interfaces: how a single LLM call is issued and how
its `usage` shape is mapped into the internal `TokenUsage` validator.
ADR-0014 deliberately scoped the agent-internal seam at
`convex/agent/steps/shared/llm.ts` to that concern — "one mapping
site for the SDK shape, prompt next to model call in each caller."
The seam works exactly as designed inside the agent walker. It is
also the only place in the deployment where the mapping happens.

Four other callers issue LLM calls outside the agent walker and each
re-implements the surface from scratch. The pattern hides three
distinct drift signals.

### Caller landscape — `generateText` / `generateObject` / `embed`

| Caller | Path | Call | `tokenUsage` extracted? | `modelUsed` stamped? | SDK shape mapping |
|---|---|---|---|---|---|
| Agent walker (`classify`, `draft` step modules) | `convex/agent/walker.ts` → `agent/steps/shared/llm.ts` | `runLlmText` / `runLlmObject` | ✅ via `normalizeUsage` | ✅ | one site |
| `translate` action | `convex/translate.ts:46-64` | `generateText({ model, messages, temperature })` | ❌ **drift** | ❌ **drift** | open-coded |
| `knowledge/extraction` action | `convex/knowledge/extraction.ts:49-70` | `generateObject({ model, schema, prompt, temperature })` | ❌ **drift** | ❌ **drift** | open-coded |
| `semanticFileProcessing` action | `convex/semanticFileProcessing.ts:60-75` | `generateObject({ model, schema, prompt })` | ❌ **drift** | ❌ **drift** | open-coded |
| `visualizationAgent` action | `convex/visualizationAgent.ts:137,165` | `generateText({ model, system, prompt })` × 2 | ❌ **drift** | ❌ **drift** | open-coded |

Five files, three call shapes, two of them already covered by the
agent seam, all four non-agent callers silently drop the data ADR-0014
captured precisely because that mapping site exists nowhere they
could reach.

### 1. Silent loss of token-usage and `modelUsed` data on four sites

The agent walker writes `tokenUsage` and `modelUsed` onto the
**Agent action** row (per ADR-0014). The four non-agent callers
destructure only the field they need (`text`, `object`) from the AI
SDK response and discard `usage` entirely. An operator investigating
"why did this AI call cost so much?" or "which model produced this
output?" for any non-agent surface has no signal — the data the SDK
returns is never recorded anywhere.

Same drift pattern as the open-coded `db.patch` sites every prior
lifecycle deepening closed: the chokepoint exists, it just doesn't
sit where the callers can use it.

### 2. SDK-shape mapping duplicated by being absent

`shared/llm.ts:29-36` is the canonical map between the AI SDK's
`{ inputTokens, outputTokens, totalTokens }` shape and the internal
`{ promptTokens, completionTokens, totalTokens }` validator. The four
non-agent callers don't map at all — they don't record token usage.
If the AI SDK rotates the field names (a real risk given the SDK
shipped this shape change in 5.x — see the comment block in
`shared/llm.ts:7-12`), the agent path will be updated once;
the four non-agent paths are silently safe only because they read
nothing.

If any of those callers later starts reading `usage`, it will read
the wrong field names and silently report zero. The current
"safety" is the absence of intent, not a property of the code.

### 3. Diverging error-handling shapes across callers

Each non-agent caller wraps its LLM call in a bespoke try/catch:

- `translate.ts:118-130` — parse-failure returns `[]`, logs via
  `logError`.
- `knowledge/extraction.ts:101-104` — any error returns silently,
  logs via `console.error`.
- `semanticFileProcessing.ts:80-86` — falls back to filename for
  title, logs via `console.error`. Three separate try/catches in
  the same file for generateObject, embed, then the second embed.
- `visualizationAgent.ts:181-225` — top-level try/catch writes a
  failure record to the visualization row.

This drift is not closed by the proposed lift — each caller's
recovery shape is genuinely different and load-bearing for its
domain. **This ADR does not unify error handling.** It does
unify the SDK-mapping shape and the token-usage extraction; the
caller still owns its recovery posture.

### Shared framing

Per LANGUAGE.md's deletion test: deleting the agent's `shared/llm.ts`
file today inlines the SDK-shape mapping into the two LLM-using
step modules (`classify`, `draft`) — complexity reappears at exactly
two sites. The four non-agent callers currently *do* inline the
mapping (by skipping it), so deleting the seam doesn't move
complexity from their perspective — but rebuilding the seam at a
shared location reveals that all five callers want the same surface.
The seam is real; it's just under-deployed.

The interface is the test surface: pre-lift, "token-usage extraction
across the runLlmText / runLlmObject boundary" can only be tested
against the agent walker harness. Post-lift, the same assertion is a
pure unit test against the lifted module's interface, exercised by
the agent walker tests *and* by direct dispatch tests with no
walker required.

Confidence: high. Pure consolidation. No new behavior. No schema
change. One file moves, one file's interface widens by one variant,
four callers update one import.

## Decision

Lift `convex/agent/steps/shared/llm.ts` to `convex/lib/llm/dispatch.ts`,
widen the text-call interface by one input variant, migrate the four
non-agent callers to the shared seam, and log token-usage from
non-agent callers via `lib/runtimeLog.ts`.

### New module: LLM dispatch (module)

```
convex/lib/llm/dispatch.ts
```

Two entry points. Owns the SDK-shape mapping and the canonical call
surface. Does not own model resolution (that's `lib/llmProviders/`),
retry, fallback, embedding, persistence, or prompt construction.

```ts
// convex/lib/llm/dispatch.ts (sketch)
'use node';

import {
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import type { z } from 'zod';
import type { TokenUsage } from '../../agent/steps/types';

type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined;

export function normalizeUsage(usage: RawUsage): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

export type LlmTextInput =
  | { messages: ModelMessage[] }
  | { prompt: string; system?: string };

export interface LlmTextOptions extends LlmTextInput {
  model: LanguageModel;
  temperature?: number;
}

export interface LlmTextResult {
  text: string;
  tokenUsage: TokenUsage | undefined;
  modelUsed: string | undefined;
}

export async function runLlmText(opts: LlmTextOptions): Promise<LlmTextResult> {
  const sdkArgs =
    'messages' in opts
      ? { messages: opts.messages }
      : { prompt: opts.prompt, system: opts.system };
  const { text, usage } = await generateText({
    model: opts.model,
    temperature: opts.temperature,
    ...sdkArgs,
  });
  return {
    text,
    tokenUsage: normalizeUsage(usage),
    modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
  };
}

export interface LlmObjectOptions<S extends z.ZodTypeAny> {
  model: LanguageModel;
  schema: S;
  prompt: string;
  temperature?: number;
}

export interface LlmObjectResult<S extends z.ZodTypeAny> {
  object: z.infer<S>;
  tokenUsage: TokenUsage | undefined;
  modelUsed: string | undefined;
}

export async function runLlmObject<S extends z.ZodTypeAny>(
  opts: LlmObjectOptions<S>,
): Promise<LlmObjectResult<S>> {
  const { object, usage } = await generateObject({
    model: opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
    temperature: opts.temperature,
  });
  return {
    object: object as z.infer<S>,
    tokenUsage: normalizeUsage(usage),
    modelUsed: typeof opts.model === 'string' ? opts.model : opts.model.modelId,
  };
}
```

The `TokenUsage` type stays where it is (`agent/steps/types.ts`) —
moving it would touch the agent step type imports for no benefit.
The lifted module imports it across the layer; this is acceptable
because the type is shaped by what the lifecycle records, not by
where the call originates.

### Interface widening: `LlmTextInput` as a discriminated input

Pre-lift, `runLlmText` accepts `{ messages: ModelMessage[] }` only.
The agent's two text callers (translate, the two visualization calls,
the agent draft step) split as follows:

| Caller | Shape | Fits today's interface? |
|---|---|---|
| Agent `draft` step | `messages: [...]` | ✅ |
| `translate.ts` | `messages: [{ role: 'system', content: ... }, { role: 'user', content: prompt }]` | ✅ |
| `visualizationAgent.ts:137` | `{ system, prompt }` | ❌ |
| `visualizationAgent.ts:165` | `{ prompt }` | ❌ |

Widening `runLlmText`'s input to accept either `{ messages }` or
`{ prompt, system? }` matches what callers already write and avoids
forcing the visualization caller to construct two-element `messages`
arrays inline. The discriminated input keeps the interface tight —
exactly the two shapes the AI SDK itself accepts as alternatives.
Three new tests cover the discriminator (`messages` variant,
`{prompt}` variant, `{prompt, system}` variant).

### Token-usage logging for non-agent callers

Non-agent callers gain `tokenUsage` and `modelUsed` from the lifted
seam. They have no row to write to (they are not part of a lifecycle
that tracks per-call action history), so they log via
`lib/runtimeLog.ts`:

```ts
import { logInfo } from './lib/runtimeLog';

const { object, tokenUsage, modelUsed } = await runLlmObject({
  model: getLLMProvider('extract'),
  schema: extractionSchema,
  prompt,
});
logInfo('[knowledge.extract] llm call', { tokenUsage, modelUsed });
```

The format is informational, not load-bearing. Operators see AI cost
in runtime logs without a new persistence surface. The four callers
each pick a stable log tag (`[knowledge.extract]`, `[translate]`,
`[semantic_file]`, `[visualization]`) so a future operator filter
can grep them out as a cluster.

### Caller migration

| Caller | Pre-lift | Post-lift |
|---|---|---|
| `convex/agent/steps/classify/index.ts` | imports `runLlmObject` from `../shared/llm` | imports from `../../../lib/llm/dispatch`; no other change |
| `convex/agent/steps/draft/index.ts` | imports `runLlmText` from `../shared/llm` | imports from `../../../lib/llm/dispatch`; no other change |
| `convex/translate.ts` | `generateText({ model, messages, temperature })` open-coded | `runLlmText({ model, messages, temperature })` + `logInfo` |
| `convex/knowledge/extraction.ts` | `generateObject({ model, schema, prompt, temperature })` open-coded | `runLlmObject({ model, schema, prompt, temperature })` + `logInfo` |
| `convex/semanticFileProcessing.ts` | `generateObject({ model, schema, prompt })` open-coded | `runLlmObject({ model, schema, prompt })` + `logInfo` |
| `convex/visualizationAgent.ts` | `generateText({ model, system, prompt })` × 2 open-coded | `runLlmText({ model, prompt, system })` × 2 + `logInfo` |

`embed()` calls at `knowledge/extraction.ts:80-83` and
`semanticFileProcessing.ts:93-98` stay open-coded. Adding
`runLlmEmbed` to the seam is a separate scope decision deferred to a
follow-up; the lift consolidates only the surface the agent seam
already covers.

### Replaces

| File:line | Pre-lift | Post-lift |
|---|---|---|
| `convex/agent/steps/shared/llm.ts` (entire file) | Agent-internal SDK seam | Deleted; contents moved to `convex/lib/llm/dispatch.ts` with widened `LlmTextInput` |
| `convex/translate.ts:46-64` | `generateText` open-coded; no usage capture | `runLlmText` call; usage logged via `runtimeLog` |
| `convex/knowledge/extraction.ts:49-70` | `generateObject` open-coded | `runLlmObject` call; usage logged |
| `convex/semanticFileProcessing.ts:60-75` | `generateObject` open-coded | `runLlmObject` call; usage logged |
| `convex/visualizationAgent.ts:137-153` | `generateText({ system, prompt })` open-coded | `runLlmText({ system, prompt })` call; usage logged |
| `convex/visualizationAgent.ts:165-169` | `generateText({ prompt })` open-coded | `runLlmText({ prompt })` call; usage logged |

No schema change. No data migration.

### Closes drift bugs

1. **Token-usage and `modelUsed` silently dropped at four sites** —
   closed by the lift. All five LLM-using files now extract the
   normalized `TokenUsage` shape and the model identifier through one
   seam (drift #1).
2. **SDK-shape mapping duplicated by being absent** — closed by the
   lift. The one `normalizeUsage` function is the canonical map for
   every LLM call in the deployment (drift #2).
3. **`runLlmText` cannot represent the `{ prompt, system }` shape** —
   closed by widening the input to a discriminated union. The
   visualization caller and any future caller with the same shape
   fits without an extra entry point or an inline message-array
   construction.

Drift #3 from the Context section (diverging error-handling shapes)
is **deliberately not closed** by this ADR. Each caller's recovery
shape is load-bearing for its domain (translate returns `[]`;
knowledge silently drops; visualization writes a failure row;
semantic-file falls back to filename). A future ADR may unify a
subset of these if a real use case emerges; this lift does not
pre-commit.

### Tests

Two new test surfaces, one migration:

1. **`runLlmText` discriminator tests** at
   `convex/lib/llm/__tests__/dispatch.test.ts`. Three cases:
   `{ messages }` variant, `{ prompt }` variant, `{ prompt, system }`
   variant. Each asserts the result shape (`{ text, tokenUsage,
   modelUsed }`) and that the SDK was called with the expected
   `sdkArgs` shape. Pure unit tests against a mock `LanguageModel`.
2. **`normalizeUsage` tests** — port the existing tests from
   `agent/steps/__tests__/shared.test.ts` (if any) to the new
   location. Covers undefined, partial (only `inputTokens`), and full
   triples.
3. **Existing `agentPipeline.integration.test.ts`** — passes against
   the new entry point with no behavior change in the agent flow.
   The import path inside the test file may need updating if it
   imports from `shared/llm` directly.

### Out of scope for this ADR

- **Lifting `embed()`** into the seam. Two callers
  (`knowledge/extraction.ts`, `semanticFileProcessing.ts`) call
  `embed()` from the AI SDK. Adding `runLlmEmbed` would be a small
  extension but was explicitly rejected at the grilling step in
  favor of "minimal lift." Lands in a follow-up if a third
  embedding caller appears.
- **Retry and fallback policy.** Each caller's recovery is
  domain-specific (return `[]`, fall back to filename, etc.). A
  generic retry layer would conflict with this scope and would
  also push the seam past "prompt next to model call" (ADR-0014).
- **Persisting usage to a dedicated `aiUsageEvents` table.** Runtime
  logs are the durable surface for now. Persistence is deferred
  until a metering or cost-attribution need lands.
- **Prompt construction helpers.** Each caller composes its prompt
  next to its model call. ADR-0014 chose this for locality; this
  ADR preserves it.
- **ADR-0014 superseded?** No. ADR-0014's intent is preserved
  exactly — the agent walker still calls a typed dispatch seam with
  `tokenUsage` and `modelUsed` extracted. The file moved from
  `agent/steps/shared/llm.ts` to `lib/llm/dispatch.ts` because the
  surface is no longer agent-internal. ADR-0014 stays accepted as
  the historical record; this ADR documents the relocation.

## Consequences

**Closes the silent-data-loss gap on four non-agent LLM callers.**
After this lands, every LLM call in the deployment extracts the
normalized token-usage shape and the model identifier. Operators
gain runtime-log visibility into AI cost across `translate`,
`knowledge/extraction`, `semanticFileProcessing`, and
`visualizationAgent` without a new persistence surface.

**Closes the "future SDK rotation hits N sites" risk.** The AI SDK
shipped one field-name change between 4.x and 5.x (the comment in
`shared/llm.ts:7-12` documents it). Pre-lift, a future rotation
silently breaks the four non-agent callers the moment they start
reading `usage`. Post-lift, the mapping site is one file for the
whole deployment.

**Honors ADR-0014's locality principle.** Each caller still
composes its prompt next to its model call. The lift consolidates
only the SDK-shape mapping and the result normalization — exactly
what ADR-0014 already scoped, just at a wider radius.

**Surface area:** net flat. One file relocates (~90 LOC) and gains
one input-variant widening (~10 LOC). Four callers shed ~5 LOC each
on the SDK-call shape and gain ~2 LOC each on the `logInfo` line.
Net production LOC: roughly unchanged. New test LOC: ~80 (three
discriminator cases + the `normalizeUsage` ports).

**Migration:** one PR. Schema unchanged. No data migration.

1. New `convex/lib/llm/dispatch.ts` file added with `runLlmText`
   (widened), `runLlmObject`, and `normalizeUsage`.
2. Old `convex/agent/steps/shared/llm.ts` deleted.
3. Two agent step files (`classify/index.ts`, `draft/index.ts`)
   update their import path.
4. Four non-agent caller files migrate from open-coded SDK calls to
   `runLlmText` / `runLlmObject` plus a `logInfo` line.
5. New tests at `convex/lib/llm/__tests__/dispatch.test.ts`.
6. CONTEXT.md entry for **LLM dispatch (module)** already landed
   inline with the grilling that produced this ADR.

No risk to in-flight runs: the agent walker's behavior is unchanged
(same `tokenUsage` and `modelUsed` written to **Agent action** rows).
The four non-agent callers gain log lines they didn't have; no
production code path becomes stricter or more restrictive.

**Out of scope for follow-up:** the embedding seam. Two callers use
`embed()` directly today. If a third embedding caller appears, an
ADR follow-up extends `lib/llm/dispatch.ts` with `runLlmEmbed`. The
seam's folder placement (`lib/llm/` rather than a flat
`lib/llmDispatch.ts`) leaves room for that extension; the lift
itself does not pre-commit to it.
