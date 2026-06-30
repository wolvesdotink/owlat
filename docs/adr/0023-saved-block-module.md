# Saved block module — event-with-effects surface plus rerender pool for stale-HTML recovery

**Status:** accepted

## Context

Four files own the saved-block concept across `apps/api/convex/`:

| File | LOC | Role |
|---|---|---|
| `emailBlocks.ts` | 355 | CRUD on `emailBlocks` rows + the open-coded `if (contentChanged) … else if (nameChanged)` propagation branch |
| `lib/linkedBlockPropagation.ts` | 324 | Three cascade-walk helpers (`propagateBlockContentUpdate`, `propagateBlockNameUpdate`, `detachBlockFromAllEmails`) plus the `updateBlockUsageCounts` helper consumed by template lifecycles |
| `linkedBlockRender.ts` | 171 | `'use node'` action that re-renders consumer HTML after content propagation |
| `linkedBlockRenderHelpers.ts` | 55 | Internal query/mutation wrappers the action calls back into |

905 LOC across four files, none under a subdirectory. ADR-0021's
established convention is to move into a subdirectory once an area
crosses three files; this area is past that threshold today.

ADR-0022 (proposed) deepened the publish-state machine on both template
tables into sibling lifecycle modules. As part of that, the
`update_block_usage_counts` effect on each lifecycle now invokes
`updateBlockUsageCounts` from `lib/linkedBlockPropagation.ts`. The
saved-block side of the linkage — the writes to `emailBlocks.usageCount`,
the propagation walks into consumers, the HTML re-render — was left as
follow-up. This ADR closes that gap.

### What the area does today

A **Saved block** (the row in `emailBlocks`) carries `name`,
`description?`, `content` (the source block JSON), and a denormalized
`usageCount`. It is embedded into one or more **Saved block consumer**
rows (`emailTemplates` or `transactionalEmails`) via:

- The consumer's `linkedBlockIds: string[]` listing which saved blocks
  it references
- Per-block `savedBlockRef: { blockId, groupId, blockName }` annotations
  inside the consumer's content JSON

When a saved block's content changes, every consumer's content JSON
needs the embedded blocks replaced, and the consumer's pre-rendered
`htmlContent` needs regenerating. When the name changes, only the
`savedBlockRef.blockName` annotation needs updating (the HTML is fine).
When the row is deleted, every consumer needs its `savedBlockRef`
cleared and the `blockId` removed from `linkedBlockIds`.

### Drift landscape

Five drift signals.

#### 1. Open-coded `if (contentChanged) … else if (nameChanged)` branch

`emailBlocks.ts:196-225` classifies the patch in-line and calls one of
two helpers, then schedules a third action:

```ts
if (contentChanged) {
  const result = await propagateBlockContentUpdate(ctx, args.blockId, newContent, newName);
  if (result.templateIds.length > 0 || result.transactionalIds.length > 0) {
    await ctx.scheduler.runAfter(0, internal.linkedBlockRender.reRenderEmails, {
      templateIds: result.templateIds,
      transactionalIds: result.transactionalIds,
    });
  }
} else if (nameChanged) {
  await propagateBlockNameUpdate(ctx, args.blockId, updates.name!);
}
```

No typed effect list. Adding a fifth observable event — say "block
published to a marketplace" with its own propagation — means writing a
fifth `else if` branch and discovering the right place to schedule the
right side effect. The branch + fire-and-forget pattern is what the
codebase replaced four lifecycles ago.

#### 2. `parseContentBlocks` duplicated identically

Both `lib/linkedBlockPropagation.ts:18` and `linkedBlockRender.ts:24`
contain identical 22-line implementations. They handle the same three
content-JSON shapes (multi-block, legacy array, single block). They
will drift the moment one adds a fourth shape.

#### 3. Four open-coded cascade walks

The same shape — `ctx.db.query('emailTemplates').collect()` (full table
scan, no index) → filter by `linkedBlockIds.includes(savedBlockId)` →
`parseContentBlocks(row.content)` → walk for `savedBlockRef.blockId
=== savedBlockId` → mutate → serialize → patch; then again for
`transactionalEmails` — appears four times:

