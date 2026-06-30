# Contact resolution module — single entry point for find-or-create

**Status:** accepted

## Context

**Ten** sites in `apps/api/convex/` re-implement "given an identifier, find or
create a Contact." Each varies in subtle, drift-prone ways. The pre-existing
`contacts/identities.ts:findByIdentifier` query is the only typed read-side
primitive — but it has no production callers because the identity table
is only populated by *one* of the ten create paths.

(The original review surfaced four sites; full implementation grep against
`ctx.db.insert('contacts',` revealed six more, all sharing the same shape.)

| Site | Mode | Lookup | Soft-delete filter | `contactIdentities` row? | `'created'` activity? | `searchableText`? |
|---|---|---|---|---|---|---|
| `inbox/messages.ts:receiveMessage` | upsert | `contacts.by_email` | ❌ | ❌ | ✅ | ✅ |
| `webhooks/channels.ts:processInboundChannel` | upsert | `contactIdentities` then `by_email` (generic) | ❌ | ✅ | ❌ | ❌ |
| `automations/triggers.ts:sendEvent` | upsert | `contacts.by_email` | ❌ | ❌ | ❌ | ❌ |
| `contacts/internal.ts:importBatchInternal` | upsert/merge | `contacts.by_email` | ❌ | ❌ | ❌ | ❌ |
| `contacts/contacts.ts:create` | strict | `contacts.by_email` | ✅ | ❌ | ❌ | ✅ |
| `contacts/contacts.ts:createForTeam` | strict | `contacts.by_email` | ✅ | ❌ | ❌ | ✅ |
| `contacts/contacts.ts:importBatch` | upsert/merge | `contacts.by_email` | ❌ | ❌ | ❌ | partial |
| `contacts/organization.ts:createForOrganization` | strict | `contacts.by_email` | ❌ | ❌ | ❌ | ✅ |
| `contacts/organization.ts:createForOrganizationInternal` | strict | `contacts.by_email` | ❌ | ❌ | ❌ | ✅ |
| `contacts/organization.ts:importBatchForOrganization` | upsert/merge | `contacts.by_email` | ❌ | ❌ | ❌ | partial |

Five drift signals concentrate.

### 1. Soft-delete filter is missing in three of four sites

Only `createForTeam` filters `deletedAt === undefined`. The three inbound
sites match a soft-deleted Contact (`existing !== null`) and re-attach
inbound messages and activities to a gravestone row the 30-day cleanup
cron is about to cascade-delete. Lookup-by-`by_email` on a deleted
contact silently misroutes future activity.

### 2. `contactIdentities` row is written by only one of four sites

The schema declares `contactIdentities` as the canonical multi-channel
identity table — but only `processInboundChannel` writes a row at
Contact-create time. Email-source Contacts (inbox, import, HTTP API)
have no identity row. The `findByIdentifier` query that is supposed to
resolve a Contact by any channel works only for the channel webhook's
contacts. That's why `findByIdentifier`'s only callers today are tests.

### 3. `'created'` activity is logged by only one of four sites

`inbox/messages.ts` inserts a `contactActivities` row of type
`'created'` on contact create. The other three create paths skip it.
Downstream "first-touch timeline" reporting drifts by source.

### 4. `searchableText` is denormalized but not populated everywhere

`contacts.searchableText` is the denormalized full-text-search field.
`inbox/messages.ts` and `createForTeam` compute it (the latter via
`buildSearchableText` helper); `processInboundChannel` and
`importContacts` skip it. Contacts created via the latter paths are
invisible to the dashboard's search box.

### 5. The `${from}@${channel}.channel` fake-email hack

`webhooks/channels.ts:110` synthesizes a fake email to satisfy the
schema's required `email` field for SMS/WhatsApp/phone-only contacts:

```ts
email: args.channel === 'generic' ? args.from
                                  : `${args.from}@${args.channel}.channel`,
```

