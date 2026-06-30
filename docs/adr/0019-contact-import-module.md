# Contact import module + DOI lifecycle admin-attest edge

**Status:** proposed

## Context

Batch contact ingestion lives in **three** mutations across three files,
each composing the same set of already-deepened sub-modules (**Contact
resolution (module)**, **Topic subscription (module)**, contact
activities, `incrementContactCount`) with a slightly different feature
subset and a different auth posture. The three are near-identical at
their core — dedupe within batch, per-row email validation, per-row
`resolveContact`, classify the result, after-loop per-topic
`subscribeMany` coalescing — and they have already drifted.

Concurrent with this, the team needs to import contacts who were
already DOI-confirmed at a source platform (Mailchimp, Klaviyo, Stripe,
etc.) — those contacts should *not* receive a fresh confirmation email
in Owlat. The **DOI lifecycle (module)** today refuses
`not_required → confirmed` outright: there is no path to set
`doiStatus: 'confirmed'` without first going through `'pending'` and a
token-keyed confirm.

### Writer landscape — batch contact import

| Producer | File | Auth | Per-row topic assignment | `incrementContactCount` | `skipDoi` / `siteUrl` | 500-row cap | Writes `contactPropertyValues` | Writes `'created'` activity |
|---|---|---|---|---|---|---|---|---|
| Web UI CSV upload | `contacts/contacts.ts:importBatch:390-546` | session + `contacts:manage` | yes (`contactListAssignments`) | ✅ | ❌ | ✅ | ❌ | ❌ |
| Public HTTP API | `contacts/organization.ts:importBatchForOrganization:388-457` | API key | ❌ (no `topicId`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Mailchimp / Stripe sync | `contacts/internal.ts:importBatchInternal:15-118` (called from `integrationImports.ts`) | internal only | ❌ (single `topicId`) | ❌ | ✅ | ❌ | ❌ | ❌ |

The three loops are structurally identical: lowercase + trim + validate
email, call `resolveContact`, classify `action`, accumulate
`{ imported, updated, skipped, failed, errors }`. The differences are
the auth shell, the input shape's surface (per-row vs single topic),
the post-loop branches (`incrementContactCount`, topic subscription),
and the parameter set exposed.

### 1. `incrementContactCount` skipped on integration imports

`contacts.ts:importBatch:489-491` and
`organization.ts:importBatchForOrganization:449-453` both call
`incrementContactCount(ctx, results.imported)` after the loop. The
internal mutation at `contacts/internal.ts:42-118` — the one driven by
Mailchimp and Stripe page processors — does *not*. Every integration
sync silently leaves the cached `organizations.cachedContactCount`
wrong by the number of imported rows. The drift accumulates per sync.

### 2. Public HTTP API can't subscribe to a topic at import time

`contacts/organization.ts:importBatchForOrganization` accepts only
`{ contacts, handleDuplicates, authUserId }`. There is no `topicId`,
no `contactListAssignments`. Operators using the public API to import
must call `addContactToTopic` separately per contact afterwards. The
web UI shell exposes both single and per-row topic; the API exposes
neither.

### 3. No path can attest to prior DOI

The `skipDoi: true` knob on the **Topic subscription (module)** lives
on the internal-only import path. The web UI CSV upload doesn't expose
it; the public API doesn't expose it. Even with `skipDoi: true`, the
contact's `doiStatus` stays `'not_required'` — Topic subscription's
`skipDoi` only bypasses the membership-side DOI gate, not the contact-
level state. A contact imported with `skipDoi: true` who later joins a
*different* DOI-required topic via a public form goes through DOI
again. The prior platform's confirmation doesn't carry.

The product need is "import contacts who are already DOI-confirmed
elsewhere and have them be `'confirmed'` in Owlat forever after."
That requires writing to `contacts.doiStatus` directly, which today's
DOI lifecycle (module) refuses (`not_required → confirmed` is an
`illegal_edge`).

### 4. Mailchimp `merge_fields` and Stripe `metadata` are silently dropped

`integrationImports.ts:147-156` (Mailchimp) reads
`member.merge_fields` and pulls *only* `FNAME` and `LNAME` into
`firstName` / `lastName`. Every other field the customer configured in
Mailchimp (`COMPANY`, `TIER`, `ACCOUNT_TYPE`, etc.) is silently dropped.

`integrationImports.ts:296-330` (Stripe) reads `customer.metadata`
similarly — it consults only `first_name` / `last_name` /
`firstName` / `lastName` keys, then drops the rest.

CSV imports have the same shape: only `email`, `firstName`, `lastName`,
`language` columns are honored. Any operator-defined CSV column (e.g.
"Tier", "Renewal Date") drops on the floor.

`contactPropertyValues` exists as a schema and as a CRUD surface
(`contacts/propertyValues.ts:set`, `bulkSet`); no import path writes
it.

### 5. No `'created'` contact activity on import

The **Contact activity (module)** entry in CONTEXT.md documents
`inbox/messages.ts:78, 172` as the only non-lifecycle direct writers
— `receiveMessage` writes `'created'` for newly-resolved inbound
contacts. Every batch-imported contact lands without a `'created'`
activity row. A contact created via Mailchimp sync has zero rows in
their contact-timeline UI; a contact created via inbound email has
one. Same `created` semantic, asymmetric audit trail.

### 6. Batch size cap enforced unevenly

`contacts/contacts.ts:importBatch:408-411` enforces a 500-row cap. The
API mutation at `organization.ts:importBatchForOrganization` has no
cap. The internal mutation at `internal.ts:importBatchInternal` has no
cap. Mailchimp page processors cap *themselves* at 100 rows per page
because Mailchimp's pagination cap is 100; Stripe at 100 for the same
reason. The cap is a property of the import module, not the source —
encoding it in one shell is brittle.

### 7. Divergent topic-assignment shapes between shells

Web UI shell:

```ts
{
  topicId?: Id<'topics'>;
  contactListAssignments?: Array<{ email: string; topicIds: Id<'topics'>[] }>;
}
```

API shell: nothing. Internal shell: `topicId?: Id<'topics'>` only.

Per-row topic assignment exists in only one of the three. The CSV
import via the web UI can support "row 1 → topic A; row 2 → topics A,B";
the public API and the integration sync cannot.

### 8. CONTEXT.md anticipates this gap

The **Contact resolution (module)** entry's `_Avoid_` clause already
reserves "Contact intake" because "overlaps with the import path's
terminology" — i.e., the import path is expected to land as a named
deepening. CONTEXT.md has the **Form submission (module)** entry as
the closest precedent: same compose-resolve-then-subscribe-then-
classify shape, single batch entry, structured outcome, replaces N
open-coded sites with one writer.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one of the three
`importBatch*` mutations leaves the same shape (dedupe, validate,
resolve, classify, after-loop coalesced subscribeMany) in the
remaining two. Deleting all three concentrates that shape at one
seam.

The composition is the natural module — the sub-modules (Contact
resolution, Topic subscription, contact activity, DOI lifecycle,
`incrementContactCount`) are each deep enough on their own; what's
missing is the *batch-shaped composition* of them, plus the property
writes that have no place to land today.

Two adapters exist for source-specific row normalization (Mailchimp
`merge_fields` flattening, Stripe `metadata` mapping). Per LANGUAGE.md
"two adapters means a real seam," but the seam isn't named because
each integration's normalization is open-coded inline. CSV's column-to-
row mapping is the third would-be adapter.

## Decision

One new module and one DOI lifecycle expansion:

- **`apps/api/convex/contacts/import.ts`** — **Contact import (module)**.
  Single internal mutation `importBatch` owning batch composition,
  property writes, contact activity writes, and (optionally) DOI
  admin-attest dispatch.
- **`apps/api/convex/contacts/doiLifecycle.ts`** — gains a new
  `not_required → confirmed` legal edge gated by
  `source: 'admin_attest'` on the `TransitionInput`. New reducer
  branch, new companion field `doiAttestedSource`, new audit action,
  new contact activity literal.

Plus: 3 schema additions, 1 audit-action literal, 1 contact-activity
literal (with both writer and editor halves), and 1 API-key
permission. Three existing shells thin out; one internal mutation is
deleted (`importBatchInternal`).

### Contact import (module) shape

```ts
// apps/api/convex/contacts/import.ts

import { internalMutation } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

export type ImportSource = 'csv' | 'api' | 'mailchimp' | 'stripe';

export type ImportRow = {
  email: string;
  firstName?: string;
  lastName?: string;
  language?: string;
  properties?: Record<string, JsonPrimitive>;
};

export type DoiAttestation = {
  attestSource: string;            // 'mailchimp' | 'klaviyo' | 'stripe' | 'csv_admin' | ...
};

export type TopicAssignments =
  | { kind: 'single'; topicId: Id<'topics'> }
  | { kind: 'per_row'; map: Record<string /* lowercased email */, Id<'topics'>[]> };

export type ImportInput = {
  rows: ImportRow[];
  source: ImportSource;
  handleDuplicates: 'skip' | 'update';
  topicAssignments?: TopicAssignments;
  doiAttest?: DoiAttestation;
  siteUrl?: string;
};

export type ImportOutcome = {
  imported: number;                 // resolution returned 'created'
  updated: number;                  // resolution returned 'updated'
  skipped: number;                  // resolution returned 'matched' + within-batch dupes
  failed: number;                   // email validation failures
  errors: string[];                 // per-row + batch-level summary lines, capped
  addedToTopics: number;            // freshly-inserted memberships
  propertiesSet: number;            // contactPropertyValues writes
  propertiesAutoRegistered: number; // mailchimp/stripe paths only
  propertiesSkipped: number;        // csv/api paths only (unknown keys)
  activitiesRecorded: number;       // 'created' + 'property_updated'
};

export const importBatch = internalMutation({
  args: { /* validators matching ImportInput */ },
  handler: async (ctx, args): Promise<ImportOutcome> => { /* ... */ },
});
```

### Per-row order of operations

The ordering is load-bearing — step 5 must precede step 6 so that
DOI-required topic memberships activate immediately rather than
firing a confirmation email at subscribe time:

1. Lowercase + trim + validate `email` (must contain `@`, must pass
   string-length validation). On failure: record one `errors[]`
   entry, increment `failed`, continue.
2. Route through the **Contact resolution (module)** `resolveContact`
   with `mode` derived from `handleDuplicates`
   (`'skip' → 'upsert'`, `'update' → 'merge'`).
3. Apply property writes per the source-gated catalog policy (below).
4. Call `recordContactActivity`:
   - `'created'` when resolution returned `action: 'created'`.
   - `'property_updated'` when at least one property value was
     written against an existing contact (`action !== 'created'`).
5. When `doiAttest` is set on the input: call
   **DOI lifecycle (module)** `transition({ contactId, input: {
   to: 'confirmed', source: 'admin_attest', attestSource:
   doiAttest.attestSource } })`. This relaxes the otherwise-refused
   `not_required → confirmed` edge.

After the row loop:

6. Per-topic `subscribeMany` coalescing through the **Topic
   subscription (module)** — one `subscribeMany` mutation call per
   distinct topic in `topicAssignments`, with the array of contact
   ids for that topic. Mirrors the existing per-topic coalescing in
   `contacts/contacts.ts:importBatch:498-541`.
7. One `incrementContactCount(ctx, imported)` call. Closes the
   silent drift bug where Mailchimp/Stripe imports skipped this.

### Property-key policy (gated by `source`)

The module loads `contactProperties` once per batch (one query,
key → `Id<'contactProperties'>`). For each row's `properties` blob:

| Property key state | Source `'csv' \| 'api'` | Source `'mailchimp' \| 'stripe'` |
|---|---|---|
| Key resolves to existing `contactProperties` row | Write `contactPropertyValues` row. Increment `propertiesSet`. | Same. Increment `propertiesSet`. |
| Key does not resolve | Skip the write. Increment `propertiesSkipped`. Surface one batch-level summary line in `errors[]` (`"Property 'COMPANY' is not registered; values dropped for 5 rows."`). Contact otherwise imports normally. | Insert a `contactProperties` row with `autoRegistered: true`, `autoRegisteredSource: source`, `dataType` inferred from value (`'boolean' \| 'number' \| 'string'` — string fallback). Write the `contactPropertyValues` row. Increment `propertiesAutoRegistered`. |

The `csv` and `api` policy is strict because operators are presumed
to have intent over their column choices — silent auto-registration
of typo'd column names ("Tier" → registered, "Tor" typo → also
registered) would fill the property registry with noise.

