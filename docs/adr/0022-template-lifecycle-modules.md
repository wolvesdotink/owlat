# Template lifecycle modules — sibling lifecycles for email-template and transactional-email publish state

**Status:** proposed

## Context

ADR-0017 deepened campaign state transitions into the **Campaign
lifecycle (module)** plus the sibling **AB test lifecycle (module)** —
two parallel state machines on the same row, sharing the **Outbound
lifecycle** shape (typed `TransitionInput`, `LEGAL_EDGES`, reducer per
kind, effects list, `TransitionOutcome`). ADR-0018 deepened sending-
domain transitions into the **Sending domain lifecycle (module)** —
first lifecycle that owns row insertion *and* deletion as lifecycle
entry points (`create()` and `remove()`). ADR-0021 (proposed)
introduced the **Transactional send intake (module)** and moved the
transactional area under `convex/transactional/`. ADR-0021's
"Follow-up work" section named the gap this ADR closes:

> **`transactionalEmails` lifecycle (module).** The `draft → published`
> state machine on `transactionalEmails` (and the parallel one on
> `emailTemplates`) is open-coded across `publish`, `unpublish`,
> `update`, `changeType`, `duplicate`, `addTranslation`,
> `removeTranslation`, `setDefaultLanguage` mutations. The same shape
> that landed for Send / Postbox / Campaign / AB-test / Sending-domain
> lifecycles applies here.

The deepening hasn't landed. Both template tables share the publish-
state concept, both have open-coded transitions, and both are missing
audit-log coverage that every other lifecycle has. But they are *not*
identical — and the divergence is load-bearing for the shape decision.

### Pre-deepening landscape — `emailTemplates*.ts`

| File | LOC | Role |
|---|---|---|
| `emailTemplates.ts` | 380 | `emailTemplates` row CRUD: `get`, `list`, `create`, `update`, `publish`, `unpublish`, `duplicate`, `remove`, `changeType` |
| `emailTemplatesI18n.ts` | 418 | i18n CRUD: `getForLanguage`, `addTranslation`, `updateTranslation`, `removeTranslation`, `setDefaultLanguage` + shared block-walking helpers |
| `emailTemplatesOrganization.ts` | 167 | HTTP-API CRUD: `listByOrganization`, `countByTypeByOrganization`, `getRecentByOrganization`, `createForOrganization`, `createFromPreset` |

Three files at top-level, past the ≥3-file subdirectory threshold the
project established (`forms/`, `contacts/`, `campaigns/`, `delivery/`,
`domains/`, `topics/`, `inbox/`, `mail/`, `webhooks/`, `automations/`,
`organizations/`, `platformAdmin/`, plus `transactional/` after
ADR-0021). The email-templates area is now the largest cluster still
at top level.

### Pre-deepening landscape — `transactional/emails.ts`

Post-ADR-0021 location. Carries `create`, `update`, `publish`,
`unpublish`, `duplicate`, `remove`, `updateSchema`, plus the read
queries (`get`, `getBySlug`, `list`, `countByStatus`). The `publish`
mutation runs `scanContent` from `@owlat/email-scanner` inline (lines
304-335) and branches the row's next state on the scan result.

### Two state machines, not one

**`emailTemplates.status`: `'draft' | 'published'`** — two states.
Writers: `publish` writes `'published'` (line 139), `unpublish` writes
`'draft'` (line 163), `duplicate` inserts `'draft'` (line 197),
`create` inserts `'draft'` (line 369), and the
`createForOrganization` / `createFromPreset` mutations in
`emailTemplatesOrganization.ts` insert `'draft'` (lines 127, 160).
No content-scan gate. No `pending_review` state.

**`transactionalEmails.status`: `'draft' | 'published' | 'pending_review'`**
— three states. `publish` (line 286) runs `scanContent`, then branches:
`blocked → throw`, `suspicious → patch status='pending_review'`,
`clean → patch status='published'` (lines 327, 337). `unpublish` (line
352) writes `'draft'` and clears `publishedAt` (line 366). `duplicate`
(line 377) inserts `'draft'`. `create` (line 123) inserts `'draft'`.

The divergence is intentional and load-bearing: marketing templates
are scanned at *send time* by the **Campaign send orchestrator
(module)** before fan-out, so a publish-time scan would be redundant
and would double-scan every send. Transactional templates have no
send-time operator gate — the public `POST /api/v1/transactional`
endpoint dispatches whatever the slug references — so the scan has
to happen at publish time. The `pending_review` state is the
admin-approval pause for suspicious content; same shape as the
**Campaign lifecycle (module)**'s `pending_review → sending` admin
surface.