This pollutes the `by_email` index with rows like
`+15551234@sms.channel`, which:
- can't be used to *actually* send email to that contact,
- can match other webhook payloads that happen to share the format,
- masks the truth that those contacts have no email at all.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one site's find-or-create
block reveals the same lookup-then-decide pattern re-implemented at
three other sites with conflicting identity-creation semantics. The four
sites have no module; each holds its own slice of the contract.

Reading "what does Owlat do when an inbound signal arrives for an
unknown identifier" requires opening four files and diff'ing them.
Adding a fifth ingest path (a future SDK `track()` endpoint, a form
embed, a hypothetical migration tool) requires re-deciding all five
sub-questions and copying the answer at a new site.

## Decision

One module at `apps/api/convex/contacts/resolution.ts` owning find-or-create
from a typed signal. The four call sites collapse to one `resolve(...)` call
each. A schema breaking change clears the underlying ambiguity.

### Schema breaking change

`contacts.email` becomes `v.optional(v.string())`. Contacts that arrive
via non-email channels have no email; `contactIdentities` is the
canonical lookup table. Every Contact gets at least one
`contactIdentities` row at create time. Reads that need "the contact's
primary email" go through the email-channel identity (or read the
denormalized `contacts.email` when present — see Migration below).

### `Contact resolution (module)` shape

```ts
type ChannelKind = 'email' | 'sms' | 'whatsapp' | 'phone' | 'generic';

type ContactSource = 'api' | 'import' | 'form' | 'transactional' | 'inbound';

type ResolveMode = 'strict' | 'upsert' | 'merge';

interface ResolveSignal {
  channel: ChannelKind;
  identifier: string;
  source: ContactSource;
  mode: ResolveMode;
  contactFields?: {
    firstName?: string;
    lastName?: string;
    language?: string;
    timezone?: string;
  };
}

type ResolveAction = 'matched' | 'created' | 'updated';

interface ResolveResult {
  contactId: Id<'contacts'>;
  action: ResolveAction;
}

export const resolve: (ctx, signal: ResolveSignal) => Promise<ResolveResult>;
```

Behaviour by `mode`:

- **`strict`** — find returns existing → throw `AlreadyExists`. Create
  otherwise. Used by HTTP `POST /contacts` (the HTTP layer translates
  `AlreadyExists` to a 409 response).
- **`upsert`** — find returns existing → return the matched contactId,
  *no field update*. Create otherwise. Used by `receiveMessage`,
  `processInboundChannel`, and `importContacts` when
  `handleDuplicates: 'skip'`. Specifically protects against inbound
  signals overwriting user-set `firstName` with junk from
  `extractNameFromEmail(...)`.
- **`merge`** — find returns existing → patch fields where the new
  value is non-empty (existing wins for `undefined`/empty). Create
  otherwise. Used by `importContacts` when `handleDuplicates: 'update'`.

The module owns:

- **Lookup primitive.** `contactIdentities.by_identifier` filtered to
  exclude soft-deleted Contacts. Match-by-identifier is uniform across
  channels — including `'email'`, which used to read the
  `contacts.by_email` index directly.
- **Identity-row write on create.** Every newly-created Contact gets a
  `contactIdentities` row with `isPrimary: true`.
- **`searchableText` computation.** Computed from email + names so the
  two paths that miss it today get fixed for free.
- **Skip-soft-deleted invariant.** Soft-deleted matches are ignored.
  Combined with the cascade rule below, an inbound signal for an
  identifier whose previous Contact was soft-deleted creates a fresh
  Contact — there's no Identity-row collision because the gravestone
  has no identities.
- **`contacts.email` population.** When `channel === 'email'`, the
  identifier is stored on `contacts.email` as well as in the identity
  row. For non-email channels, `contacts.email` stays `undefined`.

The module does *not* own:

- Activity logging (`contactActivities`). The caller decides which
  rows to insert based on the returned `action`. The inbox path
  continues to insert `'created'` on `action === 'created'` and
  `'inbound_received'` always; the import path aggregates by `action`
  for its results summary; the HTTP path inserts nothing.