The `mailchimp` and `stripe` policy is permissive because the
operator does *not* control the foreign system's field names; the
sync should be best-effort lossless. The `autoRegistered` flag lets
the web UI surface an "auto-registered from Mailchimp" badge so the
operator can review and re-name / merge / delete those rows.

### DOI lifecycle admin-attest edge

```ts
// apps/api/convex/contacts/doiLifecycle.ts (additions)

export type DoiTransitionInput =
  | { to: 'pending'; token: string; ttlMs: number; siteUrl?: string }
  | { to: 'confirmed' }                                                  // existing — pending → confirmed
  | { to: 'confirmed'; source: 'admin_attest'; attestSource: string };   // NEW

// Legal-edges addition:
//   not_required → confirmed   (only when input.source === 'admin_attest')

// Reducer branch (new):
function reduceAdminAttest(
  contact: Doc<'contacts'>,
  input: Extract<DoiTransitionInput, { source: 'admin_attest' }>,
): { patch: Partial<Doc<'contacts'>>; effects: DoiEffect[]; applied: boolean } {
  // Idempotent: contact already confirmed → recorded no-op (no second activity row).
  if (contact.doiStatus === 'confirmed') {
    return { patch: {}, effects: [], applied: false };
  }

  // Legal only from not_required (pending → confirmed is the token-keyed reducer).
  // The transition() router enforces legal_edges before calling this reducer.

  const now = Date.now();
  return {
    patch: {
      doiStatus: 'confirmed',
      doiConfirmedAt: now,
      doiAttestedSource: input.attestSource,
    },
    effects: [
      {
        kind: 'audit_log',
        action: 'doi.admin_attested',
        contactId: contact._id,
        details: { attestSource: input.attestSource },
      },
      {
        kind: 'contact_activity',
        literal: 'doi_attested',
        contactId: contact._id,
        metadata: { attestSource: input.attestSource },
      },
      // fire_topic_subscribed_triggers — same as token-keyed confirm; no-op
      // when the contact has no DOI-required memberships yet (the typical
      // import order: attest → subscribe means this fan-out is empty).
      { kind: 'fire_topic_subscribed_triggers', contactId: contact._id },
    ],
    applied: true,
  };
}
```