### Drift landscape

Eight drift signals across the two state machines.

#### 1. Non-idempotent `publish` on emailTemplates

`emailTemplates.ts:139-145`:

```ts
await ctx.db.patch(args.templateId, {
  status: 'published',
  htmlContent: args.htmlContent,
  htmlTranslations: args.htmlTranslations,
  publishedAt: Date.now(),
  updatedAt: Date.now(),
});
```

No guard for `template.status === 'published'`. Calling `publish`
twice silently re-patches `publishedAt`, which is what every other
lifecycle module's reducer reports as `already_in_state` (and skips
the patch). The transactional path checks this (line 299:
`throwInvalidState('Transactional email is already published')`) —
so the two paths disagree on idempotency.

#### 2. `unpublish` doesn't clear `publishedAt` on emailTemplates

`emailTemplates.ts:163-166`:

```ts
await ctx.db.patch(args.templateId, {
  status: 'draft',
  updatedAt: Date.now(),
});
```

`publishedAt` is left stale on the row. The transactional path clears
it (line 366: `publishedAt: undefined`). Same field, two writers,
divergent semantics. Analytics queries reading "when was this template
last published?" can't distinguish "never published" from "previously
published, now in draft".

#### 3. Three create paths disagree on default fields

`emailTemplates.ts:create:363-378` populates `contentBlockVersion` and
`rendererVersion` (lines 372-373) using `CURRENT_CONTENT_BLOCK_VERSION`
/ `CURRENT_RENDERER_VERSION`. The two organization-side variants
(`emailTemplatesOrganization.ts:createForOrganization:121-133` and
`:createFromPreset:154-166`) skip these fields entirely. Rows created
via the HTTP API land without the version fields populated; the
session-driven path lands them with the fields populated.

#### 4. Zero audit-log coverage

Every other lifecycle module emits an `audit_log` effect on every
transition. Both template lifecycles emit nothing — `publish`,
`unpublish`, `create`, `delete`, `duplicate`, `changeType` all happen
silently from the audit trail's perspective. There is no way to ask
"who published this template, and when?" without reading the row's
own `publishedAt` and looking at session logs separately.

#### 5. `update` silently mutates published rows

`emailTemplates.ts:update:23-119` accepts `subject`, `content`,
`htmlContent`, `previewText`, `defaultLanguage`, and a dozen other
fields as optionals. It writes whatever is passed in, regardless of
the row's `status`. So a `published` template can have its `subject`
swapped silently — `publishedAt` stays set, but what's "published"
no longer matches the source. Same drift on `transactional/emails.ts:
update:179-281`.

The corollary on the i18n side: `setDefaultLanguage:364-418` swaps
the main `subject` / `previewText` / `content` fields with a
translation's. `removeTranslation:316-361` removes a language that
might be in `htmlTranslations`. `updateTranslation:248-313` (default-
language path, lines 264-282) patches main `subject` / `previewText`.
Each silently mutates the publishable surface on a published row.
`changeType:228-249` swaps a template between `marketing` and
`transactional` — a published marketing template silently becomes a
published transactional template (a Campaign that references it by
id silently get a transactional template instead).

#### 6. `pending_review` is a dead-end in transactional

`transactional/emails.ts:326-334` writes `status: 'pending_review'`.
No code anywhere transitions out of it. There is no admin-approve
mutation. There is no admin-reject mutation. Rows that hit
`pending_review` stay there forever; the **Transactional send intake
(module)** (ADR-0021) refuses them with `template_not_published`.
The same shape as the Campaign lifecycle had pre-ADR-0017 — the
admin surface is a follow-up, but the legal-edges graph documents
where it plugs in.

#### 7. Inline content-scan + result write

`transactional/emails.ts:304-335` runs `scanContent`, inserts a
`contentScanResults` row (line 308), and branches the `transactionalEmails`
patch on the scan result. The scan decision and the write are
interleaved with the lifecycle transition. There is no isolatable
surface to assert "the publish reducer correctly routes suspicious
content to `pending_review`" without seeding a real
`@owlat/email-scanner` happy-path-or-not body.

#### 8. `updateBlockUsageCounts` called from two sites with no shared owner