- `lib/linkedBlockPropagation.ts:57` `propagateBlockContentUpdate`
- `lib/linkedBlockPropagation.ts:170` `propagateBlockNameUpdate`
- `lib/linkedBlockPropagation.ts:265` `detachBlockFromAllEmails`
- `linkedBlockRender.ts:46` `reRenderEmails`

Each loop owns its own per-block transform but the table-iteration and
parsing skeleton is identical. The walker is the seam that should be
deep.

#### 4. Dead `incrementUsage` mutation

`emailBlocks.ts:270` exposes `incrementUsage` to public callers — zero
matches anywhere in `apps/`. The mechanism was superseded by
ADR-0022's `update_block_usage_counts` effect on the template
lifecycles, which auto-maintains the count when a consumer's
`linkedBlockIds` array changes. The mutation is a footgun for any
future caller that finds it and thinks it's the right surface.

#### 5. Fire-and-forget re-render with silent failure

`emailBlocks.ts:213` does
`ctx.scheduler.runAfter(0, internal.linkedBlockRender.reRenderEmails, …)`.
The mutation commits with the content propagation; the action runs
out-of-band. If the action fails (renderer crash, OOM, transient
network blip), `propagation` is already on the consumer rows but
`htmlContent` is stale. The action's own error handler logs and
continues per `linkedBlockRender.ts:108,166`:

```ts
} catch (error) {
  logError(`Failed to re-render template ${templateId}:`, error);
}
```

There is no durable signal that HTML is out of date with the source
blocks. The next publish or manual edit regenerates HTML; if neither
happens, the discrepancy lives until someone notices.

#### 6. Open-coded `updateBlockUsageCounts` calls bypassing the lifecycle

Post-ADR-0022, the canonical path for `linkedBlockIds` changes is
through the lifecycle's `update_block_usage_counts` effect. But two
sites still call `updateBlockUsageCounts` directly:

- `emailTemplates/emails.ts:108`
- `transactional/emails.ts:252`

Either ADR-0022 missed these or they were left as a known gap. Either
way, they're a second writer alongside the lifecycle effect — exactly
the "two writers, divergent semantics" pattern the deepening principle
exists to close.

### Why a lifecycle is the wrong framing

Saved blocks have no `status` column. There is no state machine,
because every observable event is unconditional: create, update,
duplicate, delete. A lifecycle module with a `LEGAL_EDGES` graph
mapping `status → status[]` would be a graph with one node and zero
edges. The framing doesn't fit.

The closest analog in the codebase is **Topic subscription (module)**:
no status machine, multiple entry points covering the row-write shapes
that exist in code (`subscribe`, `subscribeMany`, `unsubscribe`,
`unsubscribeMany`, `unsubscribeAllForContact`), each emitting a typed
atomic effect list. Same shape applied to saved blocks: row writes
(create, update, duplicate, remove) each emit a typed effect list,
with the walker behind one private helper.

### Why the workpool

The fire-and-forget rerender at `emailBlocks.ts:213` is the load-
bearing failure surface. Two postures considered:

- **Cron-driven retries** — periodic reconcile of stale rows (mirror
  `topics.reconcileMemberCounts`). Up to 15 minutes of latency between
  failure and retry. No new pool infra; same cron pattern the codebase
  already runs.
- **Workpool-driven retries** — enqueue the rerender into a pool with
  declared retry schedule. Reactive: backoff fires immediately on
  failure. Mirrors `campaignEmailPool` / `transactionalEmailPool`.

Workpool wins. Saved-block edits flow through the editor UI; an
operator hits Save, sees the consumer list "stale" briefly, and
expects the HTML to catch up within seconds, not a quarter-hour. The
workpool also gives a natural failure-handler shape (`onComplete`
fires on terminal failure with the typed error envelope) that the
cron approach would have to reinvent.

## Decision

Introduce the **Saved block (module)** at `convex/emailBlocks/module.ts`
and the **Saved block rerender pool** at `convex/emailBlocks/rendering.ts`.
Move the four pre-deepening files under `convex/emailBlocks/`:

| Before | After |
|---|---|
| `convex/emailBlocks.ts` | `convex/emailBlocks/blocks.ts` |
| `convex/lib/linkedBlockPropagation.ts` | DELETED — exports migrate to `module.ts` |
| `convex/linkedBlockRender.ts` | `convex/emailBlocks/rendering.ts` (absorbs the helpers below) |
| `convex/linkedBlockRenderHelpers.ts` | DELETED — absorbed into `rendering.ts` |
| (new) | `convex/emailBlocks/module.ts` |

