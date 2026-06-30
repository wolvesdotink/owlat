# Organization deletion module-family — typed walker over per-table modules, closing cascade divergence, coverage gaps, and storage orphans

**Status:** accepted

## Context

`organizationSettings.remove` schedules `deleteOrgBatch`, a 230-line
internal mutation at `organizationSettings.ts:205-437` that wipes every
row the org has produced. The mutation is one giant
`switch (step: v.string())` over seven hard-coded buckets
(`'contacts' | 'contactRelated' | 'campaigns' | 'automations' |
'transactional' | 'misc' | 'settings'`), each case manually
self-scheduling the next step via
`ctx.scheduler.runAfter(0, internal.organizationSettings.deleteOrgBatch, ...)`.

The shape is the textbook missed seam — a step machine implemented as a
switch instead of a walker. Owlat already has the **Step walker**
(ADR-0004, automations), **Agent walker** (inbox agent pipeline), and
**IMAP command walker** (ADR-0016) for exactly this pattern: typed
dispatch table, pure per-kind modules, walker owns lifecycle plumbing.

Beyond the shape, the substance is broken in four distinct ways. Each
mirrors a drift signature a prior ADR closed elsewhere.

### 1. Cascade divergence: two writers of contact-deletion

`lib/contactMutations.ts:permanentlyDeleteContactWithRelations` is the
canonical contact cascade introduced by ADR-0008. It deletes five child
tables (`contactTopics`, `contactPropertyValues`, `contactActivities`,
`contactIdentities`, `contactRelationships`) and **soft-marks**
`emailSends` / `transactionalSends` with `deletedAt + deletedBy` so
audit-trail reads can distinguish "still active contact" from "contact
removed."

`deleteOrgBatch:214-263` re-implements the cascade. It walks four of
the five child tables (skips `contactRelationships` entirely), then
**hard-deletes** the contact's `emailSends` rows instead of soft-marking,
then walks `automationRuns + automationStepRuns` inline as a fifth
cascade step the canonical helper does not perform.

Two writers. Divergent semantics. The 30-day soft-delete cleanup cron
uses the canonical helper; the org-wipe path silently uses something
else. Same drift signature as the open-coded find-or-create blocks
ADR-0008 collapsed into the **Contact resolution (module)**.

### 2. Coverage gap: ~15 tables silently un-deleted

A quick schema audit against the seven `switch` cases shows the
following tables in `apps/api/convex/schema/` *with no deletion path*
in `deleteOrgBatch` today:

- `agentActions` (per-step audit rows from the inbox agent pipeline)
- `inboundMessages` (the shared-inbox row the **Inbox processing
  lifecycle (module)** writes)
- `conversationThreads` (shared-inbox threading)
- `mailMessages` (Postbox personal mail — each row carries three
  storage references: `rawStorageId`, `textBodyStorageId`,
  `htmlBodyStorageId`)
- `mailboxes` (per-user Postbox identity rows)
- `mailDrafts` (compose drafts — `attachments[].storageId` per draft)
- `mailAliases`, `mailFolders`, `mailLabels`, `mailFilters`,
  `mailSignatures`, `mailAppPasswords` (Postbox configuration siblings)
- `contentScanResults` (publish-time scans owned by **Transactional
  email lifecycle (module)**)
- `knowledgeEntries`, `semanticFiles` (RAG corpus — `semanticFiles`
  carries `storageId`)
- `providerHealth`, `providerRoutes` (send-side provider routing)
- `sendingDomainMtaIdentities`, `sendingDomainSesIdentities` (the
  per-provider sibling tables added by ADR-0018)
- `trackingDomains`, `domainReputation` (sibling tables to `domains`)
- `mediaAssets` (user-uploaded image rows — `storageId` per asset)
- `contactProperties` (the schema definitions; today's `contactRelated`
  step deletes these, BUT it also deletes `topics` from the same case,
  conflating two unrelated tables)

