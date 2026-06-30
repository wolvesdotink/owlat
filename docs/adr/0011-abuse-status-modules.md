# Abuse status modules — split writer (lifecycle) and reader (gate), drop dead `throttled` literal

**Status:** accepted

## Context

`instanceSettings.abuseStatus` is a five-state column
(`clean | warned | throttled | suspended | banned`) tracking org-level
enforcement state. It has **four writers** with divergent severity
rules and **many readers** that consult one of two pure helpers in
`lib/abuseHelpers.ts`. The write side has real drift; the read side
silently treats `throttled` as a no-op.

### Writer landscape

| Producer | Path | Severity check | banned-terminal | Audit log |
|---|---|---|---|---|
| Platform admin override | `platformAdmin/mutations.ts:setOrganizationStatus:14-61` | ❌ no check | ❌ no check | ✅ |
| MTA circuit breaker | `webhooks/dispatcher.ts:140-159` → `setAbuseStatusInternal` | ✅ via helper | ✅ via helper | ❌ |
| Internal helper | `organizationSettings.ts:setAbuseStatusInternal:446-495` | ✅ ad-hoc map at lines 472-478 | ✅ line 469 | ❌ |
| Reputation auto-enforcement | `analytics/sendingReputation.ts:autoEnforceReputation:229-263` | ❌ **bypasses helper**, ad-hoc rules (lines 246, 253) | ✅ inline line 244 | ❌ |

Four drift signals concentrate.

### 1. `autoEnforceReputation` bypasses `setAbuseStatusInternal`

`analytics/sendingReputation.ts:autoEnforceReputation` patches
`abuseStatus` **directly** via `ctx.db.patch(settings._id, ...)`,
duplicating but diverging from the severity logic in
`setAbuseStatusInternal`:

- `setAbuseStatusInternal:483` blocks **any** downgrade except to
  `clean`.
- `autoEnforceReputation:246` uses `currentStatus !== 'suspended'`
  (allows escalation only if not already at the target).
- `autoEnforceReputation:253` uses `!currentStatus` (only warns if
  no current status — refuses to warn an already-warned org, where
  `setAbuseStatusInternal` would silently no-op via severity check).

The two writers cannot agree on whether `warned → warned` is a no-op
or a refuse-without-warning. They cannot agree on whether `clean →
warned` after a prior `suspended` should escalate or refuse. Same
column, two policies.

### 2. Severity map is private to one mutation

```ts
// organizationSettings.ts:472-478
const statusSeverity: Record<string, number> = {
  clean: 0,
  warned: 1,
  throttled: 2,
  suspended: 3,
  banned: 4,
};
```

This map is the only place severity is encoded. It's a local `const`,
not exported. `autoEnforceReputation` cannot reuse it; its rules are
ad-hoc. Any future writer would either copy the map or invent a third
rule.

### 3. `banned`-is-terminal is checked in three places independently

- `organizationSettings.ts:469` — `if (settings.abuseStatus === 'banned') return;`
- `analytics/sendingReputation.ts:244` — `if (currentStatus === 'banned') return;`
- (Implicit) — `platformAdmin/mutations.ts:setOrganizationStatus` does
  **not** check, meaning admins can demote `banned` to `clean`. By
  design, but un-documented in code.

If a fourth writer arrives, it has to decide afresh whether `banned`
is terminal for *it*.

### 4. `throttled` is set but never gates anything

```ts
// lib/abuseHelpers.ts:37-40
export function isSendingAllowed(abuseStatus: string | null | undefined): boolean {
  if (!abuseStatus) return true;
  return abuseStatus !== 'suspended' && abuseStatus !== 'banned';
}
```

`requireSendingAllowed` is symmetric — throws on `suspended` and
`banned` only. Both readers treat `clean`, `warned`, and `throttled`
identically as "allow." The MTA circuit breaker writes `throttled`
via `webhooks/dispatcher.ts:146`, intending to signal "we noticed,
limit them" — but no consumer acts on it. `throttled` is dead state:
the literal exists in the schema, the writer code, the platform-admin
UI, but it has no semantic effect on sends. Today, `throttled ==
warned` operationally.