Add `htmlRenderState` to both consumer schemas. Add a new audit-action
group `email_block.*` to the catalog. Register `rerenderBlocksPool` in
`convex.config.ts`.

The CONTEXT.md vocabulary lands alongside this ADR (already landed —
new section `## Saved blocks` with four entries: **Saved block**,
**Saved block consumer**, **Saved block (module)**, **Saved block
rerender pool**; plus updates to the `update_block_usage_counts`
lines in the **Email template lifecycle (module)** and
**Transactional email lifecycle (module)** entries).

### Module shape — Saved block (module)

```ts
// convex/emailBlocks/module.ts

export const create = internalMutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    content: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'emailBlocks'>> => {
    // Insert row at usageCount: 0; fire audit_log.
  },
});

export const update = internalMutation({
  args: {
    blockId: v.id('emailBlocks'),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.string()),
      content: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args): Promise<UpdateOutcome> => {
    // Classify which fields changed.
    // Patch the row.
    // Build effect list:
    //   contentChanged → propagate_content + schedule_rerender + audit_log
    //   nameChanged    → propagate_name + audit_log (if not also content)
    //   descOnly       → audit_log
    // Apply effects in order (propagate_* are mutation-context; schedule_*
    // enqueues into the rerender pool).
  },
});

export const duplicate = internalMutation({ /* clone with name → "<n> (Copy)", usageCount: 0; audit_log */ });
export const remove = internalMutation({ /* detach_all + audit_log; then delete row */ });

// Cross-cutting entry for Saved block consumer lifecycles.
export const updateBlockUsageCounts = internalMutation({
  args: {
    previousIds: v.array(v.string()),
    nextIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    // Single writer of emailBlocks.usageCount. Increments for newly
    // added, decrements for newly removed.
  },
});

// Private — the shared walker.
async function walkConsumers<T>(
  ctx: MutationCtx,
  blockId: string,
  transform: (blocks: EditorBlock[]) => EditorBlock[] | null
): Promise<{ templateIds: Id<'emailTemplates'>[]; transactionalIds: Id<'transactionalEmails'>[] }> {
  // One implementation. Three effect handlers (propagate_content,
  // propagate_name, detach_all) call it with different transforms.
  // The canonical parseContentBlocks lives here.
}
```

### Effect shape

The effect list and its semantics live in CONTEXT.md's **Saved block
(module)** entry. Recapped here for completeness:

- `propagate_content` — runs `walkConsumers(blockId, replaceLinkedBlocks)`.
  For every consumer row touched, the patch includes both the new
  content JSON *and* `htmlRenderState: { stale: true, failureCount: 0 }`
  — the two writes are atomic within the Convex mutation.
