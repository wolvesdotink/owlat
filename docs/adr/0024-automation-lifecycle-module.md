# Automation lifecycle module — single writer of `automations.status`, the last untyped state machine

**Status:** accepted

## Context

`automations.status` is the only top-level row-status machine in the
codebase without a lifecycle module. Send (ADR-0006), Postbox outbound
(ADR-0012), DOI (ADR-0009), Inbox processing (ADR-0010), Abuse (ADR-
0011), Campaign (ADR-0017), Sending domain (ADR-0018), Template
(ADR-0022) — eight rows have one. Automation is the conspicuous
absentee.

The surface is small (three statuses, four writers, ~95 LOC of
transition code) but the drift signature is the same shape every prior
ADR closed: open-coded `if (status !== 'X')` gates, optional /
inconsistently-applied side effects per transition, no audit-log
coverage, a one-way `pause` door, and trigger-config validation that
only runs the first time.

### Writer landscape — `automations.status`

| Producer | Path | Transition | Audit log | `trackEvent` | Validates trigger config |
|---|---|---|---|---|---|
| Create | `automations.ts:260` | `(insert) → draft` | ❌ | ❌ | n/a |
| Duplicate | `automations.ts:453` | `(insert) → draft` | ❌ | ❌ | n/a |
| Activate | `automations.ts:370` | `draft → active` | ❌ **drift** | ✅ `automation_activated` | ✅ |
| Pause | `automations.ts:397` | `active → paused` | ❌ **drift** | ✅ `automation_paused` | n/a |
| Resume | `automations.ts:424` | `paused → active` | ❌ **drift** | ❌ **drift** | ❌ **drift** |

Five real writers (two inserts at `draft`, three transitions). Three
distinct drift signals across three transitions.

### 1. Zero audit-log coverage on any transition

`auditActions/catalog.ts` declares actions like `campaign.scheduled`,
`sending_domain.verified`, `doi.confirmed`, `contact.imported` — eight
modules' worth of `<area>.<verb>` audit literals. There is no
`automation.*` action declared and no `recordAuditLog` call in the
activate / pause / resume paths.

A platform admin auditing "who paused this automation at 3am" finds
nothing. The pause timestamp is preserved in `pausedAt`; the actor is
not. Same silent-drift pattern that ADR-0011 closed for
`abuseStatus` writes and ADR-0017 closed for ten Campaign-status
transitions.

### 2. `resume` silently skips `trackEvent`

```ts
// automations.ts:370 — activate
await trackEvent(ctx, session, 'automation_activated', { automationId });

// automations.ts:397 — pause
await trackEvent(ctx, session, 'automation_paused', { automationId });

// automations.ts:424 — resume
// (no trackEvent call)
```

Three transitions, two `trackEvent` calls. Analytics dashboards built
on PostHog `automation_*` events under-report any automation resume.
The drift exists because `resume` was added later as a copy of
`activate` with the trackEvent line dropped — the same shape ADR-0017
closed for the `*ForOrganization` HTTP siblings of Campaign mutations.

### 3. Trigger-config validation only runs on `draft → active`

```ts
// automations.ts:360-368 — inside `activate`
if (automation.triggerType === 'contact_updated' && !automation.triggerConfig) {
  throwInvalidInput('Contact Updated trigger requires a property to watch');
}
if (automation.triggerType === 'event_received' && !automation.triggerConfig) {
  throwInvalidInput('Event Received trigger requires an event name');
}
if (automation.triggerType === 'topic_subscribed' && !automation.triggerConfig) {
  throwInvalidInput('Topic Subscribed trigger requires a topic selection');
}
```

These checks live inside the `activate` handler. The `resume` handler
(line 408-430) has no validation block. A paused automation whose
referenced topic was deleted, or whose contact property was renamed,
resumes silently into a broken `active` state — the **Trigger fanout**
later filters it out as a no-op match per fired trigger.

The bug is theoretical today because `updateTrigger` (line 321) refuses
non-draft automations, so the config can't go stale via that path. But
deleting a topic that an automation references doesn't propagate to the
automation row — the validation gap is one upstream-delete away from
real.

### 4. `paused` is a one-way door (no path back to draft)

The current edge set is `draft → active`, `active → paused`,
`paused → active`. There is no `paused → draft` writer.

To re-edit an active automation, the admin must either delete it
(refused by `remove` when status is `active`, allowed when `paused`)
and rebuild from scratch, or duplicate it and pause-then-delete the
original. The duplicate path loses analytics history. Same shape as
the `pending_review` one-way door ADR-0017 closed for Campaigns.