Each missed table is a row that survives "delete my account." Some hold
PII (`mailMessages`, `inboundMessages`). Some hold revenue-relevant
data (`providerHealth`). All are silent orphans.

### 3. Storage-blob orphans

Convex storage charges per stored byte. The `deleteOrgBatch` switch
calls `ctx.db.delete(row._id)` on rows whose fields reference storage
blobs, never calling `ctx.storage.delete(blobId)`. Across the schema:

| Table                | Storage references                                       |
|----------------------|----------------------------------------------------------|
| `mediaAssets`        | `storageId`                                              |
| `semanticFiles`      | `storageId`                                              |
| `mailMessages`       | `rawStorageId`, `textBodyStorageId`, `htmlBodyStorageId` |
| `mailDrafts`         | `attachments[].storageId` (per attachment)               |
| `transactionalSends` | `attachmentStorageIds: v.array(v.string())`              |

Deleting an org today orphans every blob. For a moderately active org
this is potentially gigabytes of un-billable, un-deletable data.

### 4. Provider-side orphans on `domains`

`deleteOrgBatch:387` calls `ctx.db.delete(d._id)` directly on every
`domains` row, bypassing the **Sending domain lifecycle (module)**'s
`remove()` entry (ADR-0018). The lifecycle's `delete_with_provider`
effect calls the per-provider adapter's `deleteFromProvider(domain)`
— SES's case calls
`SES.send(new DeleteIdentityCommand({ Identity: domain }))`; MTA's case
DELETEs the domain via the MTA HTTP API. Bypassed → SES / MTA-side
identity records are never released. The org "deleted" their domain
but it lingers, attributable, on the provider's side.

Same drift the **Sending domain lifecycle (module)** introduced
`delete_with_provider` precisely to close — the org-wipe path bypasses
the closure.

### 5. Stringly-typed step argument

```ts
// organizationSettings.ts:205-208
export const deleteOrgBatch = internalMutation({
  args: {
    step: v.string(),
  },
  // ...
});
```

A typo anywhere along the chain
(`scheduler.runAfter(0, ..., { step: 'campaign' })` instead of
`'campaigns'`) compiles, ships, and silently no-ops on the runtime's
`default:` (which the switch lacks — it falls through to the closing
`}` and the function returns without scheduling further). Convex
literal-union args (`v.union(v.literal('contacts'), ...)`) catch this
at compile time; the existing pattern across all eight lifecycle
modules' `TransitionInput` validators is precisely this.

### 6. Duplicated "more-batch vs next-step" branching per case

The "did I exhaust this step's batch?" decision appears nine times
across the switch cases, each in slightly varied shapes:

```ts
// case 'contacts' (line 254-263)
if (contacts.length === BATCH_SIZE) {
  await ctx.scheduler.runAfter(0, ..., { step: 'contacts' });
} else {
  await ctx.scheduler.runAfter(0, ..., { step: getNextStep(step)! });
}

// case 'campaigns' (line 286-290)
if (templates.length === BATCH_SIZE) {
  await ctx.scheduler.runAfter(0, ..., { step: 'campaigns' });
  return;
}
// ... (repeated for blocks, campaigns sub-batches)

// case 'transactional' (line 347-351)
if (sends.length === BATCH_SIZE) {
  await ctx.scheduler.runAfter(0, ..., { step: 'transactional' });
  return;
}
```

`getNextStep(step)!` casts away the `string | null` return — every case
asserts non-null at the boundary, and the terminal `'settings'` case
silently relies on the function returning `null` and the case not
reaching its `await` because of an earlier `return`. The terminal
discipline is implicit, not encoded.

### 7. CONTEXT.md gap (closed by this ADR)

Pre-this-ADR, CONTEXT.md has no vocabulary for the org-wipe pipeline.
The deepening introduces three terms — **Organization deletion
(module)**, **Organization deletion walker**, **Organization deletion
step (module)** — added under a new `## Organization deletion` section
between `## Abuse` and `## Automations`. Naming chosen per the
[[project_single_org_per_deployment]] memory: "Organization" not "Org",
"deletion" not "wipe / cleanup / removal."