### 5. Audit log fires only on the admin path

`platformAdmin/mutations.ts:47-57` records an audit log on every
admin-driven status change. The three other writers — circuit breaker,
internal helper, reputation auto-enforcement — patch the row without
audit logging. An operator looking at the audit timeline sees admin
demotes and promotions, but sees nothing when the system itself
auto-suspends an org for sending abuse. Real observability gap.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one writer reveals the
same status-patch-with-companion-fields pattern open-coded across the
other three, with conflicting severity rules and conflicting audit-log
discipline.

The original /improve-codebase-architecture review framed this as "the
primary friction is on the read side, not the write side." That framing
was wrong. Reading the actual code:

- **Write side has real drift.** Two different severity-ladder
  implementations, scattered `banned`-terminal checks, missing
  audit-log effect on three of four writers.
- **Read side has dead state.** `throttled` is set but never read.

Both sides need a module. The shapes are different (write side is a
lifecycle; read side is a predicate surface), so they split into two
sibling modules. This mirrors the **Send lifecycle (module)** /
**Send reads (module)** split (ADR-0006): same column, sibling modules
divided by direction.

## Decision

Two modules at `apps/api/convex/organizations/`:

- `abuseStatus.ts` — owns *writes* of `abuseStatus` and its companion
  fields (lifecycle shape).
- `abuseGate.ts` — owns *reads* of `abuseStatus` for sending-allowed
  decisions (predicate surface).

A schema breaking change drops the dead `throttled` literal.

### Schema breaking change

`instanceSettings.abuseStatus` becomes
`v.union(v.literal('clean'), v.literal('warned'), v.literal('suspended'),
v.literal('banned'))`. The four-state union replaces the five-state
union. Pre-prod: no data migration needed at deploy time; if any
existing dev rows have `'throttled'`, a one-shot internal mutation
re-maps them to `'warned'`.

The MTA circuit-breaker path
(`webhooks/dispatcher.ts:140-159`) re-targets to
`{ to: 'warned', changedBy: 'mta_circuit_breaker' }`. Semantically
this matches today's effective behavior (circuit-breaker tripping has
never blocked sends; it was always advisory).

### `Abuse status (module)` shape

```ts
type AbuseStatus = 'clean' | 'warned' | 'suspended' | 'banned';

type TransitionInput = {
  to: AbuseStatus;
  at: number;
  reason: string;
  changedBy: string; // admin user id, or 'system' / 'mta_circuit_breaker' / 'reputation_auto'
};

type TransitionOutcome =
  | {
      ok: true;
      applied: 'transitioned' | 'recorded';
      from: AbuseStatus;
      to: AbuseStatus;
    }
  | {
      ok: false;
      reason: 'no_settings_row' | 'illegal_edge' | 'terminal' | 'severity_downgrade';
      from?: AbuseStatus;
      to?: AbuseStatus;
    };

// Internal-writer path (severity-checked, banned-terminal)
export const transition: (
  ctx,
  args: { input: TransitionInput }
) => Promise<TransitionOutcome>;

// Admin-override path (bypasses severity check, can leave banned)
export const adminOverride: (
  ctx,
  args: { input: TransitionInput }
) => Promise<TransitionOutcome>;
```

### Severity ladder

Exported as a module constant:

```ts
export const STATUS_SEVERITY: Record<AbuseStatus, number> = {
  clean: 0,
  warned: 1,
  suspended: 2,
  banned: 3,
};
```

`transition` enforces:

- `banned` is terminal — any transition out of `banned` returns
  `{ ok: false, reason: 'terminal' }`.
- Downgrades are refused with `severity_downgrade` *except* downgrades
  to `clean` (the "auto-recover" path; circuit breaker recovery and
  reputation-stats normalization both write `clean`).