The token-keyed `pending → confirmed` reducer is unchanged. The
`pending → confirmed` edge does not accept `source: 'admin_attest'` —
once a contact is in `'pending'` they have an outstanding
confirmation token and the token-keyed path is the only way out.

### Three thin shells

```ts
// apps/api/convex/contacts/contacts.ts:importBatch (web UI CSV upload, public mutation)
export const importBatch = mutation({
  args: {
    contacts: v.array(/* row validator */),
    handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
    topicId: v.optional(v.id('topics')),
    contactListAssignments: v.optional(v.array(/* per-row assignment */)),
    doiAttest: v.optional(v.object({ attestSource: v.string() })),
  },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    const session = await getMutationContext(ctx);
    requirePermission(
      hasPermission(session.role, 'contacts:manage'),
      'Only owners and admins can import contacts',
    );

    const topicAssignments = args.contactListAssignments
      ? {
          kind: 'per_row' as const,
          map: Object.fromEntries(
            args.contactListAssignments.map((a) => [
              a.email.toLowerCase().trim(),
              a.topicIds,
            ]),
          ),
        }
      : args.topicId
      ? { kind: 'single' as const, topicId: args.topicId }
      : undefined;

    return await ctx.runMutation(internal.contacts.import.importBatch, {
      rows: args.contacts,
      source: 'csv',
      handleDuplicates: args.handleDuplicates,
      topicAssignments,
      doiAttest: args.doiAttest,
    });
  },
});
```