`emailTemplates.ts:102` (inside `update`) and `:223` (inside `remove`
— actually, no, `remove` doesn't call it — but `duplicate` doesn't
call it either, even though it inserts a row with `linkedBlockIds`
copied from the source). The block-usage-count propagation lives
in `lib/linkedBlockPropagation.ts` but its callers don't coordinate
through a single writer. Adding it to `create` and `duplicate` would
close a silent drift (saved-block usage counts skip `duplicate`
inserts today).

### Shared framing

The intake-friction-then-deepening pattern from ADR-0015 (forms),
ADR-0019 (contact import), and ADR-0021 (transactional intake) is the
wrong framing here — these aren't intake paths. The right framing is
the lifecycle-deepening pattern from ADR-0017 (campaigns + AB test) and
ADR-0018 (sending domain): typed transitions on a row, atomic
companion-field patches, effect lists, `pending_review` admin gate
where applicable.

Two state graphs that diverge in publishable ways → two sibling
lifecycle modules, parallel shape, separate `LEGAL_EDGES`. Same
posture the codebase took for Campaign + AB test (parallel lifecycles
on the same row) and for Send + Postbox-outbound (parallel lifecycles
on different tables sharing the **Outbound lifecycle** shape).

## Decision

Introduce two sibling modules:

- **Email template lifecycle (module)** at `convex/emailTemplates/lifecycle.ts`
- **Transactional email lifecycle (module)** at `convex/transactional/lifecycle.ts`

Both own row creation, status transitions, duplication, and removal
for their respective tables. Both export a shared-shape publish
invariant guard that the surrounding CRUD shells call.

The CONTEXT.md vocabulary lands alongside this ADR (already landed —
see the new `## Email templates` section and the additions to
`## Transactional sends`).

### Module shape — Email template lifecycle (module)

```ts
// convex/emailTemplates/lifecycle.ts

export type TransitionInput =
  | { to: 'published'; htmlContent: string; htmlTranslations?: string }
  | { to: 'draft' };

export type TransitionOutcome =
  | { ok: true; status: EmailTemplateStatus; applied: boolean }
  | { ok: false; reason: 'illegal_edge' | 'not_found' };

export const LEGAL_EDGES: Record<EmailTemplateStatus, EmailTemplateStatus[]> = {
  draft:     ['published'],
  published: ['draft'],
};

export const create = internalMutation({
  args: {
    name: v.string(),
    type: v.union(v.literal('marketing'), v.literal('transactional')),
    subject: v.optional(v.string()),
    previewText: v.optional(v.string()),
    content: v.optional(v.string()),
    defaultLanguage: v.optional(v.string()),
    linkedBlockIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
    // Validate input, build searchableText, insert at 'draft' with
    // contentBlockVersion + rendererVersion populated uniformly,
    // fire audit_log + update_block_usage_counts effects.
  },
});

export const transition = internalMutation({
  args: { templateId: v.id('emailTemplates'), input: ... },
  handler: async (ctx, args): Promise<TransitionOutcome> => {
    // Load template, look up current → next in LEGAL_EDGES,
    // reducer per kind produces { patch, effects, applied },
    // apply patch + run effects + return outcome.
  },
});

export const duplicate = internalMutation({ ... });
export const remove = internalMutation({ ... });

export function assertEditableForPublishableChange(
  template: Doc<'emailTemplates'>,
  force?: boolean,
): void {
  if (template.status === 'published' && !force) {
    throw new ConvexError({
      code: 'template_published',
      message: 'Template is published. Pass forceWhilePublished: true or unpublish first.',
    });
  }
}
```

### Module shape — Transactional email lifecycle (module)

Same shape, 3-state graph, content scan inside the `→ published`
reducer:

```ts
// convex/transactional/lifecycle.ts

export type TransitionInput =
  | { to: 'published'; htmlContent: string; htmlTranslations?: string }
  | { to: 'draft' }
  | { to: 'approved' /* pending_review → published, admin */ }
  | { to: 'rejected' /* pending_review → draft, admin */ };

export const LEGAL_EDGES: Record<TransactionalEmailStatus, TransactionalEmailStatus[]> = {
  draft:           ['published', 'pending_review'],
  pending_review:  ['published', 'draft'],
  published:       ['draft'],
};
```

The `→ published` reducer runs `scanContent(subject, htmlContent)`
inline:
- `clean` → patch `status: 'published'` + `publishedAt: Date.now()`, no
  scan-result effect