### 5. Implicit `LEGAL_EDGES` spread across four mutations

```ts
// activate: `if (automation.status === 'active') throwInvalidState(...)`
// pause:    `if (automation.status !== 'active') throwInvalidState(...)`
// resume:   `if (automation.status !== 'paused') throwInvalidState(...)`
// duplicate: implicit — always inserts at 'draft'
// updateTrigger: `if (automation.status !== 'draft') throwInvalidState(...)`
// remove:        `if (automation.status === 'active') throwInvalidState(...)`
```

The edge graph is six `if` checks across two files. A new edge
(`paused → draft`) requires editing two files and convincing yourself
no other gate refuses the same combination from the wrong angle.
Same drift the **Sending domain lifecycle (module)** (ADR-0018)
closed by collapsing six provider-specific status branches.

### 6. CONTEXT.md has no Automation status vocabulary

Pre-this-ADR, CONTEXT.md declares **Automation**, **Step**, **Step
module**, **Step outcome**, **Step walker**, **Trigger module**,
**Trigger fanout**, **Condition**, **Condition type module**,
**Condition editor module**, **Condition editor context** — eleven
terms across the Automations section — but does not name the
`automations.status` machine or its module. New devs asking "where
does pausing an automation live?" have no single answer; the writer
landscape table above is the answer they need.

This ADR adds **Automation status** and **Automation lifecycle
(module)** to CONTEXT.md alongside the existing terms.

### Shared framing

Per LANGUAGE.md's deletion test: deleting the three transition
mutations (activate, pause, resume) and inlining their bodies reveals
three near-mirror copies of "load automation → check current status →
patch new status → optionally trackEvent." The drift is structural
(audit-log gap, trackEvent gap, validation gap) and concentrates at
exactly the seam this ADR introduces. **The interface is the test
surface** — today's tests have to drive the public mutations to test
state transitions; under the lifecycle they can table-drive the
reducer directly.

Confidence: high. Pattern mirrors eight prior lifecycle modules. No
new architectural ground.

## Decision

One new module, one new public mutation, four new audit actions:

- **`automations/lifecycle.ts`** — **Automation lifecycle (module)**
  owns transitions of `automations.status`. Single entry point
  `transition({ automationId, input })`. The reducer per `to` is the
  only writer of `automations.status` and its companion fields
  `activatedAt`, `pausedAt`, `updatedAt`.
- **`automations/automations.ts:revertToDraft`** — new public
  mutation for the `paused → draft` edge. Auth-shell only; dispatches
  to the lifecycle.
- `auditActions/catalog.ts` gains `automation.activated`,
  `automation.paused`, `automation.resumed`,
  `automation.reverted_to_draft`.

### Automation lifecycle (module) shape

```ts
// apps/api/convex/automations/lifecycle.ts

export type AutomationStatus = 'draft' | 'active' | 'paused';

export type AutomationTransitionInput =
  | { to: 'active'; at: number; userId: string }
  | { to: 'paused'; at: number; userId: string }
  | { to: 'draft';  at: number; userId: string };

export type AutomationTransitionOutcome =
  | { ok: true;
      applied: 'transitioned' | 'recorded';  // recorded = idempotent self-loop
      from: AutomationStatus;
      to: AutomationStatus;
      automationId: Id<'automations'> }
  | { ok: false;
      reason: 'automation_not_found'
            | 'illegal_edge'
            | 'no_steps'                 // → active precondition
            | 'invalid_trigger_config';  // → active precondition
      from?: AutomationStatus;
      to?: AutomationStatus };

export const transition = internalMutation({
  args: { automationId: v.id('automations'),
          input: transitionInputValidator },
  handler: async (ctx, args): Promise<AutomationTransitionOutcome> => { ... }
});
```

### Automation status — legal edges

```
draft   → active            (activate; validates trigger config + ≥1 step)
active  → paused            (pause; in-flight automationRuns continue)
paused  → active            (resume; re-validates trigger config)
paused  → draft             (revertToDraft; new edge)
```

`active → draft` is refused as `illegal_edge` — admins must pause
first. No terminal states. Duplicate same-state attempts return
`{ ok: true, applied: 'recorded' }` — idempotent (audit row emitted,
no patch).

### Reducer per `to` — patch shape