- Conversation thread resolution (stays in the inbox path).
- Downstream effects (stays in callers).
- Cross-contact merge logic (stays in `contacts/identities.ts:mergeContacts`).

### Soft-delete cascade

Wherever a Contact gets soft-deleted today (the `softDelete` mutation
in `contacts/contacts.ts` and any callers), an internal helper
hard-deletes the Contact's `contactIdentities` rows in the same
mutation. The identifier becomes reclaimable on day 1 — the cleanup
cron continues to handle activities/messages cascade after the 30-day
retention window. Identity rows are not part of the retention window
because the identifier itself (phone, email) is the privacy-sensitive
datum that should disappear on user request.

### Call-site shape after the cut

```ts
// inbox/messages.ts (was lines 67-97)
const { contactId, action } = await ctx.runMutation(
  internal.contacts.resolution.resolve,
  {
    channel: 'email',
    identifier: senderEmail,
    source: 'inbound',
    mode: 'upsert',
    contactFields: { firstName: extractNameFromEmail(args.from) },
  },
);

if (action === 'created') {
  await ctx.db.insert('contactActivities', {
    contactId,
    activityType: 'created',
    metadata: { source: 'inbound' },
    occurredAt: now,
  });
}
```

```ts
// webhooks/channels.ts:processInboundChannel (was lines 80-124)
const { contactId } = await ctx.runMutation(
  internal.contacts.resolution.resolve,
  {
    channel: args.channel,
    identifier: args.from,
    source: 'inbound',
    mode: 'upsert',
  },
);
// No fake-domain email synthesis. No inline identity insert.
```

```ts
// contacts/internal.ts:importContacts (was lines 54-87)
const { action } = await ctx.runMutation(
  internal.contacts.resolution.resolve,
  {
    channel: 'email',
    identifier: contactData.email!,
    source,
    mode: args.handleDuplicates === 'skip' ? 'upsert' : 'merge',
    contactFields: {
      firstName: contactData.firstName,
      lastName: contactData.lastName,
      language: contactData.language,
    },
  },
);
// Aggregate by action: 'created' → imported++, 'updated' → updated++,
// 'matched' → skipped++.
```

```ts
// contacts/contacts.ts:createForTeam (was lines 625-680)
return await ctx.runMutation(internal.contacts.resolution.resolve, {
  channel: 'email',
  identifier: args.email,
  source: args.source ?? 'api',
  mode: 'strict',
  contactFields: {
    firstName: args.firstName,
    lastName: args.lastName,
    language: args.language,
  },
}).then((r) => r.contactId);
// Throws AlreadyExists → HTTP layer's existing catch translates to 409.
```

## Considered options

### Schema cut

1. **Hide the email/identity fork inside the module.** Keep
   `contacts.email` required; module synthesizes the fake-domain email
   internally on behalf of non-email channels. Keeps the dirt; just
   moves it. The drift-prone schema invariant survives. Rejected.
2. **Make `contacts.email` optional, identities canonical** *(chosen)*.
   Breaking schema change, but it's the only option that lets a
   phone-only Contact be honest about having no email. Single-org-per-
   deployment makes the migration tractable.
3. **Drop `contacts.email` entirely.** All reads of "primary email"
   go through the email-channel identity row. Forces a rewrite of
   downstream code that reads `contacts.email` directly (segments,
   render-variable substitution, dashboard list views). Rejected as
   too much scope creep.

### Soft-delete behavior at find time

1. **Un-delete the matched contact.** Privacy-hostile (a soft-delete
   triggered by GDPR-style request gets undone by the next inbound
   email). Rejected.
2. **Skip and create new** *(chosen)*. Clean GDPR semantics: the
   gravestone is forgotten, the new signal starts fresh.
3. **Branch by caller mode.** HTTP `POST /contacts` un-deletes; inbound
   paths skip. Defeats the single-entry-point property — every caller
   has to think about it again. Rejected.
4. **Hard-fail.** Refuse to resolve, return `null`/error. Callers each
   need fallback logic; defeats the deepening. Rejected.

