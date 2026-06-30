# Organization settings collapse — three modules across one singleton, closing permission divergence and dead code

**Status:** accepted

## Context

After ADR-0025 extracted the 230-line `deleteOrgBatch` switch into the
**Organization deletion** module-family, the residual
`convex/organizationSettings.ts` (191 LOC) is a duplicate of
`convex/instanceSettings.ts` (281 LOC). Both files write the same
singleton `instanceSettings` row under the
[[project_single_org_per_deployment]] invariant. ADR-0025 explicitly
flagged this as the next follow-up: *"lands cleanly *after* candidate 1"*
— that candidate has now landed.

This ADR closes five distinct drift signals that the duplication is
hiding, plus a CONTEXT.md vocabulary gap.

### Writer landscape — singleton `instanceSettings` row

| Producer | Path | Column(s) | Permission | Audit log |
|---|---|---|---|---|
| `organizationSettings.get` | L15 | (read) `*` | none | n/a |
| `organizationSettings.getFromSession` | L27 | (read) `*` — byte-identical to `.get` | none | n/a |
| `organizationSettings.create` | L40 | bootstrap insert; throws if exists | `settings:manage` | n/a |
| `organizationSettings.update` | L91 | `emailTheme`, `timezone`, `defaultFromName`, `defaultFromEmail`, `updatedAt` | `settings:manage` | ❌ |
| `organizationSettings.remove` | L167 | (schedules deletion walker) | `role === 'owner'` | n/a |
| `instanceSettings.get` | L46 | (read) `*` | `getUserIdFromSession` | n/a |
| `instanceSettings.getAbuseStatus` | L24 | (read) slice — **zero callers** | n/a | n/a |
| `instanceSettings.update` | L60 | same fields as `organizationSettings.update` | `getMutationContext` only — **any signed-in member** | ❌ **drift** |
| `instanceSettings.getFeatureFlags` | L94 | (read) `featureFlags` resolved | none (pre-auth nav) | n/a |
| `instanceSettings.getResolvedFlags` | L107 | (read) `featureFlags` resolved | internal | n/a |
| `instanceSettings.setFeatureFlag` | L125 | `featureFlags` | `requireAdminContext` | side-effect: `ai.agent` knowledge-backfill kick-off |
| `instanceSettings.setFeaturePack` | L191 | `featureFlags` | `requireAdminContext` | ❌ |
| `instanceSettings.setAllFeatureFlags` | L228 | `featureFlags` | `requireAdminContext` | ❌ |
| `instanceSettings.createInternal` | L262 | bootstrap insert; idempotent | none (internal) | n/a |

Fifteen entry points across two files for one row. Five distinct
drift signals, each mirroring a drift signature a prior ADR closed
elsewhere.

### 1. Permission divergence on `update` — silent

```ts
// organizationSettings.ts:106-113 — tight rule
const session = await getMutationContext(ctx);
requirePermission(
  hasPermission(session.role, 'settings:manage'),
  'Only owners and admins can update instance settings'
);

// instanceSettings.ts:74-75 — loose rule
await getMutationContext(ctx);  // confirms session + org membership only
// (no `requirePermission` call)
```

Both mutations write the same columns on the same row. The active
public surface used by the dashboard is `api.instanceSettings.update`
(11 frontend call sites). That mutation lets *any signed-in org member*
edit `emailTheme`, `defaultFromName`, `defaultFromEmail`, `timezone` —
silently, with no role check. Same drift signature as the
`*ForOrganization` HTTP siblings ADR-0017 closed for Campaign mutations
and the `resume` trackEvent gap ADR-0024 closed for the Automation
lifecycle.

The legacy `organizationSettings.update` shell has the correct rule
(`settings:manage`) but is reachable only via the now-orphaned
`api.organizationSettings.*` surface — which has exactly one caller
(`__tests__/organizationDeletionWalker.test.ts:724`, calling `.remove`,
not `.update`).

### 2. Dead-code mutations and queries

`organizationSettings.create`: zero callers anywhere. Bootstrap
(`seedAdmin.ts:146`) goes through `instanceSettings.createInternal`
(the idempotent internal variant). Pre-deepening, `create` existed as
the public-mutation symmetric counterpart to `createInternal` — no
production code ever reached it.