| `to`     | `from`   | patch |
|----------|----------|-------|
| `active` | `draft`  | `{ status: 'active', activatedAt: at, pausedAt: undefined, updatedAt: at }` |
| `active` | `paused` | `{ status: 'active', pausedAt: undefined, updatedAt: at }` (preserves first-activate timestamp; same pattern as `verifiedAt` on Sending domain per ADR-0018) |
| `paused` | `active` | `{ status: 'paused', pausedAt: at, updatedAt: at }` |
| `draft`  | `paused` | `{ status: 'draft', activatedAt: undefined, pausedAt: undefined, updatedAt: at }` |

### Preconditions inside `→ active` reducer

Both checks run on `draft → active` AND `paused → active` (closes drift
#3):

1. `automationSteps` count > 0 → otherwise `{ ok: false, reason: 'no_steps' }`
2. Trigger config valid for trigger type (per the three open-coded
   checks at `automations.ts:360-368`) → otherwise
   `{ ok: false, reason: 'invalid_trigger_config' }`

Stats counters (`statsEntered`, `statsActive`, `statsCompleted`) are
lifetime. The reducer does not touch them on any edge — including
`paused → draft`. Same split as Campaign lifecycle (which zeroes
stats on `→ sending`) vs Send lifecycle (which bumps per-recipient
counters). Stats writes stay in **Trigger fanout** (`triggers.ts:152,
231`) and `stepExecutorQueries.ts:completeAutomationRun /
cancelAutomationRun`.

### Effects

```ts
type AutomationEffect =
  | { kind: 'audit_log';
      action: AuditAction;            // automation.activated | .paused
                                      // | .resumed | .reverted_to_draft
      automationId: Id<'automations'>;
      userId: string;
      details: Record<string, string | number | boolean | null> }
  | { kind: 'track_event';
      event: 'automation_activated' | 'automation_paused'
           | 'automation_resumed'   | 'automation_reverted_to_draft';
      automationId: Id<'automations'>;
      userId: string };
```

Per-transition effect table:

| Transition | `audit_log` action | `track_event` event |
|---|---|---|
| `draft → active`   | `automation.activated`         | `automation_activated`         |
| `active → paused`  | `automation.paused`            | `automation_paused`            |
| `paused → active`  | `automation.resumed`           | `automation_resumed`           |
| `paused → draft`   | `automation.reverted_to_draft` | `automation_reverted_to_draft` |
| self-loop (any)    | `<matching action>` w/ `{ no_op: true }` | (none) |

`userId` is `session.userId` from the public mutation shell. No
`system:*` synthetic userIds today — Automation has no scheduler-tick
or background-process transition writers (contrast Campaign lifecycle
which carries `system:scheduler_tick` etc).

### Public-mutation shells after the deepening

The four shells in `automations/automations.ts` collapse to auth +
feature gate + dispatch:

```ts
export const activate = mutation({
  args: { automationId: v.id('automations') },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    await assertFeatureEnabled(ctx, 'automations');
    requirePermission(
      hasPermission(session.role, 'automations:manage'),
      'Only owners and admins can activate automations'
    );
    const outcome = await ctx.runMutation(
      internal.automations.lifecycle.transition,
      { automationId: args.automationId,
        input: { to: 'active', at: Date.now(), userId: session.userId } }
    );
    if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
  },
});
// pause, resume, revertToDraft mirror exactly with `to: 'paused' | 'active' | 'draft'`
```

`reasonToMessage` is a one-line mapping kept in the shell file —
`'no_steps'` → "Automation must have at least one step to be
activated", etc. The lifecycle's typed `reason` is the contract; the
human string is shell-local.

### What stays outside the lifecycle

- `create` (line 240) and `duplicate` (line 433) — direct CRUD inserts
  at `status: 'draft'`. Same split as Campaign lifecycle vs Campaign
  create. The duplicate path loses no information by skipping the
  lifecycle because there is no `draft → draft` transition to record.
- `remove` (line 483) — direct CRUD delete. Refuses `active`; allows
  `paused` and `draft`. The lifecycle never transitions a row to
  deletion; rows leave the table via this mutation.
- `updateTrigger` (line 300) — `status !== 'draft'` field-level write
  gate. Stays in the CRUD shell. With `paused → draft` now legal, the
  edit path becomes: pause → revertToDraft → updateTrigger → activate.
  Previously: pause → delete → rebuild.
- `assertFeatureEnabled('automations')` — per-shell, same as every
  other lifecycle (none of the eight lifecycle modules in the codebase
  consult feature flags).
- Stats deltas — driven by trigger fanout and run completion, untouched
  by the lifecycle.
- `automationRuns.status` and `automationStepRuns.status` — their own
  state spaces. An in-flight `running` run is unaffected by a parent
  `active → paused` transition. Future candidates for their own
  lifecycle modules, out of scope here.

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `automations.ts:333-379` (activate) | 47-line mutation: load, gate, validate steps, validate trigger config, patch, trackEvent | 12-line shell: auth + dispatch |
| `automations.ts:381-405` (pause) | 25-line mutation: load, gate, patch, trackEvent | 12-line shell |
| `automations.ts:407-430` (resume) | 23-line mutation: load, gate, patch (no trackEvent) | 12-line shell |
| n/a | n/a | new `revertToDraft` mutation, ~12-line shell |
| n/a | n/a | new `lifecycle.ts` module, ~250 LOC |

### Closes drift bugs

1. Zero audit-log coverage on automation transitions — all four edges
   now emit `audit_log` effects (drift #1).
2. Missing `trackEvent('automation_resumed')` — closed by typed
   effect-per-transition table (drift #2).
3. Validation skipped on `paused → active` resume — `→ active`
   reducer always validates (drift #3).
4. `paused` one-way door — new `paused → draft` edge plus
   `revertToDraft` public mutation (drift #4).
5. Implicit edge graph spread across six `if (status !== 'X')` checks
   — single `LEGAL_EDGES` constant (drift #5).
6. CONTEXT.md vocabulary gap — added in this ADR (drift #6).

### Tests

The reducer is pure: `(automation, stepCount, input) → ReducerResult`.
Tests cover:

1. Edge legality matrix: every `(from, to)` pair against `LEGAL_EDGES`,
   asserting `applied: 'transitioned'` for legal, `reason:
   'illegal_edge'` for illegal, `applied: 'recorded'` for self-loops.
2. Per-transition patch shape: assert each row of the patch table
   above against a fixture automation.
3. Preconditions: `no_steps` returned when `stepCount === 0`,
   `invalid_trigger_config` returned for each of the three trigger
   kinds with missing config.
4. Effects emitted: each row of the per-transition effect table.

Integration tests (existing in
`__tests__/automations.integration.test.ts`) shift from driving the
public mutations directly to asserting the audit-log row and PostHog
event landed alongside the status change. The existing tests at lines
72-75 (status filtering) and 132+ (activate/pause/resume drivers)
update to call the new shells and check the new effects.

## Consequences

**Closes the last untyped major lifecycle in the codebase.** Every
top-level row-status machine now lives in a lifecycle module:
Campaign, Send, Postbox outbound, DOI, Inbox processing, Abuse,
Sending domain, Template, Automation.

**Surface area added:** ~250 LOC in `lifecycle.ts`, ~50 LOC in
`auditActions/catalog.ts` additions, ~15 LOC for the new
`revertToDraft` shell. Net LOC roughly flat against the ~95 LOC of
transition code removed from `automations.ts`.

**One new behavior:** `paused → draft` edge — admins can revert paused
automations to draft for re-editing without delete-and-rebuild. The
prior workaround (duplicate + delete the original) loses analytics
history; this preserves it.

**One re-tightened invariant:** `paused → active` resume now
re-validates trigger config. A paused automation whose referenced
topic was deleted can no longer silently resume into a broken-but-
filtering active state. Behaviorally the difference surfaces only if
upstream deletes have raced ahead of the automation row — rare today,
but the gate closes a latent edge.

**Migration:** Behind a one-shot internal mutation that walks every
automation row and asserts `LEGAL_EDGES.{status}` is non-empty. No
data backfill required — the schema is unchanged; only the writers
are. Existing rows pass through the lifecycle unchanged on their next
transition.

**No risk to in-flight runs:** the deepening leaves `automationRuns`
and the **Step walker** untouched. A `pause` mid-run still leaves
that run completing — confirmed product decision per the grilling
session, contradicting prior intuition that pause might mean
"cancel everything." Recording this here so future re-suggestions
of "pause should cancel runs" can find the rejection.

**Out of scope for follow-up:** `automationRuns.status` lifecycle
(`running → completed | cancelled` — would own the stats deltas
currently in `stepExecutorQueries.ts`), `automationStepRuns.status`
lifecycle (`pending → executing → completed | failed | skipped`),
both of which are sibling state spaces under the same area but
neither bleeds into this ADR's scope.