### Identity persistence across soft-delete window

1. **Identities persist after Contact soft-delete.** Collides with the
   "skip and create new" rule above — the new Contact's identity row
   insert would fail uniqueness (manual or otherwise). Rejected.
2. **Cascade-delete identities at soft-delete time** *(chosen)*. The
   identifier is reclaimable on day 1. Activities/messages still
   cascade after the 30-day retention window via the existing cron.
   The identifier itself (phone, email) is the privacy-sensitive datum
   that should disappear immediately; downstream activities are
   per-Contact-id-keyed and don't carry identifiers.
3. **Reassign the gravestone's identity row to the new Contact.**
   Brittle; partly un-erases the soft-deleted Contact via link
   continuity (the identity row's `_creationTime` predates the new
   Contact). Rejected.

### Operation surface

1. **Two operations.** `findOrCreate(signal)` for the inbound paths,
   `createStrict(signal)` for the HTTP API's must-be-new case. Splits
   by intent. Forces the import path's `'skip' | 'update'` policy into
   yet a third operation. Rejected — three operations for what's
   structurally one lookup-then-decide.
2. **One operation with mode flag** *(chosen)*. Matches the **Send
   lifecycle (module)**'s pattern (typed `TransitionInput` discriminated
   by `to`). Adding a future mode (e.g. `'create-only'` for an idempotent
   replay path) is additive.
3. **Three operations matching today's three call shapes.**
   `findOrCreate`, `createStrict`, `importRow`. Wider surface; no
   pay-off. Rejected.

### Output shape

1. **`{ contactId }`.** Minimal but loses information: the inbox path
   needs to know whether to log `'created'`. Rejected.
2. **`{ contactId, created: boolean }`.** Binary; collapses matched-no-
   touch with matched-and-patched. Loses the import.update vs
   import.skip distinction that already exists in
   `importContacts.results`. Rejected.
3. **`{ contactId, action: 'matched' | 'created' | 'updated' }`**
   *(chosen)*. Three-way; lines up with the existing
   `results.imported/updated/skipped` accounting in `importContacts`.

### Input signal shape

1. **Single `(channel, identifier)` per call** *(chosen)*. No caller
   today has multi-identifier needs. Webhooks that one day include both
   an email and a phone can chain `resolve(primary)` +
   `addIdentity(secondary, contactId)`. Per LANGUAGE.md, "one adapter
   means a hypothetical seam" — don't pay for the multi-identifier
   shape until a second caller needs it.
2. **Multi-identifier rich signal.** `{ identifiers: [...], primary: 0,
   ... }`. Adds lookup-priority and inter-identifier conflict logic to
   the module from day one. Rejected as speculative.

### `searchableText` ownership

1. **Caller passes `searchableText`.** Keeps drift — three of four
   sites forget today. Rejected.
2. **Module computes `searchableText` from email + names** *(chosen)*.
   Locality: the denormalization rule lives one place.
3. **Caller can override.** No caller today needs override. Rejected.

## Consequences

### Files that collapse / disappear

All ten call sites collapse to a single `resolveContact(ctx, signal)` call
each (the public `resolve` mutation is reserved for HTTP-side callers; the
exported helper is used directly in mutations to avoid the `runMutation`
round-trip).

- **Inbound paths (upsert mode):**
  - `apps/api/convex/inbox/messages.ts:67-97` — find-or-create block
    collapses to one call + conditional `'created'` activity insert.
  - `apps/api/convex/webhooks/channels.ts:80-124` — block (~45 LOC)
    collapses; the `${args.from}@${args.channel}.channel` fake-domain
    synthesis is deleted.
  - `apps/api/convex/automations/triggers.ts:sendEvent` — the inline
    `ctx.db.insert('contacts', ...)` becomes a `resolve(...)` call;
    `fireTrigger('contact_created', ...)` now fires only when
    `action === 'created'`.