- `same → same` transitions return `applied: 'recorded'` with no
  patch.

`adminOverride` enforces:

- No severity check; the admin can move between any two states,
  including escaping `banned`.
- Audit-log effect fires regardless.

### Reducer effects

- **`audit_log(action, previousStatus, newStatus, reason, changedBy)`**
  — fires on every transition (including `applied: 'recorded'` when
  the writer explicitly attempts a same-state write, so observability
  captures the attempt). Closes drift signal #5. The action literal
  is `'abuse_status_changed'` (new audit-action literal added to the
  ADR-0002 catalog).
- **`notify_admin(newStatus, reason)`** — placeholder; not wired to
  any channel today. Lands when the admin-notification surface ships
  (out of scope here — the effect is enumerated so callers don't need
  to add it later).

### `Abuse gate (module)` shape

```ts
import { type AbuseStatus } from './abuseStatus';

// Hot-path predicate for mutations (queries instanceSettings, throws
// ConvexError on suspended/banned)
export const requireSendingAllowed: (ctx: MutationCtx) => Promise<void>;

// Pure predicate over a status value already in hand (used in
// actions/HTTP handlers that fetched the status via a prior query)
export const isSendingAllowed: (status: AbuseStatus | null | undefined) => boolean;

// Reserved for future expansion. The gate is the only module that
// knows which states mean "block what" — internal writers don't,
// and downstream callers don't.
//
// e.g.
// export const canCreateCampaign: (status: AbuseStatus | null | undefined) => boolean;
// export const sendRateMultiplier: (status: AbuseStatus | null | undefined) => number;
```

Both functions are the same shape as today's
`lib/abuseHelpers.ts` exports — but co-located with the status module
and tied to the `AbuseStatus` type rather than `string | null | undefined`.

### Call-site shape after the cut

```ts
// platformAdmin/mutations.ts:setOrganizationStatus (was lines 14-61)
const outcome = await abuseStatus.adminOverride(ctx, {
  input: { to: args.abuseStatus, at: Date.now(), reason: args.reason, changedBy: admin.authUserId },
});
if (!outcome.ok) throwInvalidState(outcome.reason);
return { success: true, previousStatus: outcome.from, newStatus: outcome.to };
// Audit log fires from inside the module — no inline recordAuditLog call.
```

```ts
// webhooks/dispatcher.ts (was lines 140-159)
'internal.circuit_breaker_tripped': async (ctx, e) => {
  const outcome = await abuseStatus.transition(ctx, {
    input: {
      to: 'warned',  // was 'throttled'
      at: Date.now(),
      reason: `MTA circuit breaker: ${e.message}${
        e.bounceRate ? ` (bounce rate: ${e.bounceRate}%)` : ''
      }`,
      changedBy: 'mta_circuit_breaker',
    },
  });
  // outcome may be illegal_edge if already at higher severity — that's the right behavior.
},
```

```ts
// analytics/sendingReputation.ts:autoEnforceReputation (was lines 229-263)
const target = args.riskLevel === 'critical' ? 'suspended' : 'warned';
await abuseStatus.transition(ctx, {
  input: {
    to: target,
    at: Date.now(),
    reason: target === 'suspended'
      ? 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds'
      : 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds',
    changedBy: 'reputation_auto',
  },
});
// Severity check is now uniform — no ad-hoc currentStatus !== 'suspended' / !currentStatus rules.
```

```ts
// emails.ts:79,413 (unchanged signature, file moves from lib/abuseHelpers to organizations/abuseGate)
import { isSendingAllowed } from '../organizations/abuseGate';
if (!isSendingAllowed(orgSettings?.abuseStatus ?? null)) {
  throwInvalidState('Sending is not allowed for this organization');
}
```

## Considered options

### Module count