```ts
// apps/api/convex/contacts/organization.ts:importBatchForOrganization (API-key, public mutation)
export const importBatchForOrganization = mutation({
  args: {
    contacts: v.array(/* row validator */),
    handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
    authUserId: v.string(),
    topicId: v.optional(v.id('topics')),                           // NEW — gap closed
    doiAttest: v.optional(v.object({ attestSource: v.string() })), // NEW
  },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    // API key auth has been validated at the HTTP shell.
    if (args.doiAttest) {
      await requireApiKeyPermission(ctx, args.authUserId, 'contacts:import_attest');
    }

    return await ctx.runMutation(internal.contacts.import.importBatch, {
      rows: args.contacts,
      source: 'api',
      handleDuplicates: args.handleDuplicates,
      topicAssignments: args.topicId
        ? { kind: 'single', topicId: args.topicId }
        : undefined,
      doiAttest: args.doiAttest,
    });
  },
});
```

```ts
// apps/api/convex/integrationImports.ts (Mailchimp page processor)
// Replaces lines 158-184 of the existing handler.

const rows: ImportRow[] = [];
for (const member of data.members) {
  if (member.status !== 'subscribed') continue;
  const { FNAME, LNAME, ...customMergeFields } = member.merge_fields ?? {};
  rows.push({
    email: member.email_address.toLowerCase(),
    firstName: FNAME,
    lastName: LNAME,
    properties: Object.fromEntries(
      Object.entries(customMergeFields).filter(
        ([, v]) => v !== undefined && v !== '',
      ),
    ),
  });
}

if (rows.length > 0) {
  try {
    const result = await ctx.runMutation(internal.contacts.import.importBatch, {
      rows,
      source: 'mailchimp',
      handleDuplicates: args.handleDuplicates,
      topicAssignments: args.topicId
        ? { kind: 'single', topicId: args.topicId }
        : undefined,
      doiAttest: { attestSource: 'mailchimp' },
    });
    /* update batch counters from `result` */
  } catch (error) { /* unchanged */ }
}
```

The Stripe page processor follows the same shape with
`source: 'stripe'`, `attestSource: 'stripe'`, and `customer.metadata`
(minus the name keys) mapped into `properties`.

`contacts/internal.ts:importBatchInternal` — deleted. The Mailchimp
and Stripe processors now call `internal.contacts.import.importBatch`
directly.

### File layout

```
apps/api/convex/contacts/
  import.ts                          (new) — Contact import module
  __tests__/
    contactImport.integration.test.ts (new) — module's integration tests
  contacts.ts                        (thinned) — importBatch shell
  organization.ts                    (thinned) — importBatchForOrganization shell
  internal.ts                        (deleted — only contained importBatchInternal)
  doiLifecycle.ts                    (extended) — new admin_attest edge

apps/api/convex/contactActivities/
  doi_attested/
    index.ts                         (new) — writer half (server)
  catalog.ts                         (extended) — adds 'doi_attested' literal

apps/web/app/composables/contactActivities/
  doi_attested/
    index.ts                         (new) — editor half (display config + formatter)
  index.ts                           (extended) — registers FE editor module

apps/api/convex/
  integrationImports.ts              (modified) — Mailchimp + Stripe row normalization

apps/api/convex/auditActions/
  catalog.ts                         (extended) — adds 'doi.admin_attested'

apps/api/convex/schema/
  contacts.ts                        (extended) — adds doiAttestedSource
  contactProperties.ts (or wherever) (extended) — adds autoRegistered fields
  apiKeys.ts (or wherever)           (verified/extended) — permissions array
```

### Schema additions

```ts
// schema/contacts.ts (additions to the `contacts` table)
doiAttestedSource: v.optional(v.string()),  // populated only when status is 'confirmed'
                                            // via the admin-attest path

// schema/contactProperties.ts (additions)
autoRegistered: v.optional(v.boolean()),
autoRegisteredSource: v.optional(v.string()),  // 'mailchimp' | 'stripe' | ...

// schema/apiKeys.ts (verify presence; add if missing)
permissions: v.optional(v.array(v.string())),  // e.g. ['contacts:import_attest']
```