- **Bulk import paths (upsert/merge per row):**
  - `apps/api/convex/contacts/internal.ts:importBatchInternal` —
    per-row find/patch/create block collapses to one call + action-keyed
    counter increment.
  - `apps/api/convex/contacts/contacts.ts:importBatch` — same shape;
    duplicate `buildSearchableText` calls disappear.
  - `apps/api/convex/contacts/organization.ts:importBatchForOrganization`
    — same shape; the parallel `contacts.ts`/`organization.ts` import
    duplication remains an open deepening opportunity (out of scope).

- **Strict-create paths (HTTP / session entry points):**
  - `apps/api/convex/contacts/contacts.ts:create` — strict mode; throws
    `AlreadyExists` translated to 409 by the HTTP shell.
  - `apps/api/convex/contacts/contacts.ts:createForTeam` — strict mode;
    used by HTTP action handlers.
  - `apps/api/convex/contacts/organization.ts:createForOrganization` —
    strict mode; API-key auth.
  - `apps/api/convex/contacts/organization.ts:createForOrganizationInternal`
    — strict mode; unauthenticated form ingest.

- **Lookup primitive:**
  - `apps/api/convex/contacts/identities.ts:findByIdentifier` — kept;
    finally has production callers via the resolution module.

### Files that grow

- `apps/api/convex/contacts/resolution.ts` (new, ~260 LOC). Exports the
  `ChannelKind` / `ContactSource` / `ResolveMode` literal tuples and
  validators, the `ResolveSignal` / `ResolveResult` types, the
  `findContactByIdentifier` lookup primitive, the `resolveContact`
  internal helper (the direct-call entry point), the `resolve`
  `internalMutation` (the cross-runtime wire surface), and
  `deleteIdentitiesForContact` (the cascade helper called by
  `softDeleteContact`).
- `apps/api/convex/schema/contacts.ts` — `contacts.email` becomes
  `v.optional(v.string())` with a short comment pointing to the ADR.
- `apps/api/convex/lib/contactMutations.ts:softDeleteContact` —
  one-line addition calling `deleteIdentitiesForContact`.

Net LOC change is favourable: the ten call sites shed ~250 LOC of
duplicated find-or-create plumbing; the new module adds ~260 LOC.
The value is locality, typed contract, and the deletion of five drift
bugs.

### Migration

Pre-production: no data backfill is required. The schema change
(`contacts.email` → optional) is additive at the schema level — existing
rows with `email: string` are still valid under the new
`email: v.optional(v.string())` validator.

If/when production data exists, this would need a backfill pass:

1. **Backfill identity rows.** For every live Contact with a real
   email, insert a `contactIdentities` row with `channel: 'email'`,
   `identifier: contact.email`, `isPrimary: true`. The existing
   `ensureEmailIdentity` internal mutation is the per-Contact primitive;
   wrap in a batched cron.
2. **Clear fake-domain emails and backfill the real channel identity.**
   For Contacts whose `email` matches `*@(sms|whatsapp|chat).channel`,
   look up the matching channel record (via `unifiedMessages` joined
   on `contactId`) to determine the real `(channel, identifier)`;
   insert the identity row; clear `contacts.email`.

The soft-delete cascade hook itself is part of the code change (now in
`lib/contactMutations.ts:softDeleteContact`) — not a data migration.

Single-org-per-deployment (per project memory) means no multi-tenant
migration coordination is needed.

### Test surface

- `apps/api/convex/__tests__/contactResolution.integration.test.ts`
  (new, 14 tests) — table-driven per `mode × match | nomatch ×
  channel`. Covers strict/upsert/merge semantics, soft-delete-skip,
  identity cascade reclaimability, email-vs-phone identifier
  normalization, and cross-channel isolation (same number on `sms` vs
  `whatsapp` produces separate Contacts).
- The ten call sites' integration tests stay, with two existing tests
  amended to insert a `contactIdentities` row alongside their fixture
  Contact (the resolution module's lookup is now identity-based, so
  pre-existing fixtures need the identity row to be findable):
  `__tests__/inbound.integration.test.ts` and
  `__tests__/contactsOrganization.integration.test.ts`.