1. **Two modules: status writer + gate reader** *(chosen)*. The call-site
   populations are disjoint (3 internal writers + 1 admin caller vs many
   send-path readers); the concerns are different (severity rules vs
   gate semantics); the existing `lib/abuseHelpers.ts` shape already
   separated read-side into its own helpers. Mirrors the **Send
   lifecycle / Send reads** split.
2. **One module exporting both surfaces.** Simpler at the file level
   but conflates two responsibilities under one name. Rejected — the
   user explicitly chose the split during grilling for the clarity of
   "this module writes; this module reads."
3. **Three modules: status writer + gate reader + severity helper.**
   The severity map becomes its own export. Over-decomposed; rejected.

### Dead `throttled` literal

1. **Drop the literal (pre-prod schema change)** *(chosen)*. Four-state
   union: `clean | warned | suspended | banned`. The MTA
   circuit-breaker path re-targets to `warned`. Cleanest; no dead
   state lingers in the codebase.
2. **Give `throttled` actual semantics.** E.g., gate predicate becomes
   "blocks campaigns, allows transactional," or
   `sendRateMultiplier(throttled) → 0.5`. Real product decision;
   deferred. The gate-module surface is reserved (commented-out
   placeholders) to land this later as additions, not rewrites.
3. **Document that `throttled` is dead and leave it.** Lowest-effort
   but the deepening leaves a known dead literal in the codebase and
   in the UI. Rejected — pre-prod cleanup is essentially free.

### Severity ladder enforcement