### Catalog additions

```ts
// auditActions/catalog.ts
| 'doi.admin_attested'

// contactActivities/catalog.ts (CONTACT_ACTIVITY_TYPE_LITERALS)
| 'doi_attested'

// API key permissions catalog (wherever it lives)
| 'contacts:import_attest'
```

### Module entry validators (sketch)

```ts
const rowValidator = v.object({
  email: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  language: v.optional(v.string()),
  properties: v.optional(v.record(v.string(), v.union(
    v.string(), v.number(), v.boolean(), v.null(),
  ))),
});

const topicAssignmentsValidator = v.optional(v.union(
  v.object({ kind: v.literal('single'), topicId: v.id('topics') }),
  v.object({
    kind: v.literal('per_row'),
    map: v.record(v.string(), v.array(v.id('topics'))),
  }),
));

const doiAttestValidator = v.optional(v.object({ attestSource: v.string() }));
```

## Considered options

### Scope of the seam

1. **Per-row module** — `importContact(row)`. Each existing shell
   keeps its batch loop and per-row dedupe/coalescing. Smaller
   change; doesn't move the dedup, count-coalesce, or per-topic
   coalescing logic. Rejected — the drift bugs (`incrementContactCount`,
   per-topic coalescing) live in the batch-after-loop section. A per-
   row module would close none of them.
2. **Per-batch module** *(chosen)* — `importBatch(input)`. Module
   owns the row loop, dedup, property catalog, per-topic
   `subscribeMany` coalescing, and the after-loop count. Shells
   become parse + dispatch.
3. **Per-source module family** — `importFromCsv` / `importFromMailchimp`
   / `importFromStripe`. Each source has its own entry that knows how
   to extract rows from the source-specific payload. Rejected —
   moves the source adapter into the module, expanding scope without
   benefit. The per-source row normalization stays in the adapter
   file because it's coupled to the foreign API's shape, not to
   Owlat's contact-resolution sequence.

### DOI semantic for "already-confirmed-elsewhere" imports

1. **Use Topic subscription's existing `skipDoi: true`** — Topic
   subscription already bypasses the DOI gate per-membership when
   `skipDoi` is true. Contact's `doiStatus` stays `'not_required'`.
   Rejected — the prior platform's confirmation doesn't *persist*
   on the contact; a later DOI-required topic subscription via a
   public form would re-trigger DOI for the same person.
2. **Extend DOI lifecycle with an `admin_attest` source** *(chosen)*
   — relax the `not_required → confirmed` legal edge specifically
   when the input carries `source: 'admin_attest'`. Contact reaches
   `'confirmed'` permanently. Adds the `doiAttestedSource` companion
   field on `contacts`, the `doi.admin_attested` audit action, and
   the `'doi_attested'` contact activity literal.
3. **Per-contact `confirmedElsewhereAt: number` field, queried by
   Topic subscription** — store the attestation as a sibling fact
   without touching the DOI lifecycle. Topic subscription's gate
   becomes `skipDoi || !requireDoubleOptIn || doiStatus ===
   'confirmed' || confirmedElsewhereAt !== undefined`. Rejected —
   introduces a second source of truth for "is this contact
   DOI-confirmed in Owlat's eyes," and the existing automation
   triggers + activity rows + audit log would all need to learn
   about the new field. Concentrating the rule at the DOI lifecycle
   (option 2) keeps `doiStatus` as the single source of truth.

### Property-key policy

1. **Auto-register everywhere** — any unknown property key auto-
   creates a `contactProperties` row regardless of source. Friendly
   to importers. Rejected — operators typo'ing CSV column names
   would silently fill the registry. The web UI's contact-property
   catalog becomes noise.
2. **Skip silently everywhere** — unknown keys → no write, no error.
   Safe. Rejected — operators expect their CSV columns to land; the
   silent drop is the wrong default for a paid import action.
3. **Fail the row everywhere** — unknown key → row goes to `errors`.
   Strict. Rejected — punishes the entire row for one typo'd
   property; loses contacts unnecessarily.
4. **Per-source policy: strict for operator-driven sources
   (`csv`, `api`), auto-register for integration-driven sources
   (`mailchimp`, `stripe`)** *(chosen)*. Matches the actual
   ownership model — operators control CSV/API column intent;
   foreign platforms control their own field naming. The
   `autoRegistered` flag on `contactProperties` lets the operator
   review auto-created rows in the web UI later.
5. **Configurable per-call policy** — `unknownProperties: 'skip' |
   'fail' | 'auto_register'`. Most expressive. Rejected as
   premature — no caller is asking for per-call control, and the
   per-source default policy covers every existing caller's
   semantic correctly.

### Shell collapse

1. **Three thin shells, one module entry** *(chosen)*. Each shell
   keeps its existing auth posture (session+permission, API key,
   internal). Composition moves out.
2. **One public mutation, branches on auth shape** — single
   `importBatch` mutation accepting both session and `authUserId`,
   dispatching based on which is set. Rejected — couples auth
   shapes that today live in separate Convex mutation kinds
   (`mutation` vs an API-key-shell `mutation`). Mirrors no other
   convention in the codebase.