- `suspicious` → patch `status: 'pending_review'` + write
  `htmlContent` / `htmlTranslations` on the row, emit
  `record_content_scan_result` effect with the scan result
- `blocked` → throw with the scan-result string baked in (matches
  today's behavior at `transactional/emails.ts:317-322`)

The admin `to: 'approved'` reducer assumes the scan happened on the
prior `→ pending_review` transition and patches `status: 'published'`
+ `publishedAt` without re-scanning. The `to: 'rejected'` reducer
patches `status: 'draft'` and clears `publishedAt`. Both fire
distinct audit-log actions (`transactional_email.approved` /
`.rejected`).

### Shared publish invariant guard

Both lifecycles export `assertEditableForPublishableChange(row,
force?)`. Consumed by every mutation in `emailTemplates/` and
`transactional/` that touches publishable content:

| Module | Mutation | Gains `forceWhilePublished?` |
|---|---|---|
| `emailTemplates/emails.ts` | `update` | yes |
| `emailTemplates/emails.ts` | `changeType` | yes |
| `emailTemplates/i18n.ts` | `addTranslation` | yes |
| `emailTemplates/i18n.ts` | `updateTranslation` (any path) | yes |
| `emailTemplates/i18n.ts` | `removeTranslation` | yes |
| `emailTemplates/i18n.ts` | `setDefaultLanguage` | yes |
| `transactional/emails.ts` | `update` | yes |
| `transactional/emails.ts` | `updateSchema` | yes |
| `transactional/translations.ts` | (mirror of i18n CRUD) | yes |

Each mutation calls the guard before patching. Default value of
`forceWhilePublished` is `false`; the editor UX surfaces an "Unpublish
to edit?" gate to the user and explicitly opts in when the user
confirms. The public HTTP API mutations (`createForOrganization`,
`createFromPreset` in `emailTemplates/organization.ts`) don't expose
publish/unpublish, so they refuse on published rows without the knob.

### File layout — subdirectory move for emailTemplates

ADR-0021 moved the transactional area under `convex/transactional/`
once it crossed the ≥3-file threshold. The email-templates area is
past that threshold today (three files at top level). Move:

| Before | After |
|---|---|
| `convex/emailTemplates.ts` | `convex/emailTemplates/emails.ts` |
| `convex/emailTemplatesI18n.ts` | `convex/emailTemplates/i18n.ts` |
| `convex/emailTemplatesOrganization.ts` | `convex/emailTemplates/organization.ts` |
| (new) | `convex/emailTemplates/lifecycle.ts` |

Transactional area gains one file:

| (existing post-ADR-0021) | Action |
|---|---|
| `convex/transactional/api.ts` | unchanged |
| `convex/transactional/dispatch.ts` | unchanged |
| `convex/transactional/emails.ts` | publish / unpublish / create / duplicate / remove delegate to lifecycle |
| `convex/transactional/sends.ts` | unchanged |
| `convex/transactional/translations.ts` | gains the guard call on its mutations |
| (new) | `convex/transactional/lifecycle.ts` |

## Considered options

### Shape — single polymorphic lifecycle vs two siblings

**Chosen: two siblings.**

A single `templateLifecycle.transition({ templateRef, input })` keyed
by a `TemplateRef = { kind: 'email_template' | 'transactional_email';
id }` would unify the two state machines under one module — same
trick the **Send lifecycle (module)** plays with **SendRef**.

It fails on the divergence. Send's two tables share *every*
transition (`queued → sent → delivered → opened → ...`); the
per-kind variation is in *effect choice* (campaign stats vs.
attachment cleanup), not in the state graph. Template's two tables
disagree on the graph itself: 2 states vs. 3, no scan vs.
scan-in-reducer, no `pending_review` vs. `pending_review →
published | draft` admin edges. A single module would either (a)
fold both graphs into a `Record<TemplateKind, LEGAL_EDGES>` map
that callers have to know to consult correctly, or (b) define a
union graph that allows `pending_review` for both kinds (silently
broken on the email-template side).

Two sibling modules names the asymmetry honestly. Same posture
the codebase took for Campaign + AB test (parallel lifecycles on
the same row, but separate graphs) and for Send + Postbox-outbound
(parallel lifecycles on different tables).

### Publish-while-modified posture — refuse vs auto-revert

**Chosen: refuse unless `forceWhilePublished: true`.**

Auto-revert (any `update` to a publishable field on a published row
silently flips status to `draft`) seems caller-friendly but has two
costs:

1. **Field-classification logic in the reducer.** "Did this update
   touch a publishable field?" branches the reducer on which fields
   changed. Field names like `linkedBlockIds`, `previewText`,
   `searchableText` all need to be classified — and the classification
   is itself a publish-time invariant that drifts as new fields land.

2. **Invisible state changes.** Editor calls `update` on every
   keystroke. Each one auto-reverts. The user doesn't see the
   transition; they're surprised at "I published 30 seconds ago,
   why is this in draft again?".

Refuse-unless-force inverts the cost: the caller must acknowledge
intent. The editor's "Editing this template will unpublish it;
continue?" gate is the natural UX. The guard is one function call
per mutation, no field classification.

### Scope — `update` only vs all publishable-content mutations

**Chosen: all publishable-content mutations.**

`update` is the obvious site, but the same drift hides in
`setDefaultLanguage` (swaps main `subject`/`previewText`/`content`
with a translation's), `removeTranslation` (removes a language that
may be in `htmlTranslations`), `updateTranslation` default-language
path (patches main `subject`/`previewText`), `addTranslation` (the
new translation isn't in the published `htmlTranslations`, but the
user expectation is "translations match published"), and
`changeType` (a published marketing template silently becomes a
published transactional template — a Campaign referencing it by id
silently switches kinds).

One consistent rule across all of them: published rows refuse any
mutation that touches publishable content without
`forceWhilePublished: true`. The exception is `updateSchema`
(transactional only) — it patches `dataVariablesSchema`, which is
read by the **Transactional send intake (module)** for variable
validation. Changing it on a published row could break in-flight
API consumers; same rule applies.

### Pending_review admin edges — land now vs defer

**Chosen: land now.**

The legal-edges graph carries `pending_review → published`
(admin approve) and `pending_review → draft` (admin reject). No
admin mutation exists yet — the surface is follow-up work. But the
graph documents where the surface plugs in, and the reducer kinds
for `'approved'` and `'rejected'` are defined so the eventual
admin shell calls `lifecycle.transition({ to: 'approved' })` and
gets the correct effects (audit-log, no re-scan).

ADR-0017 took the same posture for the Campaign lifecycle's
`pending_review → sending` and `pending_review → draft` edges —
defined ahead of the admin surface so the graph is complete.

### Vocabulary — naming the two row types

**Chosen: Email template + Transactional email.**

Both colloquially called "templates" — the conflict is real. The
CONTEXT.md `_Avoid_` list for **Transactional email** already
reserves "Template alone" as ambiguous. **Email template** for the
`emailTemplates` row matches the table name and stays distinct
from **Transactional email** for the `transactionalEmails` row.

Module names follow naturally: **Email template lifecycle
(module)** and **Transactional email lifecycle (module)**.

## Consequences

### Files that collapse / disappear

| File | What happens |
|---|---|
| `convex/emailTemplates.ts` | Renamed → `convex/emailTemplates/emails.ts`. `publish`, `unpublish`, `create`, `duplicate`, `remove`, `changeType` mutations shrink to thin shells that delegate to `lifecycle.*`. `update` keeps its body but gains the guard call and a `forceWhilePublished?: boolean` arg. Read queries unchanged. |
| `convex/emailTemplatesI18n.ts` | Renamed → `convex/emailTemplates/i18n.ts`. All four mutations (`addTranslation`, `updateTranslation`, `removeTranslation`, `setDefaultLanguage`) gain the guard call + the new arg. Read queries (`getForLanguage`) unchanged. |
| `convex/emailTemplatesOrganization.ts` | Renamed → `convex/emailTemplates/organization.ts`. `createForOrganization` and `createFromPreset` shrink to thin shells delegating to `lifecycle.create`. Read queries unchanged. |
| `convex/transactional/emails.ts` (post-ADR-0021) | `publish`, `unpublish`, `create`, `duplicate`, `remove` delegate to `lifecycle.*`. `update`, `updateSchema` gain guard call + new arg. The 30-line inline scan branch (lines 304-335) moves into the lifecycle reducer. |
| `convex/transactional/translations.ts` (post-ADR-0021) | i18n CRUD gains the guard call + new arg. |

### Files that grow

| File | What it gains |
|---|---|
| `convex/emailTemplates/lifecycle.ts` (new) | The module: `LEGAL_EDGES`, four entry points (`create`, `transition`, `duplicate`, `remove`), private reducers, effect runner, the `assertEditableForPublishableChange` exported guard. ~240 LOC total. |
| `convex/transactional/lifecycle.ts` (new) | The module: 3-state `LEGAL_EDGES` including admin edges, four entry points, private reducers (including the publish-with-scan reducer), effect runner, exported guard. ~320 LOC total (extra weight for the scan branch + admin reducers). |
| `convex/auditActions/catalog.ts` | New audit actions: `email_template.created`, `.published`, `.unpublished`, `.duplicated`, `.deleted`, `transactional_email.created`, `.published`, `.flagged_for_review`, `.approved`, `.rejected`, `.unpublished`, `.duplicated`, `.deleted`. |

### Migration

Pre-prod. No schema migration needed — the new lifecycle reducers
write the same fields the existing mutations already write
(`status`, `publishedAt`, `updatedAt`, plus content/HTML fields on
`→ published`). The `unpublish` change ("clear `publishedAt` on
emailTemplates too") is a behavior bump on existing rows, but
historical rows already in `draft` with stale `publishedAt` keep
that value forever (or until the next publish/unpublish cycle).
Optional one-shot backfill: `UPDATE emailTemplates SET publishedAt =
NULL WHERE status = 'draft'`. Not strictly required; the analytics
queries that distinguish "never published" vs. "previously
published" are read-only and would just see noisy historical data
until the rows cycle.

Steps:

1. **Add audit actions** to `auditActions/catalog.ts`.
2. **Move emailTemplates files** under `convex/emailTemplates/`:
   - `emailTemplates.ts → emailTemplates/emails.ts`
   - `emailTemplatesI18n.ts → emailTemplates/i18n.ts`
   - `emailTemplatesOrganization.ts → emailTemplates/organization.ts`
   Update internal `import` statements between these files.
3. **Add `convex/emailTemplates/lifecycle.ts`** with `LEGAL_EDGES`,
   reducers, four entry points, exported guard.
4. **Add `convex/transactional/lifecycle.ts`** with the 3-state
   `LEGAL_EDGES` (including admin edges), reducers, four entry
   points, exported guard.
5. **Rewire emailTemplates shells.** `publish`, `unpublish`,
   `create` (×3 sites), `duplicate`, `remove`, `changeType`
   delegate to `lifecycle.*`. `update` gains the guard call + new
   arg.
6. **Rewire transactional shells.** Mirror of step 5 in the
   transactional area. Move the inline scan branch into the
   lifecycle reducer.
7. **Add the guard call** to all i18n mutations
   (`addTranslation`, `updateTranslation`, `removeTranslation`,
   `setDefaultLanguage`) on both sides.
8. **Update cross-namespace imports** for the renamed
   emailTemplates files:
   - `api.emailTemplates.*` → `api.emailTemplates.emails.*`
   - `api.emailTemplatesI18n.*` → `api.emailTemplates.i18n.*`
   - `api.emailTemplatesOrganization.*` → `api.emailTemplates.organization.*`
   - matching `internal.*` updates
   Mechanical search-and-replace; Convex codegen regenerates;
   missed references are compile errors.
9. **Optional `publishedAt` backfill** on `emailTemplates` rows
   currently in `draft`. Not blocking.
10. **Tests** — see below.

### Test surface

| Surface | Before | After |
|---|---|---|
| Publish idempotency (publish twice on a published row) | Today: emailTemplates re-patches `publishedAt`; transactional throws. Disagreement masked. | One reducer test per lifecycle asserts `applied: false`, no patch on already-in-state. Same semantics across both modules. |
| Unpublish clears `publishedAt` | Today: emailTemplates leaves it; transactional clears it. | One reducer test per lifecycle asserts `publishedAt` is undefined post-transition. |
| Content scan branches (transactional only) | Inline in `publish` mutation; only testable end-to-end with a real scanner body. | Reducer test: mock `scanContent` to return `clean | suspicious | blocked`, assert next state + effect list per branch. |
| Pending_review admin edges | Untested (no surface, no edges). | Reducer test for `{to: 'approved'}` and `{to: 'rejected'}` from `pending_review` — even before the admin mutation exists, the lifecycle has the edges. |
| Guard refuses on published | Today: untested (no guard). | Pure-function test on `assertEditableForPublishableChange(row, force?)` — eight cases (two statuses × two force values × two reasonable templates). |
| Audit-log effects | Today: untested (no effect). | Effect-list assertion per transition kind — every transition emits `audit_log` with the right action. |

### Behavior

Identical to today on every successful path *except*:

- **`publish` is idempotent on already-published rows.** emailTemplates
  stops re-patching `publishedAt`; both modules now return
  `applied: false` on same-state transitions.
- **`unpublish` clears `publishedAt` on emailTemplates too.**
  Matches transactional's existing behavior.
- **`update` (and i18n mutations and `changeType`) refuse on
  published rows by default.** Callers must pass
  `forceWhilePublished: true` or call `unpublish` first. The editor
  UI gains an "Unpublish to edit?" gate.
- **All status changes emit audit logs.** New rows in
  `auditLogs` with the actions listed above.
- **`pending_review` is reachable out of.** Today nothing
  transitions out of it; the graph documents the admin surface.
  No mutation calls it yet, so observable behavior on the
  pre-existing admin-less path is unchanged.
- **`duplicate` runs `updateBlockUsageCounts` on copied
  `linkedBlockIds`.** Today the duplicate path skips it — saved-
  block usage counts drift on every duplicate. Now counted.

No other observable changes. Customers see today's responses on
every input that worked today.

### Vocabulary

Adds the new section `## Email templates` to CONTEXT.md with three
entries: **Email template**, **Email template status**, **Email
template lifecycle (module)**.

Adds to `## Transactional sends`: **Transactional email status** and
**Transactional email lifecycle (module)**.

Updates the existing **Transactional email** entry to reflect the
3-state union and cross-reference the new status entry.

Adds two new Relationships bullets describing the parallel-lifecycle
shape and bumps the "eight instances" count to ten.

(Already landed alongside this ADR.)

## Follow-up work

- **Admin approve/reject surface** for transactional email
  `pending_review` rows. Mirrors the deferred Campaign admin
  approve/reject surface from ADR-0017. Lands when the platform-admin
  UI grows a "review queue" view.
- **i18n split for transactional.** ADR-0021 moved transactional under
  `transactional/` and the i18n CRUD lives in `translations.ts`. The
  same split that emailTemplates is getting (separate `i18n.ts`) is
  already done on the transactional side. Sanity-check the file
  contents post-deepening; they should be parallel.
- **`updateBlockUsageCounts` on `remove`.** Today
  `emailTemplates.ts:remove` deletes a row but doesn't decrement
  block-usage counts. The deepening's `lifecycle.remove` reverses
  counts via `update_block_usage_counts`; the same fix on the
  transactional side requires checking whether transactional emails
  even use `linkedBlockIds` (today's schema may not allow it).
- **`changeType` deprecation question.** The mutation switches a
  template between `marketing` and `transactional`. The deepening
  refuses it on published rows. If draft-mode type-changes turn out
  to be unused in practice, the mutation can disappear in a
  follow-up.

## Execution

### Steps

1. **Add audit actions to `auditActions/catalog.ts`:**
   - `email_template.created`, `.published`, `.unpublished`,
     `.duplicated`, `.deleted`
   - `transactional_email.created`, `.published`,
     `.flagged_for_review`, `.approved`, `.rejected`, `.unpublished`,
     `.duplicated`, `.deleted`
2. **Create the `convex/emailTemplates/` directory.** Move the three
   existing files in. Update internal imports.
3. **Write `convex/emailTemplates/lifecycle.ts`** — `LEGAL_EDGES`,
   reducers per transition kind, the four entry points (`create`,
   `transition`, `duplicate`, `remove`), the effects runner, and the
   exported `assertEditableForPublishableChange` guard.
4. **Write `convex/transactional/lifecycle.ts`** — same shape, 3-state
   `LEGAL_EDGES`, content-scan-inside-reducer for the `→ published`
   kind, the exported guard.
5. **Rewire `emailTemplates/emails.ts`:**
   - `create`, `duplicate`, `remove` delegate to
     `lifecycle.create / .duplicate / .remove`.
   - `publish` delegates to `lifecycle.transition({to: 'published',
     htmlContent, htmlTranslations?})`.
   - `unpublish` delegates to `lifecycle.transition({to: 'draft'})`.
   - `update` and `changeType` gain `forceWhilePublished?: boolean`
     arg and the guard call.
6. **Rewire `emailTemplates/organization.ts`:**
   - `createForOrganization` and `createFromPreset` delegate to
     `lifecycle.create`.
7. **Rewire `emailTemplates/i18n.ts`:** every mutation
   (`addTranslation`, `updateTranslation`, `removeTranslation`,
   `setDefaultLanguage`) gains `forceWhilePublished?: boolean` +
   guard call.
8. **Rewire `transactional/emails.ts`:** mirror of step 5. The
   inline scan branch at `:304-335` moves into the lifecycle
   reducer.
9. **Rewire `transactional/translations.ts`:** mirror of step 7.
10. **Update cross-namespace imports:**
    - `internal.emailTemplates.*` → `internal.emailTemplates.emails.*`
    - `api.emailTemplates.*` → `api.emailTemplates.emails.*`
    - `internal.emailTemplatesI18n.*` → `internal.emailTemplates.i18n.*`
    - `api.emailTemplatesI18n.*` → `api.emailTemplates.i18n.*`
    - `internal.emailTemplatesOrganization.*` → `internal.emailTemplates.organization.*`
    - `api.emailTemplatesOrganization.*` → `api.emailTemplates.organization.*`
    Mechanical search-and-replace; Convex codegen catches missed
    references at compile.
11. **Tests.** Per-transition-kind reducer tests on both lifecycles.
    Guard tests. End-to-end test: publish → confirm audit row +
    `publishedAt` set + `applied: true`; publish again → confirm
    `applied: false` + no second audit row. Unpublish → confirm
    `publishedAt` cleared. Suspicious-publish on transactional →
    confirm `pending_review` + `contentScanResults` row. The
    pre-existing test for "force-update on published" gets the
    guard's refusal asserted.
12. **Optional one-shot:** `publishedAt = undefined` backfill on
    `emailTemplates` rows in `draft`. Not blocking.

### Verification greps

After execution, these should return zero matches:

```sh
# No file outside the lifecycle writes emailTemplates.status
rg "emailTemplates.*status:" apps/api/convex/ \
  -g '!**/emailTemplates/lifecycle.ts' -g '!**/__tests__/**'

# No file outside the lifecycle writes transactionalEmails.status
rg "transactionalEmails.*status:" apps/api/convex/ \
  -g '!**/transactional/lifecycle.ts' -g '!**/__tests__/**'

# The inline scan + status patch is gone from transactional/emails.ts
rg "scanContent.*status:|status:.*pending_review" apps/api/convex/transactional/emails.ts

# Top-level emailTemplates*.ts files are gone
test ! -f apps/api/convex/emailTemplates.ts && \
test ! -f apps/api/convex/emailTemplatesI18n.ts && \
test ! -f apps/api/convex/emailTemplatesOrganization.ts
```

These should return matches:

```sh
# The two new modules exist
test -f apps/api/convex/emailTemplates/lifecycle.ts && \
test -f apps/api/convex/transactional/lifecycle.ts

# The four moved files are at the new path
test -f apps/api/convex/emailTemplates/emails.ts && \
test -f apps/api/convex/emailTemplates/i18n.ts && \
test -f apps/api/convex/emailTemplates/organization.ts

# CRUD shells delegate to the lifecycle
rg "lifecycle\.transition|lifecycle\.create|lifecycle\.duplicate|lifecycle\.remove" \
  apps/api/convex/emailTemplates/emails.ts apps/api/convex/transactional/emails.ts

# The guard is called from every publishable-content mutation
rg "assertEditableForPublishableChange" apps/api/convex/emailTemplates/ apps/api/convex/transactional/
```

### Done when

- `convex/emailTemplates/lifecycle.ts` exists with `LEGAL_EDGES`,
  four entry points, exported guard.
- `convex/transactional/lifecycle.ts` exists with the 3-state graph
  including the admin edges, content-scan-in-reducer for
  `→ published`, exported guard.
- The four mutations in `emailTemplates/emails.ts` and the five in
  `transactional/emails.ts` that previously wrote `status` directly
  now delegate to the lifecycle.
- All seven publishable-content mutations across the two areas
  call the guard.
- Every status change emits an audit-log row (new actions in the
  catalog).
- The three top-level `emailTemplates*.ts` files are deleted and
  moved under `convex/emailTemplates/`.
- The inline content-scan branch in `transactional/emails.ts:304-335`
  is gone — the scan runs inside the lifecycle reducer.
- The CONTEXT.md `## Email templates` section, the new entries in
  `## Transactional sends`, the updated **Transactional email**
  entry, and the two new Relationships bullets match this ADR.
- Per-transition-kind reducer tests pass on both lifecycles.
- The grep verification matches above all hold.