1. **Refuse any downgrade except to `clean`** *(chosen — matches
   today's `setAbuseStatusInternal`)*. Auto-recover-to-clean is the
   only legitimate downgrade for internal writers (circuit-breaker
   recovery; reputation-stats normalization). Anything else
   (`suspended → warned`) requires admin override.
2. **Refuse any downgrade including to `clean`.** Stricter; circuit
   breaker can no longer auto-clear. Rejected — auto-clear is the
   intended recovery path.
3. **Allow all downgrades; internal writers handle severity
   themselves.** Defeats the deepening; rejected.

### `banned` is terminal — for whom?

1. **Terminal for `transition` (internal writers), reachable from
   `banned` only via `adminOverride`** *(chosen)*. Matches today's
   behavior (admin can demote; system cannot).
2. **Terminal for both `transition` and `adminOverride`.** Removes
   admin's ability to lift a ban; would require a separate
   `unbanOrganization` mutation. Rejected as scope creep — admins do
   need to lift bans (e.g., on appeal).
3. **Not terminal anywhere — `banned` is just the highest severity.**
   Internal writers could escalate above `banned` to nothing; doesn't
   change the rule for internal writers (severity downgrades still
   refused). Equivalent in practice; rejected for vocabulary clarity.

### Audit log scope

1. **Audit log fires on every transition including `recorded`**
   *(chosen)*. Observability captures every attempt, even no-ops
   (e.g., `warned → warned` from the circuit breaker means "the
   breaker tripped again while we were still in the warned state" —
   informative).
2. **Audit log fires only on `transitioned`.** Loses the
   "breaker keeps tripping" signal. Rejected.
3. **Audit log fires only on the admin path** (today's behavior).
   The drift signal we're closing. Rejected.

### Gate predicate evolution

1. **Reserve gate module for future expansion; today exports just the
   two functions matching `lib/abuseHelpers.ts`** *(chosen)*. When
   product decides `warned` should rate-limit or block campaigns
   only, the surface lands inside the gate module as additional
   exports — writers don't need to know.
2. **Eagerly add `canSendCampaign`, `canSendTransactional`,
   `sendRateMultiplier` placeholders now.** Speculative; YAGNI.
   Rejected — the empty placeholders are a tax on every read site
   to be aware of them.
3. **Make the gate module a Convex query for declarative use in UI.**
   Today's helpers are functions; turning them into queries forces
   every caller into Convex's reactive-subscription model. Rejected
   — they stay as pure helpers + one mutation-context-bound
   helper.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/organizationSettings.ts:446-495` —
  `setAbuseStatusInternal` is deleted; its callers (the dispatcher,
  the `autoEnforceReputation` path's re-routed call) point at
  `abuseStatus.transition`.
- `apps/api/convex/analytics/sendingReputation.ts:229-263` —
  `autoEnforceReputation` shrinks to ~10 LOC: target = critical ?
  'suspended' : 'warned', call `abuseStatus.transition`, done. The
  divergent severity rules disappear.
- `apps/api/convex/lib/abuseHelpers.ts` — file is deleted;
  `isSendingAllowed` and `requireSendingAllowed` move to
  `organizations/abuseGate.ts`. Imports updated at six call sites.
- `apps/api/convex/platformAdmin/mutations.ts:setOrganizationStatus` —
  the inline `ctx.db.patch` collapses to one `adminOverride` call;
  the inline `recordAuditLog` call collapses into the module's
  `audit_log` effect.
- `apps/api/convex/webhooks/dispatcher.ts:140-159` — the
  `setAbuseStatusInternal` runMutation call swaps to
  `abuseStatus.transition`; the target literal changes from
  `'throttled'` to `'warned'`.

### Files that grow

- `apps/api/convex/organizations/abuseStatus.ts` (new, ~220 LOC).
  Exports the `AbuseStatus` literal tuple and validator, the
  `STATUS_SEVERITY` map, the `TransitionInput` /
  `TransitionOutcome` types and validators, the `transition` and
  `adminOverride` `internalMutation`s, and per-transition reducers.
- `apps/api/convex/organizations/abuseGate.ts` (new, ~50 LOC).
  Exports `isSendingAllowed` and `requireSendingAllowed`, both keyed
  to the `AbuseStatus` type imported from `abuseStatus.ts`.
- `apps/api/convex/schema/auth.ts:64` — the `abuseStatus` validator
  union drops `v.literal('throttled')`.
- `apps/api/convex/contactActivities/catalog.ts` (or the audit
  catalog from ADR-0002) — adds `'abuse_status_changed'` to the
  audit-action literal set.

Net LOC change is favourable: ~120 LOC down across the writer scatter,
~270 LOC up across the two new modules. The value is locality, typed
contract, and the deletion of four drift bugs plus the elimination of
the dead `throttled` literal.

### Migration

Pre-production: a one-shot internal mutation at
`apps/api/convex/_internal/migrations/dropThrottledAbuseStatus.ts`
finds any dev rows with `abuseStatus: 'throttled'` and re-maps them
to `'warned'`. Runs at deploy time. Schema validator change lands
in the same PR.

If/when production data exists, the same migration logic applies —
no operationally meaningful change since `throttled` already had no
gating effect.

### Test surface

- `apps/api/convex/__tests__/abuseStatusLifecycle.integration.test.ts`
  (new, ~14 tests) — table-driven per
  `from-state × to-state × producer-path`. Covers the four-state
  graph, severity-downgrade refusals, `banned`-terminal refusals for
  `transition`, admin-override escape from `banned`, the audit-log
  effect on every transition (including `recorded`), the
  circuit-breaker re-target to `warned`, and the auto-recovery path
  to `clean`.
- `apps/api/convex/__tests__/abuseGate.test.ts` (new, ~6 tests) —
  pure predicate tests over the four-state value (`isSendingAllowed`
  + `requireSendingAllowed`). Replaces the existing
  `__tests__/abuseHelpers.test.ts` 1:1.
- The six existing call-site integration tests (`emails.ts`,
  `transactionalApiHttp.ts`, etc.) stay; their import path updates.

### Behavior

All caller-visible behaviors are preserved (with four drift bugs
fixed opportunistically and `throttled` re-mapped to `warned`):

- Platform-admin status changes still work (route via `adminOverride`).
- MTA circuit-breaker tripping still escalates the org's abuse
  status; the value changes from `throttled` to `warned`, but the
  send-gating effect is unchanged (both were always non-blocking).
- Reputation auto-enforcement still escalates on critical / high
  risk levels; severity rules now match the internal helper's rules
  (so `warned → warned` is now `recorded` not refused; `clean →
  warned` after a prior `suspended` is now refused as severity
  downgrade not silently accepted).
- Send and transactional-send gates still block `suspended` and
  `banned`.

Five drift signals are fixed opportunistically:

1. `autoEnforceReputation` now goes through the same severity rules
   as every other internal writer — drift signal #1.
2. `STATUS_SEVERITY` is exported from one module; no more local
   `const` in `organizationSettings.ts` — drift signal #2.
3. `banned`-terminal is checked once (in `transition`); `adminOverride`
   intentionally bypasses it — drift signal #3.
4. `throttled` is dropped; the dead state literal is gone from the
   schema, the writers, and the readers — drift signal #4.
5. Audit log fires on every transition, including internal-writer
   escalations and same-state `recorded` outcomes — drift signal #5.

### Vocabulary

CONTEXT.md gains a new **Abuse** section between **Inbox processing**
and **Automations**, with three entries: **Abuse status**,
**Abuse status (module)**, and **Abuse gate (module)**. A relationships
paragraph links the writers and the readers to the two-module split
and notes that abuse blocks send creation **upstream** of the
**Send lifecycle (module)** — abuse-blocked orgs never produce
`queued` Sends.

## Follow-up work

1. **`warned` semantics.** Today `warned` is purely advisory.
   Product decision pending: should `warned` rate-limit, throttle
   campaigns only, or stay advisory? When decided, the change lands
   inside `abuseGate.ts` as additional predicate exports —
   call-site changes are at the readers, not the writers.
2. **Audit-action catalog entry.** `'abuse_status_changed'` joins
   the ADR-0002 catalog. If/when the audit catalog grows enough to
   warrant per-action audit modules (analogous to per-event webhook
   modules), this is a candidate.
3. **Cross-deployment abuse signaling.** With single-org-per-deployment,
   each instance has its own `abuseStatus`. If/when a future control
   plane needs to propagate abuse signals across deployments (e.g.,
   "this user banned in deployment A should be flagged in deployment
   B"), the writer surface is the natural integration point.
4. **`webhooks/dispatcher.ts:internal.ip_event` handling.** The
   dispatcher's `internal.ip_event` handler does not call abuse
   transitions today; ip-warming events go directly to the IP table.
   If/when ip-level abuse signals should propagate to org abuse status,
   the writer surface is `abuseStatus.transition(...)`.

## Execution

Implemented in a single pre-production pass — no separate execution
plan, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/organizations/abuseStatus.ts` — new module.
- `apps/api/convex/organizations/abuseGate.ts` — new module.
- `apps/api/convex/lib/abuseHelpers.ts` — deleted.
- `apps/api/convex/organizationSettings.ts:setAbuseStatusInternal`
  — deleted; callers point at `abuseStatus.transition`.
- `apps/api/convex/analytics/sendingReputation.ts:autoEnforceReputation`
  — collapsed to a single transition call.
- `apps/api/convex/platformAdmin/mutations.ts:setOrganizationStatus`
  — collapsed to a single `adminOverride` call.
- `apps/api/convex/webhooks/dispatcher.ts` — circuit-breaker
  re-target to `'warned'`.
- `apps/api/convex/schema/auth.ts` — drop `'throttled'` literal.
- `apps/api/convex/_internal/migrations/dropThrottledAbuseStatus.ts`
  — one-shot internal mutation.
- Six call sites updated to import from `organizations/abuseGate`.
- `apps/api/convex/__tests__/abuseStatusLifecycle.integration.test.ts`
  — new.
- `apps/api/convex/__tests__/abuseGate.test.ts` — new (replacing
  `abuseHelpers.test.ts`).

CONTEXT.md is updated in the same pass (Abuse section + Relationships
paragraph). The audit-action catalog adds `'abuse_status_changed'`.