3. **Module entry as a public mutation; integrations call it
   internally too** — single `importBatch` mutation, both public
   shells and integration actions call it. Rejected — public
   mutations require auth-shell handling that the integration
   processors don't have (and shouldn't fake). The internal
   mutation is the right Convex kind for the composition; thin
   public shells wrap it with auth.

### Module naming

1. **Contact import (module)** *(chosen)*. Matches the row's
   intent verb. CONTEXT.md's **Contact resolution (module)** entry
   reserves "Contact intake" in its `_Avoid_` clause specifically
   for this slot; "import" is the established noun.
2. **Contact intake (module)** — rejected, per the above.
3. **Contact batch (module)** — rejected. Names the shape, not the
   role. Mirrors "Contact resolution (module)"'s `_Avoid_` reasoning:
   the unit is the operation, not the batching.
4. **Contact upload (module)** — rejected. Collides with the file-
   upload UI concept; suggests the module owns the HTTP payload
   parse, which it does not.
5. **Bulk contact (module)** — rejected. The module also handles
   the single-page Mailchimp / Stripe sync, which the operator does
   not perceive as "bulk."

### DOI attest source: enum vs free string

1. **`attestSource: string`** *(chosen)*. Free-form. Today's known
   sources: `'mailchimp'`, `'stripe'`. Anticipated: `'klaviyo'`,
   `'salesforce'`, `'csv_admin'`, `'hubspot'`. Each new integration
   passes its own label; no central enum to maintain. Audit log and
   activity row carry the label verbatim.
2. **`attestSource: 'mailchimp' | 'stripe' | 'klaviyo' | 'csv_admin' | ...`**
   — typed union. Rejected — adding an integration becomes a
   coordinated edit across the DOI lifecycle, the activity module,
   the audit catalog, and the import module. Free-form keeps the
   integration as a one-file change.

### Activity literal: new `doi_attested` vs reuse existing

1. **New `'doi_attested'` literal** *(chosen)*. Distinct semantic
   from `'topic_confirmed'`: attestation records the contact-level
   DOI promotion, not a topic-membership confirmation. Carries
   `{ attestSource }` metadata; the contact's timeline UI surfaces
   "DOI attested from Mailchimp" rows.
2. **Reuse `'topic_confirmed'` for the attest path's
   fire-triggers-effect** — emit one `'topic_confirmed'` row per
   DOI-required Topic membership at attest time. Rejected — at
   attest time during import the contact typically has no
   memberships yet (the import module's ordering: attest precedes
   subscribe), so the fan-out is empty. The attestation itself
   gets no row.
3. **Skip the activity row entirely; rely on audit log** —
   rejected. The contact timeline UI is the operator-facing
   surface; "this contact became DOI-confirmed via Mailchimp" is
   the kind of fact the operator wants to see on the contact
   detail page.

### Audit action: new `doi.admin_attested` vs reuse `doi.confirmed`

1. **New `doi.admin_attested` action** *(chosen)*. Distinct from
   `doi.confirmed` (token-keyed). The compliance / audit consumer
   needs to distinguish "contact confirmed via clicking a link" from
   "contact was attested as confirmed by an admin import." Same
   `audit_log` effect, different action literal, different
   `details` payload.
2. **Reuse `doi.confirmed`** with a `details.via: 'admin_attest'`
   marker — rejected. Audit log consumers filter on action literal;
   forcing them to also unpack `details.via` to distinguish "real
   confirmation" from "attestation" loses the audit trail's
   signal-to-noise.

### Permission gating on public ingest

1. **`contacts:manage` gates both ordinary import and attest on
   web UI; new `contacts:import_attest` API-key permission gates
   attest on API** *(chosen)*. Web UI's `contacts:manage` is already
   owner+admin only; tying attest to the same role is consistent
   with the "admin authoritative" framing CONTEXT.md uses for
   Topic subscription's `skipDoi`. API keys are separate-trust
   entities (potentially issued to third-party scripts), so attest
   gets its own permission flag that an org owner explicitly grants.
2. **Same `contacts:manage` everywhere** — rejected. API keys today
   carry no permission flags; treating any authenticated API key as
   able to set `doiStatus: 'confirmed'` directly is more trust than
   the existing API surface conveys.