### Shared framing

Per LANGUAGE.md's deletion test: deleting the seven `switch` cases and
inlining their bodies reveals seven near-mirror copies of "query rows
→ delete rows → schedule next." The drift is structural (cascade
divergence, coverage gap, storage orphans, provider orphans, stringly-
typed step, duplicated batching plumbing) and concentrates at exactly
the seam this ADR introduces. **The interface is the test surface** —
today's switch is testable only through the public `remove` mutation
end-to-end; under the walker each per-table module is unit-testable
with a stub `ctx`.

Confidence: high. Pattern mirrors three prior walkers (ADR-0004 Step,
ADR-0016 IMAP command, the inbox Agent walker). No new architectural
ground; the deepening's value is in the substance corrections (cascade
delegation + coverage + storage purge + provider cleanup) not the
shape change.

## Decision

One new module-family at `convex/organizations/deletion/`, one new
internal mutation entry-point (`walker.start`), one new internal
mutation hop (`walker.runStep`), N per-table modules (one per
deletable table — ~37 in the initial landing per the coverage audit).

- **`convex/organizations/deletion/walker.ts`** — the **Organization
  deletion walker**. Owns the ordered table list, the typed module
  registry, the public-ish entry (called by
  `organizationSettings.remove`), and the self-scheduled `runStep` hop.
- **`convex/organizations/deletion/steps/<table>/index.ts`** — one
  per deletable table. Exports an `OrganizationDeletionStepModule`
  with `table`, optional `batchSize`, `deleteBatch(ctx) →
  { deletedCount, hasMore }`, and an optional `purgeStorage?(row, ctx)`
  hook for storage-bearing tables.
- **`convex/organizations/deletion/steps/_common.ts`** — the
  interface definitions and shared helpers (e.g. `defaultBatchSize`).

The 230-line switch in `organizationSettings.ts:205-437` is deleted.
The `DELETION_STEPS` constant and `getNextStep` helper at
`organizationSettings.ts:183-199` are deleted (their replacements live
in `walker.ts` with typed identifiers).

### Organization deletion walker shape