- `propagate_name` — runs `walkConsumers(blockId, renameLinkedBlocks)`.
  Mutates `savedBlockRef.blockName` only; does not touch
  `htmlRenderState` (block names don't appear in rendered HTML).
- `detach_all` — runs `walkConsumers(blockId, detachLinkedBlocks)`.
  Patches both content JSON (with `savedBlockRef` removed) and the
  consumer's `linkedBlockIds` array (with `blockId` stripped).
- `schedule_rerender` — enqueues `rerenderBlocksPool.enqueueAction(
  internal.emailBlocks.rendering.reRenderEmails, { templateIds,
  transactionalIds })`. The pool runs the action with retries; on
  terminal failure, `onComplete` patches
  `htmlRenderState.failureCount += 1` + `lastFailureAt` and fires the
  `email_block.rerender_failed` audit action.
- `audit_log(action, details?)` — fires on every entry. New audit
  actions: `email_block.created`, `.updated` (with
  `details: { contentChanged, nameChanged }`), `.duplicated`,
  `.deleted`, `.rerender_failed`.

### Module shape — Saved block rerender pool

```ts
// convex/emailBlocks/rendering.ts (excerpt)

import { Workpool } from '@convex-dev/workpool';
import { components } from '../_generated/api';

export const rerenderBlocksPool = new Workpool(components.rerenderBlocksPool, {
  maxParallelism: 5, // batches of consumer-row re-renders; lower than email pools
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 3,
    initialBackoffMs: 1000,
    base: 2,
  },
});

// Action — runs the renderer with 'use node'.
export const reRenderEmails = internalAction({
  args: {
    templateIds: v.array(v.id('emailTemplates')),
    transactionalIds: v.array(v.id('transactionalEmails')),
  },
  handler: async (ctx, args) => {
    // For each consumer:
    //   load row → parse content → renderEmailHtml → patch htmlContent
    //   + htmlTranslations (if any) + clear htmlRenderState.stale.
    // Any per-row error throws → workpool retries the whole job.
  },
});

// onComplete — translates the workpool outcome into the failure record.
export const onRerenderComplete = internalMutation({
  args: { /* workpool callback signature */ },
  handler: async (ctx, args) => {
    if (args.result.kind === 'failed') {
      // For each consumer in the failed job:
      //   patch htmlRenderState.failureCount += 1, lastFailureAt = now
      //   fire audit_log({ action: 'email_block.rerender_failed', ... })
    }
  },
});
```

### Schema additions

Both `emailTemplates` and `transactionalEmails` gain one field:

```ts
htmlRenderState: v.optional(v.object({
  stale: v.boolean(),
  failureCount: v.optional(v.number()),
  lastFailureAt: v.optional(v.number()),
})),
```

The field is optional. Existing rows have it `undefined`, which the
send path treats as "not stale" — equivalent to the pre-deepening
default. No backfill required.

### Send-path posture — log only, gating deferred

The **Campaign send orchestrator (module)** and **Transactional send
intake (module)** read `htmlRenderState.stale` at dispatch time. If
true: write a warning log (`htmlRenderState.stale at send time for
<consumerId>; using cached htmlContent`) and proceed. They do *not*
refuse the send. Adding a refusal gate is a behavior change with
operator-visible impact (a stale flag could block a campaign mid-
send); it deserves its own decision.

The deepening makes the surface available. The gate can layer on
later as a one-line check in each send path.

## Considered options

### Shape — lifecycle vs event-with-effects

**Chosen: event-with-effects** (Topic subscription analog).

A lifecycle module would have one state, zero edges, and a
`LEGAL_EDGES` graph existing only to fit the shape. The reducer per
"transition" would be a reducer per "row write," which is what
event-with-effects already is — without the ceremony.

The codebase has both patterns. Lifecycle modules
(**Campaign lifecycle (module)**, **Email template lifecycle (module)**,
etc.) own state machines on a `status` column. Event-with-effects
modules (**Topic subscription (module)**, **Contact resolution
(module)**, **Form submission (module)**) own row-write surfaces with
atomic effect lists but no status. Saved blocks fit the second
cluster.

### `updateBlockUsageCounts` location — module vs lib

**Chosen: module.**

Either (a) move into the new saved-block module as an exported entry
point — template lifecycles import from there — or (b) leave in
`lib/`, renaming the file once the other three propagation helpers
have moved out.

(a) wins on ownership clarity. Topic subscription owns *all* writes to
`contactTopics` *and* the `topics.cachedMemberCount` denormalization;
the parallel is "saved-block module owns all writes to `emailBlocks.*`
including the `usageCount` denormalization." Split ownership of
`emailBlocks.usageCount` between two locations is the exact friction
the deepening exists to close.

The asymmetry is that template lifecycles call into the saved-block
module from their `update_block_usage_counts` effect. That's
acceptable — cross-module effect dispatch is the established pattern
(**DOI lifecycle (module)**'s `fire_topic_subscribed_triggers` reaches
into **Topic subscription (module)**'s trigger surface; **Campaign
lifecycle (module)**'s `start_ab_test_if_enabled` reaches into the
**AB test lifecycle (module)**).

### Retry posture — workpool vs cron

**Chosen: workpool.**

Saved-block edits are interactive operations through the editor. A
15-minute reconcile interval (cron) is too long for the UX expectation
of "save and the change shows up." Workpool's reactive retries match
the user mental model. The pool infrastructure already exists for
sends (`campaignEmailPool`, `transactionalEmailPool`); adding
`rerenderBlocksPool` is one entry in `convex.config.ts` and one
`Workpool` declaration.

The cron approach was the simpler "no new pool" option but trades
infrastructure for UX latency. Wrong trade for this surface.

### Send-path posture — gate vs log

**Chosen: log only, gating deferred.**

Three postures considered: gate (refuse stale sends), inline-rerender
(regenerate on the send path), log (current behavior, plus the new
flag for visibility).

Gating is the strongest correctness guarantee but introduces a new
operator-visible failure mode (a stuck rerender blocks a campaign).
Inline-rerender adds the Node-only renderer to the send path, which
adds latency and an action-context dependency to a mutation-context
flow.

Log + flag preserves current behavior on the happy path but makes the
stale state queryable. A future operator surface or a future "gate
sends with override" feature plugs in without re-litigating the
schema decision.

### Dead-code `incrementUsage` — keep or delete

**Chosen: delete.**

Grep across `apps/` returns zero hits outside the definition site (the
coverage report doesn't count). The mechanism was already superseded
by ADR-0022's `update_block_usage_counts` effect. Keeping the dead
mutation invites a future contributor to call it and re-introduce the
two-writer divergence the deepening just closed.

### Subdirectory boundary — `emailBlocks/` vs absorbed into `emailTemplates/`

**Chosen: `emailBlocks/`.**

Saved blocks are upstream of the template tables — a template embeds
saved blocks, not the other way around. They have their own row table,
their own audit-action namespace, their own walker. Putting them under
`emailTemplates/` would invert the dependency direction and conflate
two distinct concepts.

## Consequences

### Files that collapse / disappear

| File | What happens |
|---|---|
| `convex/emailBlocks.ts` | Renamed → `convex/emailBlocks/blocks.ts`. Mutations (`create`, `update`, `duplicate`, `remove`) shrink to thin shells that delegate to `module.*`. Read queries (`list`, `get`, `getStatsByTeam`, `getRecentByTeam`, `listByTeam`, `createForTeam`) unchanged. `incrementUsage` deleted. |
| `convex/lib/linkedBlockPropagation.ts` | Deleted. Three propagation helpers become reducer effects in `module.ts`. Walker helpers (`parseContentBlocks`, `serializeContentBlocks`, `replaceLinkedBlocks`) become private to `module.ts`. `updateBlockUsageCounts` becomes the cross-cutting entry point on the module. |
| `convex/linkedBlockRender.ts` | Renamed → `convex/emailBlocks/rendering.ts`. The duplicated `parseContentBlocks` removed (imports from `module.ts`'s private export or shares via the walker). Gains the `rerenderBlocksPool` declaration and the `onComplete` mutation. |
| `convex/linkedBlockRenderHelpers.ts` | Deleted. Four internal queries/mutations absorbed into `rendering.ts`. |

### Files that grow

| File | What it gains |
|---|---|
| `convex/emailBlocks/module.ts` (new) | The module: four row-side entry points (`create`, `update`, `duplicate`, `remove`), cross-cutting `updateBlockUsageCounts`, private reducer per kind, private walker with canonical parsing, effects runner. ~350 LOC. |
| `convex/emailBlocks/rendering.ts` (renamed + grew) | `rerenderBlocksPool` declaration, `reRenderEmails` action, `onRerenderComplete` mutation, the four internal helpers from the absorbed `linkedBlockRenderHelpers.ts`. ~200 LOC. |
| `convex/schema/templates.ts` | `htmlRenderState` field added to `emailTemplates` and `transactionalEmails`. |
| `convex/auditActions/catalog.ts` | New literals: `email_block.created`, `.updated`, `.duplicated`, `.deleted`, `.rerender_failed`. |
| `convex/convex.config.ts` | New workpool component registration: `rerenderBlocksPool`. |
| `convex/emailTemplates/lifecycle.ts` | `update_block_usage_counts` effect imports from `emailBlocks/module` instead of `lib/linkedBlockPropagation`. |
| `convex/transactional/lifecycle.ts` | Same change. |
| `convex/emailTemplates/emails.ts` | Open-coded `updateBlockUsageCounts` call at `:108` removed — the lifecycle's effect path is the canonical writer. |
| `convex/transactional/emails.ts` | Same change at `:252`. |
| `convex/emails.ts` (Campaign send orchestrator) | Reads `htmlRenderState.stale` at dispatch time; logs a warning if true; does not gate. ~3 lines. |
| `convex/transactional/dispatch.ts` (Transactional send intake) | Same change. |

### Migration

Pre-prod. No data migration required — `htmlRenderState` is optional,
existing rows have it `undefined`, treated as "not stale" by the send
path. The `rerenderBlocksPool` registration is a one-line add to
`convex.config.ts`; Convex codegen wires the rest.

Steps:

1. **Add audit actions to `auditActions/catalog.ts`:**
   - `email_block.created`
   - `email_block.updated`
   - `email_block.duplicated`
   - `email_block.deleted`
   - `email_block.rerender_failed`
2. **Add `htmlRenderState` field** to `emailTemplates` and
   `transactionalEmails` schemas in `convex/schema/templates.ts`.
3. **Register `rerenderBlocksPool` component** in
   `convex/convex.config.ts`.
4. **Create `convex/emailBlocks/` directory.** Move the three existing
   files in:
   - `emailBlocks.ts → emailBlocks/blocks.ts`
   - `linkedBlockRender.ts → emailBlocks/rendering.ts`
   - `linkedBlockRenderHelpers.ts → (delete; contents merge into rendering.ts)`
5. **Write `convex/emailBlocks/module.ts`** — five entry points
   (`create`, `update`, `duplicate`, `remove`, `updateBlockUsageCounts`),
   private reducers, walker with canonical `parseContentBlocks`, effects
   runner.
6. **Wire `rerenderBlocksPool`** into `rendering.ts` with the
   `Workpool` declaration, the `reRenderEmails` action body adapted
   to throw on per-row failure (so the pool retries), and the
   `onRerenderComplete` mutation that handles terminal-failure
   bookkeeping.
7. **Rewire `emailBlocks/blocks.ts` shells:**
   - `create`, `duplicate`, `remove` delegate to `module.*`.
   - `update` delegates to `module.update`.
   - `incrementUsage` is deleted (zero callers).
   - Read queries unchanged.
8. **Rewire template lifecycle effects:** `emailTemplates/lifecycle.ts`
   and `transactional/lifecycle.ts` import `updateBlockUsageCounts`
   from `emailBlocks/module` instead of `lib/linkedBlockPropagation`.
9. **Close the open-coded `updateBlockUsageCounts` sites** at
   `emailTemplates/emails.ts:108` and `transactional/emails.ts:252` —
   delete the direct call; the canonical path is the lifecycle's
   `update_block_usage_counts` effect.
10. **Delete `convex/lib/linkedBlockPropagation.ts`.** Confirm no
    remaining imports.
11. **Add send-path warning logs** at the **Campaign send
    orchestrator** and **Transactional send intake** for stale
    `htmlRenderState`.
12. **Update cross-namespace imports** for the renamed `emailBlocks`
    files:
    - `api.emailBlocks.*` → `api.emailBlocks.blocks.*`
    - `internal.linkedBlockRender.*` → `internal.emailBlocks.rendering.*`
    - `internal.linkedBlockRenderHelpers.*` → `internal.emailBlocks.rendering.*`
    Convex codegen catches missed references at compile.
13. **Tests** — see below.

### Test surface

| Surface | Before | After |
|---|---|---|
| Content-only update fires `propagate_content + schedule_rerender + audit_log` | Untested — only testable end-to-end through `emailBlocks.update` and the fire-and-forget scheduler. | Reducer test asserts the effect list shape; walker test asserts the consumer-row patches with both `content` and `htmlRenderState.stale: true`. |
| Name-only update fires `propagate_name + audit_log` (no rerender) | Untested. | Reducer test asserts only `propagate_name` + `audit_log` in the effect list; assert `htmlRenderState` not touched. |
| Description-only update fires `audit_log` only | Untested. | Reducer test asserts no propagation effects. |
| `remove` fires `detach_all + audit_log` | Untested — only end-to-end via mutation. | Reducer test asserts the effect list; walker test asserts both content patch (savedBlockRef stripped) and `linkedBlockIds` array stripped. |
| Walker handles both consumer tables | Untested. | Integration test: insert one row in each consumer table that links to a shared block; assert both get patched in one call. |
| `updateBlockUsageCounts` increments/decrements correctly | Tested today only through manual call sites. | Cross-module integration test: call from template lifecycle's effect path, assert `emailBlocks.usageCount` reflects the delta. |
| Rerender pool retries on transient failure | Untested. | Test: throw from inside `reRenderEmails` for one of N consumer IDs; assert pool retries up to `maxAttempts`; assert success on retry clears `htmlRenderState.stale`. |
| Rerender pool terminal failure fires `rerender_failed` audit + sets `failureCount` | Untested. | Test: throw deterministically; assert `onRerenderComplete` increments `failureCount`, sets `lastFailureAt`, fires the audit action, leaves `stale: true`. |
| Send path reads `htmlRenderState.stale` and logs | Untested (no flag exists). | Integration test on campaign send: with `stale: true`, assert log line present, assert send completes. |

### Behavior

Identical to today on every successful path *except*:

- **Re-renders now retry on transient failure.** Today's fire-and-forget
  loses any failure; under the pool, transient errors retry up to 3
  times with backoff before terminal.
- **Stale state is observable.** Operators (and any future audit/admin
  surface) can query `htmlRenderState.stale: true` to find consumer
  rows whose HTML is out of date with their source blocks.
- **Persistent-failure rows write an audit row.** When retries are
  exhausted, `email_block.rerender_failed` lands in `auditLogs` with
  the consumer ID and failure count.
- **`updateBlockUsageCounts` runs through one writer.** The two
  open-coded direct calls at `emailTemplates/emails.ts:108` and
  `transactional/emails.ts:252` are deleted; the count updates only
  through the lifecycle's effect path.
- **All saved-block writes emit audit logs.** New rows in `auditLogs`
  with the actions listed above.
- **Description-only updates no longer touch downstream rows.** Today's
  branch falls through with no effect when only `description` changes;
  under the module the audit_log effect still fires (closing a silent-
  edit gap), but no propagation walks run. (Behavior change in spirit
  only — no observable side effect today either.)

The `incrementUsage` mutation is deleted but had zero callers; no
observable change for any current consumer.

### Vocabulary

Adds the section `## Saved blocks` to CONTEXT.md with four entries:
**Saved block**, **Saved block consumer**, **Saved block (module)**,
**Saved block rerender pool**. Updates the `update_block_usage_counts`
bullets in **Email template lifecycle (module)** and **Transactional
email lifecycle (module)** to reference the new module's entry point.

(Already landed alongside this ADR.)

## Follow-up work

- **Send-path gating.** Add a refusal gate on
  `htmlRenderState.stale: true` to the **Campaign send orchestrator
  (module)** and **Transactional send intake (module)**, with an
  operator override. Deferred because the failure mode (a stuck
  rerender blocks a campaign mid-send) has operator-visible impact
  worth thinking through separately.
- **Operator surface for `rerender_failed` rows.** A platform-admin
  view that lists consumer rows with `htmlRenderState.failureCount >=
  3`, exposing the last error and a "rerender now" action. Plugs in
  on top of this deepening with no shape change.
- **Index for `linkedBlockIds` lookup.** The walker scans full consumer
  tables today (`ctx.db.query('emailTemplates').collect()`). Convex
  doesn't natively index array fields; a sidecar `emailBlockConsumers`
  index table maintained by the template lifecycle's
  `update_block_usage_counts` effect would let the walker hit a
  point-lookup. Defer until the full-scan cost shows up in production
  metrics.
- **`updateSchema` mutation on transactional emails.** Carries the
  publish-invariant guard from ADR-0022 but doesn't itself touch
  saved-block linkages; out of scope here.

## Execution

### Steps

1. **Add five audit-action literals** to `auditActions/catalog.ts`.
2. **Add `htmlRenderState` schema field** to both consumer tables in
   `convex/schema/templates.ts`.
3. **Register `rerenderBlocksPool` component** in
   `convex/convex.config.ts`.
4. **Create `convex/emailBlocks/` directory**, move the three
   existing files in (deleting `linkedBlockRenderHelpers.ts` as its
   contents merge into `rendering.ts`).
5. **Write `convex/emailBlocks/module.ts`** — the four row-side entry
   points, the cross-cutting `updateBlockUsageCounts`, the private
   walker with canonical `parseContentBlocks`, reducers per kind,
   typed effect-list runner.
6. **Update `convex/emailBlocks/rendering.ts`** — add the workpool
   declaration, adapt `reRenderEmails` to throw on per-row failure,
   add `onRerenderComplete` that does the failure-bookkeeping patches.
7. **Rewire `emailBlocks/blocks.ts`** shells to delegate to `module.*`;
   delete the dead `incrementUsage`.
8. **Rewire template lifecycle imports** in
   `emailTemplates/lifecycle.ts` and `transactional/lifecycle.ts` to
   pull `updateBlockUsageCounts` from `emailBlocks/module`.
9. **Close the open-coded direct-call sites** at
   `emailTemplates/emails.ts:108` and `transactional/emails.ts:252`.
10. **Delete `convex/lib/linkedBlockPropagation.ts`** and confirm zero
    remaining imports.
11. **Add stale-HTML warning logs** at the Campaign send orchestrator
    and Transactional send intake dispatch sites.
12. **Update cross-namespace imports** for the renamed `emailBlocks/`
    files. Mechanical; codegen catches misses.
13. **Tests.** Per-effect reducer tests on the module. Walker tests
    on a fixture with rows in both consumer tables. Integration tests
    on the rerender pool's retry and terminal-failure paths.
    Send-path stale-log assertion.

### Verification greps

After execution, these should return zero matches:

```sh
# Old lib helper file is gone
test ! -f apps/api/convex/lib/linkedBlockPropagation.ts

# No file outside the module imports the old helpers
rg "from.*lib/linkedBlockPropagation" apps/api/convex/

# Old top-level files are gone
test ! -f apps/api/convex/emailBlocks.ts && \
test ! -f apps/api/convex/linkedBlockRender.ts && \
test ! -f apps/api/convex/linkedBlockRenderHelpers.ts

# Dead mutation is gone
rg "export const incrementUsage" apps/api/convex/

# No remaining open-coded updateBlockUsageCounts direct calls
rg "updateBlockUsageCounts\(" apps/api/convex/emailTemplates/emails.ts \
  apps/api/convex/transactional/emails.ts

# parseContentBlocks has exactly one definition
rg "function parseContentBlocks" apps/api/convex/ | wc -l   # → 1

# Old fire-and-forget rerender at emailBlocks.ts:213 is gone
rg "internal.linkedBlockRender" apps/api/convex/
```

These should return matches:

```sh
# New module files exist
test -f apps/api/convex/emailBlocks/module.ts && \
test -f apps/api/convex/emailBlocks/blocks.ts && \
test -f apps/api/convex/emailBlocks/rendering.ts

# Schema field is wired
rg "htmlRenderState" apps/api/convex/schema/templates.ts

# Workpool component is registered
rg "rerenderBlocksPool" apps/api/convex/convex.config.ts

# Audit actions in the catalog
rg "email_block\.(created|updated|duplicated|deleted|rerender_failed)" \
  apps/api/convex/auditActions/catalog.ts

# Lifecycles delegate to the new module
rg "from.*emailBlocks/module" apps/api/convex/emailTemplates/lifecycle.ts \
  apps/api/convex/transactional/lifecycle.ts

# Send-path stale logging
rg "htmlRenderState\.stale|htmlRenderState\?\.stale" apps/api/convex/emails.ts \
  apps/api/convex/transactional/dispatch.ts
```

### Done when

- `convex/emailBlocks/module.ts` exists with five entry points,
  walker, effect runner.
- `convex/emailBlocks/blocks.ts` mutations delegate; dead
  `incrementUsage` deleted.
- `convex/emailBlocks/rendering.ts` carries the workpool, action,
  onComplete, and the absorbed helper queries/mutations.
- `convex/lib/linkedBlockPropagation.ts` and
  `convex/linkedBlockRenderHelpers.ts` are deleted.
- Both consumer tables carry `htmlRenderState` in schema; the
  `propagate_content` effect writes it atomically with the content
  patch.
- `rerenderBlocksPool` is registered in `convex.config.ts` and used
  by `schedule_rerender`.
- Template lifecycles import `updateBlockUsageCounts` from the new
  module; the two open-coded direct calls are deleted.
- Send path logs (does not gate) on stale `htmlRenderState`.
- New audit actions in the catalog; every saved-block write fires one.
- The CONTEXT.md `## Saved blocks` section + the
  `update_block_usage_counts` updates in the two template-lifecycle
  entries match this ADR.
- Per-effect reducer tests, walker test, rerender-pool retry test,
  terminal-failure audit test all pass.
- The verification greps above all hold.