`instanceSettings.getAbuseStatus`: zero callers anywhere. Returned an
abuse-slice + send-counter shape; the **Abuse gate (module)** at
`convex/organizations/abuseGate.ts` reads the row directly (per
ADR-0011) and never used this query. Pre-deepening artifact from
before the abuse-gate split.

### 3. Two `get` variants with subtly different auth shapes

| Variant | Auth gate | Behavior |
|---|---|---|
| `organizationSettings.get` | none | bare `.query('instanceSettings').first()` |
| `organizationSettings.getFromSession` | none | byte-identical to `.get` |
| `instanceSettings.get` | `getUserIdFromSession(ctx)` | confirms session exists, then same query |

Three reads of the same row with three subtly different surfaces. The
two `organizationSettings` variants are unreachable in production (no
callers under that surface name); the `instanceSettings.get` variant
is the only live read. Same drift the **Send reads (module)** (ADR-0006)
closed by consolidating per-call-site send-spanning queries into one
typed entry.

### 4. Settings + feature flags mixed in one file

`instanceSettings.ts` is 281 LOC, of which:
- ~95 LOC are org-level settings CRUD (`get`, `update`, `createInternal`)
- ~165 LOC are feature-flag CRUD + per-flag side effects
  (`setFeatureFlag`, `setFeaturePack`, `setAllFeatureFlags`,
  `getFeatureFlags`, `getResolvedFlags`)
- ~20 LOC of imports and shared

The two halves share a file but not a concern. Permission audiences
differ (settings: owner/admin via `settings:manage`; flags: admin via
`requireAdminContext`). The per-flag side-effect surface (today:
`ai.agent` toggle kicks off knowledge-backfill at L156-180; tomorrow:
any per-flag lifecycle behavior) lives next to unrelated theme/from-
email CRUD. Adding a per-flag effect means editing a file that also
houses unrelated settings code.

Same drift the **Abuse status (module)** + **Abuse gate (module)**
split (ADR-0011) closed by separating reads from writes on the
`abuseStatus` column — different concerns, different writers, same
row.

### 5. File path doesn't match the project naming convention

The `convex/organizations/` directory already houses
`abuseStatus.ts`, `abuseGate.ts`, and `deletion/` per ADRs 0011 and
0025. Both files under deepening sit at the convex root:

- `convex/organizationSettings.ts` — name suggests "organization"
  scope but the file is mostly duplicate of `instanceSettings.ts`