```ts
// convex/organizations/deletion/walker.ts

export type OrganizationDeletionTable =
  | 'mediaAssets'
  | 'semanticFiles'
  | 'mailMessages'
  | 'mailDrafts'
  | 'transactionalSends'
  | 'emailSends'
  | 'agentActions'
  | 'contentScanResults'
  | 'inboundMessages'
  | 'conversationThreads'
  | 'mailboxes'
  | 'mailAliases'
  | 'mailFolders'
  | 'mailLabels'
  | 'mailFilters'
  | 'mailSignatures'
  | 'mailAppPasswords'
  | 'webhookDeliveryLogs'
  | 'webhooks'
  | 'formSubmissions'
  | 'formEndpoints'
  | 'automationStepRuns'
  | 'automationRuns'
  | 'automationSteps'
  | 'automations'
  | 'campaigns'
  | 'emailTemplates'
  | 'transactionalEmails'
  | 'emailBlocks'
  | 'contacts'                         // delegates to permanentlyDeleteContactWithRelations
  | 'contactProperties'
  | 'topics'
  | 'segments'
  | 'apiKeys'
  | 'blockedEmails'
  | 'knowledgeEntries'
  | 'sendingDomainMtaIdentities'
  | 'sendingDomainSesIdentities'
  | 'trackingDomains'
  | 'domainReputation'
  | 'providerHealth'
  | 'providerRoutes'
  | 'domains'                          // delegates to sendingDomainLifecycle.remove()
  | 'onboardingProgress'
  | 'auditLogs'                        // second-to-last; accumulates throughout the run
  | 'instanceSettings';                // terminal — singleton row that owned the org

// Ordered cascade — children before parents, storage-bearing tables
// purge their blobs before row delete, audit logs second-to-last,
// instanceSettings terminal.
const STEPS: readonly OrganizationDeletionTable[] = [
  // Storage-bearing leaves: storage hooks fire before row delete
  'mediaAssets',
  'semanticFiles',
  'mailMessages',
  'mailDrafts',
  'transactionalSends',

  // Send + dispatch leaves
  'emailSends',
  'agentActions',
  'contentScanResults',

  // Conversation parents (after their leaves)
  'inboundMessages',
  'conversationThreads',

  // Postbox configuration before mailboxes
  'mailAliases',
  'mailFolders',
  'mailLabels',
  'mailFilters',
  'mailSignatures',
  'mailAppPasswords',
  'mailboxes',

  // Webhook / form children before parents
  'webhookDeliveryLogs',
  'webhooks',
  'formSubmissions',
  'formEndpoints',

  // Automation children before parents
  'automationStepRuns',
  'automationRuns',
  'automationSteps',
  'automations',

  // Campaign + template parents
  'campaigns',
  'emailTemplates',
  'transactionalEmails',
  'emailBlocks',

  // Contact cascade — delegates; sweeps 5 child tables that aren't standalone steps
  'contacts',

  // Independent definitions (no parent/child among themselves)
  'contactProperties',
  'topics',
  'segments',
  'apiKeys',
  'blockedEmails',
  'knowledgeEntries',

  // Domain stack — provider identities + reputation before domains,
  // which delegates for SES / MTA-side cleanup
  'sendingDomainMtaIdentities',
  'sendingDomainSesIdentities',
  'trackingDomains',
  'domainReputation',
  'providerHealth',
  'providerRoutes',
  'domains',

  // UI / onboarding state
  'onboardingProgress',

  // Audit logs LAST (accumulates from delegated lifecycle calls above)
  'auditLogs',

  // Terminal — the singleton row that owned the org's existence
  'instanceSettings',
] as const;

export const ORGANIZATION_DELETION_STEPS: {
  readonly [K in OrganizationDeletionTable]:
    OrganizationDeletionStepModule<K>
} = { /* one entry per step module */ } as const satisfies ...;

export const start = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0,
      internal.organizations.deletion.walker.runStep,
      { table: STEPS[0] });
  },
});

export const runStep = internalMutation({
  args: { table: tableValidator },
  handler: async (ctx, { table }) => {
    const mod = ORGANIZATION_DELETION_STEPS[table];
    const { hasMore } = await mod.deleteBatch(ctx);
    if (hasMore) {
      await ctx.scheduler.runAfter(0,
        internal.organizations.deletion.walker.runStep,
        { table });
      return;
    }
    const next = nextTable(table);
    if (next === null) return;       // terminal reached
    await ctx.scheduler.runAfter(0,
      internal.organizations.deletion.walker.runStep,
      { table: next });
  },
});

const nextTable = (table: OrganizationDeletionTable):
  OrganizationDeletionTable | null => {
    const idx = STEPS.indexOf(table);
    return idx === STEPS.length - 1 ? null : STEPS[idx + 1];
};
```

### Organization deletion step (module) shape

```ts
// convex/organizations/deletion/steps/_common.ts

export interface OrganizationDeletionStepModule<
  T extends OrganizationDeletionTable
> {
  readonly table: T;
  readonly batchSize?: number;                       // default 100

  /**
   * Delete one batch of rows for this table.
   * `hasMore: true` if the batch was full and more rows likely remain.
   * The walker re-fires this step until `hasMore: false`.
   */
  deleteBatch(ctx: MutationCtx): Promise<{
    deletedCount: number;
    hasMore: boolean;
  }>;
}

// Storage-bearing tables implement the purge hook *inside* deleteBatch,
// calling it before each db.delete(row._id). The hook is internal to
// the module — not part of the walker's interface — because storage
// purge is per-row, not per-batch.
```