### Behavior

All ten caller-visible behaviors are preserved:

- HTTP `POST /contacts` still 409s on existing email (now via `strict`
  → `AlreadyExists` → 409 translation in the HTTP handler).
- Inbound emails still create-or-attach silently.
- Channel webhooks still create-or-attach (now without the fake-domain
  hack — phone-only Contacts have no email).
- Bulk import still respects `'skip' | 'update'` (mapped to
  `'upsert' | 'merge'`).
- `sendEvent`'s `createContactIfNotExists` path still fires
  `contact_created` automation trigger; the trigger now fires
  conditionally on `action === 'created'` rather than on every call
  that resolved a missing contact.

Five drift bugs are fixed opportunistically:

1. The three sites that forget `searchableText` get it for free.
2. The three sites that forget the soft-delete filter get it for free.
3. The `${from}@${channel}.channel` fake-email rows go away.
4. `findByIdentifier` becomes a load-bearing production query.
5. The "every Contact has at least one identity" invariant becomes
   true (was true only for channel-webhook contacts before).

The `'created'` activity log is *not* automatic: callers explicitly
insert it when `action === 'created'`. This preserves the inbox path's
behavior exactly and lets the import path newly distinguish
`created` / `matched` / `updated` rows in its results summary if it
wants to.

### Vocabulary

CONTEXT.md gains a **Contacts** section between **Email rendering** and
**Outbound lifecycle**. Three new terms — **Contact**, **Contact
identity**, **Contact resolution (module)** — pin the language used in
this ADR and subsequent reviews. The Relationships section gains one
paragraph linking the Contact / Contact identity / Contact resolution
chain to the ten producer call sites.

## Follow-up work

1. **Channel literal catalog.** `contactIdentities.channel` is
   `v.string()` today; the resolution module declares its own
   `ChannelKind` union. A future ADR-0002-style catalog module pins
   the set once across `contactIdentities`, `webhooks/channels.ts`,
   and any future channel-aware code. Out of scope here.
2. **`addIdentity` uniqueness check audit.** The existing
   `identities.ts:addIdentity` enforces uniqueness manually
   (`identities.ts:140`). After the resolution module lands, audit
   whether `addIdentity`'s uniqueness check matches the resolution
   module's — they should share the lookup primitive.
3. **`contacts.ts` / `organization.ts` parallel structure.** The two
   files implement parallel session-auth vs API-key-auth variants of
   the same operations (create, import). They both delegate to the
   resolution module now, but the auth-shell duplication remains —
   its own future deepening opportunity.
4. **DOI status on inbound-created Contacts.** Today `doiStatus` is set
   by signup/form flows. Inbound-channel-created Contacts default to
   `undefined`. Policy decision deferred — not blocking on this ADR.
5. **Activity-log emission module.** Callers each insert
   `contactActivities` with slightly different metadata shapes. A
   future review could deepen activity-log emission into its own
   module (mirroring the Send lifecycle's effect list). Out of scope.

(The "verify no fifth find-or-create site" follow-up from the original
ADR draft is resolved: the actual count was ten; all are migrated.
The `auth/accountManagement.ts` file is read-only against `contacts`
— no create paths.)

## Execution

Implemented in a single pre-production pass — no separate execution
plan, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/contacts/resolution.ts` — new module.
- `apps/api/convex/schema/contacts.ts` — `email` becomes optional.
- `apps/api/convex/lib/contactMutations.ts:softDeleteContact` —
  cascade hook.
- Ten call sites migrated across `inbox/`, `webhooks/`,
  `automations/`, and `contacts/`.
- `apps/api/convex/__tests__/contactResolution.integration.test.ts`
  — new (14 tests, all green).
- Two pre-existing integration tests amended to insert identity rows
  for fixture Contacts.

Verified by `bun run ci:test` — 1,446 backend tests pass; all eight
turbo packages green. The one pre-existing eslint error in
`automations/automations.ts` (unused `Id` import) is unrelated and
predates this change.