- `convex/instanceSettings.ts` — name matches the schema table
  (`instanceSettings`) but contradicts the
  [[project_single_org_per_deployment]] memory note's "Organization"
  not "Instance" discipline (followed in ADR-0025 for the deletion
  module's naming)

The dashboard UI already calls the data "Organization settings"
(`apps/web/app/pages/dashboard/settings/index.vue`'s
`useConvexMutation(api.instanceSettings.update)` is dropped into
a local variable named `updateOrganizationSettings`). The frontend
vocabulary is right; the backend file paths are not.

### 6. CONTEXT.md vocabulary gap (closed inline)

Pre-this-ADR, CONTEXT.md has no entry for the singleton settings
surface, no entry for feature flags as a concept distinct from
settings, and the **Organization deletion (module)** entry points at
the about-to-die `organizationSettings.remove` and `instanceSettings.ts`
file paths. Three terms added inline as decisions crystallized
during the grilling that produced this ADR:

- **Organization settings (module)** — under new `## Organization
  settings` section
- **Feature flags (module)** — under new `## Feature flags` section
- New Relationships entry documenting the four-writer / one-row
  pattern (`Organization settings`, `Feature flags`, `Abuse status`,
  `Organization deletion`) with the permission-audience split

Three references inside `## Organization deletion` updated to point
at the new module locations. Naming chosen per the
[[project_single_org_per_deployment]] memory: "Organization" not
"Org", "Organization settings" not "Instance settings."

### Shared framing

Per LANGUAGE.md's deletion test: deleting
`convex/organizationSettings.ts` and replaying its three live entries
(`get`, `update`, `remove`) reveals byte-identical duplicates of
functions already present in `instanceSettings.ts` (plus one orphan,
`remove`, whose only caller is the deletion test). The file is a
pass-through. Complexity does *not* reappear across N callers; it
vanishes.

Conversely, deleting `convex/instanceSettings.ts` and replaying its
entries reveals four call-site populations:
1. Eleven frontend reads (`api.instanceSettings.get`)
2. Three frontend writes (`api.instanceSettings.update`)
3. Four frontend feature-flag operations
4. Three internal callers (`createInternal`, `getResolvedFlags`)

The complexity is in the row itself, not in either file. The split is
by concern, not by file.

**The interface is the test surface**: pre-deepening, integration
tests at `__tests__/knowledgeBackfill.integration.test.ts` drive
`api.instanceSettings.setFeatureFlag` end-to-end through the active
Convex surface — five calls per scenario. Post-deepening, the same
tests drive `api.organizations.featureFlags.setFeatureFlag`, and the
per-flag side-effect (knowledge-backfill kick-off) is unit-testable
against the **Feature flags (module)** with a stub `ctx` instead of
the full Convex test harness.

Confidence: high. Pattern mirrors ADR-0011 (Abuse split into
status + gate on the same row), ADR-0017 (Campaign + AB test sibling
lifecycles on the same row), ADR-0025 (Organization deletion as a
fourth writer of the same row's lifecycle endpoint). No new
architectural ground; the deepening's value is in the substance
corrections (permission unification + dead-code removal + concern
separation) and the file-path alignment.

## Decision

Three modules in `convex/organizations/`, two files deleted, one
permission rule unified, one orphan + one dead query removed.

### New module: Organization settings (module)

```
convex/organizations/settings.ts
```

Four entry points — `get`, `update`, `remove`, `createInternal`.
Sole writer of the singleton row's *settings columns* (`emailTheme`,
`timezone`, `defaultFromName`, `defaultFromEmail`, `updatedAt`).

```ts
// apps/api/convex/organizations/settings.ts

import { v } from 'convex/values';
import {
  query, mutation, internalMutation,
} from '../_generated/server';
import { internal } from '../_generated/api';
import {
  getUserIdFromSession,
  getMutationContext,
  requirePermission,
  hasPermission,
} from '../lib/sessionOrganization';

export const get = query({
  args: {},
  handler: async (ctx) => {
    await getUserIdFromSession(ctx);
    return await ctx.db.query('instanceSettings').first();
  },
});

export const update = mutation({
  args: {
    timezone: v.optional(v.string()),
    defaultFromName: v.optional(v.string()),
    defaultFromEmail: v.optional(v.string()),
    emailTheme: v.optional(v.object({
      primaryColor: v.string(),
      fontFamily: v.string(),
      backgroundColor: v.string(),
      baseWidth: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    // UNIFIED rule — closes drift #1.
    requirePermission(
      hasPermission(session.role, 'settings:manage'),
      'Only owners and admins can update organization settings'
    );
    const now = Date.now();
    const existing = await ctx.db.query('instanceSettings').first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert('instanceSettings', {
      ...args, createdAt: now, updatedAt: now,
    });
  },
});

export const remove = mutation({
  args: {},
  handler: async (ctx) => {
    const session = await getMutationContext(ctx);
    requirePermission(
      session.role === 'owner',
      'Only the owner can delete the organization'
    );
    await ctx.scheduler.runAfter(
      0,
      internal.organizations.deletion.walker.start,
      {},
    );
    return { success: true, message: 'Organization deletion started' };
  },
});

export const createInternal = internalMutation({
  args: {
    timezone: v.optional(v.string()),
    defaultFromName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('instanceSettings').first();
    if (existing) return existing._id;
    const now = Date.now();
    return await ctx.db.insert('instanceSettings', {
      timezone: args.timezone || 'UTC',
      defaultFromName: args.defaultFromName,
      createdAt: now,
    });
  },
});
```

### New module: Feature flags (module)

```
convex/organizations/featureFlags.ts
```

Five entry points — `getFeatureFlags`, `getResolvedFlags`,
`setFeatureFlag`, `setFeaturePack`, `setAllFeatureFlags`. Sole writer
of the singleton row's `featureFlags` map. Owns the per-flag
side-effect surface (today: `ai.agent` knowledge-backfill kick-off).

The full body is the lift-and-shift of L94-256 from
`instanceSettings.ts` — five exports, unchanged behavior, including
the explicit-only `ai.agent` backfill semantic at L156-180 (cascade-
driven enables do NOT trigger the backfill; the gating on absence of
any prior backfill job is preserved).

### Unchanged module: Abuse status (module)

```
convex/organizations/abuseStatus.ts  (unchanged)
```

The grilling considered absorbing `instanceSettings.getAbuseStatus`
into this module. Investigation revealed it had zero callers —
deleted rather than moved.

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `convex/instanceSettings.ts` (281 LOC) | mixed settings + feature flags + dead `getAbuseStatus` | Deleted — split across `organizations/settings.ts` and `organizations/featureFlags.ts`; `getAbuseStatus` removed |
| `convex/organizationSettings.ts` (191 LOC) | duplicate `get` / `getFromSession` / `create` / `update` / `remove` | Deleted — live entries (`get`, `update`, `remove`) move to `organizations/settings.ts`; dead `create` and duplicate `getFromSession` removed |
| `organizationSettings.ts:91-154` `update` (loose loose+tight pair) | two `update` mutations with divergent permission rules | One `update` in `organizations/settings.ts`, single `settings:manage` rule |

### Closes drift bugs

1. **Permission divergence** on `update` — unified to `settings:manage`
   (drift #1). Any-org-member writes to `emailTheme` / `defaultFromName`
   / `defaultFromEmail` / `timezone` are no longer possible.
2. **Dead-code `organizationSettings.create`** — deleted; bootstrap
   stays on `createInternal` (drift #2).
3. **Dead-code `instanceSettings.getAbuseStatus`** — deleted; the
   **Abuse gate (module)** is the only reader of the `abuseStatus`
   column (drift #2).
4. **Three `get` variants with divergent auth** — collapsed to one
   `get` with `getUserIdFromSession` (drift #3). The two unreachable
   `organizationSettings.get` / `getFromSession` variants are gone.
5. **Settings + feature flags mixed in one file** — split across
   two modules with disjoint permission audiences (drift #4). The
   per-flag side-effect surface (knowledge-backfill kick-off) now
   lives in the Feature flags (module) next to other flag behavior.
6. **File-path / concept misalignment** — both files move under
   `convex/organizations/` alongside `abuseStatus.ts`, `abuseGate.ts`,
   `deletion/` (drift #5). API surface becomes
   `api.organizations.settings.*` and
   `api.organizations.featureFlags.*` — matching the dashboard's UI
   vocabulary.
7. **CONTEXT.md gap** — closed by inline updates landed alongside
   this ADR (drift #6). New `## Organization settings` and
   `## Feature flags` sections; updated `## Organization deletion`
   references; new Relationships entry documenting the four-writer /
   one-row pattern.

### Caller migration

Mechanical search-and-replace across the codebase:

| Old surface | New surface | Sites |
|---|---|---|
| `api.instanceSettings.get` | `api.organizations.settings.get` | 11 frontend (Vue) |
| `api.instanceSettings.update` | `api.organizations.settings.update` | 3 frontend |
| `api.instanceSettings.getFeatureFlags` | `api.organizations.featureFlags.getFeatureFlags` | 2 frontend (`useFeatureFlag.ts`, `settings/features.vue`) |
| `api.instanceSettings.setFeatureFlag` | `api.organizations.featureFlags.setFeatureFlag` | 2 frontend + 5 test |
| `api.instanceSettings.setFeaturePack` | `api.organizations.featureFlags.setFeaturePack` | 1 frontend |
| `api.instanceSettings.setAllFeatureFlags` | `api.organizations.featureFlags.setAllFeatureFlags` | 1 setup endpoint |
| `api.organizationSettings.remove` | `api.organizations.settings.remove` | 1 test |
| `internal.instanceSettings.createInternal` | `internal.organizations.settings.createInternal` | 1 (`seedAdmin.ts:146`) |
| `internal.instanceSettings.getResolvedFlags` | `internal.organizations.featureFlags.getResolvedFlags` | 1 (`emails.ts:302`) |

No backend internal-caller updates beyond `seedAdmin.ts` and
`emails.ts`. Frontend imports are renames only — no behavior change
at any call site.

### Tests

The deepening produces three new test surfaces and migrates three
existing ones:

1. **Per-module unit tests** at
   `organizations/__tests__/settings.test.ts` and
   `organizations/__tests__/featureFlags.test.ts`. Each module has a
   small surface; tests assert at the interface (the four / five
   entry points respectively).
2. **Permission regression test** at `settings.test.ts` — asserts
   `update` rejects a `member` role with the `settings:manage` error.
   Catches the silent any-member-can-edit bug if it ever recurs.
3. **Feature-flag side-effect test** at `featureFlags.test.ts` —
   asserts `setFeatureFlag({ flag: 'ai.agent', value: true })` from
   `false` kicks off the backfill (job created, runChunk scheduled,
   audit-log row emitted) and that a cascade-driven enable does NOT.
   This is a lift from the existing
   `__tests__/knowledgeBackfill.integration.test.ts` but moves to the
   module-level test surface; the integration test stays as a
   higher-level smoke test.
4. **Existing integration tests migrate to new paths**:
   - `__tests__/knowledgeBackfill.integration.test.ts` — 5 call sites
     update from `api.instanceSettings.setFeatureFlag` to
     `api.organizations.featureFlags.setFeatureFlag`. No behavior
     change.
   - `__tests__/organizationDeletionWalker.test.ts:724` — 1 call site
     updates from `api.organizationSettings.remove` to
     `api.organizations.settings.remove`. No behavior change.
5. **Old unit tests on `organizationSettings.ts` and
   `instanceSettings.ts`** — none exist today (pre-deepening neither
   file had unit tests; the only coverage was the
   knowledge-backfill integration test). Net new test surface from
   this ADR.

## Consequences

**Closes the second residual file from ADR-0025's follow-up list.**
After this lands, `organizationSettings.ts` is deleted and
`instanceSettings.ts` is deleted — the only surviving file in the
`convex/` root that touches the singleton row is the per-table
deletion step at `convex/organizations/deletion/steps/instanceSettings.ts`
(the terminal step of the wipe), and that file's name is the
*schema table name*, not the module name (matching the other ~36
per-table deletion step files).

**Surface area:** ~10 LOC reduction net. `organizationSettings.ts`
(191 LOC) deletes entirely. `instanceSettings.ts` (281 LOC) deletes
entirely. New files: `organizations/settings.ts` (~85 LOC),
`organizations/featureFlags.ts` (~175 LOC). Plus new unit-test files
(~250 LOC). Total: -10 LOC of production code, +250 LOC of new test
coverage where there was effectively none.

**One re-tightened invariant:** the singleton `instanceSettings` row
has exactly *four* writer modules — Organization settings, Feature
flags, Abuse status, Organization deletion — each owning a disjoint
column set, each enforcing a distinct permission rule. The
four-writer / one-row pattern is documented in CONTEXT.md's
Relationships section. Future writers of new columns choose: extend
an existing module if the concern fits, or define a fifth module if
the concern is genuinely new. They do not append to a shared
catch-all file.

**Migration:** one PR. Schema unchanged. No data backfill. Cutover:
1. New module files added with full bodies
2. Old files deleted (`organizationSettings.ts`, `instanceSettings.ts`)
3. `_generated/api.d.ts` regenerates automatically
4. Caller updates land in the same PR (search-and-replace)
5. Test migrations land in the same PR

No risk to in-flight runs: the deletion walker continues to schedule
`internal.organizations.deletion.walker.start` from the (now-moved)
`remove` mutation. The Organization deletion module-family is
untouched.

**Out of scope for follow-up:** further consolidation of the
`organizations/` module-family. After this ADR, the directory
contains six concerns sharing the singleton row's lifecycle:
`settings.ts`, `featureFlags.ts`, `abuseStatus.ts`, `abuseGate.ts`,
`deletion/`. Each is small, each owns a disjoint column set. There
is no apparent factor candidate — the modules genuinely diverge at
the implementation level (deletion is a walker; abuse is a
lifecycle; settings / feature flags are CRUD; abuse gate is a
read-side helper). The Relationships entry names the family without
factoring it.

**Out of scope for follow-up:** the Lifecycle factor question. This
ADR is *not* a lifecycle module (no status column, no
`LEGAL_EDGES`) and does not bear on whether the ten existing
lifecycle modules should collapse into a generic `Lifecycle<S, E,
Eff>` shape. CONTEXT.md still records that question as "active
design but not landed."