A typical hard-delete step:

```ts
// convex/organizations/deletion/steps/segments/index.ts
import { defineStep } from '../_common';

export const segmentsStep = defineStep({
  table: 'segments',
  async deleteBatch(ctx) {
    const rows = await ctx.db.query('segments').take(100);
    for (const r of rows) await ctx.db.delete(r._id);
    return { deletedCount: rows.length, hasMore: rows.length === 100 };
  },
});
```

A storage-bearing step:

```ts
// convex/organizations/deletion/steps/media-assets/index.ts
export const mediaAssetsStep = defineStep({
  table: 'mediaAssets',
  async deleteBatch(ctx) {
    const rows = await ctx.db.query('mediaAssets').take(100);
    for (const r of rows) {
      await ctx.storage.delete(r.storageId);   // purge blob first
      await ctx.db.delete(r._id);
    }
    return { deletedCount: rows.length, hasMore: rows.length === 100 };
  },
});
```

A delegating step:

```ts
// convex/organizations/deletion/steps/contacts/index.ts
import { permanentlyDeleteContactWithRelations } from '../../../lib/contactMutations';

export const contactsStep = defineStep({
  table: 'contacts',
  async deleteBatch(ctx) {
    const rows = await ctx.db.query('contacts').take(100);
    for (const r of rows) {
      // Single canonical cascade writer. By the time this step runs
      // emailSends and transactionalSends are already empty (their
      // steps ran first), so the helper's "soft-mark sends" loop is a
      // no-op index lookup — no waste, no special flag needed.
      await permanentlyDeleteContactWithRelations(ctx, r._id, {
        decrementCount: false,    // count is going away too
      });
    }
    return { deletedCount: rows.length, hasMore: rows.length === 100 };
  },
});

// convex/organizations/deletion/steps/domains/index.ts
import { lifecycle as sendingDomainLifecycle } from '../../../domains/lifecycle';

export const domainsStep = defineStep({
  table: 'domains',
  async deleteBatch(ctx) {
    const rows = await ctx.db.query('domains').take(100);
    for (const r of rows) {
      // Fires delete_with_provider → SES/MTA-side identity released.
      await sendingDomainLifecycle.remove(ctx, { domainId: r._id });
    }
    return { deletedCount: rows.length, hasMore: rows.length === 100 };
  },
});
```

### Why only two tables delegate

For an org-wipe, most lifecycle `remove()` effects are noise that gets
wiped moments later:

- `emailTemplateLifecycle.remove()`'s `update_block_usage_counts`
  effect patches `emailBlocks.usageCount` — but `emailBlocks` is the
  step that runs three steps later in the ordered list.
- `transactionalEmailLifecycle.remove()`'s `audit_log` effect — wiped
  in the `auditLogs` step at the end.
- `savedBlockModule.remove()`'s `detach_all` effect walks consumer
  tables that are themselves about to be wiped.

The two exceptions write something that *escapes* the org's data
boundary:

- `permanentlyDeleteContactWithRelations` is the single canonical
  writer of contact cascade. Delegating closes drift #1 (cascade
  divergence) at zero cost — the helper's "soft-mark sends" loop
  no-ops because `emailSends` / `transactionalSends` have already
  been wiped by their own steps.
- `sendingDomainLifecycle.remove()`'s `delete_with_provider` effect
  reaches into SES / MTA via the **Sending domain provider adapter
  (module)** — purely external state Owlat would otherwise orphan.

### Audit-log ordering — accept the noise