3. **New role required (`owner` only)** — rejected. The team-roles
   matrix (owner / admin / member) already has `contacts:manage` as
   owner+admin. Narrowing to owner-only contradicts existing
   admin-can-do-everything-contact-related conventions.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/contacts/internal.ts` — the file's sole export
  `importBatchInternal` is deleted. The file may be deleted
  outright if nothing else inhabits it.
- `contacts/contacts.ts:importBatch` — shrinks from ~158 LOC to
  ~30 LOC (auth shell + topicAssignments build + dispatch).
- `contacts/organization.ts:importBatchForOrganization` — shrinks
  from ~70 LOC to ~25 LOC. Gains `topicId` and `doiAttest`
  parameters (net new capability).
- `integrationImports.ts` — the per-page row-build sections
  (~25 LOC each in Mailchimp + Stripe processors) gain the
  `properties` field mapping but lose the parallel `imported /
  updated / skipped / failed` accumulation since they now receive
  the structured outcome directly. Roughly LOC-neutral.

### Files that grow

- `apps/api/convex/contacts/import.ts` — new module (~280 LOC).
  Validators, the `importBatch` handler with the per-row loop, the
  property catalog resolution + write, the `recordContactActivity`
  calls, the optional DOI attest dispatch, the per-topic
  coalescing, the `incrementContactCount`.
- `apps/api/convex/contacts/doiLifecycle.ts` — gains a reducer
  branch (~30 LOC), the `admin_attest` discriminator on
  `TransitionInput`, the `not_required → confirmed` legal-edge
  exception.
- `apps/api/convex/contactActivities/doi_attested/index.ts` — new
  writer module (~25 LOC). Exports
  `ContactActivityModule<'doi_attested'>` with `metadataSchema`
  validating `{ attestSource: v.string() }`.
- `apps/web/app/composables/contactActivities/doi_attested/index.ts`
  — new editor module (~25 LOC). Exports
  `ContactActivityEditorModule<'doi_attested'>` with display
  config (icon: shield-check, label: 'DOI attested', color: green)
  and `formatDescription(metadata) → 'DOI attested via ${metadata.attestSource}'`.
- `apps/api/convex/auditActions/catalog.ts` — one new literal
  `'doi.admin_attested'`. Net ~3 LOC.
- `apps/api/convex/contactActivities/catalog.ts` — one new literal
  in `CONTACT_ACTIVITY_TYPE_LITERALS`. Net ~2 LOC.
- `apps/api/convex/schema/contacts.ts` — `doiAttestedSource: v.optional(v.string())`.
  Net ~2 LOC.
- `apps/api/convex/schema/<contactProperties location>.ts` —
  `autoRegistered` + `autoRegisteredSource` fields. Net ~3 LOC.
- `apps/api/convex/schema/<apiKeys location>.ts` — verify
  `permissions: v.optional(v.array(v.string()))` exists; add if not.
  Net 0-3 LOC.
- `apps/api/convex/contacts/__tests__/contactImport.integration.test.ts`
  — new (~30 tests; see §Test surface).
- `apps/api/convex/__tests__/doiLifecycle.integration.test.ts` —
  gains ~8 tests for the admin-attest path.

Net LOC change: ~250 LOC down (deleted internal mutation + thinned
shells) plus ~400 LOC up (new module, lifecycle extension, activity
module pair, schema/catalog additions) plus ~500 LOC up (new tests).
Net ~+650 LOC. Value: locality (import writers 3 → 1, drift bugs 7 →
0, the missing DOI-attest surface lands as one capability across all
three shells), the new "import-already-confirmed" capability the
product needs, the property-write surface that's been dormant.

### Migration

No backfill required. The three new fields are all
`v.optional(...)`:

- `contacts.doiAttestedSource` — undefined on existing rows; only
  the admin-attest path writes it.
- `contactProperties.autoRegistered` / `autoRegisteredSource` —
  undefined on existing rows; only the integration import paths
  set them.
- `apiKeys.permissions` — if the field doesn't already exist,
  existing rows materialize with `undefined` which `requireApiKeyPermission`
  treats as "no permissions"; existing API keys retain their
  current capability set (everything except `doiAttest`).

The deletion of `importBatchInternal` requires the Mailchimp and
Stripe integration actions to be updated atomically with the new
module landing. No in-flight import is at risk because integration
imports are per-page (no row spans the deployment).

### Test surface

`apps/api/convex/contacts/__tests__/contactImport.integration.test.ts`
(new, ~30 tests):

**Per-source resolution:**
- `source: 'csv'`, `handleDuplicates: 'skip'`: existing email
  resolves as `matched`, returns `skipped: 1`.
- `source: 'csv'`, `handleDuplicates: 'update'`: existing email
  with new `firstName` resolves as `updated`, returns `updated: 1`.
- `source: 'api'`, fresh email: resolves as `created`, returns
  `imported: 1`.
- `source: 'mailchimp'`, batch of 50 mixed (some existing, some
  new, some duplicates within batch): correct accumulation.
- Within-batch dedup keeps first occurrence.

**Topic assignments:**
- `topicAssignments: { kind: 'single', topicId }`: every imported
  contact subscribed via one `subscribeMany` call.
- `topicAssignments: { kind: 'per_row', map }`: per-row topic
  assignment; multiple topics per contact; correct per-topic
  coalescing (one `subscribeMany` call per distinct topic
  regardless of contact count).
- No `topicAssignments`: no subscription writes.

**Property policy:**
- `source: 'csv'`, known property key: writes `contactPropertyValues`,
  increments `propertiesSet`.
- `source: 'csv'`, unknown property key, 5 rows affected: contacts
  import normally, `propertiesSkipped: 5`, one batch summary line
  in `errors[]`.
- `source: 'mailchimp'`, unknown property key: `contactProperties`
  row inserted with `autoRegistered: true`,
  `autoRegisteredSource: 'mailchimp'`, value written,
  `propertiesAutoRegistered` incremented.
- `source: 'mailchimp'`, multiple rows with same unknown key:
  one `contactProperties` row inserted (not duplicated), values
  written for each row.
- Property `dataType` inference: number value → `'number'`,
  boolean → `'boolean'`, string → `'string'`, null/undefined →
  skipped.

**DOI attest:**
- `doiAttest: { attestSource: 'mailchimp' }`, fresh contact:
  contact ends at `doiStatus: 'confirmed'`,
  `doiAttestedSource: 'mailchimp'`, `doi_attested` activity row,
  `doi.admin_attested` audit log.
- `doiAttest` set, contact already `'confirmed'`: idempotent —
  no new activity row, no new audit log.
- `doiAttest` set, contact in `'pending'`: idempotent or
  refused — the reducer treats `'pending'` as outside the
  attest path (the token-keyed flow must complete; attestation
  doesn't override a pending confirmation).
- `doiAttest` set, contact subscribes to DOI-required topic in
  same batch: subscription fires the `subscribed` trigger
  immediately (no confirmation email), per the ordering rule.

**`incrementContactCount`:**
- 5 imported, 3 updated, 2 skipped: count increments by 5 (only
  `imported`).
- 0 imported (all duplicates): no `incrementContactCount` call.

**Contact activity writes:**
- New contact: `'created'` activity row.
- Existing contact with property writes: `'property_updated'`
  activity row.
- Existing contact, no property writes: no activity row.

**Shell smoke tests** (~6 tests across the three shells):
- `contacts.ts:importBatch` dispatches with `source: 'csv'`.
- `contacts.ts:importBatch` rejects non-`contacts:manage` callers.
- `organization.ts:importBatchForOrganization` dispatches with
  `source: 'api'`.
- `organization.ts:importBatchForOrganization` with `doiAttest`
  but without `contacts:import_attest` permission: refused.
- Mailchimp processor dispatches with `source: 'mailchimp'`,
  `attestSource: 'mailchimp'`, properties extracted from
  `merge_fields` minus FNAME/LNAME.
- Stripe processor dispatches with `source: 'stripe'`,
  `attestSource: 'stripe'`, properties extracted from `metadata`
  minus name keys.

`apps/api/convex/__tests__/doiLifecycle.integration.test.ts`
(extended, ~8 new tests):

- `not_required → confirmed` with `source: 'admin_attest'`:
  patches `doiStatus`, `doiConfirmedAt`, `doiAttestedSource`;
  emits `doi.admin_attested` audit + `doi_attested` activity.
- `not_required → confirmed` without `source: 'admin_attest'`:
  refused as `illegal_edge`.
- `pending → confirmed` with `source: 'admin_attest'`: refused
  (token-keyed path is the only way out of `pending`).
- `confirmed → confirmed` with `source: 'admin_attest'`:
  idempotent recorded no-op (no second audit row, no second
  activity row).
- `not_required → confirmed` admin-attest with the contact
  holding DOI-required Topic memberships at attest time:
  per-topic `topic_confirmed` activity rows fire (the existing
  `fire_topic_subscribed_triggers` effect runs).
- `not_required → confirmed` admin-attest with no Topic
  memberships: the `topic_subscribed_triggers` effect fires
  with an empty membership list (no-op).
- Reducer leaves the `doiConfirmationToken` /
  `doiTokenExpiresAt` companions untouched (they were
  `undefined` since `'not_required'` doesn't write them).
- Audit log payload carries `details.attestSource: 'mailchimp'`.

### CONTEXT.md additions

Already landed inline during the grilling conversation:

- **DOI status** entry: added `doiAttestedSource` companion,
  added the `not_required → confirmed` admin-attest legal edge.
- **DOI lifecycle (module)** entry: updated `transition` entry
  point description; added the `contact_activity('doi_attested')`
  and `audit_log('doi.admin_attested')` effects.
- **Contact activity** entry: literal count 12 → 13.
- **Contact activity (module)** entry: Contact import (module)
  added as a third non-lifecycle direct writer.
- New **Contact import (module)** entry at the end of the
  Contacts section.

### Vocabulary discipline

Avoid:

- **Contact intake (module)** — already reserved by the **Contact
  resolution (module)** entry's `_Avoid_` clause for this slot.
- **Contact batch (module)** — names the shape, not the role.
- **Contact upload (module)** — collides with file-upload UI.
- **Bulk contact (module)** — covers only part of the intent.
- **Contact resolution (module)** alone (without the "import"
  wrapper) — collapses the composition; loses the property /
  activity / DOI / topic surface that import owns and resolution
  doesn't.

### Cross-references

- ADR-0008 (Contact resolution module) — the per-row resolve
  step this module composes.
- ADR-0009 (DOI lifecycle module) — the lifecycle this ADR
  extends with the admin-attest edge.
- ADR-0013 (Topic subscription module) — the per-topic
  `subscribeMany` step this module composes.
- ADR-0015 (Form submission module) — the closest precedent
  shape: single batch entry, classification outcome, replaces N
  open-coded sites with one writer.
- ADR-0017 (Campaign lifecycle modules) — the `source`
  discriminator pattern on `TransitionInput` adopted here for
  the DOI lifecycle's `admin_attest` source.