Delegated lifecycle calls (contacts × N rows, domains × N rows) emit
`audit_log` effects via `recordAuditLog`. Those rows land in
`auditLogs`. The `auditLogs` step is positioned second-to-last in
`STEPS` — every audit row written during the wipe (including the two
delegate calls' rows) is itself deleted before the walker terminates.

No `suppressEffects` flag added to lifecycle modules. The simpler
ordering choice wins: lifecycle modules stay pure; the wipe's noise
ends inside the wipe.

### What stays outside the module-family

- `organizationSettings.remove` — the public mutation shell. Owner-only
  permission check; schedules `walker.start`; returns the
  "Instance deletion started" response synchronously. Body shrinks from
  ~20 LOC of permission + schedule to ~10 LOC. The mutation is not
  consolidated into the deletion module because it's the
  organization-settings *surface*, not the deletion *pipeline*.
- `permanentlyDeleteContactWithRelations` — stays in
  `lib/contactMutations.ts` as the single canonical cascade writer.
  The delegating `contacts` step imports and calls it; both the
  30-day soft-delete cron and the org-wipe path now route through the
  same helper.
- `sendingDomainLifecycle.remove()` — stays as the only writer of
  `domains` row deletion. The delegating `domains` step calls it; the
  user-initiated domain-removal mutation already calls it.
- The `Sending domain provider adapter (module)` family — unchanged.
  The two adapters' `deleteFromProvider` methods are reached
  transitively via `sendingDomainLifecycle.remove()`'s
  `delete_with_provider` effect.
- All other lifecycle modules — unchanged. Their `remove()` entries
  are not called by the wipe; they continue to serve user-initiated
  row deletion.

### Replaces

| File:line                                     | Pre-deepening | Post-deepening |
|-----------------------------------------------|---------------|----------------|
| `organizationSettings.ts:183-191` `DELETION_STEPS` constant | hard-coded array | Deleted — `STEPS` lives in `walker.ts` typed against the literal union |
| `organizationSettings.ts:193-199` `getNextStep` helper      | runtime string-indexed lookup | Deleted — `nextTable` in `walker.ts` is typed |
| `organizationSettings.ts:205-437` `deleteOrgBatch` switch   | 230-line internal mutation | Deleted — replaced by `walker.runStep` + N step modules |
| `organizationSettings.ts:161-180` `remove` mutation         | schedules `deleteOrgBatch` with `step: 'contacts'` | Schedules `walker.start` (no args) |

### Closes drift bugs

1. **Cascade divergence** between the org-wipe path and the canonical
   `permanentlyDeleteContactWithRelations` helper — the `contacts`
   step delegates to the helper, both paths now route through one
   writer (drift #1).
2. **Coverage gap** — ~15 silently un-deleted tables (drift #2). Each
   lands as one **Organization deletion step (module)** in the
   initial landing.
3. **Storage-blob orphans** — `mediaAssets`, `semanticFiles`,
   `mailMessages` (× 3 storage refs per row), `mailDrafts` (× N
   attachments per row), `transactionalSends` (× N attachments per
   row) now all purge blobs before row delete via the step modules'
   internal storage hook (drift #3).
4. **Provider-side orphans on `domains`** — the `domains` step
   delegates to `sendingDomainLifecycle.remove()`, fires
   `delete_with_provider` → SES / MTA-side identities released
   (drift #4).
5. **Stringly-typed step argument** — `runStep`'s `table` arg is
   validated against the `OrganizationDeletionTable` literal union; a
   typo is a compile error (drift #5).
6. **Duplicated "more-batch vs next-step" branching** — the
   "did I exhaust this step?" decision lives once, in `walker.runStep`;
   per-step modules return `hasMore: boolean` and stay agnostic to the
   scheduling decision (drift #6).
7. **CONTEXT.md vocabulary gap** — added in this ADR alongside the
   existing **Step walker** / **Agent walker** / **IMAP command
   walker** terms (drift #7).

### Tests

The walker is a self-scheduled loop over a typed registry. Tests cover:

1. **Per-step modules** — for each module, a unit test with a stub
   `ctx` seeded with rows for the module's table. Assert
   `deleteBatch` deletes the seeded rows and reports `hasMore`
   correctly (full batch vs partial).
2. **Storage purge** — for each storage-bearing step, the stub `ctx`
   records `ctx.storage.delete` calls. Assert one delete per storage
   reference per row.
3. **Delegating steps** — for the `contacts` step, stub
   `permanentlyDeleteContactWithRelations` and assert it's called
   per contact with `decrementCount: false`. For the `domains` step,
   stub `sendingDomainLifecycle.remove` and assert per-domain calls.
4. **Walker dispatch** — stub the module registry with fakes that
   report `hasMore: true / false` on a script. Assert the walker's
   step transitions follow `STEPS` exactly: same step re-fires while
   `hasMore`, next step fires when `hasMore` flips to false, terminal
   step (`instanceSettings`) does not re-schedule.
5. **Ordered list invariants** — a meta-test asserting `STEPS` contains
   every `OrganizationDeletionTable` literal exactly once (catches
   accidental omission when a new table is added).
6. **Integration** — `__tests__/contactsOrganization.integration.test.ts`
   stays, driving `organizationSettings.remove` end-to-end. Asserts
   tables empty at completion. Extended to assert `ctx.storage` blobs
   were deleted (today's test doesn't check) and SES/MTA-side cleanup
   was triggered for the `domains` step (mock the adapter, assert
   `deleteFromProvider` was called).

## Consequences

**Closes one of the last open-coded step machines in the codebase.**
After this lands, the surviving switches-where-walkers-belong are the
chat / agent surfaces (`apps/api/convex/chat/`, `visualizationAgent.ts`)
and the contact-import per-source dispatch (`integrationImports.ts`).

**Surface area added:** ~50 LOC in `walker.ts`, ~10-30 LOC per per-table
step module × ~37 tables = ~500-700 LOC of step modules. Net LOC up
from the 230-line switch — but the LOC is in *typed*, *unit-testable*
per-table modules instead of one monolithic switch. The walker itself
(~50 LOC) is the test surface for dispatch; per-step modules are
testable in isolation. Today's switch has zero unit-test surface.

**One re-tightened invariant:** "delete my account" now actually deletes
my account. Pre-this-ADR, ~15 tables and gigabytes of storage blobs
silently survived. Post-this-ADR, the only data that survives an org
delete is what external providers (SES, MTA, Resend) haven't acked the
delete for — and even those receive the request via
`sendingDomainLifecycle.remove()`'s `delete_with_provider` effect.

**Migration:** Behind a one-shot landing. Schema unchanged. The
existing `deleteOrgBatch` continues to ship until the new walker lands;
the cutover is one PR that swaps the `scheduler.runAfter` target in
`organizationSettings.remove`. The new walker is idempotent against
already-partial wipes (each step queries-then-deletes; a half-finished
wipe restarts mid-table on resume). No data backfill required.

**No risk to in-flight runs:** the deepening leaves every other
lifecycle / walker / module untouched. The two delegated lifecycle
methods (`permanentlyDeleteContactWithRelations`,
`sendingDomainLifecycle.remove`) are unchanged. The
**Sending domain provider adapter (module)**'s `deleteFromProvider`
method is unchanged.

**Out of scope for follow-up:** unifying `organizationSettings.ts` and
`instanceSettings.ts` (Candidate 2 from the architecture review — they
share one singleton table under the single-org invariant; the
duplicate `get` / `update` queries can collapse). This was flagged as
"lands cleanly *after* candidate 1" — meaning after this ADR ships
and `deleteOrgBatch` has left `organizationSettings.ts`, the latter
file's only remaining unique content is the public `remove` shell,
which is small enough to live alongside `instanceSettings.ts`.

**Out of scope for follow-up:** the Lifecycle factor. CONTEXT.md flags
this as "active design but not landed" — ten lifecycle modules share
the typed-`TransitionInput` + `LEGAL_EDGES` + reducer + effects shape
by convention, not by a generic factor. This ADR is *not* a lifecycle
module (no status column, no `LEGAL_EDGES`) and so doesn't bear on
that question.
