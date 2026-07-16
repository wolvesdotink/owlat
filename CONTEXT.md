# Owlat Context

This file pins the project-specific language used across architecture decisions
and grilling sessions. Update inline when terms get sharpened during design
conversations.

## Email rendering

**Block**:
A unit of email content with one declared type (`button`, `image`, `text`,
`columns`, etc.). The single source of truth for "what is a button" across
rendering, validation, compatibility scoring, and the editor.
_Avoid_: Component (overloaded — Vue/React already use "component" for UI),
Section (already means something specific in MJML/email templating), Element.

**Block module**:
A Block's full surface, physically split into two halves because one runs in
Node/CLI and the other imports Vue components:
- **Renderer half** — `packages/email-renderer/src/blocks/<type>/index.ts`
  exporting a `BlockModule<T>`: HTML render, plaintext render, AMP render,
  validators, default factory, placement metadata, compatibility data
  (Feature compatibility + Property compatibility), section-layout overrides
  (`layout?`), theme-default consumption (`applyTheme?`), responsive CSS
  emission (`responsiveCss?`).
- **Editor half** — `packages/email-builder/src/blocks/<type>/index.ts`
  exporting an `EditorModule<T>`: label, icon, panel schema, slash-menu
  entry, capability flags (`canBeInColumn`, `canBeInContainer`,
  `supportsBorderRadius`, `focusOnInsert`), column-context default factory,
  and (for composite blocks) `childrenView`/`allowedChildTypes`.

Both halves are keyed by `type` and dispatched by the Walker (renderer side)
or the typed `EditorModuleMap` (editor side). Adding a new block type means
adding both halves and an entry to the `BlockType` union.
_Avoid_: Block renderer (that names one function inside the renderer half,
not the whole thing).

**Placement**:
Where a Block sits in the email tree. Currently *root* (top-level), *column*
(inside a `columns` block), *container* (inside a `container` block), and
*hero* (inside a `hero` block). A Block declares which placements it allows.
_Avoid_: Slot, position, location.

**Allotted width**:
The pixel width budget the parent passes down to a Block. At root it's
`baseWidth` (default 600). Inside a column it's the column's share of the
parent. Blocks use this for VML width math and image sizing — they never
assume 600px.

**Walker**:
The recursion that descends the Block tree applying placement-specific
wrapping. Owns the table-and-cell HTML around each Block. Replaces the
parallel `renderBlock` / `renderColumnItem` / `renderContainerItem`
switches in `email-renderer/src/blocks/index.ts`.

**Feature compatibility**:
A Block module's declared knowledge of how its features render across
email clients — per-client `support` level, the `fallback` description
when support is partial or absent, and whether Owlat ships a workaround
(`owlatHandled`). Lives on the Block module under `compatibility.features`.
_Avoid_: Client support data (vague), compat entries.

**Property compatibility**:
The per-property variant of Feature compatibility — e.g. `button.borderRadius`
specifically, below feature granularity. Used by the builder UI to surface
"this property is shaky in Outlook" tooltips. Lives on the Block module
under `compatibility.properties`. The `blockType` is implied by the module
that owns the entry — it is not stored on each entry.

**Compatibility walker**:
The cross-cutting consumer that gathers Feature compatibility and Property
compatibility from every registered Block module to drive scoring, audience
reach, and the builder's limitation summaries. Mirrors the HTML/plaintext
walker pattern: thin dispatcher, per-module data ownership.

## Contacts

**Contact**:
A person Owlat knows about. Stored in `contacts` with optional `email`,
`firstName`, `lastName`, `language`, `timezone`, and other profile fields.
Identity — what Owlat uses to recognize them — lives in sibling
`contactIdentities` rows; one Contact has 1..N **Contact identities**.
`contacts.email` is denormalized from the primary email-channel identity
when one exists; it is *optional* because Contacts can arrive via
phone/SMS/WhatsApp/generic with no email signal at all. Soft-delete sets
`deletedAt`; the daily cleanup cron hard-deletes after the 30-day
retention window and cascades to children. All list/lookup queries
MUST filter `deletedAt === undefined`.
_Avoid_: Person (too generic), User (collides with `userProfiles` —
BetterAuth account holders), Lead (CRM term Owlat doesn't model).

**Contact identity**:
One row in `contactIdentities`. The `(channel, identifier)` pair Owlat
uses to recognize someone — `('email', 'foo@bar.com')`,
`('phone', '+15551234')`, `('whatsapp', '+15551234')`,
`('generic', shared-secret-payload-id)`. Uniqueness is
*application-enforced*: at most one row exists per `(channel,
identifier)` pair among *live* Contacts. The **Contact resolution
(module)** enforces it at Contact-create time; `addIdentity` enforces
it at secondary-link time. Soft-deleting a Contact hard-deletes its
identities (cascade) so the identifier is reclaimable on day 1 — the
next inbound signal for the same `(channel, identifier)` creates a new
Contact, not a re-link. The schema does *not* enforce uniqueness; the
invariant is application code's responsibility.
_Avoid_: Identifier alone (means the literal string, not the row),
Channel alone (the kind, not the row), Identity unqualified (collides
with auth/SSO identity).

**Contact resolution (module)**:
The module at `convex/contacts/resolution.ts` that owns find-or-create
of a Contact from a `{ channel, identifier, source, contactFields? }`
signal. Single entry point dispatched by `mode`:
- `strict` — match on identifier → throw `AlreadyExists`. Create
  otherwise. Used by HTTP `POST /contacts`.
- `upsert` — match → return matched contactId with no field update.
  Create otherwise. Used by `inbox/messages.ts:receiveMessage`,
  `webhooks/channels.ts:processInboundChannel`, and
  `importContacts` when `handleDuplicates: 'skip'`. Specifically
  protects inbound signals from overwriting user-set `firstName` with
  values like `extractNameFromEmail(From: ...)`.
- `merge` — match → patch fields where new value is non-empty
  (existing wins for `undefined`/empty). Create otherwise. Used by
  `importContacts` when `handleDuplicates: 'update'`.

Returns `{ contactId, action: 'matched' | 'created' | 'updated' }` —
the caller decides what `contactActivities` rows to insert based on
`action`. The module owns: identity-row write on create (every Contact
gets at least one `contactIdentities` row), `searchableText`
denormalization (computed from email + names so the two paths that
miss it today get fixed for free), the `doiStatus: 'not_required'`
initial write on create (so the field is always populated; the
**DOI lifecycle (module)** is the only later writer), and the
skip-soft-deleted invariant (soft-deleted matches are ignored;
identity cascade at soft-delete time guarantees no `(channel,
identifier)` collision can block create).
The module does *not* own: activity logging, conversation thread
resolution, or any downstream effect — the created-effect trio (count,
`contact_created` trigger, `created` activity) lives in the **Contact
creation (module)** that wraps this one. Replaces the open-coded
find-or-create blocks in `inbox/messages.ts`,
`webhooks/channels.ts:processInboundChannel`,
`contacts/internal.ts:importContacts`, and
`contacts/contacts.ts:createForTeam`. Closes drift bugs: missing
`searchableText` in 3 of 4 sites, missing soft-delete filter in 3 of 4
sites, and the `${args.from}@${args.channel}.channel` fake-email hack
in `webhooks/channels.ts:110`.
_Avoid_: Contact upsert (names the verb, hides the strict mode),
Contact create / Contact creation (those name the create-only effects
sibling — see **Contact creation (module)** — not this all-modes
primitive), Contact intake (overlaps with the import path's
terminology), Contact registry (overloaded with the Block/Step module
registry pattern).

**Contact creation (module)**:
The module at `convex/contacts/creation.ts` that owns the effect set
fired when a single Contact comes into existence. Wraps the **Contact
resolution (module)**: calls `resolveContact`, and on `action ===
'created'` fires the uniform created-effect trio —
`incrementContactCount(ctx, 1)`, the `contact_created` automation
trigger (`fireContactCreatedTrigger`), and one `created` **Contact
activity** with `metadata.source` taken from the signal's `source`.
Returns the same `{ contactId, action }` resolution returns, so callers
that branch on `action` are unaffected. The single entry point
`createContact(ctx, signal)` is used by every *single*-Contact create
path: the strict-mode HTTP/session/internal mutations
(`contacts/contacts.ts:create` + `createForTeam`,
`contacts/organization.ts:createForOrganization` +
`createForOrganizationInternal`) and the upsert-mode paths
(`inbox/messages.ts:receiveMessage`,
`webhooks/channels.ts:processInboundChannel`,
`transactional/dispatch.ts`, `forms/submission.ts:submit`,
`automations/triggers.ts:sendEvent`). Callers keep
their own domain effects layered on top (inbox still writes its
`inbound_received` activity; the form still writes its submission row) —
this module owns *only* the trio. It is created-effects only: its
callers run `strict`/`upsert`, which never yield `action: 'updated'`;
the `merge`/`updated` case belongs to the **Contact import (module)**,
which is exempt and calls `resolveContact` directly (one batched
`incrementContactCount(imported)` plus its own per-row composition,
ADR-0019). Keeping the trio in a layer *above* the still-effect-free
resolution primitive — not inside it — is what lets import's batched
count and the single-create trio coexist without double-counting.
Single-create goes through Contact creation; only import calls
`resolveContact` directly (convention, not enforced). Closes the drift
the scatter produced: before this module no single create path fired all
three effects — `cachedContactCount` was never incremented for Contacts
born via inbound email / channel webhook / transactional send / form /
`sendEvent`, the `contact_created` trigger never fired for the four
inbound paths (and fired ad-hoc in `sendEvent`), and the `created`
activity was written by only one of nine call sites.
_Avoid_: Contact intake (reserved for the import path), Contact
lifecycle (no state machine — creation is a one-shot event, not a
transition), Contact factory (collides with test-data factories).

**DOI status**:
The contact-level double-opt-in state stored at `contacts.doiStatus`:
`not_required | pending | confirmed`. Every Contact has this field
populated — the **Contact resolution (module)** writes `'not_required'`
on create, so `undefined` does not appear in new rows (pre-prod;
existing rows are backfilled atomically with the module landing).
`confirmed` is terminal — unsubscribing from a topic removes the
`contactTopics` row but never reverts `doiStatus`. Companions
`doiConfirmationToken`, `doiTokenExpiresAt`, `doiConfirmedAt`, and
`doiAttestedSource` are written/cleared atomically with the status
by the DOI lifecycle reducer. `doiAttestedSource` is populated only
on the admin-attest path (a free-form source label such as
`'mailchimp' | 'klaviyo' | 'stripe' | 'csv_admin'`); the token-keyed
confirm path leaves it undefined. Legal edges:
- `not_required → pending` (a DOI-required topic subscription requests
  confirmation; sends one confirmation email per pending window)
- `pending → pending` (already pending — idempotent `recorded`, no
  second email)
- `pending → confirmed` (token-keyed confirm)
- `not_required → confirmed` (admin-attest path — only when the
  `TransitionInput` carries `source: 'admin_attest'`. Used by the
  **Contact import (module)** for contacts that were already
  DOI-confirmed at a source platform; populates `doiAttestedSource`.
  Refused for any other source.)
- `confirmed → confirmed` (already confirmed — idempotent `recorded`)

`confirmed → pending` (revoke) is refused as `illegal_edge`. The
token TTL is 7 days (`DOI_TOKEN_TTL_MS`), consolidated from the prior
7d (topics paths) vs 48h (form path) drift.
_Avoid_: Opt-in status (vague), DOI state (collides with the per-machine
"state" suffix already used in Postbox outbound).

**DOI lifecycle (module)**:
The module at `convex/contacts/doiLifecycle.ts` that owns transitions
of `contacts.doiStatus`. Mirrors the **Outbound lifecycle** shape —
typed `TransitionInput` discriminated by `to`, a `LEGAL_EDGES` graph,
a private reducer per kind returning `{ patch, effects, applied }`,
and a `TransitionOutcome` reporting `ok | reason` for duplicate /
illegal / kind-mismatched attempts. Two entry points:
- `transition({ contactId, input })` — direct path; used by admin /
  internal callers, the form-confirmation HTTP handler after it has
  resolved the contact via the unified token, and the
  **Contact import (module)** for the admin-attest path
  (`input: { to: 'confirmed', source: 'admin_attest', attestSource }`
  — relaxes the otherwise-refused `not_required → confirmed` edge,
  populates `doiAttestedSource`).
- `transitionByConfirmationToken({ token, input })` — token-keyed
  path; looks up the contact via
  `contacts.by_doi_confirmation_token`. Symmetric to Send lifecycle's
  `transitionByProviderMessageId`. Under the unified token namespace
  (one token per pending confirmation), `formSubmissions.confirmationToken`
  and `contacts.doiConfirmationToken` are *the same string* — the
  form-confirm endpoint looks up the form submission by token, calls
  `transitionByConfirmationToken` with that same token, then patches
  `formSubmissions.status: 'success'` separately.

Effects:
- `send_confirmation_email` — fires on `to: 'pending'` from
  `not_required`, schedules `internal.confirmationEmail.send` with
  the freshly generated token. Skipped (no effect emitted) when
  `siteUrl` is absent — preserves today's admin-import behaviour.
- `fire_topic_subscribed_triggers` — fires on `to: 'confirmed'`,
  fans out to every DOI-required `contactTopics` row the contact is
  in at confirm time. Encodes the contact-level DOI invariant: one
  click confirms the contact, all DOI-required memberships become
  active. Form-confirm path inherits this for free.
- `contact_activity_topic_confirmed` — fires on `to: 'confirmed'`,
  writes one `contactActivities` row per DOI-required membership
  with `activityType: 'topic_confirmed'`. Closes the silent drift
  bug where none of the four pre-deepening paths wrote this row.
- `contact_activity({ literal: 'doi_attested', metadata: {
  attestSource } })` — fires only on the admin-attest path
  (`to: 'confirmed'` with `source: 'admin_attest'`). One row, not
  per-topic — at attest time the contact typically has no
  DOI-required memberships yet (the **Contact import (module)** runs
  attestation *before* `subscribeMany`), so the per-topic
  `topic_confirmed` fan-out is a no-op in that ordering. The
  `'doi_attested'` literal records the attestation itself on the
  contact's timeline.
- `audit_log({ action: 'doi.admin_attested', contactId, details: {
  attestSource } })` — fires only on the admin-attest path. The
  audit action is new in `auditActions/catalog.ts`. The
  token-keyed confirm path emits its own audit action through the
  existing effect surface.

Replaces the open-coded blocks in `topics/topics.ts:addContact`
(lines 292-318), `topics/bulk.ts:addContacts` (lines 59-83),
`topics/topics.ts:confirmDoi` (lines 362-420), and
`forms/endpoints.ts:confirmFormSubmission` (lines 410-479). Closes
drift bugs: missing `fire_topic_subscribed_triggers` in the form
path, missing `topic_confirmed` activity rows in all four paths,
the 7d-vs-48h token-TTL drift between topics and forms paths, and
the dual-token namespace (under unification, the form submission and
the contact share one token).
_Avoid_: DOI module (collides with the per-kind module-family pattern —
Block module, Step module, etc.), Subscription confirmation lifecycle
(stretches because DOI applies to forms without topics too), Double
opt-in lifecycle (verbose; field names use the `doi` prefix and the
acronym is established).

**Contact activity**:
One row in `contactActivities` — a single observed event against one
Contact (`email_sent`, `email_opened`, `topic_subscribed`,
`topic_confirmed`, `inbound_received`, `property_updated`, etc.).
Carries an `activityType` literal, an optional flat `metadata` blob
(`Record<string, JsonPrimitive>` shape at the schema level), and an
`occurredAt` timestamp. The audit-trail unit the contact timeline UI
renders. Thirteen literals today (the twelve original plus
`'doi_attested'` added with the **Contact import (module)**),
catalogued at `contactActivities/catalog.ts`.
_Avoid_: Activity alone (overloaded with audit logs and agent
actions), Contact event (collides with **Inbound event** / **Webhook
event**), Timeline entry (names the surface, not the row).

**Contact activity (module)**:
One activity literal's full surface, physically split into two halves
keyed by literal — same shape as Block module, Step module, Condition
module:
- **Writer half** — `apps/api/convex/contactActivities/<literal>/index.ts`
  exporting a `ContactActivityModule<L>`: the per-literal Convex
  `metadataSchema` enforced at write time. No `build` layer (the
  metadata blob is flat audit data; a transform step would do trivial
  field-copies in every case — schema-as-contract is enough).
- **Display half** — `apps/web/app/composables/contactActivities/<literal>/index.ts`
  exporting a `ContactActivityEditorModule<L>`: `displayConfig:
  { icon, label, color }` plus `formatDescription(metadata) → string`
  for the activity-timeline UI.

Both halves are keyed by literal and dispatched by typed registries —
server-side `ACTIVITY_MODULES` map in `contactActivities/writer.ts`,
FE `ACTIVITY_EDITOR_MODULES` map in
`apps/web/app/composables/contactActivities/index.ts`. Adding a new
literal means adding both halves *and* an entry to
`CONTACT_ACTIVITY_TYPE_LITERALS` in `contactActivities/catalog.ts` —
missing either half is a compile error.

The writer half feeds into one internal writer
`recordContactActivity(ctx, { literal, contactId, metadata,
occurredAt? })` at `contactActivities/writer.ts` — the only place that
inserts into `contactActivities`. The `metadata` arg is typed per
literal via `MetadataFor<L>` derived from the module's
`metadataSchema`; the call site gets compile-time field-name
discipline. `occurredAt` defaults to `Date.now()`.

Schema posture: `contactActivities.metadata` stays as the existing
permissive `v.optional(activityMetadataValidator)` (`Record<string,
JsonPrimitive>`). Expressing per-literal shape at the schema level
would force a `v.union` discriminated on `activityType` and collide
with already-stored rows whose shapes pre-date this deepening.
Runtime enforcement at the writer is the contract; the table is
storage. Mirrors the **Webhook event module** pattern (table
permissive, module's `schema` is the runtime contract).

Lifecycle integration: every contact-activity write across the
lifecycle modules that touch `contactActivities` collapses to one
effect kind `contact_activity` carrying `{ literal, contactId,
metadata }`. The **Send lifecycle (module)**'s pre-deepening
`contact_activity` effect keeps its name and gains the typed `literal`
discriminator. The **DOI lifecycle (module)**'s
`contact_activity_topic_confirmed` effect kind is deleted — the
reducer emits N generic `contact_activity` effects (one per
DOI-required Topic membership the Contact has at confirm time) with
`literal: 'topic_confirmed'`. The **Topic subscription (module)**'s
`contact_activity_topic_unsubscribed` effect is deleted similarly,
emitting `contact_activity` with `literal: 'topic_unsubscribed'`. The
two non-lifecycle direct writers in
`inbox/messages.ts:78, 172` (`receiveMessage` writes `'created'` and
`'inbound_received'`) call `recordContactActivity` directly — no
effect indirection because `receiveMessage` is not a lifecycle
transition. The **Contact import (module)** is a third non-lifecycle
direct writer — per row it calls `recordContactActivity` with
`'created'` when the **Contact resolution (module)** returned
`action: 'created'`, and `'property_updated'` when property values
were written against an existing contact.

Replaces the five open-coded `ctx.db.insert('contactActivities', ...)`
sites: `contacts/activities.ts:79-86` (the generic `create` mutation,
deleted — zero callers), `inbox/messages.ts:78, 172`,
`delivery/sendLifecycle.ts:721`, `contacts/doiLifecycle.ts:226`, and
`topics/subscription.ts:304`. Plus the four `logXActivity` mutations
at `contacts/activities.ts:90-192`, deleted outright (zero callers
confirmed by grep — they were defined but never wired up).

Closes drift bugs:
- Missing `inbound_received` / `inbound_replied` literals in
  `contacts/activities.ts:198-213` `getRecent` filter union (replaced
  by `contactActivityTypeValidator` from the catalog).
- 9-of-12 `activityConfig` map in `useActivityTimeline.ts:15-25`
  (missing `inbound_received`, `inbound_replied`, `topic_confirmed`)
  — replaced by the FE module registry.
- Description-rendering drift in the timeline component (today the
  component plucks metadata fields inline by activity type; under
  this module each literal owns its `formatDescription`, and adding
  a metadata field forces an exhaustiveness check on the formatter).
- Divergent metadata shapes built per call-site (today each writer
  builds its own blob; under this module the per-literal schema
  enforces shape at write time and `MetadataFor<L>` enforces it at
  the call site).
- Dead-code `logXActivity` mutations that no caller routes through
  but that would have offered a "second writer" if any caller had
  picked them up.

The module does *not* own: auth (lifecycle effects skip auth; if a
public mutation ever ships it owns its own auth shell), audit logs
(separate concern owned by `recordAuditLog`), the conversation-thread
or inbox-state side effects (those are **Inbox processing lifecycle
(module)**'s domain), or activity reads (the read queries
`listByContact`, `countByContact`, `getRecent`, `deleteByContact` in
`contacts/activities.ts` stay where they are — they are not under the
writer-side scope this module covers).
_Avoid_: Activity module (collides with **Agent action** the row),
Contact activity catalog module (the catalog is the dispatch index,
this is the per-literal unit), Contact activity entry module (entry
stretches — the unit is "the activity literal's surface," not "an
entry in the catalog").

**Contact import (module)**:
The module at `convex/contacts/import.ts` that owns batch contact
ingestion — the path from a normalized array of import rows to
resolved Contacts plus Topic memberships plus property values plus
contact activity rows plus (optionally) admin-attested DOI
confirmation. Mirrors the **Form submission (module)** shape — a
single batch entry with a discriminated `source` and a structured
outcome. Not a lifecycle in the **Outbound lifecycle** sense: each
row's status is the `action` returned by the **Contact resolution
(module)**, and no status machine is owned at the import level.

Single entry point:
- `importBatch({ rows, source, handleDuplicates, topicAssignments?,
  doiAttest?, siteUrl? })` — internal mutation. Returns
  `{ imported, updated, skipped, failed, errors, addedToTopics,
  propertiesSet, propertiesAutoRegistered, propertiesSkipped,
  activitiesRecorded }`.

Row shape:
`{ email, firstName?, lastName?, language?, properties?:
Record<string, JsonPrimitive> }`. Source kinds: `'csv' | 'api' |
'mailchimp' | 'stripe'`. The `source` discriminator gates the
property-key policy (below) and surfaces in
`doiAttest.attestSource` defaults for integration paths.

Per-row order of operations (the ordering is load-bearing):
1. Lowercase + trim + validate email; on failure record one
   `errors[]` entry and continue.
2. **Contact resolution (module)** with `mode` derived from
   `handleDuplicates` (`'skip' → 'upsert'`, `'update' → 'merge'`).
3. Property writes per the source-gated policy.
4. `recordContactActivity` — `'created'` when resolution returned
   `'created'`; `'property_updated'` when property values were
   written against an existing contact.
5. When `doiAttest` is set: **DOI lifecycle (module)** `transition({
   to: 'confirmed', source: 'admin_attest', attestSource:
   doiAttest.attestSource })`. Must precede step 6 so DOI-required
   topic memberships activate immediately rather than triggering a
   confirmation email.

After the row loop:
- Per-topic `subscribeMany` coalescing through the **Topic
  subscription (module)** (one mutation call per topic regardless of
  contact count).
- One `incrementContactCount(ctx, imported)` call (closes the silent
  drift bug where Mailchimp/Stripe imports skipped the cached count).

Property-key policy (gated by `source`):
- `'csv' | 'api'` (operator-driven): unknown keys → skip the write,
  surface one batch-level summary line in `errors[]` (e.g.
  `"Property 'COMPANY' is not registered; values dropped for 5
  rows."`), increment `propertiesSkipped`. The contact otherwise
  imports normally.
- `'mailchimp' | 'stripe'` (integration-driven): unknown keys →
  insert a `contactProperties` row with `autoRegistered: true`,
  `autoRegisteredSource: source`, `dataType` inferred from value
  (string fallback), then write the value. Increment
  `propertiesAutoRegistered`. The web UI for contact properties can
  surface an "auto-registered" badge from these companion fields.

Three thin shells dispatch to this entry:
- `contacts/contacts.ts:importBatch` — session + `contacts:manage`
  permission; web UI CSV upload; passes `source: 'csv'`. The
  `contactListAssignments` (per-row) and `topicId` (single) inputs
  collapse into the module's `topicAssignments` discriminator. May
  pass `doiAttest` (gated by the same `contacts:manage` permission).
- `contacts/organization.ts:importBatchForOrganization` — API-key
  shell; passes `source: 'api'`. Gains a `topicId?` parameter
  (closing the prior gap) and a `doiAttest?` parameter (gated by the
  new `contacts:import_attest` API-key permission).
- The **Integration import walker** at
  `convex/integrationImports/walker.ts` — generic action that
  dispatches to one **Integration import provider adapter (module)**
  per page, normalizes via the adapter, and calls `importBatch` with
  `source = provider` and `doiAttest` derived from the adapter's
  `defaultDoiAttest`. Per-provider adapters live at
  `convex/integrationImports/providers/<kind>/index.ts`.
  `importBatchInternal` in `contacts/internal.ts` is deleted.

Replaces the three open-coded batch import loops in
`contacts/contacts.ts:importBatch:407-546`,
`contacts/organization.ts:importBatchForOrganization:402-457`, and
`contacts/internal.ts:importBatchInternal:15-118`.

Closes drift bugs:
- Silently-skipped `incrementContactCount` on Mailchimp/Stripe paths
  (cached count was wrong after every integration sync).
- Missing `topicId` parameter on the public HTTP API import.
- Missing DOI attestation surface across all three paths — closes
  the requirement to import already-DOI-confirmed contacts from
  external platforms (Mailchimp, Klaviyo, Stripe).
- Silently-dropped `merge_fields` / `metadata` / CSV custom columns:
  `contactPropertyValues` are now written from row data.
- Missing `'created'` contact activity on every import path: the
  timeline now records new contacts regardless of channel.
- 500-row batch cap only enforced on the web UI shell.
- Diverging `contactListAssignments` (per-row) vs. `topicId` (single)
  shape between web UI and API, consolidated under one
  `topicAssignments` discriminator.

The module does *not* own: the per-source payload normalization
(Mailchimp `merge_fields` flattening, Stripe `metadata` mapping, CSV
column-to-row mapping all live in their respective adapter files),
the DOI confirmation email send (DOI lifecycle's
`send_confirmation_email` effect), the topic membership row write
(Topic subscription), the contact identity row write (Contact
resolution), the per-shell auth (each shell keeps its own auth
posture), or the pagination / progress tracking for integration
imports (those live in the **Integration import walker**, not in
this module).
_Avoid_: Contact ingest (overlaps with the import-vs-ingest debate
the **Contact resolution (module)** entry resolved — "import" is the
established noun on this row), Contact batch (module) (names the
shape, not the role), Contact upload (collides with the file-upload
concept on the web UI), Bulk contact (module) (covers only part of
the intent — the module also handles integration syncs that aren't
"bulk" from the operator's perspective).

## Integration imports

**Integration import**:
One row in `integrationImports` — the record of one paginated
contact-import run against one third-party platform. Carries
`provider: 'mailchimp' | 'stripe'`, `status: 'running' |
'completed' | 'failed'`, an opaque `cursor: string` (`''` =
first-page sentinel; per-provider adapter interprets), running
counters (`imported`, `updated`, `skipped`, `failed`),
`errors: string[]` (capped at 20), `handleDuplicates`, optional
`topicId`, `startedAt`, `completedAt?`. The deployment-wide
singleton-in-flight unit — `startIntegrationImport` refuses to
schedule a new run while any row has `status: 'running'`.
Disjoint from **Contact import (module)** runs over CSV / API
data: those have no `integrationImports` row because the data
is inline (no pagination, no remote API, no retries needed).
_Avoid_: Integration sync (overloaded — "sync" implies
bidirectional; Owlat only reads), Import job (generic; doesn't
signal the integration-vs-inline distinction), Integration run
(the row name is `integrationImports` — keep the noun aligned
with the table).

**Integration import provider adapter (module)**:
The per-provider module at
`convex/integrationImports/providers/<kind>/index.ts` that owns
the integration-side surface of one third-party platform that
supplies contacts via paginated HTTP. Two adapters today:
`providers/mailchimp/` and `providers/stripe/`. Discriminated by
`kind: 'mailchimp' | 'stripe'` matching the `provider` column on
`integrationImports`. Dispatched by the registry at
`providers/index.ts` exporting `providerFor(kind)`. Mirrors the
**Sending domain provider adapter (module)** shape (ADR-0018) and
**Channel inbound adapter** shape (ADR-0005) — one TypeScript
interface, N concrete implementations, registry-driven dispatch.
Exports an `IntegrationImportProviderModule<K>` with:
- `kind: K` — the provider literal.
- `defaultDoiAttest?: AttestSource` — per-provider default DOI
  attestation passed to **Contact import (module)** when this
  provider's rows land. Mailchimp / Stripe both attest as
  themselves; CSV / API have no adapter and therefore no default.
- `validateConfig(config) → { ok } | { ok: false, reason }` — pure
  check of the per-provider config shape (Mailchimp expects
  `apiKey` + `listId`; Stripe expects `apiKey`). The
  **Integration import walker**'s `startIntegrationImport`
  mutation calls this before scheduling the first page.
- `fetchPage({ config, cursor }) → { rows, nextCursor | null,
  totalEstimate? }` — provider API call. Cursor is opaque
  (`''` = first page); adapter interprets internally (Mailchimp
  parses to numeric offset; Stripe uses as `starting_after`).
  Throws `RetryableProviderError` on 429 / network blip (walker
  retries with backoff up to N); throws regular `Error` on fatal
  (walker marks the import `failed` immediately). Returns
  normalized `ImportRow[]` matching the **Contact import
  (module)**'s row shape.

Adding a third integration provider (HubSpot, Klaviyo) is a
one-folder change: new `providers/<kind>/` directory, one new
entry in `INTEGRATION_IMPORT_PROVIDERS` registry, one new branch
in the `IntegrationProviderConfig` discriminated union. The
compile-time `satisfies` check on the registry catches missing
methods. The walker never branches on `provider` — provider
variation lives entirely behind this seam.
_Avoid_: Integration adapter alone (drops "provider" and
"module"), Integration provider (module) (drops "adapter" — per
LANGUAGE.md "adapter" carries the *role* of "a concrete thing
satisfying an interface at a seam"), Contact source adapter
(module) (the source discriminator on **Contact import** includes
`'csv' | 'api'` which don't get adapters; using the same word
stretches), Paginated import adapter (module) (names the
mechanism, not the role; a future non-paginated remote
integration would awkwardly fit).

**Integration import walker**:
The action at `convex/integrationImports/walker.ts` that owns
the page-by-page execution of one **Integration import** run.
Responsibilities the per-provider adapter doesn't carry:
- Retries with backoff (`RetryableProviderError` → retry up to N
  with linear backoff; any other thrown `Error` → fail the
  import immediately).
- Progress patching via the internal `updateImportProgress`
  mutation (running counter sums + rolling error list capped at
  20).
- `importBatch` delegation to the **Contact import (module)** with
  `source = provider` and `doiAttest` derived from the adapter's
  `defaultDoiAttest`.
- Self-scheduling the next page (when adapter returns non-null
  `nextCursor`) or calling `completeImport` (when `nextCursor` is
  null).
- Cancellation: every scheduled hop checks `importRecord.status`
  at entry and short-circuits if not `'running'`. The public
  `cancelImport` mutation patches the row to `'failed'`; the
  next scheduled hop sees it and bails without another fetch.

Two entry points:
- `startIntegrationImport({ provider, config, handleDuplicates,
  topicId? })` — public mutation. Validates the provider's
  config via `providerFor(provider).validateConfig(config)`,
  validates the optional `topicId`, refuses if any
  `integrationImports` row is `'running'`, inserts the row, and
  schedules the first `processIntegrationPage` hop. The `config`
  arg is a Convex-validated discriminated union
  (`IntegrationProviderConfig`); a new provider adds one
  branch to the validator.
- `processIntegrationPage({ importId, provider, config, cursor
  })` — internal action. Status-check → adapter.fetchPage with
  retry → `importBatch` → progress patch → schedule next or
  complete.

Replaces the per-provider `startMailchimpImport` /
`startStripeImport` mutations and the per-provider
`processMailchimpPage` / `processStripePage` actions. The walker
never branches on `provider` — every per-provider concern lives
behind the adapter seam.

Closes drift bugs:
- Duplicated retry / backoff plumbing across `processMailchimpPage`
  and `processStripePage` (~100 LOC × 2 today, ~30 LOC × 1
  post-deepening in the walker).
- Duplicated start-mutation validation (validate-topic,
  check-running, insert-row) across `startMailchimpImport` and
  `startStripeImport` (one writer, gated by adapter
  `validateConfig`).
- Diverging per-provider error-message extraction (Mailchimp
  pulls `detail`/`title`; Stripe pulls `error.message`) —
  adapter owns its `fetchPage` thrown-message contract,
  walker treats them uniformly.
- Silent risk of a future provider's `startXImport` mutation
  skipping the no-import-running check (today's check exists in
  each mutation by convention only) — under the walker the
  check lives once, behind the only public start entry.

The walker does *not* own: per-shell auth (the public
`startIntegrationImport` keeps its `getMutationContext` +
`requirePermission('imports:manage')` auth shell from the
pre-deepening mutations), the `integrationImports` row schema
(stays in `schema/`), the `cancelImport` mutation (stays as a
small public mutation that patches `status: 'failed'`), the
`getImportProgress` query (stays as a public read), provider
HTTP details (live behind the adapter seam), or the row writes
into `contacts` and friends (the **Contact import (module)**
owns those via `importBatch`).
_Avoid_: Integration import dispatcher (collides with the Send
dispatch terminology), Integration import orchestrator (the
orchestrator role is reserved for multi-lifecycle-call
orchestrators like the **Campaign send orchestrator (module)** —
this walker is a single linear page-by-page loop), Integration
import (module) (collides with the per-provider adapter module —
the walker is the dispatcher, the adapter is the module).

## Topics

**Topic**:
A user-defined audience grouping a Contact can be a member of. Stored
in `topics` with `name`, `description`, `requireDoubleOptIn` (defaulting
to `true`), `displayOrder`, `isDefault`, and a denormalized
`cachedMemberCount`. Membership is recorded in sibling `contactTopics`
rows — one row per `(contactId, topicId)` pair among live Contacts. The
audience unit for campaigns (`campaigns.audienceType === 'topic'`), the
consent unit for DOI (one DOI confirmation activates every DOI-required
Topic membership the Contact has at confirm time), and the evaluation
unit for the `topic_membership` **Condition** kind.
_Avoid_: Mailing list (legacy term; the rename to Topics is complete),
List alone (legacy), Segment (Segments are computed audiences over
**Condition**s; Topics are explicit memberships).

**Topic membership**:
One row in `contactTopics`: the `(contactId, topicId, addedAt)` triple
recording that a Contact is currently subscribed to a Topic. Hard-deleted
on unsubscribe — the `topic_unsubscribed` Contact activity row is the
historical record, not a soft-deleted membership. The denormalized
`topics.cachedMemberCount` is maintained by the **Topic subscription
(module)** on every membership write; the daily `topics.reconcileMemberCounts`
cron walks all topics to fix drift.
_Avoid_: Subscription alone (overloaded with email-subscription and
DOI), Member alone (the Contact is the member, not the row).

**Topic subscription (module)**:
The module at `convex/topics/subscription.ts` that owns *all* writes to
`contactTopics` and *all* maintenance of `topics.cachedMemberCount`.
Five entry points covering the three usage shapes that exist in code:
- `subscribe({ topicId, contactId, source, skipDoi?, siteUrl? })` —
  one topic, one contact. Single-membership op.
- `subscribeMany({ topicId, contactIds, source, skipDoi?, siteUrl? })`
  — one topic, many contacts. Coalesces the `cachedMemberCount` patch
  (one patch per call regardless of array size). Used by admin bulk-add
  and CSV / integration import.
- `unsubscribe({ topicId, contactId, source, reason? })` — one topic,
  one contact. Single-membership remove.
- `unsubscribeMany({ topicId, contactIds, source, reason? })` — one
  topic, many contacts. Coalesces the count patch.
- `unsubscribeAllForContact({ contactId, topicId?, source, reason? })`
  — one contact, one-or-all topics. Per-contact effects fire ONCE per
  call regardless of how many topics; per-topic effects fire N times.
  Used by the public unsubscribe link (the email-footer endpoint and
  the preferences page).

The `source` discriminator covers `'admin' | 'form' | 'import' |
'public_api' | 'automation' | 'public_email_link' | 'preferences_page'`.
The module's source→effects map is the one place where "which side
effects fire for which trigger" lives.

Subscribe effects:
- `insert_membership` — fires unless `already_member`. Patches the
  membership row plus the `cachedMemberCount` increment.
- `fire_topic_subscribed_trigger` — fires when DOI is not in the way:
  `skipDoi || !topic.requireDoubleOptIn || contact.doiStatus ===
  'confirmed'`. Routes through `automations.triggers.fireTopicSubscribedTrigger`.
- `request_doi` — fires when DOI is required and the contact is not yet
  `confirmed`. Calls the **DOI lifecycle (module)** `transition({ to:
  'pending', token, ttlMs, siteUrl })`. The lifecycle's own
  `fire_topic_subscribed_triggers` effect handles the trigger fanout at
  confirm time — the subscription module does not double-fire.

Unsubscribe effects:
- `delete_membership` — fires unless `not_member`. Patches the
  `cachedMemberCount` decrement.
- `contact_activity_topic_unsubscribed` — fires on every successful
  unsubscribe regardless of source. Closes the silent drift bug where
  admin-remove paths wrote no activity row.
- `patch_contact_updated_at` — fires on every successful unsubscribe.
- `clear_form_submission_confirmations` — fires on `source:
  'public_email_link' | 'preferences_page'`. Clears
  `formSubmissions.confirmedAt` for every form submission the Contact
  has confirmed, forcing re-confirmation on next resubscribe.
- `increment_campaign_unsubscribed_stats` — fires on `source:
  'public_email_link'`. Increments `campaigns.statsUnsubscribed` on
  the most-recent `emailSends` row for the Contact.
- `fire_topic_unsubscribed_webhook` — fires on `source:
  'public_email_link' | 'preferences_page'`. Schedules
  `webhooks/scheduleFanout` for the `topic.unsubscribed` **Webhook event**
  with the array of removed topics (`unsubscribeAllForContact` aggregates;
  `unsubscribe` / `unsubscribeMany` emit one webhook per call with the
  one-or-many topics in scope).

Invariants:
- Refuses to subscribe a soft-deleted Contact (`deletedAt !== undefined`)
  — returns `{ ok: false, reason: 'contact_soft_deleted' }`. Mirrors the
  **Contact resolution (module)**'s skip-soft-deleted invariant.
- Already-member subscribe is a no-op returning `{ action:
  'already_member' }` — does not re-fire triggers, does not re-patch
  counts, does not re-request DOI.
- Already-non-member unsubscribe is a no-op returning `{ action:
  'not_member' }` — does not write an activity row, does not fire the
  webhook, does not decrement the count.
- `subscribe` / `subscribeMany` return `{ action, doiToken? }` per
  inserted membership; `doiToken` is populated when the `request_doi`
  effect fired (one token per pending DOI window). Surfaced to callers
  that need to record the token on a sibling row — e.g. the
  **Form submission (module)** stores it on `formSubmissions.confirmationToken`
  without a re-read of the contact.

Replaces the open-coded membership writes in:
- `topics/topics.ts:addContact:280-331` (single-add public mutation)
- `topics/bulk.ts:addContacts:34-95` (bulk-add public mutation)
- `contacts/internal.ts:importBatchInternal:81-117` (batch import — gains
  the `skipDoi` knob the file was missing today)
- `forms/endpoints.ts:confirmSubmission:478-490` (safety-fallback insert
  — deleted; membership is reliably inserted at submission time via
  `subscribe`)
- `topics/topics.ts:removeContact:338-364` (single-remove public mutation)
- `topics/bulk.ts:removeContacts:103-128` (bulk-remove public mutation —
  gains the `cachedMemberCount` decrement it was silently missing)
- `delivery/unsubscribeQueries.ts:processUnsubscribe:38-168` (public
  unsubscribe link).

Closes drift bugs: missing `topic_unsubscribed` Contact activity row on
admin-remove paths (timeline gap), missing `cachedMemberCount` decrement
on bulk-remove, missing DOI gate on batch import (silent `requireDoubleOptIn`
bypass for CSV / integration imports), missing webhook fanout on admin-
remove paths, and the diverging `skipDoi` parameter semantics between
single-add ("we already DOI-confirmed; don't ask again") and bulk-add
("admin authoritative; treat as subscribed") — under this module the
flag means "admin authoritative" uniformly.

The module does *not* own: auth (public mutations stay as auth-bearing
shells), the DOI confirmation token write (DOI lifecycle), the
`topic_subscribed` automation trigger when DOI is pending (DOI lifecycle's
`fire_topic_subscribed_triggers` effect handles it at confirm time), the
webhook payload contract (**Webhook event module**s), or the actual
webhook delivery + retry machinery (**Webhook event fanout**).
_Avoid_: Topic membership module (collides with **Topic membership** the
value), Topic add module (covers only one side), Subscribe module alone
(collides with email-subscription / unsubscribe-link concepts), List
subscription (legacy "list" terminology — Topics replaced lists).

## Forms

**Form submission**:
One row in `formSubmissions` — the record of one public-form POST against
a `formEndpoints` row. Carries `status: 'spam' | 'invalid' | 'duplicate'
| 'pending_confirmation' | 'success'`, the raw `data`, `ipAddress`,
`userAgent`, an optional `contactId` link (populated once a Contact is
resolved), and (for the DOI-pending case) a `confirmationToken` shared
with the contact's `doiConfirmationToken` under the unified token
namespace.
_Avoid_: Submission alone (overloaded — Send / Postbox dispatches read
as "submissions" colloquially), Form record (vague), Form post (names
the verb).

**Form submission (module)**:
The module at `convex/forms/submission.ts` that owns the intake path for
public form-endpoint submissions — the path from a raw form-data POST
to a classified `formSubmissions` row. Mirrors the **Contact resolution
(module)** shape: a single intake function with a discriminated `action`
result, plus one small companion entry for the only real post-create
transition. Not a lifecycle in the **Outbound lifecycle** sense — most
rows land directly in a terminal state at create time, so the legal-edges
+ reducer bookkeeping doesn't pay its keep here. Two entry points:
- `submit({ formEndpointId, submissionData, ipAddress?, userAgent? })`
  — loads the form, runs honeypot + field validation, routes through the
  **Contact resolution (module)** (`upsert` mode) for find-or-create,
  then through the **Topic subscription (module)** `subscribe()` when
  `form.topicId` is set, then writes one `formSubmissions` row. Returns
  `{ ok: true, submissionId, action, contactId? }` where `action ∈
  'spam' | 'invalid' | 'duplicate' | 'pending_confirmation' | 'success'`,
  or `{ ok: false, reason: 'form_not_found' | 'form_inactive' }` for
  pre-classification gates.
- `markConfirmedByToken({ token })` — patches the single
  `pending_confirmation → success` transition. Called by the form-confirm
  HTTP handler after `doiLifecycle.transitionByConfirmationToken` commits.
  Idempotent on re-confirm. Returns `{ ok: true, submissionId }` or
  `{ ok: false, reason: 'no_submission_for_token' | 'already_confirmed'
  | 'invalid_state' }`.

Classification rules inside `submit`:
- Honeypot field set → `spam` (row written, no Contact resolved, no
  subscribe).
- Required field missing, oversized, or email-shaped value invalid →
  `invalid` (row written, no Contact resolved).
- No `form.topicId`, Contact resolution returned `matched` → `duplicate`.
- `form.topicId` set, subscribe returned `already_member` → `duplicate`.
- subscribe returned DOI-pending → `pending_confirmation`, with
  `confirmationToken` populated from subscribe's returned `doiToken`
  (no contact re-read).
- Otherwise → `success`.

Behavior change vs pre-deepening: an existing Contact who fills out a
form to join a new Topic now actually gets added to that Topic. Today's
path skips `subscribe` whenever the contact already exists (writing
`duplicate` and silently dropping the membership). Under this module the
`duplicate` literal means "duplicate Topic membership" (or "duplicate
Contact when no topicId is set"), not "any existing Contact at all
costs" — matching the literal's name.

Replaces the 285-line `submitForm` `httpAction` in
`forms/apiHttp.ts:141-425` and the open-coded
`formSubmissions.status: 'success'` patch in
`forms/endpoints.ts:confirmSubmission`. HTTP shells shrink to the
minimum: CORS / rate-limit / parse-body / dispatch / respond for submit;
parse-token / DOI transition / dispatch / respond for confirm.

Closes drift bugs: the open-coded find-or-create that pre-dated
**Contact resolution (module)** in the form path (3 of 4 sites already
migrated via ADR-0008; the form path was missed); the silently-dropped
Topic membership for existing-contact-joins-new-topic; the split
`formSubmissions.status` writer between submit and confirm (today: two
files patch it; under the module: one writer); the redundant contact
re-read for the DOI token (closed by the small return-shape bump on
**Topic subscription (module)**'s `subscribe()` — see its Invariants
section).

The module does *not* own: the HTTP shell (CORS, rate-limit, URL
parsing, body parsing — the **Public token endpoint (module)** wraps
the `submitForm` httpAction in `forms/apiHttp.ts`; the multipart body
parser stays local because it's the only site needing it), the
form-endpoint CRUD
(stays in `forms/endpoints.ts`), the DOI confirmation token write (DOI
lifecycle), the topic membership row write (Topic subscription), or
the DOI-confirm-triggered automation fanout (DOI lifecycle's
`fire_topic_subscribed_triggers` effect).
_Avoid_: Form intake (module) (the row name is "submission" not
"intake" — keep the noun aligned with the table), Submission (module)
alone (overloaded as above), Form endpoint (module) (collides with
`formEndpoints` the row; this module owns writes to `formSubmissions`,
not endpoint configuration), Form submission lifecycle (module) (rows
are mostly created directly in terminal state; the lifecycle framing
inflates the bookkeeping for one true edge that's owned by a small
companion entry point).

## Sending domains

**Sending domain**:
A custom email-sending domain registered for an Owlat deployment.
Stored in `domains` with `domain` (the FQDN), `status`, `dnsRecords`
(the SPF/DKIM/DMARC/MAIL-FROM records the customer must publish),
`verificationResults`, `providerType` (`'mta' | 'ses'`),
`lastRegistrationError?`, `lastVerifiedAt?`, `verifiedAt?` (first-time
verified timestamp; preserved through later `→ pending` / `→ failed`
re-verifies), and timestamps. Provider-specific identity data (DKIM
selector for MTA; DKIM tokens + verification token for SES) lives in
**Sending domain identities**, not on this row. Disjoint from
**Tracking domain** (separate `trackingDomains` table, simpler
`isVerified: boolean` shape, click/open-tracking branding only — no
lifecycle).
_Avoid_: Domain alone (overloaded with `trackingDomains`,
`domainReputation`, and the data attribute in **Abuse status**),
Sender domain (legacy phrasing), From domain (names a config field).

**Sending domain status**:
The current state of a Sending domain at `domains.status`:
`registering | pending | verified | failed`. Legal edges:
- `(insert) → registering` (`Sending domain lifecycle (module)`'s
  `create()` entry)
- `registering → pending` (provider register completed; identity
  row inserted)
- `registering → failed` (provider register threw; identity row not
  written)
- `pending → verified` (all DNS records + per-provider check pass)
- `pending → failed` (any DNS record failed verification)
- `pending → pending` (re-verify: some records still missing, none
  failed — recorded, results patched)
- `verified → registering` (regenerate)
- `failed → registering` (regenerate)
- `verified → verified` / `failed → failed` (re-verify on stable
  state — recorded, results patched)
- `verified → failed` / `verified → pending` (DNS changed underneath
  a previously-verified domain — `verifiedAt` preserved as
  first-verified history)

No terminal states — every status can leave via regenerate or
re-verify. Companion fields written atomically with the status by
the **Sending domain lifecycle (module)** reducer: `dnsRecords`
(set on `→ pending`, cleared on `→ registering`),
`verificationResults` (patched on every verification transition
including self-loops), `lastVerifiedAt` (patched on every
verification transition), `verifiedAt` (set on the first
`pending → verified` only — preserves "first verified" history
through later DNS instability), `lastRegistrationError` (set on
`registering → failed`, cleared on subsequent `→ pending`).
_Avoid_: Verification status (collides with `verificationResults`
the field), Registration status (names one transition slice).

**Sending domain lifecycle (module)**:
The module at `convex/domains/lifecycle.ts` that owns transitions
of `domains.status`, plus row creation and removal. Mirrors the
**Campaign lifecycle (module)** shape — typed `TransitionInput`
discriminated by `to`, a `LEGAL_EDGES` graph, a reducer per kind
returning `{ patch, effects, applied }`, and a `TransitionOutcome`
reporting `ok | reason` for illegal / domain-not-found attempts.
Five entry points:
- `create({ domain })` — validates format, checks uniqueness,
  inserts at `'registering'`, fires `register_with_provider`.
- `transition({ domainId, input })` — direct transitions for the
  `→ pending` / `→ verified` / `→ failed` / `→ registering`
  (regenerate) paths.
- `requestVerification({ domainId })` — refuses unless current
  status is `pending | verified | failed` (not `registering`);
  fires `run_dns_verification`.
- `recordVerification({ domainId, verificationResults,
  providerCheck })` — verifier callback. Reducer combines DNS
  results + provider check to derive `verified | failed | pending`
  and transitions.
- `remove({ domainId })` — fires `delete_with_provider`,
  `clear_provider_identity`, deletes the domain row, writes audit
  log.

Effects:
- `audit_log` — fires on every lifecycle-driven status change plus
  `create` and `remove`. Skipped on verification self-loops to
  avoid spam. New audit actions (`sending_domain.created`,
  `.registered`, `.registration_failed`, `.verified`,
  `.verification_failed`, `.regenerated`, `.deleted`) added to the
  catalog.
- `register_with_provider({ domainId, providerType })` — fires on
  `create()` and on `→ registering`. Schedules the per-provider
  adapter's register action.
- `clear_provider_identity({ domainId, providerType })` — fires on
  `→ registering` when a previous identity row exists. Calls the
  adapter's `clearIdentity` (and `deleteFromProvider` best-effort).
- `run_dns_verification({ domainId })` — fires on
  `requestVerification`. Schedules the DNS verifier action.
- `delete_with_provider({ domain, providerType })` — fires on
  `remove()`. Best-effort cleanup at the provider's API.

Replaces the open-coded status writes in `domains/domains.ts:205`
(regenerate), `domains/dnsVerificationQueries.ts:52` (verify),
`:72` (SES register-complete), `:105` (MTA register-complete), and
the three inline `if (providerType === 'mta')` dispatches in
`domains.create:149`, `domains.regenerateDnsRecords:221`, and
`domains.remove:179`. Closes drift bugs: zero audit-log coverage
on domain transitions (all five existing lifecycle modules have
it), the wide-row provider-specific columns
(`mtaDkimSelector` + `sesDkimTokens` + `sesVerificationToken` +
`sesVerificationStatus` + `sesRegistrationError`) with no schema
constraint preventing cross-provider contamination, and the
kitchen-sink `updateDomainAfterRegistration` mutation that accepts
all five provider-specific fields together as optionals.

The module does *not* own: DNS lookup itself (the verifier action
in `dnsVerification.ts` runs `dns.resolveTxt` / `.resolveCname` /
`.resolveMx` and the per-provider check, then calls
`recordVerification`), provider API calls (the per-provider
adapter owns them — see below), the `trackingDomains` table
(separate concept), `domainReputation` table (separate concept),
or any of the read queries
(`listByOrganization`, `get`, `getByDomain`, `countByStatus`,
`listVerified`, `isDomainVerified`, `isDomainVerificationFresh`,
`getEmailDomainVerificationStatus` — all stay where they are).
_Avoid_: Domain lifecycle (module) (collides with
`trackingDomains`), Domain registration lifecycle (names one
transition slice), Sending domain module (the module owns
*transitions*, not the entire concept — CRUD shells, validation,
and the `dnsRecords` shape live elsewhere).

**Sending domain provider adapter (module)**:
The per-provider module at `convex/domains/providers/<kind>/index.ts`
that owns the Sending domain–side surface of one email provider.
Two adapters today: `providers/mta/` and `providers/ses/`.
Discriminated by `kind: 'mta' | 'ses'` matching the `providerType`
field on the **Sending domain** row. Dispatched by the registry at
`providers/index.ts` exporting `providerFor(kind)`. Mirrors the
**Channel inbound adapter** shape (ADR-0005) — one TypeScript
interface, two concrete implementations, registry-driven dispatch.
Exports a `SendingDomainProviderModule<K>` with:
- `registerDomain(domain) → { dnsRecords, identity }` — provider
  API call. Throws on failure; the `register_with_provider`
  effect handler catches and translates to a `→ failed`
  transition.
- `deleteFromProvider(domain)` — best-effort cleanup at the
  provider's API. Called from `clear_provider_identity` and
  `delete_with_provider` effects.
- `runProviderCheck?(domain) → { verified, lastError? }` —
  optional per-provider verification check. SES implements it
  (live `getVerificationStatus` call); MTA omits it (lifecycle
  treats absent as `{ verified: true }`). Called by the DNS
  verifier action before `recordVerification`.
- `writeIdentity(ctx, domainId, identity)`,
  `clearIdentity(ctx, domainId)` — sibling-table persistence.
  Each adapter owns its **Sending domain identity** table; the
  lifecycle reducer dispatches to these via `providerFor(kind)`.

Adding a third sending provider is a one-folder change: new
`providers/<kind>/` directory, new sibling table in
`schema/domains.ts`, one new entry in
`SENDING_DOMAIN_PROVIDERS`. The compile-time `satisfies` check on
the registry catches missing methods. The lifecycle never branches
on `providerType` — provider variation lives entirely behind this
seam.
_Avoid_: Sending domain provider module (drops "adapter" — per
LANGUAGE.md, "adapter" carries the *role* of "a concrete thing
satisfying an interface at a seam"), Email provider module
(the pre-deepening name for the send-side factory at
`lib/emailProviders/`; that vocabulary is retired in favor of **Send
provider adapter (module)** — distinct surface, parallel naming),
Sending domain provider (without "(module)") — collides with the
provider concept itself; reach for the `(module)` suffix to name
the typed surface.

**Sending domain identity**:
One row in `sendingDomainMtaIdentities` or
`sendingDomainSesIdentities` — the per-provider record of a
registered Sending domain. 1:0..1 with `domains` (a domain has at
most one identity in one provider's table; the providerType field
on `domains` tells the lifecycle which table to load). The MTA
shape is `{ domainId, dkimSelector }`; the SES shape is
`{ domainId, dkimTokens, verificationToken }`. The application
enforces uniqueness via the **Sending domain provider adapter
(module)**'s `writeIdentity` (upserts; never inserts a duplicate
for the same `domainId`). On regenerate, the lifecycle's
`clear_provider_identity` effect deletes the sibling row before
the new register effect runs.
_Avoid_: Domain identity (collides with **Contact identity** in
shape and reads as overloaded), Provider identity alone (vague),
Sending domain credential (suggests user-supplied auth secrets;
these are provider-issued tokens).

## Campaigns

**Campaign**:
A one-time marketing email blast. Stored in `campaigns` with `name`,
`emailTemplateId`, `status`, sender info (`fromName`, `fromEmail`,
`replyTo`, `subject`), audience targeting (`audienceType: 'topic' |
'segment'` with `topicId` / `segmentId` / copied `segmentFilters`),
scheduling fields (`scheduledAt`, `useRecipientTimezone`,
`scheduledHour`, `scheduledMinute`), and denormalized stats counters
(`statsSent..statsUnsubscribed`). Each campaign fans out to N **Send**s
(one per recipient) tracked in `emailSends`. The audience unit at send
time; the AB-test subject when `isABTest` is true.
_Avoid_: Blast (informal, doesn't signal the row), Send alone (Send is
the per-recipient row), Email send (overloaded with the verb).

**Campaign status**:
The current state of a Campaign at `campaigns.status`:
`draft | scheduled | sending | sent | cancelled | pending_review`. Legal
edges:
- `draft → scheduled` (schedule for future send)
- `draft → sending` (send now)
- `scheduled → draft` (unschedule for editing)
- `scheduled → cancelled` (cancel scheduled campaign)
- `scheduled → sending` (send now on already-scheduled campaign; also
  the scheduler-tick path when `scheduledAt` arrives)
- `sending → sent` (campaign-send orchestrator terminal)
- `sending → draft` (content scan blocked; `contentBlockReason` written)
- `sending → pending_review` (content scan flagged as suspicious)
- `pending_review → sending` (admin approve)
- `pending_review → draft` (admin reject)

`sent` and `cancelled` are terminal — transitions out of them are
refused as `illegal_edge`. Companion fields written atomically with the
status by the **Campaign lifecycle (module)** reducer: `sentAt` on
`→ sending`, `cancelledAt` on `→ cancelled`, `scheduledAt` (set on
`→ scheduled`, cleared on `→ sending` / `→ cancelled`),
`contentBlockReason` on `sending → draft`, and stats-zero
(`statsSent..statsUnsubscribed → 0`) on `→ sending`. The per-Send
stats *increments* live in the **Send lifecycle (module)**'s
`campaign_stats_*` effect list; the Campaign lifecycle owns the
*reset*, the Send lifecycle owns the bumps.
_Avoid_: Campaign state (vague), Send status (overloaded with
`emailSends.status`).

**Campaign lifecycle (module)**:
The module at `convex/campaigns/lifecycle.ts` that owns transitions of
`campaigns.status`. Mirrors the **Outbound lifecycle** shape — typed
`TransitionInput` discriminated by `to`, a `LEGAL_EDGES` graph (above),
a private reducer per kind returning `{ patch, effects, applied }`, and
a `TransitionOutcome` reporting `ok | reason` for duplicate / illegal /
terminal attempts. Single entry point `transition({ campaignId, input
})`; no external-key entry — campaigns are identified by their own
`Id<'campaigns'>`.

Effects:
- `audit_log(action, campaignId, details?)` — fires on every transition,
  not only on `cancel`. Closes the silent drift bug where `schedule`,
  `sendNow`, `unschedule`, and the content-scan reverts wrote `status`
  without an audit-log row.
- `schedule_campaign_send_orchestrator(delayMs)` — fires on
  `to: 'scheduled'` (with the `scheduledAt`-derived delay) and
  `to: 'sending'` (with `0`). Replaces the inline
  `scheduler.runAfter(... internal.emails.startCampaignSendInternal ...)`
  calls in the surviving `schedule` and `sendNow` mutations (the
  `forOrganization` duplicates are deleted — see Producers below).
- `track_event(event, campaignId)` — fires `campaign_scheduled`,
  `campaign_sent`, `campaign_cancelled`. Closes the PostHog-tracking
  drift where the `forOrganization` siblings silently skipped
  `trackEvent`.
- `start_ab_test_if_enabled` — fires on `to: 'sending'` when
  `campaign.isABTest` is true. Routes through the **AB test lifecycle
  (module)** `transition({ to: 'testing' })`. Cross-machine effect —
  same pattern as the **DOI lifecycle (module)**'s
  `fire_topic_subscribed_triggers` reaching into the **Topic
  subscription (module)**.

The module does *not* own: the pre-flight gates
(`validateReadyToSend(ctx, campaign)` helper at
`convex/campaigns/preflight.ts` — domain verification, template-present,
audience-configured, fromEmail-set, abuse-allowed,
scheduled-time-future — runs in callers *before* `lifecycle.transition`
to `'scheduled'` / `'sending'`; reducer trusts its input), the
archive-snapshot write (stays in
`archiveQueries.setArchiveSnapshot`, called by the campaign-send
orchestrator mid-`sending`, not on the transition to it), the per-Send
stats bumps (Send lifecycle's `campaign_stats_*` effects), or the AB
test state itself (sibling lifecycle).

Producers of transition calls today (post-deepening):
- `convex/campaigns/scheduling.ts:cancel` (`→ cancelled`)
- `convex/campaigns/scheduling.ts:unschedule` (`→ draft`)
- One surviving `schedule` mutation (`→ scheduled`) — the
  `scheduleForOrganization` duplicate in `organization.ts` is deleted;
  HTTP callers delegate.
- One surviving `sendNow` mutation (`→ sending`) — the
  `sendNowForOrganization` duplicate is deleted similarly.
- The campaign-send orchestrator (`emails.startCampaignSendInternal` or
  its successor) calls `lifecycle.transition({ to: 'sending' })` on the
  scheduler-tick path (replacing the deleted
  `emailsQueries.updateCampaignToSending`),
  `lifecycle.transition({ to: 'sent' })` at the terminal (replacing
  `emailsQueries.markCampaignSent`),
  `lifecycle.transition({ to: 'pending_review' })` on suspicious
  content (replacing `setCampaignPendingReview`), and
  `lifecycle.transition({ to: 'draft', contentBlockReason })` on
  blocked content (replacing `revertCampaignToDraft`).
- The admin approval/rejection surface (`pending_review → sending`,
  `pending_review → draft`) lands as a follow-up; the legal-edges
  graph ships with the edges in place so the surface plugs in without
  re-litigating the graph.

Replaces the 13+ open-coded `db.patch` sites across
`campaigns/campaigns.ts`, `campaigns/organization.ts`,
`campaigns/scheduling.ts`, and `emailsQueries.ts` (the `abTest.ts`
writes move to the sibling lifecycle, not this one).
`internalMutation updateStats` loses its optional `status` arg (the
backdoor used only by tests) — tests transition via
`lifecycle.transition` directly.

Closes drift bugs: missing audit-log on
`schedule`/`sendNow`/`unschedule` (only `cancel` recorded one); missing
`trackEvent` on the `forOrganization` mutations; duplicated pre-flight
check blocks (consolidated into the one helper); the `pending_review`
one-way door (legal edges out are now defined); the
`updateStats`-as-status-backdoor; and the divergent defense-in-depth
`isSendingAllowed` re-check inside the orchestrator at
`emails.ts:413` (gate runs once at the lifecycle's caller via
`validateReadyToSend`).
_Avoid_: Campaign state machine (names the value), Campaign manager
(vague), Campaign workflow (overloaded with **Automation**).

**AB test status**:
The current state of a campaign's AB test at `campaigns.abTestStatus`:
`pending | testing | winner_selected`. Legal edges:
- `(none) → pending` (`enableABTest`)
- `pending → testing` (cross-machine — the **Campaign lifecycle
  (module)** transitions to `sending` and `isABTest` is true)
- `testing → winner_selected` (`declareABTestWinner`; manual or
  auto-criteria-driven)
- `* → (none)` (`disableABTest` — reset, also clears `abTestConfig`,
  `abVariantBSent..abWinner*` companions)

The previous `completed` literal is dropped (pre-prod schema change) —
the lifecycle has no terminal beyond `winner_selected`, and no writer
ever set `completed`. The previous `testing` literal had no writer
either; under this deepening the cross-machine effect from the
**Campaign lifecycle (module)** is the writer. Companion fields written
atomically with the status: `abWinner`, `abWinnerSelectedAt` on
`→ winner_selected`; the full reset block on `→ (none)`.
_Avoid_: AB test state (names the value), Variant state (collides with
the per-recipient `abVariant` field on `emailSends`).

**AB test lifecycle (module)**:
The module at `convex/campaigns/abTestLifecycle.ts` that owns
transitions of `campaigns.abTestStatus`. Sibling of the **Campaign
lifecycle (module)** — same row, different column, separate
legal-edges graph. Same **Outbound lifecycle** shape (typed
`TransitionInput`, `LEGAL_EDGES`, reducer, `TransitionOutcome`). Single
entry point `transition({ campaignId, input })`. No external-key
entry — campaigns are identified by `Id<'campaigns'>`.

Effects:
- `audit_log(action, campaignId, details?)` — fires on every
  transition.
- `schedule_winner_remainder(campaignId)` — fires on
  `→ winner_selected`. Schedules
  `internal.emails.sendCampaignWinnerToRemainder` (the
  second-phase send) at zero delay. Cross-machine effect — the
  **Campaign send orchestrator (module)** is the consumer.

The module does *not* own: the kickoff (called via the **Campaign
lifecycle (module)**'s `start_ab_test_if_enabled` effect when the
campaign goes `→ sending`), the per-recipient variant fanout (lives in
the **Campaign send orchestrator (module)** — the orchestrator's
first-phase entry assigns `abVariant` per recipient across the test
cohort; the orchestrator's `sendCampaignWinnerToRemainder` entry tags
remainder rows with the winner's variant), the winner-criteria
evaluation (a follow-up — the auto-pick timer that declares a winner
based on open/click rate is not yet wired; today `declareABTestWinner`
is the only producer of `→ winner_selected`), and the variant-stats
counter aggregation (the `abVariantBSent..abVariantBClicked` row
counters on `campaigns` are documented in schema but never read in
production — `getABTestStats` reads `emailSends` directly via the
`by_campaign_and_variant` index; the counters are aspirational
denormalization, deferred until a query-perf need lands).

Producers of transition calls today (post-deepening):
- `convex/campaigns/abTest.ts:enableABTest` (`→ pending`)
- `convex/campaigns/abTest.ts:disableABTest` (`→ (none)`)
- `convex/campaigns/abTest.ts:declareABTestWinner` (`→ winner_selected`)
- The **Campaign lifecycle (module)**'s `start_ab_test_if_enabled`
  effect (`→ testing`)

Replaces the three open-coded `db.patch` sites in `abTest.ts`. Closes
drift bugs: the dead `testing` literal (now has a writer via the
cross-machine effect), the dead `completed` literal (dropped from the
union), the silent absence of an audit-log row on
`enableABTest` / `disableABTest` / `declareABTestWinner`.
_Avoid_: AB lifecycle (collides with general "lifecycle"), Test
lifecycle (overloaded — "test" means unit test colloquially), Variant
lifecycle (the lifecycle is over the test, not over a variant).

**Campaign send orchestrator (module)**:
The two-action surface at `convex/emails.ts` that owns the campaign
send pipeline — taking a campaign from `scheduled | sending` through
content scan, archive snapshot, audience resolution, A/B variant
fanout, and workpool enqueue. Two entry points:
- `startCampaignSend({ campaignId })` — first-phase entry. Producers:
  the daily scheduler tick (`processScheduledCampaigns`), the
  **Campaign lifecycle (module)**'s `schedule_campaign_send_orchestrator`
  effect (fires on `→ scheduled` with the `scheduledAt`-derived delay
  and on `→ sending` with `0`), and `campaigns/scheduling.ts:reschedule`
  for direct re-arming. The action runs the prep pipeline once, gates
  on the **Campaign lifecycle (module)**'s preflight, and writes the
  `scheduled → sending` transition if the campaign is still in
  `scheduled` at fire time. For A/B test campaigns
  (`isABTest && abTestStatus === 'testing'`) the first-phase send fans
  out a *test cohort* (see below); for non-A/B campaigns it sends to
  the full audience uniformly.
- `sendCampaignWinnerToRemainder({ campaignId })` — second-phase
  entry. Sole producer: the **AB test lifecycle (module)**'s
  `schedule_winner_remainder` effect on `→ winner_selected`. Loads the
  campaign, resolves the audience, excludes every contact already on
  an `emailSends` row for this campaign (test-cohort members + any
  prior second-phase attempt), sends the winner's content
  (`variantBSubject` for `subject` tests; `variantBTemplateId`'s
  content for `content` tests; A's content when the winner is A).
  Skips timezone-aware delayed scheduling — the original
  `scheduledHour/Minute` no longer reflects user intent by winner-
  declaration time. Idempotent: re-invocation finds zero remainder
  and exits with `skipped: true`.

A/B test fanout model (two-phase): `abTestConfig.splitPercentage`
means *"% per variant of the test cohort"* (10–50). For a campaign
with N recipients in a language group, the cohort is
`floor((2 × splitPercentage / 100) × N)` recipients, randomly
shuffled and split into `floor(cohort/2)` variant A and the rest
variant B. Cohorts smaller than 2 degrade gracefully to a
no-variant uniform send for that language group (`emailSends.abVariant`
is left unset, a single batch fires). The remainder
`N - cohort_size` is *held back* — no `emailSends` row is created
in first phase. After the operator (or future auto-pick timer) calls
`declareABTestWinner`, the second-phase send creates rows for the
held-back remainder tagged with the winner's variant.

The orchestrator is the only writer of `emailSends.abVariant`, the
only consumer of `abTestConfig.variantBSubject` /
`abTestConfig.variantBTemplateId`, and the only caller of
`internal.emailWorkerMutations.enqueueCampaignEmails` for campaign-
driven sends. Per-language enqueue does *not* coalesce into a single
batch when a variant split is in play — variant A and variant B are
enqueued separately (different `subject` / `htmlContent` per call) so
the existing per-batch enqueue contract holds.

The module does *not* own: the `→ sending` transition itself (Campaign
lifecycle), the AB test status transitions (AB test lifecycle), the
audit-log writes (lifecycle effects), the per-recipient HTML rendering
(`internal.emailWorker.sendSingleEmail` is the consumer that applies
tracking and personalization), the workpool rate-limiting (the
`campaignEmailPool` workpool in `lib/emailWorkpool.ts`), or any read
queries (those live in `emailsQueries.ts` and `delivery/sendReads.ts`).

Replaces the orphaned twin `startCampaignSend` (the pre-deepening
public-facing duplicate of `startCampaignSendInternal`, deleted with
this module) and consolidates the per-language enqueue loop behind
the private `enqueueVariantBatch` helper so the timezone-grouped and
chunked-50 paths live in one place. Closes drift bugs: the previously
silent A/B variant fanout gap (today `enableABTest` stored config and
the lifecycle transitioned to `testing`, but no production code wrote
`emailSends.abVariant` or used variant B's subject/template — so AB
test stats were eternally 0/0 on variant B), the dead twin's
non-existent timezone scheduling support, and the dead twin's inline
throws that an `internalAction` scheduled by the cron would have lost
invisibly.

Known gaps: the auto-pick winner timer (currently winner declaration
is manual via `declareABTestWinner` only — `winnerCriteria !=
'manual'` and `testDuration` are stored on `abTestConfig` but no cron
consumes them; the **AB test lifecycle (module)**'s
`schedule_winner_remainder` effect fires the second-phase send
regardless of pick mode — only the *trigger* is manual today); and
per-variant Send-lifecycle stats counter bumps (documented in the AB
test lifecycle entry, deferred until a query-perf need lands —
`getABTestStats` reads `emailSends` rows directly today).

Known race: `declareABTestWinner` can be called between the first-
phase orchestrator scheduling its enqueue mutations
(`runAfter(0, enqueueCampaignEmails, ...)`) and those mutations
landing the `emailSends` rows. If a winner is declared inside that
window, `sendCampaignWinnerToRemainder` will see *too few* contacts
in `listSentContactIdsForCampaign` and re-target some test-cohort
contacts as remainder — producing duplicate sends for those
contacts (one with the test variant, one with the winner). The race
is essentially impossible with the manual-trigger UI (an operator
won't declare a winner with zero data on the analytics page) and
intrinsically avoided by the future auto-pick timer
(`testDuration` is hours; first-phase enqueue completes in seconds).
Filed as a known limitation rather than guarded against in code
because the guard surface (require `statsSent > 0` before allowing
`→ winner_selected`) bakes a UI invariant into the lifecycle.
_Avoid_: Campaign sender (vague; doesn't signal the orchestrator role),
Campaign send pipeline (overloaded with the MTA **Dispatch pipeline
(module)** vocabulary — the orchestrator is a single linear flow, not
composed of typed `Phase`s), Campaign send action (names the
implementation runtime, not the responsibility), Email orchestrator
(too broad — transactional sends are *not* in this module's scope).

## Audience

**Audience**:
A Campaign's targeting *selection* — who a Campaign sends to, before
eligibility filtering. A discriminated union over `kind`:
`{ kind: 'topic', topicId }` (every **Topic membership** of one Topic)
or `{ kind: 'segment', segmentId }` (every live Contact matching a
Segment's conditions). Lives in `packages/shared` so the campaign
wizard, the public count query, and the **Audience resolution
(module)** all speak one shape. Replaces the four flat columns on
`campaigns` (`audienceType` + `topicId` + `segmentId` +
`segmentFilters` at `schema/campaigns.ts:29-32`) with a single
`audience` field — illegal states (`kind: 'topic'` carrying a
`segmentId`; `kind: 'segment'` carrying neither id nor snapshot) become
unrepresentable in storage. The wizard-facing selection subset carries
no snapshot; the *stored* segment case additionally carries an optional
`frozenFilters`, populated at send time by the **Campaign send
orchestrator (module)**, so an already-sent Campaign reproduces the
exact Segment definition it targeted even after the Segment is later
edited. Distinct from the resolved recipient projection
(`CampaignRecipient[]` — the eligibility-filtered output) and from the
raw **Topic membership** / Segment match (an Audience is the *spec*,
not the rows).
_Avoid_: Audience type (collides with the legacy `audienceType`
discriminant column — the value is the whole union, not the tag),
Targeting (vague), Recipient list (names the resolved output, not the
spec), Segment alone (covers one `kind` only).

**Audience resolution (module)**:
The module at `convex/campaigns/audienceResolution.ts` that owns the
single mapping from an **Audience** to its eligible recipients
(`CampaignRecipient[]`). One pure per-Contact *eligibility predicate*
is the shared core; two thin entries route through it so a count can
never disagree with a send:
- `resolveRecipients({ audience }) → CampaignRecipient[]` —
  internalQuery; the **Campaign send orchestrator (module)**'s
  audience-resolution step. Materializes the rows. (`frozenFilters`
  rides *inside* the `audience` segment case, not as a sibling arg.)
- `countRecipients({ audience }) → { total, eligible }` — public
  query; the wizard's audience-size readout. Runs the *identical*
  predicate but accumulates integers instead of rows, so `eligible`
  equals the number actually delivered. `total` is the raw membership
  (topic) / live-match (segment) count; the `total - eligible` gap is
  the "excluded" count, and its composition differs by kind: a *topic*
  gap is DOI-pending + emailless + suppressed, **plus** any
  soft-deleted or orphaned (hard-deleted-Contact) memberships still
  counted in `total`; a *segment* gap is emailless + suppressed only
  (soft-deleted are already dropped from `total`, and DOI never gates a
  segment).

The eligibility predicate, in order: live-Contact (skip soft-deleted),
email-present (skip phone/SMS/WhatsApp/generic Contacts — the recipient
list is email-only), not-suppressed (skip `blockedEmails` — the only
suppression gate in the send path), then the *DOI gate*. The DOI gate
is asymmetric **by design**: a `topic` Audience gates on the Contact's
`doiStatus` (`confirmed | not_required` pass) when the Topic
`requireDoubleOptIn`; a `segment` Audience never gates on DOI —
Segments are explicit operator targeting, not consent-derived
membership. This asymmetry is a named invariant, not an oversight — do
not "fix" the segment path to gate on DOI without revisiting it here.

Replaces the open-coded `getCampaignRecipients`
(`emailsQueries.ts:138-267`), the duplicate eligibility logic in
`getAudienceCountByOrganization` (`campaigns/organization.ts:99-152`),
and the third segment-count path `evaluateSegmentCount`
(`organization.ts:147`). Closes drift bugs: the count's `eligible`
over-reporting (it filtered only DOI, never email-present or
suppression, so the wizard promised more recipients than were
delivered); soft-deleted Contacts reachable on the segment send path
(`emailsQueries.ts:214` scans `contacts` with no `deletedAt` filter,
violating the live-Contact invariant); and the count-vs-send
divergence that two independent implementations guaranteed.

The module does *not* own: the `frozenFilters` snapshot write (the
**Campaign send orchestrator (module)** / preflight copies the live
Segment's filters at send time; the resolver only *reads* a snapshot
when handed one), the A/B already-sent exclusion
(`listSentContactIdsForCampaign` dedup stays in the orchestrator —
that is send-state, not Audience membership), the variant fanout /
workpool enqueue (orchestrator), auth (the public `countRecipients`
keeps its session shell), or the full-table Segment scan's
*performance* (the module localizes the scan so a future index lands
in one place, but adds none in this slice).
_Avoid_: Recipient resolution (a recipient is the resolved output /
the per-**Send** row; this module resolves the *Audience* spec into
them), Audience query (names the mechanism and hides the two-entry /
shared-predicate shape), Audience selection (names the UI act and the
**Audience** value, not the resolver), Segment evaluation (covers the
segment half only; Topic membership is the other).

## Saved blocks

**Saved block**:
A reusable **Block** or sequence of Blocks stored in `emailBlocks` with
`name`, `description?`, `content` (the source block JSON), and a
denormalized `usageCount`. Embedded into one or more **Saved block
consumer** rows via the consumer's `linkedBlockIds: string[]` plus a
per-block `savedBlockRef: { blockId, groupId, blockName }` annotation
carried inside the consumer's content JSON. The "reusable snippet" UX
unit — frontend components like `SavedBlockPickerMenu.vue` insert a
Saved block into a template by embedding its blocks with the
back-reference and adding the `blockId` to the consumer's
`linkedBlockIds`.
_Avoid_: Block alone (collides with **Block** the email-tree unit),
Reusable block (descriptive but unused in code — `emailBlocks` and
`savedBlockRef` are the established names), Snippet (informal, not in
schema), Linked block (names the relationship from the consumer's
side — the row itself is "saved" not "linked").

**Saved block consumer**:
A row that embeds one or more **Saved block**s in its content. Two
consumer tables today: `emailTemplates` and `transactionalEmails`. Each
carries `linkedBlockIds: string[]` listing the saved blocks it
references; the per-block `savedBlockRef` annotation inside the
consumer's content JSON is the back-reference the **Saved block
(module)** walker scans for. Both tables are walked uniformly by the
module's effects (`propagate_content`, `propagate_name`, `detach_all`).
Each consumer table also carries the new `htmlRenderState` field
(`{ stale: boolean; failureCount?: number; lastFailureAt?: number }`)
that records whether `htmlContent` is still in sync with the embedded
saved blocks' content — set to `stale: true` atomically with content
propagation, cleared by the **Saved block rerender pool** on successful
re-render.
_Avoid_: Linked email (vague — which email?), Block consumer (drops
"saved", reads as a Block-tree consumer), Block referrer (overloaded),
Email referencing block (verbose), Saved block host (host suggests
deployment infrastructure).

**Saved block (module)**:
The module at `convex/emailBlocks/module.ts` that owns *all* writes to
`emailBlocks` rows and the cascade walks into **Saved block consumer**
tables. Same shape as **Topic subscription (module)** — event-with-
effects, multiple entry points dispatched by the row write being
performed, atomic typed effect list per call. No status column, no
`LEGAL_EDGES` graph; saved blocks have no state machine. Four row-side
entry points:
- `create({ name, description?, content })` — inserts a row at
  `usageCount: 0`. Effect: `audit_log`.
- `update({ blockId, patch: { name?, description?, content? } })` —
  classifies internally and emits an effect list per field that
  changed. Effects (any subset, fired atomically with the row patch):
  `propagate_content`, `schedule_rerender`, `propagate_name`,
  `audit_log`. Description-only updates patch the row and emit only
  `audit_log`.
- `duplicate({ blockId })` — clones the source row with
  `name → "<source.name> (Copy)"` and `usageCount: 0`. Effect:
  `audit_log`.
- `remove({ blockId })` — detaches the saved block from every consumer
  and deletes the row. Effects: `detach_all`, `audit_log`.

Plus one cross-cutting entry point used by **Saved block consumer**
lifecycles:
- `updateBlockUsageCounts({ previousIds, nextIds })` —
  increments/decrements `usageCount` on saved blocks based on a
  consumer's `linkedBlockIds` delta. The single writer of
  `emailBlocks.usageCount`. Called by **Email template lifecycle
  (module)**'s and **Transactional email lifecycle (module)**'s
  `update_block_usage_counts` effect — those modules import this entry
  and delegate.

Effects:
- `propagate_content` — walks both **Saved block consumer** tables for
  rows with this `blockId` in `linkedBlockIds`. Replaces the embedded
  blocks via `savedBlockRef.groupId` match, re-serializes content, and
  patches `htmlRenderState: { stale: true, failureCount: 0 }`
  atomically with the content patch. The pre-deepening duplicated
  `parseContentBlocks` (lived in both `lib/linkedBlockPropagation.ts`
  and `linkedBlockRender.ts`) collapses into the module's private
  walker.
- `propagate_name` — same walker, mutates only `savedBlockRef.blockName`
  on each embedded block. No HTML re-render scheduled — block names
  aren't in rendered HTML.
- `detach_all` — same walker, removes `savedBlockRef` from each
  embedded block and strips the `blockId` from the consumer's
  `linkedBlockIds`.
- `schedule_rerender` — enqueues into the **Saved block rerender pool**
  with the affected consumer IDs. The pool runs `reRenderEmails` (in
  `convex/emailBlocks/rendering.ts`, `'use node'`) with declared retry
  schedule + backoff. On successful re-render the action patches the
  consumer's `htmlContent` plus `htmlRenderState: { stale: false }`.
  On terminal failure after retries exhausted, the pool's `onComplete`
  patches `htmlRenderState.failureCount += 1` + `lastFailureAt` and
  fires the `email_block.rerender_failed` audit action; the
  `stale: true` flag stays set as the durable signal for later
  operator intervention.
- `audit_log(action, details?)` — fires on every entry. New audit
  actions in `auditActions/catalog.ts`: `email_block.created`,
  `.updated` (with `details: { contentChanged, nameChanged }`),
  `.duplicated`, `.deleted`, `.rerender_failed`.

The send path (**Campaign send orchestrator (module)** for campaigns,
**Transactional send intake (module)** for transactional dispatches)
reads `htmlRenderState.stale` at dispatch time and logs a warning when
true, but does *not* refuse the send. Gating sends on stale HTML is a
deferred decision; the durable flag makes the surface available when
the decision lands.

Replaces `lib/linkedBlockPropagation.ts` (deleted; its three
propagation helpers become reducer effects, its walker helpers become
private to `module.ts`, its `updateBlockUsageCounts` becomes the
cross-cutting entry point) and absorbs the open-coded
`if (contentChanged) … else if (nameChanged)` branch at
`emailBlocks.ts:196-225` into the `update` reducer's classification.

Closes drift bugs:
- Duplicated `parseContentBlocks` across
  `lib/linkedBlockPropagation.ts:18` and `linkedBlockRender.ts:24` —
  one canonical walker remains.
- Dead `incrementUsage` mutation at `emailBlocks.ts:270` (zero callers
  in `apps/` — superseded by the **Email template lifecycle (module)**
  / **Transactional email lifecycle (module)** `update_block_usage_counts`
  effect which already maintains the invariant on `linkedBlockIds`
  changes) — deleted outright.
- Open-coded `updateBlockUsageCounts` calls at
  `emailTemplates/emails.ts:108` and `transactional/emails.ts:252`
  that bypass the lifecycle effect path ADR-0022 introduced — both
  rewired through the lifecycle.
- Untyped fire-and-forget re-render at `emailBlocks.ts:213` whose
  failure silently left stale `htmlContent` — replaced by workpool-
  backed retries plus the `htmlRenderState.stale` flag making the
  failure mode visible to operators and to downstream send paths.
- Four open-coded "walk emailTemplates + walk transactionalEmails"
  loops (`lib/linkedBlockPropagation.ts:57, 170, 265` and
  `linkedBlockRender.ts:46`) — one walker shared across
  `propagate_content`, `propagate_name`, `detach_all`.

The module does *not* own: the renderer call itself (lives in
`convex/emailBlocks/rendering.ts`, `'use node'` because
`@owlat/email-renderer` needs Node); the `htmlContent` patch on
consumer rows (the rendering action owns it post-render); the
consumer-side `linkedBlockIds` array maintenance during template-level
edits (each template lifecycle module owns its own row's
`linkedBlockIds` via its `update` mutation); the read queries on
`emailBlocks` (`list`, `get`, `getStatsByTeam`, `getRecentByTeam` stay
in `emailBlocks/blocks.ts`); or gating sends on `htmlRenderState.stale`
(deferred).
_Avoid_: Saved block module (no parens — informal, breaks convention),
Saved block propagation (module) (names a verb that only covers half —
`create`/`duplicate` aren't propagation), Saved block writer (module)
(implies a writer-half/display-half split per **Contact activity
(module)** that doesn't exist here), Saved block lifecycle (module)
(no status column to drive `LEGAL_EDGES`; calling it a lifecycle
invites confusion with **Email template lifecycle (module)** which
*does* have one), Email block module (drops "saved" — the row is named
`emailBlocks` but the domain term across frontend, docs, and schema
annotations is "saved block").

**Saved block rerender pool**:
The workpool at `convex/emailBlocks/rendering.ts` that owns retried
execution of `reRenderEmails` for **Saved block consumer** rows
flagged `htmlRenderState.stale`. Mirrors the `campaignEmailPool` /
`transactionalEmailPool` shape: declared retry schedule with backoff,
`onComplete` callback that translates the workpool outcome into a
final-state write. The pool is enqueued by the **Saved block
(module)**'s `schedule_rerender` effect with the affected consumer
IDs; the pool's worker runs the `@owlat/email-renderer` re-render
inside a `'use node'` action and on success patches `htmlContent` +
clears `htmlRenderState.stale` on each affected consumer. On terminal
failure, `onComplete` bumps `htmlRenderState.failureCount`,
`lastFailureAt`, and fires the `email_block.rerender_failed` audit
action — the `stale: true` flag stays set so a subsequent operator
intervention or future "rerender on read" path can pick it up.
_Avoid_: HTML render pool (overloaded — render-on-send is a separate
concern), Block rerender pool (drops "saved"), Email rerender pool
(too broad — covers more than saved-block-driven re-renders), Linked
block render pool (uses the consumer-side noun "linked").

## Email templates

**Email template**:
A reusable email content source stored in `emailTemplates` with a
`type: 'marketing' | 'transactional'`, `status: 'draft' | 'published'`,
`name`, `subject`, `previewText`, `content` (the source block JSON),
`htmlContent` (pre-rendered HTML), `defaultLanguage`,
`supportedLanguages`, `translations` (per-language translatable text),
`htmlTranslations` (per-language pre-rendered HTML), and
`linkedBlockIds` (saved-block references). The marketing template feeds
into a Campaign as `campaigns.emailTemplateId`. The transactional
template is a *separate concept* — the row in `transactionalEmails` is
the **Transactional email** with its own table and dedicated lifecycle.
The two share the publish-state shape but not the table.
_Avoid_: Template alone (collides with the broader templating concept
— **Email template** is the marketing-template row; the transactional
table is named separately), Marketing template (the table historically
allows `transactional` typed rows too — though the dedicated
**Transactional email** table is the one the public API references),
Email source (vague).

**Email template status**:
The current state of an **Email template** at `emailTemplates.status`:
`draft | published`. Legal edges:
- `(insert) → draft` (every create path lands here)
- `draft → published` (publish — caller passes the pre-rendered
  `htmlContent` and optional `htmlTranslations`; idempotent
  `published → published` reports `already_in_state` and does not
  re-patch)
- `published → draft` (unpublish — clears `publishedAt`)

No content-scan gate on this path. Marketing templates are scanned at
*send time* by the **Campaign send orchestrator (module)**, not at
publish time. The parallel **Transactional email status** adds
`pending_review` for the scan-at-publish path because the public
transactional send API can dispatch without an operator in the loop.

Companion fields written atomically with the status by the **Email
template lifecycle (module)** reducer: `publishedAt` (set on
`→ published`, cleared on `→ draft`), `updatedAt` (every transition).
_Avoid_: Template status alone (overloaded — collides with the
transactional table's same field), Email template state (collides with
the per-machine "state" suffix used in Postbox outbound).

**Email template lifecycle (module)**:
The module at `convex/emailTemplates/lifecycle.ts` that owns transitions
of `emailTemplates.status` plus row creation, duplication, and removal.
Mirrors the **Campaign lifecycle (module)** shape — typed
`TransitionInput` discriminated by `to`, a `LEGAL_EDGES` graph, a
reducer per kind returning `{ patch, effects, applied }`, and a
`TransitionOutcome` reporting `ok | reason` for illegal /
already-in-state attempts. Four entry points:
- `create({ name, type, subject?, previewText?, content?,
  defaultLanguage?, linkedBlockIds? })` — validates input, inserts the
  row at `'draft'` with `contentBlockVersion` and `rendererVersion`
  populated uniformly across all three pre-existing create shells,
  fires `update_block_usage_counts` if `linkedBlockIds` is set,
  `audit_log`.
- `transition({ templateId, input })` — `input` is `{ to: 'published',
  htmlContent, htmlTranslations? } | { to: 'draft' }`. Idempotent on
  same-state transitions (`already_in_state` outcome, no re-patch).
- `duplicate({ sourceTemplateId })` — clones source row fields with
  `name → "<source.name> (Copy)"`, `status: 'draft'`, fresh timestamps.
  Calls `create` internally for the row write + audit-log effect.
- `remove({ templateId })` — deletes the row, fires `audit_log`,
  reverses `linkedBlockIds` usage counts via
  `update_block_usage_counts`.

Effects:
- `audit_log` — fires on every transition plus `create`, `duplicate`,
  `remove`. New audit actions `email_template.created`, `.published`,
  `.unpublished`, `.duplicated`, `.deleted` land in
  `auditActions/catalog.ts`.
- `update_block_usage_counts(prev, next)` — fires when `linkedBlockIds`
  changes. Delegates to the **Saved block (module)**'s
  `updateBlockUsageCounts` entry, the single writer of
  `emailBlocks.usageCount`. Replaces the open-coded calls at
  `emailTemplates/emails.ts:108` (still bypassing the lifecycle
  post-ADR-0022) and the pre-ADR-0022 sites at `emailTemplates.ts:102`
  / `:223`, plus the `lib/linkedBlockPropagation` helper they used
  (deleted with the saved-block deepening).

Publish invariant guard:
The module exports `assertEditableForPublishableChange(template,
force?: boolean)` — throws when `template.status === 'published' &&
!force`. Consumed by every mutation in `emailTemplates/` that touches
publishable content (`update`, `setDefaultLanguage`,
`removeTranslation`, both paths of `updateTranslation`,
`addTranslation`, `changeType`). Each gains a `forceWhilePublished?:
boolean` arg routed through the guard. The editor UX surfaces an
"Unpublish to edit?" gate when a user tries to modify a published
template; the public HTTP API (`emailTemplatesOrganization.ts`) doesn't
expose publish/unpublish so its mutations refuse on published without
the knob.

Producers of transition calls today (post-deepening):
- `emailTemplates/emails.ts:publish` (`→ published`)
- `emailTemplates/emails.ts:unpublish` (`→ draft`)
- `emailTemplates/emails.ts:create`,
  `emailTemplates/organization.ts:createForOrganization`,
  `emailTemplates/organization.ts:createFromPreset` all delegate to
  `lifecycle.create`
- `emailTemplates/emails.ts:duplicate` delegates to
  `lifecycle.duplicate`
- `emailTemplates/emails.ts:remove` delegates to `lifecycle.remove`

Replaces the open-coded status writes at `emailTemplates.ts:139-145`
(publish) and `:163-166` (unpublish), the three divergent create paths
(`emailTemplates.ts:363-378`, `emailTemplatesOrganization.ts:121-133`,
`:154-166`), the open-coded duplicate at `:190-208`, and the open-coded
delete at `:223`.

Closes drift bugs: non-idempotent `publish` (today's mutation
re-patches `publishedAt` on every call); `unpublish` failing to clear
`publishedAt` (the marketing path leaves the stale timestamp in place;
the transactional path already clears it — under unified lifecycle
semantics both clear); three create paths that disagree on default
fields (`contentBlockVersion` and `rendererVersion` are populated by
`create` but skipped by the organization-side variants); zero
audit-log coverage on any status change (every other lifecycle has
it); silent edits to published templates' `subject` / `content` /
`htmlContent` via `update` (broken publish invariant); the same drift
on `setDefaultLanguage` / `removeTranslation` / `updateTranslation` /
`addTranslation` / `changeType` paths.

The module does *not* own: the i18n CRUD writes themselves (those stay
in `emailTemplates/i18n.ts` — they just gain the guard call), the
saved-block propagation algorithm (lives in
`lib/linkedBlockPropagation.ts`; the effect calls it), or the read
queries (`get`, `list`, `getForLanguage`, the by-organization read
queries, etc.).
_Avoid_: Template lifecycle (module) (the term "template" alone is
overloaded with the transactional table — both tables are colloquially
"templates"), Email template module (drops "lifecycle" — the module
owns *transitions*, not the entire row CRUD), Email template state
machine (names the value).

## Transactional sends

**Transactional email**:
A reusable email template stored in `transactionalEmails` with a
**Transactional email status** (`draft | published | pending_review`),
an `htmlContent` (pre-rendered HTML), optional `htmlTranslations`
(per-language pre-rendered HTML), an optional `dataVariablesSchema`
(typed variable contract), an optional `attachments` JSON blob
(per-template attachments merged into every send), and a `slug` for
stable lookup. The unit a transactional API call references —
`POST /api/v1/transactional` accepts either `transactionalId` or
`slug` plus a recipient `email` and resolves the template at intake
time. Disjoint from **Email template** — different table, different
state machine (3 states vs 2), publish-time content scan instead of
send-time. The transactional table's row is what the public API
references; the email-templates table feeds Campaigns.
_Avoid_: Transactional template (verbose; the row name is "transactional
email"), Template alone (collides with `emailTemplates` — a separate
broader templating table for marketing campaign sources, the
**Email template** row).

**Transactional send**:
One row in `transactionalSends` — the record of one **Transactional
email** dispatch against one recipient. Carries the Send-lifecycle
`status: 'queued' | 'sent' | 'failed' | 'delivered' | 'opened' |
'clicked' | 'bounced' | 'complained'`, the recipient `email`, the
resolved `language`, an optional `contactId` link, the rendered
`dataVariables`, a `correlationId`, and `attachmentStorageIds` for
the `attachment_cleanup` effect. Pre-created in `queued` by the
**Transactional send intake (module)** before the workpool runs;
transitioned through the Send lifecycle by **Send completion (module)**
and the **Webhook dispatcher**. The transactional half of the campaign
+ transactional `Send` union the Send lifecycle owns.
_Avoid_: Transactional dispatch (names the verb; the row is the send),
API send (collides with API-key terminology), Transactional record
(vague).

**Transactional send intake (module)**:
The module at `convex/transactional/dispatch.ts` that owns the intake
path for the public transactional send API — the path from an
API-accepted request to a `transactionalSends` row in `queued` with the
workpool job enqueued. Mirrors the **Form submission (module)** shape
— single intake mutation with a discriminated outcome — and the
**Contact import (module)** shape — single batch entry with a flat
reason union. Not a lifecycle in the **Outbound lifecycle** sense:
every successful intake lands directly in `queued`, and the Send
lifecycle owns every transition after.

Single entry point:
- `dispatch({ templateLookup, email, dataVariables?, language?,
  attachmentRefs? })` — internal mutation. `templateLookup` is a
  discriminated union `{ kind: 'id', id } | { kind: 'slug', slug }`;
  `attachmentRefs` carries already-resolved storage references
  `{ filename, contentType?, url, storageId? }`. Returns one of:
  - `{ ok: true, sendId, contactId, contactCreated, language,
    queued: true }`
  - `{ ok: false, reason: 'abuse_blocked' | 'recipient_blocked' |
    'template_not_found' | 'template_not_published' |
    'template_no_content' | 'domain_unverified' | 'invalid_variables',
    detail? }`.

The HTTP shell pre-validates input before calling `dispatch`:
JSON-shape validation (required fields, types, email format, language
format, attachment count + size limits, https-only URL check) and
attachment storage upload (base64 decode → `ctx.storage.store`, which
can only run in an `httpAction` context) live at the boundary. The
module's input is typed, well-formed data.

Per-call order of operations:
1. Abuse gate (`isSendingAllowed` on `instanceSettings.abuseStatus`)
   → `abuse_blocked`.
2. Blocklist (`blockedEmails.isBlockedInternal`) → `recipient_blocked`.
3. Template lookup (by `id` or `slug` via the `templateLookup`
   discriminator). Missing → `template_not_found`. Not published →
   `template_not_published`. No `htmlContent` → `template_no_content`.
4. Sender + domain resolution (`defaultFromEmail` →
   `domains.domains.getEmailDomainVerificationStatus`). Unverified →
   `domain_unverified`.
5. Validate `dataVariables` against
   `transactionalEmail.dataVariablesSchema` → `invalid_variables`.
6. **Contact resolution (module)** (`mode: 'upsert'`, `source:
   'transactional'`) — closes the previously open-coded contact upsert
   with race-retry `try/catch` hack at
   `transactionalApiHttp.ts:484-512`.
7. Language resolution (request → contact → template default → `'en'`).
   Pulls `htmlContent` + `subject` from `htmlTranslations[language]`
   when available; falls back to default otherwise.
8. Provider route resolution
   (`providerRoutes.getRoute({ messageType: 'transactional' })` +
   provider health → `resolveRoute`).
9. Template attachments + request attachments merge (template-side
   attachments JSON-parsed once at intake; pre-deepening this lived in
   the HTTP shell).
10. Insert `transactionalSends` row in `queued`. Writes `language` on
    the row (new field — closes the silent drift where resolved
    language was only on the API response, not persisted).
11. Increment BOTH counters atomically with the row insert:
    `instanceSettings.transactionalSendCount` and
    `emailsQueries.incrementDailySendCountInternal`. Today the daily
    counter is incremented from the HTTP shell *after* the enqueue;
    consolidating into the module closes the drift seam where any
    future non-HTTP shell would miss it.
12. Enqueue `transactionalEmailPool.enqueueAction` with
    `onComplete: emailOnComplete` and `sendRef: { kind: 'transactional',
    id: sendId }`.

One shell dispatches to this entry today:
- `convex/transactional/api.ts:sendTransactional` (the `httpAction`,
  renamed from `transactionalApiHttp.ts`). The shell shrinks from ~400
  lines of orchestration to ~80 lines: auth, CORS, JSON-shape
  validation, attachment storage upload, `dispatch()` call, response
  mapping (one `switch` on `reason` → status code + error code).

Replaces the open-coded intake in
`transactionalApiHttp.ts:sendTransactional:165-636` and the thin
`transactionalApi.ts:enqueueTransactionalEmail` internal mutation
(absorbed into `dispatch`). `transactionalApi.ts` is deleted outright.

Closes drift bugs:
- Open-coded contact upsert with race-retry `try/catch` hack at
  `transactionalApiHttp.ts:484-512`. The four other pre-ADR-0008 sites
  already migrated to **Contact resolution (module)**; the transactional
  path was missed (mirrors the form-path gap that ADR-0015 closed).
- Daily send counter incremented from the HTTP shell *after* the
  enqueue rather than atomically with the row insert. Any future
  non-HTTP shell (admin replay, batch transactional dispatch, SDK
  trigger) would silently skip the counter.
- `transactionalSends.create` (the pre-ADR-0006 mutation inserting
  directly in `sent`) — zero live callers (grep-confirmed). Deleted
  outright with this module.
- Resolved `language` only on the API response, not on the
  `transactionalSends` row. Analytics queries can't tell which
  language a send was delivered in.
- No isolatable surface for unit-testing intake classification.
  Today the only test path is end-to-end through `httpAction`.

The module does *not* own: HTTP plumbing (CORS, auth, JSON-shape
validation, attachment base64 decoding + `ctx.storage.store` — these
stay in the HTTP shell because they require action context and vary
per content-type); the `transactionalEmails` CRUD (stays in
`transactional/emails.ts`); the `transactionalEmails` translations
CRUD (stays in `transactional/translations.ts`); the
`transactionalSends` read queries (`listByTransactionalEmail`, `listAll`,
`get`, `getStatsByTransactionalEmail`, `getCountByTransactionalEmail`,
`getCounts`, `getByEmail`, `getByProviderMessageId` stay in
`transactional/sends.ts`); the worker dispatch and provider attempt
(**Send dispatch (helper)** + `emailWorker.sendSingleEmail`); the
`queued → sent | failed` transitions (**Send completion (module)**
translates the workpool callback into a **Send lifecycle (module)**
call); the bounce / complaint / open / click transitions (**Webhook
dispatcher** → **Send lifecycle (module)**); the `attachment_cleanup`
effect (Send lifecycle's effect list reads `attachmentStorageIds` off
the row).

The five existing top-level `transactional*.ts` files move under the
new `convex/transactional/` subdirectory:
`transactionalApiHttp.ts → transactional/api.ts`,
`transactionalApi.ts → DELETED` (absorbed into
`transactional/dispatch.ts`),
`transactionalSends.ts → transactional/sends.ts`,
`transactionalEmails.ts → transactional/emails.ts`,
`transactionalEmailsTranslations.ts → transactional/translations.ts`.
Mirrors the established subdirectory convention (`forms/`, `contacts/`,
`campaigns/`, `delivery/`, etc.) once an area has ≥3 files.
_Avoid_: Transactional dispatch (module) (collides with **Send dispatch
(helper)** — same verb at a different layer; the module's verb is
"intake", the helper's verb is "dispatch"), Transactional API (module)
(names the shell, not the module — the HTTP shell is the API surface;
this module sits behind it), Transactional send (module) (collides
with **Transactional send** the row), Transactional send orchestrator
(the orchestrator role is reserved for the **Campaign send
orchestrator** — that one composes multiple lifecycle calls; this
module is a single intake function).

**Transactional email status**:
The current state of a **Transactional email** at
`transactionalEmails.status`: `draft | published | pending_review`.
Legal edges:
- `(insert) → draft` (`create()`)
- `draft → published` (publish with clean content scan)
- `draft → pending_review` (publish with suspicious content scan;
  `htmlContent` and `htmlTranslations` are still patched onto the row,
  but the row is unreachable by the public send API — the
  **Transactional send intake (module)** refuses any row in this state
  with `'template_not_published'`)
- `pending_review → published` (admin approve — graph carries the
  edge; admin surface lands as follow-up, parallel to the **Campaign
  lifecycle (module)**'s `pending_review → sending` edge)
- `pending_review → draft` (admin reject — graph carries the edge;
  admin surface lands as follow-up)
- `published → draft` (`unpublish` — clears `publishedAt`)

Content scanning is *part of the transition decision*, not a side
effect — `scanContent(subject, htmlContent)` from
`@owlat/email-scanner` runs synchronously inside the `→ published`
reducer. The result determines the next state:
`clean → published`, `suspicious → pending_review`, `blocked → throw`.
The `contentScanResults` row write is emitted as a
`record_content_scan_result` effect by the **Transactional email
lifecycle (module)**.

Companion fields written atomically with the status by the
**Transactional email lifecycle (module)** reducer: `publishedAt`
(set on `→ published`, cleared on `→ draft`), `updatedAt` (every
transition).
_Avoid_: Transactional template status (uses the verbose form when
the noun "email" is already established), Transactional email state
(collides with the per-machine "state" suffix in Postbox outbound).

**Transactional email lifecycle (module)**:
The module at `convex/transactional/lifecycle.ts` that owns transitions
of `transactionalEmails.status` plus row creation, duplication, and
removal. Sibling of the **Email template lifecycle (module)** —
parallel shape, separate `LEGAL_EDGES` (3 states vs 2), distinct effect
list (adds content-scan effect). Same **Campaign lifecycle (module)**
skeleton — typed `TransitionInput`, `LEGAL_EDGES`, reducer, effects,
`TransitionOutcome`. Four entry points:
- `create({ name, slug, subject?, content?, dataVariablesSchema?,
  defaultLanguage? })` — validates slug format and uniqueness, inserts
  the row at `'draft'`, fires `audit_log`.
- `transition({ transactionalEmailId, input })` — `input` is the
  discriminated `to`-union including the admin kinds. Suspicious-scan
  publish lands in `pending_review`; the **Transactional send intake
  (module)** refuses any `transactionalEmails` row in that state with
  `'template_not_published'`.
- `duplicate({ sourceTransactionalEmailId })` — clones source fields,
  generates a unique slug via `-copy` / `-copy-N` suffix loop, inserts
  at `'draft'`. Calls `create` internally for the row write +
  audit-log effect.
- `remove({ transactionalEmailId })` — deletes the row, fires
  `audit_log`.

Effects:
- `audit_log` — fires on every transition plus `create`, `duplicate`,
  `remove`. New audit actions `transactional_email.created`,
  `.published`, `.flagged_for_review`, `.approved`, `.rejected`,
  `.unpublished`, `.duplicated`, `.deleted` land in
  `auditActions/catalog.ts`.
- `record_content_scan_result({ resourceId, score, level, flags })` —
  fires when the publish-reducer's scan returned non-clean. Owns the
  `contentScanResults` row insert that today lives inline at
  `transactional/emails.ts:307-315`.
- `update_block_usage_counts(prev, next)` — fires when `linkedBlockIds`
  changes. Delegates to the **Saved block (module)**'s
  `updateBlockUsageCounts` entry (parallel to the **Email template
  lifecycle (module)**). Also closes the open-coded direct call at
  `transactional/emails.ts:252` that bypassed the lifecycle effect
  path.

Publish invariant guard:
The module exports `assertEditableForPublishableChange(email, force?:
boolean)` — same shape as the Email template lifecycle's guard.
Consumed by every mutation in `transactional/` that touches publishable
content (`update` today; the i18n mutations once they split out from
`transactional/emails.ts`).

Producers of transition calls today (post-deepening):
- `transactional/emails.ts:publish` (`→ published` | `→ pending_review`)
- `transactional/emails.ts:unpublish` (`→ draft`)
- `transactional/emails.ts:create` delegates to `lifecycle.create`
- `transactional/emails.ts:duplicate` delegates to
  `lifecycle.duplicate`
- `transactional/emails.ts:remove` delegates to `lifecycle.remove`
- (Future) the admin approve/reject surface (`pending_review →
  published`, `pending_review → draft`) lands as a follow-up — the
  legal-edges graph ships with the edges in place so the surface plugs
  in without re-litigating the graph.

Replaces the open-coded status writes at `transactional/emails.ts:327`
(suspicious-scan publish), `:337` (clean publish), `:364` (unpublish),
the open-coded create at `:158`, the open-coded duplicate at `:406`,
and the open-coded delete at `:438`. Absorbs the inline content-scan
branch at `:304-335` into the reducer's `to: 'published'` kind.

Closes drift bugs: zero audit-log coverage on any status change
(every other lifecycle has it); silent edits to published
transactional emails' content via `update` (broken publish
invariant); the dead-end `pending_review` state (today nothing
transitions out of it — the legal-edges graph documents the admin
surface ahead of implementation); the inline `contentScanResults`
write (lives in one effect now, gates a future "re-scan on update"
addition).

The module does *not* own: the public HTTP intake (**Transactional
send intake (module)** at `transactional/dispatch.ts`), the per-send
worker dispatch (**Send dispatch (helper)**), the translation CRUD
(stays in `transactional/translations.ts`), the per-template
attachment management, the `updateSchema` mutation, or the read
queries (`get`, `getBySlug`, `list`, `countByStatus`,
`getStatsByTransactionalEmail`, etc. — all stay in their respective
read-side files).
_Avoid_: Transactional template lifecycle (overloaded — the row is
called "transactional email" in this codebase), Transactional email
module (drops "lifecycle" — the module owns *transitions*, not the
entire row CRUD), Transactional email state machine (names the
value).

## Email editor

**Email editor bridge (module)**:
The app-side owner (an `apps/web` composable) that backs the `EmailBuilder`
component against Convex and runs its edit loop. It produces the
`EmailBuilderHandlers` the builder injects — the `uploadImage` pipeline
(`generateUploadUrl` → upload → `storage.getUrl` → measure dimensions →
`mediaAssets.create`, including its always-register-to-the-media-library
side effect), the `savedBlocks` fetch/save bridge, and the media-picker
plumbing — and owns the generic load→dirty→unsaved-changes loop
(`blocks`/`subject`/`name`, `isInitialized`, change-tracking, `isSaving`,
`hasChanges`, the `UnsavedChangesDialog` wiring). The three editor surfaces
— the **Email template** editor, the **Transactional email** editor, and
the **Saved block** editor — supply only their divergent halves: a
per-surface `initialize(source)` parse and `save()` serialize, plus an
`extraWatch` list for surface-specific dirty-tracked refs (`attachments`,
`description`). The bridge never branches on which surface it serves — the
divergence lives in page-owned closures, not in bridge config. It lives in
`apps/web` because the handlers depend on the generated `@owlat/api`, which
`packages/email-builder` cannot import; the `EmailBuilderHandlers` contract
itself stays package-side.
_Avoid_: Email editor host ("host" reads as deployment infrastructure —
the same reason **Saved block consumer** avoids it), Email editor
controller (generic), Email builder backend (collides with `apps/api` as
"the backend").

**Publishable-email save**:
The app-side helper shared by the **Email template** editor and the
**Transactional email** editor — the two surfaces whose `save()` renders
HTML, builds translations (`buildHtmlTranslationsForEmail`), derives
`linkedBlockIds`, and writes a publishable lifecycle. Kept *out* of the
**Email editor bridge** so the bridge stays envelope-agnostic: the **Saved
block** editor renders nothing and writes its own `{ blocks: [...] }`
envelope, so it shares the bridge but not this helper.
_Avoid_: Email save (vague), Render-and-save (names the steps, not the
shared concept).

## Outbound lifecycle

**Outbound lifecycle**:
The shared *shape* used by every module that owns transitions of a thing
dispatched to the MTA. Components: a typed `TransitionInput` discriminated by
`to`, a `LEGAL_EDGES` graph mapping current state → set of legal next states,
a private reducer per transition kind returning `{ patch, effects, applied }`,
and a `TransitionOutcome` reporting `ok | reason` for duplicate / illegal /
terminal / kind-mismatched attempts. Two instances today: **Send lifecycle**
(campaign + transactional `Send`) and **Postbox outbound lifecycle**
(`mailMessages.outbound`). Both expose `transition` and a webhook-friendly
`transitionByProviderMessageId`. Replicated by convention, not by a generic
`Lifecycle<S, E, Eff>` factor — when a third instance lands and the duplication
bites, that's when the factor lands.
_Avoid_: State machine (generic; doesn't signal the dispatched-to-MTA
boundary), Lifecycle alone (every CRUD module has one).

**Send**:
A single addressed message dispatch tracked in `emailSends` (campaign) or
`transactionalSends` (transactional). Each row carries a `status` that
progresses through the lifecycle state graph. One instance of Outbound
lifecycle. Postbox personal-mail dispatches (`mailMessages`) are *not* Sends —
they have their own Postbox outbound lifecycle. The two share the shape,
not the table.
_Avoid_: Email send (overloaded with the verb), Delivery (Resend's term),
Dispatch.

**SendRef**:
The discriminated foreign key into the right Send table:
`{ kind: 'campaign'; id: Id<'emailSends'> } | { kind: 'transactional'; id: Id<'transactionalSends'> }`.
The Send lifecycle module operates on a SendRef so the same transitions cover
both kinds — only the kind-specific side effects (campaign stats,
instance-default-from lookup, activity-log shape) branch on `kind` internally.
SendRef does *not* extend to Postbox: a `mailMessage` is identified by its
own `Id<'mailMessages'>`, not by SendRef.

**Send status**:
The current state of a Send:
`queued | sent | failed | delivered | opened | clicked | bounced | complained`.
Legal edges:
- `queued → sent` (worker accepted by provider)
- `queued → failed` (worker errored; `errorCode` records why)
- `sent → delivered` (provider webhook confirms acceptance)
- `sent → bounced` / `delivered → bounced` (async hard or soft bounce)
- `delivered → opened` (open pixel; subsequent opens increment `openCount`
  without re-transitioning)
- `delivered → clicked` / `opened → clicked` (click tracker)
- `sent → complained` / `delivered → complained` / `opened → complained` /
  `clicked → complained` (FBL — can hit at any post-send stage)
- `bounced(soft) → bounced(hard)` (a soft bounce later hardens — the row is
  re-stamped with `bounceType: 'hard'`) and `bounced(soft) → complained`
  (a soft-bounced address later complains)

`complained` is terminal. `bounced` is terminal ONLY when the recorded bounce
is HARD (`bounceType: 'hard'`) — a permanent failure. A SOFT bounce (RFC 3463
4.x.x transient, e.g. 5.2.2 mailbox-full) also lands in `bounced` but is
NON-terminal: the same Send may later harden (`bounced(soft) → bounced(hard)`,
which overwrites `bounceType`) or draw a complaint (`bounced(soft) →
complained`); a repeat soft bounce on the same Send is a `recorded`/`duplicate`
no-op. `complained → bounced` and a later bounce off a hard-bounced row are
refused / no-ops.

A SOFT bounce is not on its own a reason to suppress (the address may recover),
but a chronically-4xx recipient is escalated to the blocklist after
`SOFT_BOUNCE_SUPPRESSION_THRESHOLD` (5) soft bounces. The count is tracked
per-recipient on `contacts.softBounceCount` (so it accumulates across the
recipient's whole send history) and reset to 0 on the next `delivered`. This is
the standard ESP "suppress-after-N-soft" practice.

`bounceType: 'hard' | 'soft'` is the canonical encoding of bounce class.
`errorCode` is reserved for the `failed` state (worker-side classification:
`WORKPOOL_FAILED`, `PROVIDER_REJECTED`, etc.) and is not written on
`bounced` rows.

**Send lifecycle (module)**:
The module at `convex/delivery/sendLifecycle.ts` that owns the transitions
above. Each transition is one mutation that patches the Send row and fires
a typed effect list — atomic with the patch. The current effects are:
`blocklist_insert`, `contact_activity` (`email_sent` on `sent`, `email_bounced`
on `bounced`, `email_complained` on `complained`), `campaign_stats_sent` /
`campaign_stats_failed` / `campaign_stats_opened` / `campaign_stats_clicked`
/ `campaign_stats_bounced`, `content_scan_complaint`, `reputation_update`,
`attachment_cleanup` (drops the `transactionalSends.attachmentStorageIds`
blobs on terminal worker outcomes), and `customer_webhook` (routes through
`webhooks/scheduleFanout` to the Webhook event registry). Replaces the
low-level `mark*` mutations in `emailSends.ts` / `transactionalSends.ts`
and the open-coded `processBounceEvent` / `processComplaintEvent` in
`resendWebhook.ts`. Three producers of transition calls today: the **Webhook
dispatcher** for external events, the **Send completion (module)** for
workpool completions, and direct callers (the open / click trackers).
_Avoid_: Send state (names the value, not the machine).

**Send reads (module)**:
The module at `convex/delivery/sendReads.ts` that owns the Send-spanning
read queries — the ones that don't care which parent the Send hangs off:
`getSend(ref)`, `getSendByProviderMessageId(id)`, `getStatsForSend(ref)`,
`listSendsForContact(contactId)`. Sibling of the Send lifecycle module
(reads vs writes), keyed by SendRef. Closes two drift bugs: hard/soft
bounce classification is now computed in one place for both kinds, and
"every email this contact has received" stops being campaign-only.
Parent-centric queries (`listByCampaign`, `listByTransactionalEmail`,
`listAll`, `getOpensTimeline`, `getOpenedContacts`, `getClickedContacts`,
`getCounts`) stay in `emailSends.ts` / `transactionalSends.ts` — their
parent type is genuinely table-specific.
_Avoid_: Send queries (vague; doesn't signal Send-spanning).

**Send completion (module)**:
The module at `convex/delivery/sendCompletion.ts` that owns the workpool
completion handler — the path from "worker finished a dispatch attempt"
to a Send lifecycle transition. Receives `{result, error, sendRef}` from
the workpool's `onComplete` callback (both campaign and transactional
sends carry a typed `sendRef: SendRef` because both pre-create their row
in `queued` — see **Send status** below). Builds the matching
`TransitionInput` (`{to: 'sent', providerMessageId, providerType}` on
success, `{to: 'failed', errorMessage, errorCode}` on error), calls
`sendLifecycle.transition`. Provider health for failover routing is
*not* recorded here — it's the **Send dispatch (helper)**'s job,
upstream of this module, so every send path records uniformly (test
sends and automation-step sends did not flow through Send completion
pre-deepening and were silently missing from `providerHealth`). The
"worker-attempt vs. lifecycle-state" split that justified isolating
health from the Send lifecycle still holds; the recording site just
moved one layer upstream, from this module to the dispatch helper that
all six send producers now route through. Webhook-triggered Send
lifecycle transitions report recipient outcomes (bounce / complaint)
and have no `latencyMs`, so they remain disjoint from health.
Symmetric to the **Webhook dispatcher** for inbound events: the
dispatcher translates `InboundEvent` → SendRef + transition; Send
completion translates a workpool result → SendRef + transition. The
only caller is the workpool callback registered in
`lib/emailWorkpool.ts`. Replaces the open-coded `onEmailComplete` in
`emailWorkerMutations.ts` (and the per-kind branching, the
`transactionalSends.createInternal` create-on-success path, and the
inline `recordEmailSendResult`, contact-activity, and attachment-cleanup
calls that lived there pre-deepening).
_Avoid_: Send dispatcher (collides with **Webhook dispatcher**),
Send callback (names the mechanism, not the role), Workpool completion
(couples the name to one implementation).

**Send composition (module)**:
The module family at `convex/delivery/sendComposition/` that owns the
path from "template + recipient signal" to "wire-ready subject + html +
headers + attachment refs + transform config". Sits upstream of the
**Send dispatch (helper)** in the send pipeline. Mirrors the **Block
module** family shape with a V8/Node physical split: the composer half
is V8-pure (variable substitution + envelope assembly), the HTML
transformation half runs in Node (cheerio). Discriminated by `kind:
'campaign' | 'transactional' | 'test' | 'archive_snapshot' |
'automation'`, one composer per kind in its own folder, dispatched by
the registry at `sendComposition/index.ts` exporting `composerFor(kind)`.

Two V8 entry points (registry-dispatched):
- `personalizeSubject({ kind, template, contactInfo? }) → string` —
  cheap subject-only personalization. Used by the campaign orchestrator
  to write `emailSends.personalizedSubject` (SNAPSHOT field per
  CONVENTIONS.md) at enqueue time without composing the full envelope.
- `composeForSend({ kind, ... }) → { subject, html, headers,
  attachmentRefs, transformConfig }` — full composition. Used by the
  worker (`emailWorker.sendSingleEmail`) and by the synchronous
  test-send paths in `emailsSending.ts`. `transformConfig` is the
  fully-resolved set of inputs the Node transform half needs
  (tracking pixel URL, click-tracking base, footer URLs, view-in-browser
  URL, list-unsubscribe header pair) — all as ready-to-apply strings,
  not toggles, so the transform half has no policy decisions.

One Node entry point:
- `transformHtml(html, transformConfig) → string` at
  `sendComposition/transform.ts` (`'use node'`). Single cheerio pass
  performing view-in-browser injection, footer injection, link
  wrapping, and tracking-pixel injection in the order that lets footer
  links be tracked. Called by the worker after `composeForSend`.

Per-kind composer module exports a `SendComposerModule<K>` with the
typed `Input<K>` shape and the per-kind `compose` function. The four
kinds and their policies:
- `campaign` — variable substitution against contact fields; tracking
  pixel + click tracking; footer (unsubscribe + preference) only when
  `audienceType !== 'segment'`; List-Unsubscribe header pair only for
  topic campaigns; view-in-browser link when archive is enabled. The
  one composer that emits a non-empty `transformConfig`.
- `transactional` — variable substitution against `dataVariables` (not
  contact fields); merged template + request attachments; **no
  tracking, no footer, no list-unsubscribe header** — policy declared
  by the composer returning an empty `transformConfig`.
- `test` — variable substitution against a sample/test contact;
  `[TEST]` subject prefix when applicable; no tracking, no footer
  (sync dispatch path; never enters the workpool).
- `archive_snapshot` — variable substitution against the canonical
  placeholder contact (`{ email: '', firstName: '', lastName: '' }`)
  baked into this composer; subject not personalized (passes through
  raw); no transform config. Produces the html written to
  `campaignArchives.archiveHtmlContent`.
- `automation` — variable substitution against contact fields (same
  shape as `campaign`); subject + html personalized; no tracking
  pixel, no footer, no list-unsubscribe header (matching today's
  automation email step behaviour). Used by the synchronous
  `automations/steps/email/index.ts` dispatch path that bypasses the
  workpool. The policy is declared by this composer returning an empty
  `transformConfig`; if automation emails ever gain unsubscribe links,
  the change lives here.

Shared V8 leaves under the module:
- `sendComposition/personalization.ts` — the single canonical
  `replaceVariables(content, variables, { escape: 'html' | 'plain' })`.
  Replaces the three pre-deepening implementations at
  `lib/emailHelpers.ts:59`, `automations/steps/shared/personalize.ts:6`,
  and `emailWorker.ts:152`. Escape policy is now an explicit argument
  declared by each per-kind composer (campaign html → `'html'`,
  campaign subject → `'plain'`, etc.), not a function-identity choice
  hidden in which import each caller picked.
- `sendComposition/trackingUrl.ts` — V8-pure
  `getTrackingPixelUrl(base, emailSendId)` and
  `getTrackedLinkUrl(base, emailSendId, originalUrl)` using `btoa` +
  `TextEncoder` (works in both Convex V8 and Node). Replaces the two
  pre-deepening implementations at `delivery/tracking.ts:41-54`
  (V8 / `stringToBase64Url`) and `emailWorker.ts:27-38` (Node /
  `Buffer.from(...).toString('base64url')`). One test surface locks
  the URL format. The Node transform half imports from this leaf;
  `delivery/trackingHttp.ts` (which decodes URLs at click-handler
  time) does too.

Replaces the open-coded blocks in:
- `emailWorker.ts:152-163` (`replaceVariables` with inline
  `escapeHtml`), `:222-258` (the `if (args.type === 'campaign')`
  branch that inlines personalize + build transform options + apply
  transform), `:63-139` (the `transformEmailHtml` function itself —
  moves to `sendComposition/transform.ts`), `:278-284` (the
  List-Unsubscribe header build inline), and the call sites at
  `:225-275` that personalize subject + html per type.
- `emails.ts:309` (archive snapshot's open-coded
  `replaceVariables(template.htmlContent, { email:'', firstName:'',
  lastName:'' })`) and `:562` (the enqueue-time SNAPSHOT subject
  personalization that today re-runs personalization the worker will
  re-run again at send).
- `emailsSending.ts:86-87, 185-186` (test-send personalization that
  bypasses the worker entirely).
- `automations/steps/email/index.ts:92-93` (automation email step's
  inline personalize-then-enqueue).

Closes drift bugs:
- The three `replaceVariables` implementations diverge on HTML
  escaping (worker variant escapes via inline `escapeHtml`,
  `lib/emailHelpers` and `automations/steps/shared/personalize` do
  not), with the escape policy hidden in which import each caller
  picked. Under the module: one implementation, explicit `escape`
  argument per per-kind composer.
- The two `getTrackingPixelUrl`/`getTrackedLinkUrl` implementations
  (Web API + Node Buffer) MUST produce identical wire output for
  tracking to work, but no test enforces the contract today. Under
  the module: one V8-pure implementation usable from both runtimes,
  one test surface locking the format.
- The duplicate subject personalization between `emails.ts:562`
  (writes the SNAPSHOT `emailSends.personalizedSubject` using
  `lib/emailHelpers.replaceVariables` — no escape) and
  `emailWorker.ts:268` (puts subject on the wire using
  `emailWorker.replaceVariables` — escapes) can produce different
  output today. Under the module: the orchestrator calls
  `personalizeSubject()`, the worker's `composeForSend()` reuses
  the same internal personalization — the SNAPSHOT and the wire
  subject are guaranteed equal by construction.
- The `if (args.type === 'campaign')` policy gates inside the worker
  silently encode which transformations apply per kind. Under the
  module: each per-kind composer declares its `transformConfig`
  explicitly; transactional / test / archive_snapshot returning an
  empty `transformConfig` is the visible policy.
- The placeholder-contact magic string `{ email:'', firstName:'',
  lastName:'' }` for archive snapshots lives at one call site
  (`emails.ts:309`) and risks divergence if a second archive path
  ships. Under the module: the placeholder lives once inside
  `archive_snapshot/index.ts`.

The module does *not* own: attachment fetch + file-type validation +
ClamAV scan (stays in the worker — `composeForSend` returns
`AttachmentRef[]` carrying storage URLs and filenames, the worker
fetches/validates/scans at send time because the IO + Node-only scan
client are not part of composition), provider routing (**Send route
strategy (module)**), provider dispatch (**Send dispatch (helper)**),
`emailSends` / `transactionalSends` row writes (the orchestrator and
transactional intake own those — the module is consumed by them, not
the other way around), or the HTTP-side decode of tracked URLs
(`delivery/trackingHttp.ts` keeps its decode logic — it imports the
same V8 URL helper from `sendComposition/trackingUrl.ts` so the encode
and decode are locked to one format).
_Avoid_: Send envelope (module) (collides with the RFC 5322 envelope
at `mail/outbound.ts:287`, the HTTP response envelope at
`lib/httpResponse.ts`, and the webhook payload envelope at
`docs/webhook-payloads.md` — three established uses in this codebase),
Send payload (module) (collides with `webhookDeliveryLogs.payloadVersion`
and the X-Signature-signed payload in `docs/webhook-payloads.md`),
Send message (module) (collides with the `unifiedMessages` /
`mailMessages` / `chatMessages` row-name family — every other
inbound/outbound row uses "message"), Send body (module) (misleading
— the module composes subject and headers too, not just body),
Personalization (module) (covers only one leaf — variable
substitution — under this module), Email composition (module) (drops
the **Send** family prefix that the rest of the pipeline uses).

**Postbox outbound state**:
The dispatch state of a personal-mail message, tracked at two
granularities.

Per-recipient state on each entry in `mailMessages.outbound.recipients[]`:
`queued | sent | bounced | failed`. Legal edges:
- `queued → sent` (MTA webhook accepts)
- `queued → bounced` (synchronous bounce from MTA POST 5xx)
- `queued → failed` (pre-MTA error: attachment scan failure, dispatcher
  exception, network error before MTA accepted the request)
- `sent → bounced` (async bounce after MTA acceptance)

`bounced` and `failed` are terminal at the per-recipient level. Each
recipient transitions independently; there is no row-wide downgrade
guard.

Aggregate state denormalized at `mailMessages.outbound.state`:
`queued | sent | bounced | failed | partial`. Derived by the
**Postbox outbound lifecycle (module)** from the per-recipient array
after every transition:
- All recipients `queued` → `queued`
- All `sent` → `sent`
- All `bounced` → `bounced`
- All `failed` → `failed`
- Any other mix (e.g. `sent` + `bounced`) → `partial`

`partial` is the only literal that exists on the aggregate but not
on a recipient.

A `recipients[]` entry is keyed by `idx` (the 0-based position in the
deduplicated `To + Cc + Bcc` list at dispatch time). The `address`
field on each entry is metadata; the same address can appear at
multiple `idx`es. The `mtaJobId` is `pb-<mailMessageId>-<idx>`,
deterministic at row-insert time.

Postbox does *not* track `delivered / opened / clicked / complained` —
personal mail has no campaign-style analytics surface. The `sending`
and `pending` literals that previously appeared in the schema are
unused (no writer ever set them) and are dropped in the breaking-changes
pass alongside the schema migration to `outbound.recipients[]`.
_Avoid_: Mail state (overloaded), Outbound state (collides with
generic "outbound"), Postbox aggregate state (the aggregate is one
projection of Postbox outbound state, not a separate concept).

**Postbox outbound lifecycle (module)**:
The module at `convex/mail/postboxOutboundLifecycle.ts` that owns
transitions of every `mailMessages.outbound.recipients[].state` and
derives the aggregate `mailMessages.outbound.state` from the recipient
array after every transition. First lifecycle in the codebase where the
unit of transition is a *slice* of a row (one recipient) rather than
the row itself.

A second instance of **Outbound lifecycle** — same shape as Send
lifecycle (legal-edges graph, typed `TransitionInput`, reducer, effects
list) — distinct because Postbox transitions a recipient slice, the
effect set is intentionally smaller, and the aggregate state is
read-only (no caller writes it). Two entry points:
- `transition({ mailMessageId, recipientIdx, input })` — direct path,
  per-recipient. Used by `mail/outbound.ts:dispatchDraft` inside the
  MTA POST loop for synchronous failures: 5xx response maps to
  `to: 'bounced'`, network error maps to `to: 'failed'`, per recipient.
- `transitionByMtaMessageId({ rawProviderMessageId, input })` —
  external-key path; takes the raw `pb-<mailMessageId>-<idx>` string,
  parses both ids internally, and transitions the matching recipient.
  Used by the **Webhook dispatcher** for MTA webhook events. The `pb-`
  prefix parser (currently `mail/outboundState.ts:parsePostboxMtaId`)
  moves into this module.

Effects:
- `audit_log(action, mailMessageId, mailboxId, recipientIdx, ...)` —
  fires on every transition. One audit row per recipient transition.
  The aggregate-state change (if any) is recorded in the action details.

Per-mailbox UI notification on bounce and per-domain reputation update
on send/bounce are *deferred to follow-up ADRs*. Both require
infrastructure that doesn't exist today: there is no notification
surface in `apps/api/convex/`, and the existing reputation tracking
(`analytics/sendingReputation.ts`) is org-level, not per-domain.
Coupling the lifecycle to introducing a new surface inflates the
deepening. The lifecycle ships with `audit_log` only; the two named
effects land in short follow-up PRs once their surfaces exist.

Postbox explicitly does *not* fire: campaign stats, contact activity
logs, content-scan feedback, or org blocklist insert. A misdelivered
personal email must not blocklist that address from the entire org.

Replaces `mail/outboundState.ts` (the ad-hoc `markSent` / `markBounced`
pair). Breaking change: the **Webhook dispatcher** updates to the new
external-key entry point, and `mail/outbound.ts:dispatchDraft` adds
per-recipient transitions on synchronous MTA POST failures (today
silently logged at `outbound.ts:454-460`). The schema gains
`mailMessages.outbound.recipients[]` (a one-shot pre-prod migration
backfills existing rows from `outbound.{state, mtaJobId, sentAt,
bounceMessage}` into a single-recipient array, then the legacy
top-level fields are removed and `outbound.state` becomes the
derived aggregate).

`mail/outboundQueries.ts:markDispatchFailed` is *not* replaced by this
module — it writes `mailDrafts.state` (reverts a draft to `'draft'` on
ClamAV malware verdict, before any `mailMessages` row exists). The
**Mail draft lifecycle (module)** owns that write under its
`to: 'draft', reason: 'scan_blocked'` transition; this module's scope
begins at the `mailMessages` row insert that fires from the draft
lifecycle's `to: 'sent'` `insert_mail_message` effect.
_Avoid_: Mail lifecycle (covers IMAP + folders + threads, not the
outbound state specifically), Outbound state machine (names the value).

**Mail draft state**:
The dispatch state of a personal-mail compose row in
`mailDrafts.state`: `draft | pending_send | scheduled`. Three literals,
no terminal `sent` literal — successful dispatch *deletes* the draft
row and inserts a `mailMessages` row in `outbound.state: 'queued'`
where the **Postbox outbound lifecycle (module)** takes over. Legal
edges:
- `(insert) → draft` (compose-new or reply-to)
- `draft → pending_send` (user clicked send, undo-window enabled)
- `draft → scheduled` (user picked a future `scheduledSendAt`)
- `pending_send → draft` (revert — discriminated by `reason`)
- `scheduled → draft` (revert — same reason union)
- `pending_send → (deleted)` (successful dispatch — see effects below)
- `scheduled → (deleted)` (successful dispatch — same)

The revert reasons are a closed union:
`user_cancel | from_revoked | scan_blocked`. `user_cancel` is the
undo-send button (and the cancel-while-scheduled action).
`from_revoked` fires when the dispatch action's from-address binding
check finds the draft's `fromAddress` is no longer in the mailbox's
allowed-from set. `scan_blocked` fires when ClamAV returns a malware
verdict on an attachment.

`pending_send` and `scheduled` differ only in *when* the dispatch
runs: `pending_send` schedules the dispatch action at
`now + undoSendDelayMs` (default 30s), `scheduled` schedules it at the
user-chosen `scheduledSendAt`. Both carry an `undoToken` so the
cancel-by-token path can lock onto the right row without trusting the
client's draftId. Both clear `scheduledSendAt` and `undoToken` on
revert.

Companion fields written atomically with the state by the **Mail
draft lifecycle (module)** reducer: `scheduledSendAt` (set on
`→ pending_send` / `→ scheduled`, cleared on revert), `undoToken`
(set on send-initiate, cleared on revert), `lastEditedAt` (every
transition).
_Avoid_: Draft state (overloaded with `mailMessages.outbound.state`),
Compose state (UI term, not row-state), Mail state (vague).

**Mail draft lifecycle (module)**:
The module at `convex/mail/draftLifecycle.ts` that owns transitions of
`mailDrafts.state` plus row creation and the terminal "send-success
delete + write the mailMessages row" composite. Mirrors the
**Outbound lifecycle** shape — typed `TransitionInput` discriminated
by `to`, a `LEGAL_EDGES` graph (above), a private reducer per kind
returning `{ patch, effects, applied }`, and a `TransitionOutcome`
reporting `ok | reason` for illegal / kind-mismatched attempts. Three
entry points:
- `create({ mailboxId, inReplyToMessageId? })` — inserts at `'draft'`
  with the reply-derived `toAddresses` / `subject` / `threadId`
  populated. Single mutation behind the public `drafts.create` shell.
- `transition({ draftId, input })` — direct path. Used by the
  `send` mutation (`→ pending_send` / `→ scheduled`), the dispatch
  action (`→ sent` on success, `→ draft, reason: 'from_revoked'`
  when the claim-time from-address check fails, `→ draft,
  reason: 'scan_blocked'` on ClamAV malware verdict), and the
  cron rearm path for overdue scheduled drafts.
- `transitionByUndoToken({ undoToken, input })` — external-key
  path. Sole consumer: the public `drafts.cancelPendingSend`
  mutation, which only knows the token. Mirrors the **Send
  lifecycle (module)**'s `transitionByProviderMessageId` and the
  **Postbox outbound lifecycle (module)**'s
  `transitionByMtaMessageId`. Refuses any input whose `to` is not
  `'draft'` with `reason: 'user_cancel'` — the external-key path
  is single-purpose by design.

Effects per kind:

`→ pending_send` / `→ scheduled`:
- `schedule_dispatch_action({ draftId, undoToken, sendAt })` —
  schedules `internal.mail.outbound.dispatchDraft`. Single producer
  of the scheduler hop; the cron at
  `mail/outboundCron.dispatchOverdueDrafts` re-arms missed runs.
- `audit_log('postbox_draft.send_initiated', mailboxId, draftId,
  { sendAt, undoSendDelayMs })`. One literal for both kinds; the
  `details.sendAt` discriminates.

`→ draft` (revert):
- `audit_log` — picks the literal from `reason`:
  `'postbox_draft.cancelled'` for `user_cancel`,
  `'postbox_draft.from_revoked'` for `from_revoked`,
  `'postbox_draft.scan_blocked'` for `scan_blocked`. Three new
  audit-action literals added to `auditActions/catalog.ts`. The
  previously-scheduled dispatch hop becomes a no-op when it runs —
  the claim check sees `state === 'draft'` and exits.

`→ sent` (terminal, deletes the draft row):
- `insert_mail_message({ draftRow, sentFolderId })` — writes the
  new `mailMessages` row in `outbound.state: 'queued'` with the
  deduplicated `recipients[]` array. The Postbox outbound lifecycle
  picks up from here.
- `patch_sent_folder({ folderId, uidNext, modseq, totalCount })` —
  bumps Sent folder accounting.
- `patch_thread({ threadId, ... })` — updates `messageCount`,
  `lastMessageAt`, `latestSnippet`, `latestFromAddress`,
  `latestSubject`, `folderRoles`, `hasAttachments`.
- `patch_in_reply_to_flag({ messageId, flagAnswered: true })` —
  conditional on `inReplyToMessageId` being set.
- `patch_mailbox_bytes({ mailboxId, deltaBytes })` — increments
  `usedBytes` by the rfc822 size.
- `delete_attachment_storage({ storageIds })` — frees the draft's
  attachment storage blobs. **Closes the silent storage leak**:
  pre-deepening, `discard` deletes the blobs but the send-success
  path does not, because `mailMessages.attachments` has no
  `storageId` field. The blobs orphan.
- `delete_draft_row({ draftId })` — terminal. The row is gone after
  this effect.
- `audit_log('postbox_draft.sent', mailboxId, draftId,
  { messageId, recipientCount })`.

Invariants:
- The reducer for `→ sent` re-runs the from-address binding check
  inside the reducer (not as an effect) — if the address is no
  longer allowed, the kind is rejected with `outcome: { ok: false,
  reason: 'from_revoked' }` and the caller (the dispatch action)
  must instead call `transition({ to: 'draft', reason:
  'from_revoked' })` explicitly. The reducer never silently
  downgrades a transition kind.
- `transitionByUndoToken` skips entries whose `state` is `'draft'`
  with `outcome: { ok: false, reason: 'already_draft' }` —
  idempotent on double-click of the undo button.
- The `audit_log` effect is the only post-`→ sent` write that does
  not touch a table the draft row pointed to. All other terminal
  effects close out the draft's footprint (storage, mailbox bytes,
  thread, in-reply-to, draft row).

Replaces the open-coded `state !== 'X'` guards in `mail/drafts.ts`
(six call sites), the inline `db.patch` revert at
`outboundQueries.ts:60-67` (`claimForDispatch` from-address rejection),
the open-coded revert at `outboundQueries.ts:93-98`
(`markDispatchFailed`), the inline scheduler hop at
`drafts.ts:277-281` (`send`), the inline cancel patch at
`drafts.ts:305-310` (`cancelPendingSend`), and the multi-table dance
in `outboundQueries.ts:writeSentMessage:129-282` (becomes the
`→ sent` reducer's effect list). The dead `markDispatching`
internalMutation at `drafts.ts:322-332` (zero callers; despite the
name it sets `state: 'draft'`) is deleted outright.

Closes drift bugs:
- Silent attachment-storage leak on send-success (closed by
  `delete_attachment_storage` effect). Pre-deepening, `discard`
  frees the blobs but the happy path orphans them.
- Zero audit-log coverage on any Mail-draft transition.
  Personal-mail sending becomes auditable for the first time —
  matches every other lifecycle module that has it.
- The misleading "Atomic claim: transition pending_send/scheduled
  → dispatching" comment at `outboundQueries.ts:40` (the
  implementation never wrote `'dispatching'`; the comment was
  fiction). The deepening removes the comment and the dead
  `markDispatching` together.
- The inline `db.patch` reverts in `claimForDispatch` and
  `markDispatchFailed` become typed `transition` calls,
  surfacing the revert reason in audit logs.
- The `claimForDispatch` shell becomes the dispatch action's call
  to `transition({ to: 'sent' })` — succeeds if and only if the
  from-address binding is still valid; the reducer's invariant
  check replaces the inline branch.

The module does *not* own: the rfc822 serialization (lives in the
`'use node'` dispatch action — `internal.mail.outbound.dispatchDraft`);
the MTA POST itself (same place); attachment ClamAV scanning (lives
in the dispatch action, runs *before* the `→ sent` transition; on
malware verdict the action calls `transition({ to: 'draft',
reason: 'scan_blocked' })` and returns); the Postbox outbound
lifecycle transitions (sibling lifecycle on the new `mailMessages`
row); the `discard` mutation (still owned by `drafts.ts` — discard
is not a transition because it deletes a `draft`-state row, not
because it moves the state machine); the `update` / `setIdentity` /
`addAttachment` / `removeAttachment` mutations (still owned by
`drafts.ts` — they're field edits, not state changes, and the
`state !== 'draft'` guard inside each becomes a call to the module's
exported `assertStateIs(draft, 'draft')` helper); or the read queries
(`get`, `listForMailbox` stay where they are).
_Avoid_: Draft lifecycle (module) (collides with the
**Email template lifecycle (module)** which also handles a `'draft'`
state — naming the per-row state literal doesn't name the row),
Postbox draft lifecycle (module) (verbose; the file path
`mail/draftLifecycle.ts` matches the established
`postboxOutboundLifecycle.ts` neighbor and the module's name in
prose is "Mail draft lifecycle"), Compose lifecycle (module) (UI
verb, not the row noun), Mail draft state machine (names the value,
not the module).

## Send providers

**Send provider adapter (module)**:
The per-provider module at `convex/lib/sendProviders/<kind>/index.ts` that
owns the Send-side surface of one email provider. Four core adapters today:
`mta`, `ses`, `resend`, `smtp`. Core kinds are discriminated by those literals;
bundled plugin kinds use `plugin.<pluginId>.<localId>`.
Dispatched by the registry at `sendProviders/index.ts` exporting
`providerFor(kind)`. Mirrors the **Sending domain provider adapter
(module)** shape — one TypeScript interface, N concrete implementations,
registry-driven dispatch with a compile-time `satisfies` check. Disjoint
from that adapter — different surface (sending an email vs. registering
a domain), different runtime (`'use node'` action vs. mutation),
different provider set (Resend ships only on this side). Exports a
`SendProviderModule<K>` with:
- `kind: K` — the discriminator.
- `retryDelays: number[]` — per-provider retry backoff schedule
  (MTA: `[1s, 5s]`; Resend: `[1s, 5s, 30s]`; SES: per-attempt
  classification). The **Send dispatch (helper)** owns the loop; the
  module declares the schedule.
- `sendEmail(params, extras?) → EmailSendResult` — single-attempt send.
  No internal retry. Returns success with provider message id, or
  failure with raw error message + retryable hint. The dispatch helper
  decides whether to retry based on the module's `categorizeError`.
- `categorizeError(message, httpStatus?) → EmailErrorCode` —
  per-provider error-response parsing. MTA parses JSON status; SES
  parses AWS error types; Resend parses Resend's error envelope.
  Replaces today's global `categorizeError` string-matching in
  `lib/emailProviders/types.ts` that pretended to be generic but had to
  know every provider's error format — shallow.
- `extras: ExtrasFor<K>` — per-provider typed second arg on `sendEmail`.
  MTA carries `ipPool | engagementScore | dkimDomain | messageId`; SES
  and Resend carry `{}` today. Replaces the `params as MtaSendParams`
  cast in pre-deepening call sites.

Adding a core provider remains a one-folder change: a new
`sendProviders/<kind>/` adapter, one `SEND_PROVIDERS` entry, and one core kind.
An operator-installed provider instead declares a data-only
`contributes.sendTransports` descriptor and exports a `parseExtras` plus
single-attempt `send` module from a verified package subpath. Codegen adds its
metadata and Node adapter to separate generated registries; the runtime host
authorizes flag, grant, environment, and singleton scope before every attempt.
The compile-time `satisfies` check on the core registry catches missing methods.
The dispatch helper never branches on `kind` — provider variation lives
entirely behind this seam.

The module does *not* own: the retry loop (Send dispatch helper), the
strategy selection across providers (Send route strategy module), the
`providerHealth` row writes (Send dispatch helper writes; see below),
the workpool's per-job rate limiting (`lib/emailWorkpool.ts`), the
HTTP shell that wraps transactional sends (`transactionalApiHttp.ts`,
or its successor under the **Transactional send intake (module)** if
that deepening lands), the Send-row state-machine transitions (**Send
lifecycle (module)**, called downstream of the helper), or the
`sendBatch` interface from the pre-deepening factory (dead code —
documented as backcompat with no live callers; dropped in this
deepening).
_Avoid_: Email provider module (the pre-deepening factory's name —
collides with itself; the deepening retires that vocabulary), Send
provider module (without `(module)` and without "adapter" — per
LANGUAGE.md, "adapter" carries the role of *a concrete thing satisfying
an interface at a seam*; matches the Sending domain provider's suffix
exactly), Mail send provider adapter (verbose; the domain noun is
already "Send"), Send-side provider adapter (over-qualified).

**Send dispatch (helper)**:
The function at `convex/lib/sendProviders/dispatch.ts` exporting
`sendProviderDispatch(kind, params, extras?) → { result, providerType,
latencyMs }` that owns the per-attempt orchestration around a **Send
provider adapter (module)**'s single-attempt `sendEmail`. Three concerns
inside one helper, all "post-attempt" in scope:
- Retry loop driven by the module's `retryDelays` and
  `categorizeError(message, httpStatus?) → EmailErrorCode`. The
  schedule is the only thing each module declares; the loop is shared.
- Health recording — writes to `providerHealth` via the **Send provider
  health (module)**'s `recordSendResult({ providerType, success,
  latencyMs })`. Runs after every terminal outcome (success or
  exhausted retries), uniformly across all callers. Closes the
  silent-drift bug where test sends (`emails.sendEmail`,
  `emailsSending.testSend`) and the automation email step today bypass
  health recording entirely — only workpool-routed sends went through
  **Send completion (module)** and got recorded.
- Error categorization at the boundary — the dispatch result includes
  the typed `EmailErrorCode` (today's enum), not just the raw error
  string.

Six producers of dispatch calls today (post-deepening): the workpool
worker (`emailWorker.ts`), the campaign orchestrator's one-off test
send (`emails.sendEmail`), the post-send resend in `emailsSending.ts`,
the automation email step (`automations/steps/email/index.ts`), the
transactional HTTP send (`transactionalApiHttp.ts`), and any future
internal sender. All go through the helper; no caller imports a
provider module directly.

The helper does *not* own: provider selection across an org's route
config (**Send route strategy (module)** + `resolveRoute`), Send-row
state transitions (**Send lifecycle (module)** — called by the
workpool callback through **Send completion (module)**), or the
parent-side `emailSends` / `transactionalSends` patches (those live on
the **Send lifecycle (module)**'s effect list).
_Avoid_: Send runner (vague; doesn't signal the orchestration role),
Send executor (we deliberately renamed the automation `stepExecutor.ts`
to `stepWalker.ts` in ADR-0004 for the same reason — "executor" is too
generic), Provider dispatcher (collides with **Webhook dispatcher**),
Send dispatch (module) (the `(module)` suffix signals registry-driven
dispatch; this is one function, not a registry — hence `(helper)`).

**Send route strategy (module)**:
The per-strategy module at `convex/lib/sendProviders/strategies/<kind>/
index.ts` that owns one strategy for selecting a provider from an org's
configured route. Three strategies today: `single`,
`priority_failover`, `workload_split`. Discriminated by `kind: 'single'
| 'priority_failover' | 'workload_split'` matching the `strategy` field
on a `providerRoutes` row. Dispatched by the registry at
`strategies/index.ts` exporting `strategyFor(kind)`. Mirrors the **Send
provider adapter (module)** shape but at a different unit of dispatch.
Exports a `SendRouteStrategyModule<K>` with:
- `kind: K`.
- `select(entries: ProviderEntry[], healthStatuses?:
  ProviderHealthStatus[]) → ResolvedRoute | null` — pure function. The
  routing entry point `resolveRoute(routeConfig, healthStatuses)`
  shrinks to: validate the config, look up the strategy module via
  `strategyFor(routeConfig.strategy)`, call `select()`, return the
  result (or the `null` "no candidate" fallback). Adding a fourth
  strategy (e.g. `least_loaded`) is one folder + one registry entry.

The module does *not* own: the `providerRoutes` CRUD (stays in
`providerRoutes.ts`), the `providerHealth` rows themselves (**Send
provider health (module)**), or the `routeConfig === null` / "no
enabled candidates" fallbacks (`resolveRoute` owns those before any
strategy is called).
_Avoid_: Routing strategy module (drops the domain prefix; ambiguous
with HTTP routing), Provider strategy module (collides with **Sending
domain provider adapter (module)**), Strategy alone (overloaded).

**Send provider health (module)**:
The sibling module at `convex/lib/sendProviders/health.ts` that owns
*all* reads and writes of `providerHealth`. Renamed from the
pre-deepening `lib/emailProviders/healthTracker.ts` (moved alongside
its consumers; same exports, same shape). Three entry points:
- `recordSendResult({ providerType, success, latencyMs })` — internal
  mutation. The **Send dispatch (helper)** is the only writer.
- `getProviderHealth({ providerType })` — internal query for one
  provider's snapshot.
- `getAllProviderHealth({})` — internal query consumed by
  `resolveRoute` before dispatching to a **Send route strategy
  (module)**.

Health thresholds (`DOWN_THRESHOLD = 0.5`, `DEGRADED_THRESHOLD = 0.9`,
`MAX_CONSECUTIVE_FAILURES = 5`, `ROLLING_WINDOW = 100`) and
`calculateStatus(rate, consecutiveFailures)` stay generic — they're
cross-provider semantics, not per-provider. If a provider ever needs
custom thresholds, that's the seam to revisit.
_Avoid_: Provider health (overloaded — could mean Sending domain
provider verification health), Send health (vague), Health tracker
(today's file name; the deepening drops the "tracker" suffix because
the file now contains queries too, not just write-tracking).

## MTA dispatch

**Dispatch attempt**:
One execution of the MTA's `handleEmailJob` for a single `EmailJob`. A Job
has 1..N attempts — retries (via GroupMQ re-queue) produce additional
attempts. Each attempt either drops silently (content screened, recipient
suppressed), defers (re-queue with delay), or completes a send-and-record
cycle. The attempt is the unit the **Dispatch pipeline** and **Dispatch
outcome** modules operate on. Sits upstream of the Convex-side **Send
lifecycle** chain: one delivered attempt produces one `email.sent`
**Inbound event** via `notifyConvex`, which routes through the **Webhook
dispatcher** to a `sent → delivered` Send lifecycle transition.
_Avoid_: Send (Convex-side term — one Send spans 1..N attempts), Job
alone (GroupMQ vocabulary; doesn't signal the per-attempt scope).

**Dispatch pipeline (module)**:
The module at `apps/mta/src/dispatch/pipeline.ts` that owns the ordered
pre-send check sequence for a Dispatch attempt. Composed of typed
**Phase**s whose output ctx threads forward into the next phase's input.
Each phase returns one of three outcomes: `continue` (with possibly
enriched ctx), `defer` (with `delayMs` + `reason`), or `drop` (with
`status: 'screened' | 'suppressed'` + `reason`). The pipeline runner
short-circuits on the first non-`continue` outcome. Replaces the ten
comment-delimited check blocks (steps 0a–4c) in `queue/handler.ts:79-176`.
The pipeline never throws `DeferError` — it returns defer data;
`handler.ts` is the only place that translates to a throw (the GroupMQ
boundary).
_Avoid_: Pre-send pipeline (negative term — names what it's not), Send
pipeline (too generic; collides with the Convex-side Send lifecycle).

**Phase**:
The unit in the **Dispatch pipeline**. A typed record `Phase<TIn, TOut>`
with `run(deps, ctx: TIn) → PhaseOutcome<TOut>` whose input/output types
thread through `compose(...phases)` at the type level — a phase that
consumes `ip` cannot be ordered before the phase that produces it.
Phases live one per file at `apps/mta/src/dispatch/phases/<phase-name>.ts`.
They wrap existing intelligence/scaling helpers (`circuitBreaker.canSend`,
`orgLimits.checkAndIncrement`, `selectIp`, etc.) — the helpers stay; the
phase translates their per-helper return shapes into the uniform
`PhaseOutcome`. Most phases are `Phase<X, X>` (pure checks); only the
three enriching phases (`resolvePool`, `selectIp`, `acquireSlot`) advance
the ctx type.
_Avoid_: Check (vague — phases also enrich state), Step (collides with
the automation **Step**).

**Dispatch outcome (module)**:
The module at `apps/mta/src/dispatch/outcome.ts` that owns the post-send
classification + effect emission for a Dispatch attempt. Pure
`reduce(outcome) → { effects: DispatchEffect[]; defer?: { delayMs; reason } }`.
Replaces the four-branch `if/else if` in `queue/handler.ts:184-365`.
Mirrors the **Send lifecycle (module)** pattern (typed outcome + typed
effect list + runner) but operates on MTA-internal state (Redis throttle
counters, warming, metrics, suppression list) plus the cross-boundary
`notify_convex` effect that bridges to the Convex **Webhook dispatcher**
→ **Send lifecycle** chain. The four outcome kinds — `delivered |
hard_bounce | deferred | soft_bounce` — classify the result of
`sendToMx`; only `deferred` and `soft_bounce` carry a `defer` field.
_Avoid_: Dispatch reducer (names the verb), Send outcome (Send is the
Convex-side term).

**Dispatch effect**:
The typed effect variants emitted by the **Dispatch outcome** reducer.
Currently: `domain_throttle_success | domain_throttle_reject |
domain_throttle_defer | smtp_response | circuit_breaker_outcome |
warming_record | metrics_record | log_delivery_event | notify_convex |
suppress_recipient | domain_failure_clear | domain_failure_record`. The
runner in `apps/mta/src/dispatch/effects.ts` switches on `kind` and
applies via `Promise.all` (preserving the existing parallelism of
post-send recording). Tests assert against the effect list, not against
Redis or HTTP side effects.
_Avoid_: Side effect (too generic — every async op is a side effect),
Dispatch action (collides with audit action vocabulary).

## Webhook events

**Inbound event**:
A normalized, provider-agnostic event arriving at Owlat from outside —
covering email-delivery webhooks (Resend, MTA HTTPS), the MTA SMTP bounce
server, and non-email channels (Twilio SMS, Meta WhatsApp, generic
shared-secret webhooks). Discriminated union keyed by `kind`:
`email.sent | email.delivered | email.bounced | email.complained |
email.opened | email.clicked | inbound.received | channel.received |
internal.circuit_breaker_tripped | internal.ip_event`. The `email.*` kinds
match the **Webhook event** literals exactly so dispatcher and outbound
fanout share one vocabulary. `channel.received` carries a `channel:
'sms' | 'whatsapp' | 'generic'` field — one kind covers all non-email
channels, mirroring how `inbound.received` covers all email-inbound
providers (the *transport* differs, the *event* doesn't). The
`internal.*` kinds are never customer-fanned out.
_Avoid_: Inbound delivery event (the prior, email-centric name; "delivery"
stretches to fit SMS/WhatsApp). Webhook event (use that for the outbound
side). Provider event (vague about direction).

**Inbound adapter**:
A per-provider module at `apps/api/convex/webhooks/adapters/<provider>.ts`
exporting: `source` (wire identifier for audit-payload `source` and logs),
`verifySignature(req, rawBody) → ok | error` (provider-specific HMAC /
Svix multi-sig / Twilio canonical-string / Meta `sha256=`),
`parseEvent(rawBody) → Inbound event | null` (provider-specific envelope
unwrap, per-kind classification — e.g. hard/soft bounce, SMS/WhatsApp/
generic payload-to-`channel.received` normalization; `null` for kinds the
provider sends but Owlat ignores), and optional
`successResponse?: Response | ((event) => Response)` for providers whose
wire contract dictates a non-JSON response (Twilio TwiML, Meta bare 200).
The MTA SMTP bounce server is also an Inbound event producer — it
constructs the union directly because its transport is SMTP not HTTPS.
Protocol handshakes that aren't events (Meta's GET verification
challenge) live as additional helpers exported from the adapter module
but run in the outer HTTP shell *before* `runInboundPipeline`, since the
pipeline accepts POST events only. Adapters never write to the database
and never call domain mutations.
_Avoid_: Webhook handler (the HTTP handler still owns that name).

**Webhook dispatcher**:
The shared switch in the inbound HTTP handler that routes an Inbound
delivery event to its downstream domain mutation: `email.*` →
`sendLifecycle.transitionByProviderMessageId` (with Postbox `pb-` prefix
routing to `mail.outboundState`), `inbound.received` → `inbox.messages.
receiveMessage`, `internal.circuit_breaker_tripped` →
`organizationSettings.setAbuseStatusInternal`, etc. Typed dispatch table
`{ [K in InboundDeliveryEvent['kind']]: Handler<K> }` — adding a new kind
without registering a handler is a compile error. Replaces the per-handler
`if (payload.event === 'X')` chain in `resendWebhook.ts` and
`mtaWebhook.ts`.

**Webhook event** (outbound):
A customer-subscribable event Owlat emits. Identified by its wire literal
(`email.sent`, `email.bounced`, `contact.created`, etc. — the catalog
introduced by ADR-0002).
_Avoid_: Event alone (overloaded with audit events, contact activities).

**Webhook event module**:
A per-event module at `apps/api/convex/webhooks/events/<literal>/index.ts`
that owns the customer-facing payload contract for one Webhook event.
Exports `{ literal, description, isSubscribable, schema, build(input) →
data }`. `build` is pure: callers in `sendLifecycle`, `contacts`,
`topics` pre-resolve the domain data and pass it in — modules never read
from `ctx`. `schema` is a Convex validator for the `data` payload; the
fanout path validates against it before scheduling delivery. Schemas
evolve append-only — non-additive changes require a new event literal
(e.g. `email.bounced.v2`) registered as a distinct catalog entry. The
ADR-0002 catalog becomes the registry of these modules.

**Webhook event fanout**:
The internal action that takes a Webhook event literal + caller-resolved
data, looks up the **Webhook event module**, calls `build` and validates
against `schema`, then fans the resulting payload out to every active
subscribed webhook via the existing delivery + retry machinery. Replaces
`fireWebhookEvent` and `deliverWebhook` in `webhooks/delivery.ts` — the
two collapse into one path that goes through the module.

## Conversation threads

**Conversation thread**:
A grouping of related inbound messages from one Contact. Stored in
`conversationThreads` with `subject`, `normalizedSubject` (stripped of
Re:/Fwd: prefixes, lowercased), `contactId`, `contactIdentifier` (the
channel-agnostic identifier — email for email channels, phone for SMS /
WhatsApp, free-form handle for generic / chat), a **Conversation thread
status**, optional `assignedTo` (BetterAuth user id), denormalized
`messageCount`, `lastMessageAt`, `firstMessageAt`, and an optional
`latestDraftStatus` (the projection of the active draft-bearing inbound
message's processing status — written by the **Inbox processing lifecycle
(module)**'s `set_thread_draft_status` effect through the **Conversation
thread (module)**'s `draft_status_change` transition). The grouping unit
for the shared inbox; the link target for chat-channel "inline view"
(`chatRooms.linkedInboxThreadId`). The `contactEmail` field is renamed to
`contactIdentifier` with this deepening — schema migration backfills
existing rows in one pre-prod pass.
_Avoid_: Thread alone (overloaded — chat has its own room/thread
vocabulary, mail has thread reference fields), Inbox thread (names the
surface, not the row — the table is `conversationThreads`), Conversation
alone (overloaded with the chat-room concept), Message thread (collides
with the RFC 5322 threading header concept).

**Conversation thread status**:
The current state of a Conversation thread at `conversationThreads.status`:
`open | waiting | resolved | closed`. No `LEGAL_EDGES` graph — manual
status changes via the **Conversation thread (module)**'s `status_change`
kind accept any edge ("fully flexible"). Resolved threads can be
reopened, closed threads can be re-resolved without an intermediate
state, and a user can move directly from `open` to `closed`. Inbound
activity hitting a closed thread *implicitly* reopens it via the
`inbound_activity` kind — the reducer writes `status: 'open'` atomically
with the `messageCount` / `lastMessageAt` patch and fires a
`thread.reopened_by_inbound` audit row. Closes the drift bug where
`inbox/messages.ts` always reopened on inbound while
`webhooks/channels.ts:108` forked a new thread on inbound to a closed
thread — under the module, every channel reopens uniformly.
_Avoid_: Thread state (vague), Conversation state (collides with the
chat-room concept), Inbox state (overloaded with the per-message
`processingStatus` and the per-thread assignment state).

**Conversation thread (module)**:
The module at `convex/inbox/threads/module.ts` that owns *all* writes to
`conversationThreads`. Mirrors **Mail draft lifecycle (module)** shape —
typed `TransitionInput` discriminated by `kind` (not `to`, because
threads have heterogeneous independent dimensions: `status`,
`assignedTo`, `latestDraftStatus`, `messageCount` / `lastMessageAt`),
*no* `LEGAL_EDGES` graph for status (fully flexible), a private reducer
per kind returning `{ patch, effects, applied }`, and a
`TransitionOutcome` reporting `ok | reason` for kind-mismatched /
thread-not-found attempts. Three entry points:
- `findOrCreateForEmail({ contactId, contactIdentifier, subject,
  normalizedSubject, inReplyTo?, references? })` — runs the
  three-strategy thread-match cascade (`In-Reply-To` header →
  `References` header → normalized-subject + `contactIdentifier`
  composite index) and creates a new row if none match. **Implicitly**
  fires the `inbound_activity` transition before returning, so the
  find-or-create + metadata patch + reopen-if-closed bundle is atomic.
  Returns `{ threadId, action: 'matched' | 'created' }`.
- `findOrCreateForChannel({ contactId, contactIdentifier })` — runs the
  single-strategy match (most-recent thread for the contact,
  status-agnostic — the "always reopen" semantic is enforced by the
  implicit `inbound_activity` transition that follows, not by the
  matcher). Closes the drift where `webhooks/channels.ts:108` refused to
  touch closed threads and forked instead. Same return shape.
- `transition({ threadId, input })` — direct path for non-intake writes.
  `input` is `{ kind: 'inbound_activity'; occurredAt } | { kind:
  'status_change'; to: ConversationThreadStatus; source } | { kind:
  'assignment_change'; assignedTo?: string; source } | { kind:
  'draft_status_change'; latestDraftStatus }`. Used by the **Inbox
  processing lifecycle (module)**'s `set_thread_draft_status`
  effect-runner (delegates to this entry instead of patching the row
  directly) and by the user-facing `assignThread` / `updateThreadStatus`
  shells in `inbox/mutations.ts`.

Effects (atomic with the row patch):
- `audit_log` — fires on every transition kind. Audit actions added to
  `auditActions/catalog.ts`: `thread.reopened_by_inbound` (only when
  `inbound_activity` lands on a *closed* thread — not on every inbound,
  to avoid timeline noise), `thread.status_changed` (with `from`, `to`,
  `source`), `thread.assigned` / `thread.unassigned` (with `userId`,
  `source`), `thread.draft_status_changed` (with the new
  `latestDraftStatus`). Every other lifecycle module audits writes; this
  one matches.

Schema posture: this deepening renames `conversationThreads.contactEmail`
to `contactIdentifier`. The index `by_contact_email` renames to
`by_contact_identifier`; the compound `by_normalized_subject_and_contact`
keeps its name but its second key column renames. Pre-prod migration
backfills the column in one pass.

Replaces the open-coded `db.insert` / `db.patch` sites in:
- `inbox/messages.ts:131, 147` (intake + metadata patch for email).
- `webhooks/channels.ts:111, 120` (intake + metadata patch for SMS /
  WhatsApp / generic; the status-agnostic find under the new module
  unifies the channels-vs-email semantic).
- `inbox/mutations.ts:139` (`assignThread` — gains audit log).
- `inbox/mutations.ts:163` (`updateThreadStatus` — gains audit log).
- `inbox/processingLifecycle.ts:626-631` (`set_thread_draft_status`
  effect — runner now delegates to the module's `transition` rather than
  patching directly).

Closes drift bugs:
- Channel inbound on a closed thread silently forked a new thread
  instead of reopening (now uniform with email; both reopen).
- The `messageCount + 1` re-read race in `messages.ts:147-152` (insert
  then re-read with no atomic guarantee) — the module reducer reads
  inside the same mutation and writes atomically.
- `assignThread` and `updateThreadStatus` had zero audit-log coverage.
- The `contactEmail` misnomer — under the rename, channel-agnostic
  identifiers are no longer misleadingly typed as emails (the
  `webhooks/channels.ts:118-122` "Misnomer kept for now" comment goes
  away).
- The `set_thread_draft_status` effect was the only inbox-lifecycle
  effect that wrote a different table without delegating to its owner
  module — closes the implicit cross-module reach.

The module does *not* own: the `inboundMessages` row write (stays in
`inbox/messages.ts:receiveMessage`), the `unifiedMessages` row write
(stays in `webhooks/channels.ts:processInboundChannel`), the
`processingStatus` transitions on inbound messages (**Inbox processing
lifecycle (module)**), the `inboundMessages.draftResponse` /
`draftSubject` patch in `inbox/mutations.ts:editDraft` (separate gap —
should route through the Inbox processing lifecycle as a follow-up; out
of scope here), the chat-side `chatRooms.linkedInboxThreadId` write
(stays in `chat/emailLink.ts`), the **Contact resolution (module)** call
that precedes intake, the read queries (`get`, `list`, etc. stay in
`inbox/queries.ts`), or a daily reconciliation cron for `messageCount`
drift (deferred — same posture as `topics.reconcileMemberCounts` until a
query-perf need lands).
_Avoid_: Thread lifecycle (module) (collides with the
`LEGAL_EDGES`-driven lifecycle pattern — this module has no edge graph,
status is fully flexible), Inbox thread (module) (names the surface, not
the row), Conversation lifecycle (module) (overloaded — the module owns
*writes*, not state-machine transitions in the per-status sense),
Thread writer (module) (writers in this codebase are the verbs the
module exposes, not the module itself), Conversation intake (module)
(covers only the find-or-create-plus-record half; the module also owns
the non-intake `transition` writes for status / assignment /
draft-status).

## Inbox processing

**Inbox processing status**:
The current state of an inbound message in `inboundMessages.processingStatus`:
`received | security_check | quarantined | classifying | drafting |
draft_ready | awaiting_clarification | approved | sent | rejected | archived |
failed`. Twelve states
covering the joined agent-pipeline progression and the human draft-review
hand-off. Companion fields written atomically with the status: `errorMessage`
(on `failed`), `processedAt` (on terminals), `securityFlags` (on
`quarantined` / `archived`), `classification` (when `classify` completes),
`draftResponse` / `draftSubject` / `confidenceScore` (when `draft` completes),
`contextTier` (when context-retrieval completes). Legal edges:
- `received → security_check` (security_scan step starts)
- `security_check → quarantined` (security flag set)
- `security_check → classifying` (no security issue; classify step starts)
- `security_check → archived` (spam caught during scan)
- `classifying → drafting`
- `classifying → draft_ready` (no draft generation is needed)
- `classifying → awaiting_clarification`
- `awaiting_clarification → drafting`
- `awaiting_clarification → archived` (owner dismisses the message)
- `drafting → draft_ready`
- `drafting → approved` (auto-send policy approves the draft)
- `draft_ready → approved` (human approve or auto-approve)
- `approved → sent` (after dispatch)
- `approved → draft_ready` (cancelled auto-send returns to review)
- `draft_ready → rejected` (human reject)
- `quarantined → received` (release from quarantine → restarts pipeline)
- `failed → received` (cron retry → restarts pipeline)
- `* → archived` (block-sender from any state)
- `* → failed` (pipeline error from any non-terminal state)

`sent`, `rejected`, `archived` are terminal — transitions out of them are
refused as `illegal_edge`. The agent pipeline's `context_retrieval`, `clarify`,
and `route` step kinds create **Agent action** rows without changing the
processing status — they are recorded as ancillary step effects rather than
visible transitions (kept this way to preserve today's queue-filter indexes).
The four-state `conversationThreads.latestDraftStatus` is a
*projection* of the latest draft-bearing message's processing status —
written by the lifecycle module as a `set_thread_draft_status` effect,
never by callers directly.
_Avoid_: Processing state (vague), Message status (collides with
`mailMessages` Postbox status), Inbox status (overloaded with thread
state and assignment state).

**Agent action**:
One row in `agentActions` — a single execution attempt of one pipeline
step (`security_scan | context_retrieval | classify | clarify | draft | route`)
against one `inboundMessages` row. Carries the per-step audit fields
(input/output JSON, retry count, model used, token usage, duration). One
Inbox processing message has 1..N Agent actions across its lifetime (one
per kind in the happy path, plus retries within a kind). The
**Inbox processing lifecycle (module)** is the only writer of the row;
creation/completion are fired as effects of inbox-side transitions or as
the **Agent walker**'s in-state `recordStepBegin` / `recordStepEnd` calls
that flow through the lifecycle's primitives. The Agent action's own
`status` (`pending | running | completed | failed | abandoned | skipped`) is
maintained by those effects; it does not get its own lifecycle module
because every transition is already gated by an inbox-side transition.
The `actionType` enum matches the **Agent step (module)** kind union
exactly — adding a kind to one without the other is a compile error.
_Avoid_: Pipeline step (names the kind, not the row), Agent action
module (collides with this entry — the per-kind compute is the
**Agent step (module)**, not "Agent action module").

**Inbox processing lifecycle (module)**:
The module at `convex/inbox/processingLifecycle.ts` that owns
transitions of `inboundMessages.processingStatus`. Mirrors the
**Outbound lifecycle** shape — typed `TransitionInput` discriminated
by `to`, a `LEGAL_EDGES` graph (above), a private reducer per kind
returning `{ patch, effects, applied }`, and a `TransitionOutcome`
reporting `ok | reason`. Single entry point `transition({
inboundMessageId, input })`; no external-key entry — inbound messages
are identified by their own `Id<'inboundMessages'>`, and the SMTP
`messageId` is for threading, not transition lookup.

Effects:
- `create_agent_action(actionType)` — fires on transitions *into*
  pipeline-phase states (`security_check`, `classifying`, `drafting`) and
  on the ancillary kinds (`context_retrieval`, `route`). Primitive
  surfaces (`recordStepBegin` / `recordStepEnd` / `recordStepFail`) are
  exposed for the **Agent walker**'s in-state step calls.
- `complete_agent_action(actionId, output?, tokenUsage?, durationMs?,
  modelUsed?)` — fires on transitions *out of* pipeline-phase states
  on success.
- `fail_agent_action(actionId, errorMessage)` — fires on `to: 'failed'`
  carrying the in-progress action's id.
- `set_thread_draft_status(threadId, draftStatus)` — fires on
  `draft_ready`, `approved`, `rejected`, and `sent`. Closes the bypass
  bug where `inbox/mutations.ts` patches the thread inline (lines
  35-39, 77-81) instead of via the helper.
- `schedule_send` — fires on `to: 'approved'`; replaces the inline
  scheduler call in `inbox/mutations.ts:42-44`. Next-step scheduling for
  the agent pipeline is *not* a lifecycle effect — the **Agent walker**
  owns the `runStep → runStep` self-schedule loop and calls the lifecycle
  for the state-change side of each hop.
- `audit_log(action, resourceId, details?)` — fires on human-driven
  transitions (`approved`, `rejected`, `archived` via block-sender,
  `received` via release-from-quarantine).
- `increment_auto_reply_count` — fires on `to: 'approved'` when the
  source is `'auto'` (auto-approval threshold met).

Replaces the nine open-coded writers above plus the in-pipeline
status/agentAction split. Closes drift bugs: today the pipeline writes
`processingStatus` and `agentActions` in *two separate mutations*, so
a step that crashes between them leaves them inconsistent; today the
human review path writes `processingStatus` and `latestDraftStatus`
in *two separate patches* inside one mutation, identical drift surface
at human boundaries.
_Avoid_: Agent pipeline lifecycle (excludes the human-review half),
Inbox lifecycle (overloaded with thread state and assignment state),
Inbound message lifecycle (collides with **Inbound event** from the
Webhook adapter family).

**Agent step (module)**:
The module at `convex/agent/steps/<kind>/index.ts` that owns the per-kind
compute + routing for one stage of the agent pipeline. Two pure functions:
`execute(ctx, input) → { output, modelUsed?, tokenUsage? }` runs the work
(pattern match, DB joins, or LLM call); `route(output, runCtx) →
AgentRoute` decides what happens next — an in-state next step, a state
transition optionally followed by a next step, or `done` (pipeline
terminates). Modules carry an optional `llm?: { tier: 'fast' | 'capable' }`
flag for the three LLM-based kinds (`classify`, `clarify`, `draft`); the **Agent
walker** uses the flag to call the **LLM dispatch (module)** at
`convex/lib/llm/dispatch.ts` (lifted out of the agent-internal
`shared/llm.ts` so non-agent callers share the same seam) so
per-module `execute` shrinks to prompt construction + output parsing. The six kinds match the
**Agent action** `actionType` enum exactly: `security_scan |
context_retrieval | classify | clarify | draft | route`. The `clarify` kind
sits at the classify fork — a missing-info gate that either parks the message
in `awaiting_clarification` (open questions for the owner) or falls through to
`drafting` (today's behaviour); it fails soft to `drafting` on any error. The
`plan` kind was
dropped with this deepening — today's plan-record was a placeholder JSON
construction inside `agentDrafter` (`agentDrafter.ts:75-86`), never a
real planning step; if a real planner ships later it joins through a host-owned
catalog addition, its core module registry entry, and any corresponding
lifecycle decision. Modules own only the compute + routing surface — Agent
action creation/completion,
`processingStatus` transitions, scheduling, and retry all live in the
**Agent walker** which calls into the **Inbox processing lifecycle
(module)** primitives.

Bundled hosted kinds use `plugin.<pluginId>.<localId>` and come from the same
generated catalog that derives `AgentStepKind`, the walker validator, the
lifecycle action validator, and the schema validator. Their public module is
deliberately narrower than a core module: it receives a bounded message
projection and returns `continue` or a declared restrict-only `caution`. The
walker preserves the original core continuation; plugins cannot route to
another step, approve, send, or change core lifecycle legality.

Replaces the six open-coded `internalAction` handlers in
`convex/agent/agent<Kind>.ts` plus the scheduler-hop chain between them
(`internal.agent.agentContext.retrieveContext` →
`internal.agent.agentClassifier.classifyMessage` →
`internal.agent.agentDrafter.generateDraft` →
`internal.agent.agentRouter.routeDraft`). Closes drift bugs: today's
token-usage extraction shape (`{promptTokens, completionTokens,
totalTokens}` rebuilt from `usage.inputTokens/outputTokens/totalTokens`)
exists only in `agentDrafter.ts:194-198` and `agentClassifier.ts:72-78` —
future LLM steps would re-discover it; routing policy moves out of
~50-line `execute` handlers (today's classifier three-way branch at
`agentClassifier.ts:88-139`, security three-way branch at
`agentSecurity.ts:188-244`) into standalone ~15-line `route` functions
that are inspectable in isolation; the error → failed-transition pattern
becomes one walker-level handler instead of six per-step try/catch
blocks; the `plan` placeholder disappears.
_Avoid_: Pipeline step (names the kind, not the module — the kind
already has a name: it's the **Agent action** `actionType`), Agent action
module (collides with **Agent action** the row), Agent step alone
(without the `(module)` qualifier — risks collision with the automation
**Step** the same way **Step module** qualifies for automations).

**Agent walker**:
The action at `convex/agent/walker.ts` that owns the per-step execution
loop for the agent pipeline. Mirrors the automation **Step walker** shape
— a typed dispatch table `Record<AgentStepKind, AgentStepModule<...>>`;
modules are pure; the walker owns lifecycle effects and the
self-scheduled `runStep` hop. Two entry points:
- `start({ inboundMessageId })` — kicks the pipeline off at
  `security_scan`. Three callers: `inbox/messages.ts:receiveMessage` on
  new-message arrival (replaces today's direct
  `scheduler.runAfter(0, internal.agent.agentSecurity.runSecurityScan)`
  call), the **Inbox processing lifecycle (module)**'s
  `schedule_pipeline_start` effect on `to: 'received'` from
  `release_quarantine` (release-from-quarantine restart), and the same
  effect on `to: 'received'` from `cron_retry` (cron-driven retry of
  failed actions). The latter two callers close a latent bug — today the
  lifecycle's reducer for `to: 'received'` resets `errorMessage` and the
  failed action to `pending`, but no caller re-schedules the pipeline,
  so cron retries and quarantine releases silently leave messages in
  `received` forever. The `schedule_pipeline_start` effect lands as part
  of this deepening.
- `runStep({ inboundMessageId, kind, input })` — self-scheduled dispatch.
  Loads the **Agent step (module)** for `kind`, calls
  `lifecycle.recordStepBegin(kind)` to create the action row, runs
  `module.execute(ctx, input)` (wrapping LLM calls with shared
  token-usage extraction when `module.llm` is set), then applies
  `module.route` to one of three paths: `in_state` (calls
  `recordStepEnd`, schedules the next `runStep`), `transition` (calls
  `lifecycle.transition` with the step result merged in, optionally
  schedules a next `runStep`), or `done` (calls `recordStepEnd` and
  stops). On exception, calls `lifecycle.transition({ to: 'failed',
  failingActionId })`.

Retry semantics are *whole-pipeline restart* (same as today's reducer
intent): when the cron transitions a failed message to `received`, the
walker's `start` re-runs from `security_scan`. Per-step resumption would
require reconstructing the failed step's input from prior outputs —
deferred until a real use case lands. Step files no longer import each
other's Convex API paths — the walker is the only place that knows the
kind → module mapping.
_Avoid_: Agent step walker (over-qualified — only one walker in the
agent domain, file path is `agent/walker.ts` not `agent/stepWalker.ts`),
Agent pipeline (names what the walker traverses, not the walker), Agent
executor (vague — same reason the automation `stepExecutor.ts` was
renamed `stepWalker.ts`: doesn't signal the dispatch role).

## LLM dispatch

**LLM dispatch (module)**:
The module at `convex/lib/llm/dispatch.ts` that owns the canonical
shape for issuing one LLM call plus the one mapping between the AI
SDK's `usage` shape and the internal `TokenUsage` validator. Lifted
out of the agent-internal `convex/agent/steps/shared/llm.ts` (see
ADR-0014) so every LLM caller across the deployment shares the same
dispatch + token-usage extraction surface. Two entry points:
- `runLlmText({ model, messages | { prompt, system? }, temperature? })
  → { text, tokenUsage, modelUsed }` — wraps `generateText`. Accepts
  either a `messages` array or a `{ prompt, system? }` pair as a
  discriminated input; translation-style and visualization-style
  callers both fit without separate entry points.
- `runLlmObject({ model, schema, prompt, temperature? }) →
  { object, tokenUsage, modelUsed }` — wraps `generateObject`.

Callers: the **Agent walker** (for the two LLM-based **Agent step
(module)** kinds — `classify` and `draft`), `translate.ts`,
`knowledge/extraction.ts`, `semanticFileProcessing.ts`, and
`visualizationAgent.ts`. The walker writes `tokenUsage` and
`modelUsed` onto the lifecycle's **Agent action** row; non-agent
callers log them via `lib/runtimeLog.ts` so operators see AI cost in
runtime logs without a new persistence surface.

The module does *not* own: model resolution (lives behind
`lib/llmProviders/` — one seam picks the model, this seam issues the
call), retry policy, parse-failure fallback, embedding (`embed()`
stays open-coded at its two callers — knowledge extraction and
semantic file processing — to honor "minimal lift"), persistence of
usage to a dedicated table (deferred until a metering need lands),
or prompt construction (each caller still composes its prompt next
to its model call — preserving the locality principle ADR-0014
chose deliberately).
_Avoid_: LLM helper (vague — doesn't signal the dispatch role),
LLM wrapper (collides with the `lib/llmProviders/` factory, which
is the real wrapper of the AI SDK), AI dispatch (the seam is
language-model-specific; embeddings don't go through it today),
LLM task (module) (collides with the tier vocabulary already on the
provider — `LLMTask = 'classify' | 'extract' | …` is a tier
discriminator, not the unit this module dispatches).

## Postbox mailbox

**Mailbox**:
A personal-mail identity row in `mailboxes`, owned by exactly one `userId`
(BetterAuth account holder) within one `organizationId`, addressable at
one canonical lowercase `address` (and one or more **Mail aliases**).
Carries `status: 'active' | 'suspended' | 'deleted'` and the `usedBytes` /
`quotaBytes` storage accounting. The unit the **Postbox outbound lifecycle
(module)** dispatches drafts on behalf of, the IMAP **Connection state**'s
`auth` resolves to, and every `mail/*` mutation and query gates against
via the **Mailbox gate (helper)**.
_Avoid_: Postbox alone (Postbox is the umbrella concept covering IMAP +
Mailbox + folders + drafts + identities), Account (overloaded with
BetterAuth's user account), Mailbox identity (collides with **Contact
identity** and **Sending domain identity** in shape and reads as
overloaded).

**Mailbox gate (helper)**:
The function at `convex/mail/permissions.ts` exporting
`loadOwnedMailbox(ctx, mailboxId) → MailboxAccessOutcome` that owns the
permission predicate for *every* `mail/*` mutation and query operating on
a **Mailbox**. Mirrors **Abuse gate (module)** in role (read-side
predicate co-located with the area it gates) but is a `(helper)` because
it exports one function, not a sibling-paired module family — same
precedent as **Send dispatch (helper)** and `validateReadyToSend`. The
outcome is the typed `{ ok: true; userId; mailbox } | { ok: false;
reason: 'no_session' | 'mailbox_missing' | 'mailbox_inactive' |
'forbidden' }` shape — discriminated on `reason` so future audit logging
or HTTP error mapping can dispatch.

Policy encoded:
- Session must exist with a role (`no_session` otherwise).
- Mailbox must exist (`mailbox_missing`) and `status === 'active'`
  (`mailbox_inactive`) — read paths refuse on suspended/deleted mailboxes
  alongside writes (the eleven pre-deepening clones already encoded this;
  the deepening preserves it explicitly rather than splitting into
  per-intent gates).
- Caller must be `owner` / `admin` (acting on behalf of any user in the
  org) or `mailbox.userId === s.userId` (`forbidden` otherwise).

Returns the loaded `mailbox` row on success — callers that need it stop
re-`db.get`-ing the id (closes the two double-fetch sites in
`drafts.ts:create` and `forwarding.ts`). Replaces eleven identical
`async function loadOwnedMailbox` declarations co-located in
`mail/aliases.ts`, `mail/appPasswords.ts`, `mail/contacts.ts`,
`mail/drafts.ts`, `mail/filters.ts`, `mail/folders.ts`,
`mail/forwarding.ts`, `mail/labels.ts`, `mail/messageActions.ts`,
`mail/signatures.ts`, and `mail/vacation.ts` (51 call sites total, ten
in `drafts.ts` alone). The single canonical owner makes the
"owner / admin / mailbox-user" policy auditable in one place — adding
delegated access, app-password scope filtering, or an `audit_log` effect
on "admin acted on user's mailbox" lands once, not eleven times.

The helper does *not* own: BetterAuth session lookup (delegated to
`getBetterAuthSessionWithRole` in `lib/sessionOrganization.ts`), the
**Mail alias** address-allow check (lives at
`resolveAllowedFromAddressesForCtx` in `mail/aliases.ts`), per-row state
guards (each caller still checks `draft.state === 'draft'`,
`filter.enabled`, etc. — the gate is mailbox-level, not row-level), or
audit logging on admin-acts-on-other-user paths (deferred surface; the
`reason` discriminator opens that seam for a follow-up effect once the
audit-log shape lands).
_Avoid_: Mailbox permissions (vague — names the concern, not the
surface), Mailbox auth (collides with BetterAuth and IMAP auth), Mail
gate (drops "box" — the gate is per-mailbox, not per-message), Postbox
gate (overloaded with IMAP-level access concerns), `loadOwnedMailbox`
module (names the function not the role; the function is the helper's
single export, the helper is the unit).

## IMAP

**IMAP command (module)**:
A per-verb module at `apps/imap/src/commands/<verb>/index.ts` exporting an
`ImapCommandModule<TArgs>`: `verbs` (one or more IMAP verbs the module
handles — `['LIST', 'LSUB']`, `['SELECT', 'EXAMINE']`, etc.),
`capabilities?` (the CAPABILITY-line atoms the module contributes, e.g.
`['IDLE']`, `['MOVE']`, `['UIDPLUS']`), `parseArgs(rawArgs, verb) →
TArgs | { error }`, and `start(deps, state, args, tag, send) →
CommandSession`. Modules are pure with respect to socket I/O — they
receive a `send(line)` callback from the **IMAP pump** and the
**Connection state**, and they return a session that the pump tracks
until its `completion` resolves. One interface covers both shapes:
- **One-shot** — `start` writes its response lines via `send`, returns a
  session whose `completion` is already resolved with the next state.
  Covers the ~14 read-only and state-transitioning commands
  (CAPABILITY, NOOP, LOGOUT, ID, NAMESPACE, ENABLE, LOGIN, LIST / LSUB,
  SELECT / EXAMINE, UNSELECT / CLOSE, STATUS, FETCH, CHECK, STORE, COPY,
  MOVE, EXPUNGE, UID).
- **Long-running** — `start` returns a pending session that owns its own
  timers (IDLE) or declares `awaitingLiteral: { bytes: N }` so the pump
  routes the next N raw bytes to `onLiteralBytes` (APPEND). Sessions
  expose `onClientLine(line)` for in-band termination (IDLE reads bare
  `DONE`) and `cancel()` for socket close. Covers IDLE and APPEND.

Modules never touch the socket directly, never reach for a connection
field via `this` (there is no `this`), and never know the rate limiter
is shared with the next connection — all I/O and shared deps flow
through `deps`. The verb-keyed dispatch table makes missing a
registration a compile error. Replaces the 1106-LOC `ImapConnection`
class with a per-verb module folder structure.
_Avoid_: IMAP handler (the current file's term for `handleX` methods —
overloaded with the HTTP/Convex "handler" vocabulary), Command alone
(overloaded), Verb module (the verb is the dispatch key, not the noun),
IMAP step (collides with the automation **Step**).

**Connection state**:
The pure `{ auth, selected }` value threaded between IMAP commands —
distinct from the **pump state** which is buffer + active-session
bookkeeping owned by the connection shell. LOGIN transitions
`auth: null → AuthState`. SELECT / EXAMINE transitions `selected`.
UNSELECT / CLOSE clears `selected`. The pump owns `pendingAppend`
absorption progress and `idleSession` timer handles — these are
*not* connection state because they're per-active-command lifetime,
not per-connection lifetime. The pump tears them down when the
session's `completion` resolves; the connection state survives across
command boundaries.
_Avoid_: Connection context (vague), IMAP state alone (collides with
pump state — IMAP has two state shapes and they're worth keeping
distinct).

**IMAP pump**:
The component in `apps/imap/src/connection.ts` (the existing
`ImapConnection` class, post-deepening shrunk from 1106 LOC to ~150)
that owns the socket lifecycle, line buffering, literal absorption,
and active-session tracking. Receives bytes from the TLS / TCP socket,
parses lines through `parser.ts`, calls the **IMAP command walker** to
dispatch one-shot commands, starts long-running sessions, routes
subsequent client lines / literal bytes to the active session if any,
writes session-emitted lines back to the socket, calls `session.cancel()`
on socket close. The pump never knows what an IMAP verb means; that
lives in modules. The buffer is utf-8 decoded today — a Buffer-mode
rewrite for 8-bit APPEND bodies is tracked as separate correctness
debt and not blocked on this deepening.
_Avoid_: IMAP server (that's `server.ts` — the TLS bootstrap and
per-IP accounting), IMAP connection alone (the class keeps that name;
"pump" names the *role* the post-deepening class plays).

**IMAP command walker**:
The dispatcher at `apps/imap/src/commands/walker.ts` that owns the
typed per-verb registry `Record<ImapVerb, ImapCommandModule>` and the
parse-and-start handoff from the pump. One entry point —
`dispatch(deps, state, parsedLine, send) → CommandSession` — looks up
the module by `parsedLine.command`, calls `module.parseArgs` (returning
a session that immediately emits BAD on parse error), then
`module.start`. Sessions track themselves until `completion` resolves.
The CAPABILITY-line string is also assembled here from the registered
modules' `capabilities?` declarations, so adding a new capability is one
module edit. Mirrors the **Step walker** (automations) and **Agent
walker** (inbox agent pipeline) shapes: typed dispatch table, pure
modules, walker owns lifecycle plumbing.
_Avoid_: IMAP dispatcher (collides with the Convex-side **Webhook
dispatcher**), Command router (overloaded), IMAP command executor (we
deliberately renamed the automation `stepExecutor.ts` to `stepWalker.ts`
in ADR-0004 for the same reason — "walker" names the dispatch role).

## Sending reputation

**Reputation scope**:
The granularity at which bounce/complaint reputation is tracked: `org`
(deployment-wide, the singleton instance) or `domain` (one per sending
**Domain**). A single delivery event updates the `org` window always and
the `domain` window when the event carries a sending domain — ISPs judge
reputation per domain, so both views matter. Stored as a `scope`
discriminator + optional `domain` on the unified `sendingReputation`
table; the pre-deepening split into a separate `domainReputation` table
is collapsed (same columns, one scope key).
_Avoid_: Reputation level (collides with the derived `riskLevel`),
Reputation period (names the daily bucket, not the granularity).

**Sending reputation (module)**:
The module at `convex/analytics/sendingReputation.ts` that owns the
rolling-window reputation table and is its only writer. Two
responsibilities behind one small interface:
- `recordEvent({ eventType, domain? })` — the only writer. Buckets the
  event by UTC day at each **Reputation scope** (org always; domain when
  present), then summarizes the `org` scope and, when its derived risk
  reaches `high` / `critical`, asks the **Abuse status (module)** to
  transition (`warned` / `suspended`). The single place the enforce
  decision lives — the pre-deepening duplicate trigger in
  `updateRiskLevel` is gone. Domain buckets are recorded for the
  per-domain dashboard only; Abuse status is a deployment-level state,
  so domain risk never independently enforces.
- `summarize(reader, scope)` — the only summarizer of the rolling 30-day
  window: sums the day buckets and derives `bounceRate` /
  `complaintRate` / `riskLevel` (via the pure `calculateRiskLevel`).
  Reader-typed so the public auth-shell reads
  (`reputationQueries.getSendingOverview` / `getDomainReputations`) and
  the platform-admin reads (`platformAdmin/queries.ts`) all cross the
  same seam — the shell-vs-engine split the **Listing engine** uses
  (ADR-0037). Derived rate/risk is computed on read, never stored: the
  pre-deepening per-bucket cache (written by the writers, recomputed
  independently by every reader, and read stale off "the latest bucket"
  by platform admin) is removed, and the dead `listByRiskLevel` /
  `listDomainsByRiskLevel` queries + their `by_risk_level` index go with
  it.

One producer today: the **Send lifecycle (module)**'s `reputation_update`
effect (the sole caller). The module is upstream of the **Abuse status
(module)** — one of that module's three internal writers (ADR-0011) — and
never reads or writes `abuseStatus` itself. The hourly cron is now
cleanup-only: it ages out buckets older than 60 days across *both*
scopes, closing the pre-deepening asymmetry where org buckets were pruned
but domain buckets grew unbounded.

Closes the scatter: five copies of the "sum the 30-day window → derive
rate → classify risk" loop (two writers, the cron, two public reads)
collapse to one `summarize`; the verbatim org/domain writer twins
collapse to one scope-parametric `recordEvent`.
_Avoid_: Reputation tracker (vague), Reputation analytics (it's a sending
control that auto-suspends, not a report), Deliverability module
(overbroad — warming and DNS verification are separate concerns).

## Abuse

**Abuse status**:
The org-level enforcement state stored at `instanceSettings.abuseStatus`:
`clean | warned | suspended | banned`. Severity-ordered: `clean = 0,
warned = 1, suspended = 2, banned = 3`. Internal writers (reputation
enforcement, MTA circuit breaker) can escalate up the ladder and reset
down to `clean` (auto-recover) — they cannot move laterally (e.g.,
`suspended → warned`). `banned` is terminal for internal writers;
only platform-admin override can leave it. The legacy `throttled`
literal is dropped (pre-prod schema change) — it never gated anything
in the **Abuse gate (module)**, so the codebase was silently treating
it as `warned` already. The MTA circuit-breaker path (`internal.circuit_breaker_tripped`
in the Webhook dispatcher) re-targets to `warned`.

Companion fields written atomically with the status:
`abuseStatusReason` (free-text), `abuseStatusChangedAt`,
`abuseStatusChangedBy` (admin user id or `'system'` / sub-tag like
`'mta_circuit_breaker'`).
_Avoid_: Org status (overloaded with verification/billing state),
Sending status (collides with `Send status`), Suspension state (names
one literal).

**Abuse status (module)**:
The module at `convex/organizations/abuseStatus.ts` that owns
*writes* of `abuseStatus` and its companion fields. Mirrors the
**Outbound lifecycle** shape — typed `TransitionInput` discriminated
by `to`, a severity-ordered `LEGAL_EDGES` graph (above), a reducer per
kind returning `{ patch, effects, applied }`, and a `TransitionOutcome`
reporting `ok | reason` for illegal / no-op (severity downgrade) /
terminal-without-override attempts. Two entry points:
- `transition({ to, reason, changedBy })` — internal-writer path,
  enforces severity rules (no lateral moves, no demotes except to
  `clean`, no escape from `banned`). Three internal callers:
  the **Webhook dispatcher** for `internal.circuit_breaker_tripped`
  events, `analytics/sendingReputation.ts:autoEnforceReputation` for
  rolling-stats enforcement, and any future internal escalator.
- `adminOverride({ to, reason, changedBy })` — admin-only path,
  bypasses all severity rules. Only caller: `platformAdmin/mutations.ts:
  setOrganizationStatus` (auth-gated by `requirePlatformAdmin`).

Effects:
- `audit_log(action, ...)` — fires on every transition, not only on
  the admin path. Closes the silent drift bug where internal escalations
  (circuit breaker, auto-enforcement) wrote `abuseStatus` without an
  audit-log row.
- `notify_admin(status, reason)` — placeholder; intentionally not
  wired today. Lands when the admin-notification surface ships.

Replaces the open-coded `setAbuseStatusInternal` in
`organizationSettings.ts:446-495`, the bypass writer in
`analytics/sendingReputation.ts:autoEnforceReputation:247-260` (which
patched directly with a divergent severity rule), and the admin
mutation in `platformAdmin/mutations.ts:setOrganizationStatus:39-44`.
Closes drift bugs: the `autoEnforceReputation` bypass (different
severity rule for the same domain), the three open-coded `banned`-terminal
checks (lines 469, 244, plus implicit in the gates), and the missing
audit-log effect on internal escalations.
_Avoid_: Abuse lifecycle (lifecycle is the shape, not the noun), Abuse
enforcement (overloaded — that's what the *callers* do), Abuse manager
(vague).

**Abuse gate (module)**:
The module at `convex/organizations/abuseGate.ts` that owns *reads*
of `abuseStatus` for sending-allowed predicates. Sibling of the
**Abuse status (module)** (reads vs writes). Exports two functions:
- `requireSendingAllowed(ctx)` — fetches `instanceSettings` and
  throws `ConvexError` on `suspended | banned`. Used in mutation
  hot paths (campaign send, transactional send).
- `isSendingAllowed(status)` — pure predicate over a status value.
  Used in actions and HTTP handlers that already have the status in
  hand from a prior query.

Encodes the canonical gate semantics in one place: today's "warned
and clean both pass, suspended and banned both block" stays unchanged;
the legacy `throttled` literal is no longer in scope (dropped from
the value union). Future product decisions about what `warned` means
operationally (rate-limit reductions, campaign-only blocks, etc.)
land here as additions to the predicate surface — the writers don't
need to know.

Replaces the existing `lib/abuseHelpers.ts` (which had the same two
functions but lived under `lib/` rather than co-located with the
status module). Six call sites move: `emails.ts:79`, `emails.ts:413`,
`transactionalApiHttp.ts:173`, plus any future send-path gate.
_Avoid_: Abuse predicates (clinical), Sending gate (gates exist for
many reasons; this one is specifically abuse-driven), Abuse helpers
(the file's current name; the deepening renames it).

## Organization settings

**Organization settings (module)**:
The module at `convex/organizations/settings.ts` that owns the singleton
`instanceSettings` row's *settings* surface — `emailTheme`, `timezone`,
`defaultFromName`, `defaultFromEmail`, and any future org-level
configuration that isn't a feature flag or an abuse-status column.
Sibling of the **Abuse status (module)**, the **Feature flags (module)**,
and the **Organization deletion (module)** — all four modules write
disjoint columns on the same singleton row. The schema table stays
`instanceSettings` (one physical row); the modules are split by *what
concern owns each column*, not by table.

Four entry points:
- `get(ctx)` — public query; org-member auth. Returns the full row or
  `null`. The dashboard organization-settings page, email-theme editor,
  and `useOrganizationContext` composable all read through this.
- `update(ctx, args)` — public mutation; `settings:manage` permission
  (owner/admin). Upserts on first call. Pre-deepening drift: the two
  `update` mutations had divergent permission rules — the
  `organizationSettings.update` shell required `settings:manage` but
  the active `instanceSettings.update` only required a session,
  silently letting any org member edit theme/from-email. Unified here.
- `remove(ctx)` — public mutation; owner-only. Schedules the
  **Organization deletion walker**'s `start()`. The deletion module-
  family is the only writer of the wipe; this entry is the public
  shell (auth + scheduler call + synchronous response).
- `createInternal(ctx, args)` — internal mutation; no auth (called by
  `seedAdmin.ts`). Idempotent: skips if a row already exists.

Replaces the duplicate `get`/`update`/`create` pair across
`convex/instanceSettings.ts` and `convex/organizationSettings.ts`. Both
files are deleted. Closes the permission-divergence bug above; deletes
the dead-code `organizationSettings.create` (zero callers; bootstrap
goes through `createInternal`) and `instanceSettings.getAbuseStatus`
(zero callers; the **Abuse gate (module)** reads the row directly).

The module does *not* own: the `abuseStatus` column (writes by the
**Abuse status (module)**, reads by the **Abuse gate (module)**); the
`featureFlags` map (writes and reads by the **Feature flags (module)**);
the row's eventual delete (owned by the **Organization deletion
walker** as its terminal `instanceSettings` step). The four modules
share the row; they do not share the writer set.
_Avoid_: Instance settings (module) (the singleton table is named
`instanceSettings` but the concept is the organization — same naming
discipline as the **Organization deletion (module)**), Org settings
(module) (drops "Organization" — follow the
[[project_single_org_per_deployment]] memory note's "Organization" not
"Org"), Organization config (module) (vague).

## Feature flags

**Feature flags (module)**:
The module at `convex/organizations/featureFlags.ts` that owns the
singleton `instanceSettings.featureFlags` map — the per-deployment
toggle surface for product surfaces (e.g. `ai.agent`,
`campaigns.archive`, `inbox.codeTasks`). Sibling of the **Organization
settings (module)**; they write disjoint columns on the same row but
answer to different permission audiences (settings: `settings:manage`;
flags: `requireAdminContext`).

Five entry points:
- `getFeatureFlags(ctx)` — public query; no auth (the resolved flag
  map drives nav rendering on the pre-auth setup page). Returns the
  cascaded `FeatureFlagState` from `resolveFlags(stored)`.
- `getResolvedFlags(ctx)` — internal query; same body as the public
  query, callable from actions.
- `setFeatureFlag(ctx, { flag, value })` — admin mutation. Applies
  cascade rules (`requires` + `cascadesOff`) via `applyToggle`. Carries
  the per-flag side-effect surface — today: an explicit `false → true`
  toggle of `ai.agent` kicks off the one-shot knowledge-graph backfill
  (gated by the absence of any prior backfill job). Cascade-driven
  enables do NOT trigger the backfill — the explicit-only semantic is
  load-bearing for "first time only" behavior. Future per-flag side
  effects land here, not next to theme/from-email CRUD.
- `setFeaturePack(ctx, { pack, value })` — admin mutation. Toggles
  every flag in a pack at once; cascade rules apply per flag.
- `setAllFeatureFlags(ctx, { flags })` — admin mutation. Setup wizard
  uses this on first-run apply; replaces the entire map after cascade
  resolution.

Pre-deepening, all five entry points lived in
`convex/instanceSettings.ts` alongside theme/from-email CRUD — settings
and flags mixed in one file. Splitting co-locates flag changes with
each other and gives the per-flag side-effect surface a natural home.

Reads the underlying map via `lib/featureFlags.getStoredFlags(ctx)`
(unchanged); the catalog of valid flag keys lives in
`@owlat/shared/featureFlags` (`FEATURE_FLAGS`, `FEATURE_PACKS`,
`resolveFlags`, `applyToggle`, `applyPackToggle`).
_Avoid_: Flags (module) (collides with `ContentFlag` from the email
scanner), Toggles (module) (informal — the codebase says "feature
flag" throughout), Settings flags (module) (overloaded with non-flag
settings).

## Organization deletion

**Organization deletion (module)**:
The module-family at `convex/organizations/deletion/` that owns the
"delete every row this org has" pipeline triggered from the
**Organization settings (module)**'s `remove` entry. Replaces the 230-line
`deleteOrgBatch` switch at `organizationSettings.ts:205-437`. Mirrors
the **Step walker** (automations) and **Agent walker** (inbox)
shapes — typed dispatch table, pure per-table modules, walker owns
the batch loop semantics. Composed of:
- An **Organization deletion walker** at
  `convex/organizations/deletion/walker.ts` owning the public entry
  point, the ordered table list, and the self-scheduled
  `runStep({ table })` hop.
- N **Organization deletion step (module)**s at
  `convex/organizations/deletion/steps/<table>.ts`, one per
  table, each owning that table's per-batch delete semantics (and,
  for storage-bearing rows, the pre-delete storage purge).

Lifecycle delegation is intentionally narrow — for an org wipe, most
lifecycle `remove()` effects (audit-log writes, cache patches,
back-reference cleanups in other tables) are noise about to be wiped
moments later. Two tables delegate because their lifecycles do
something that *escapes* the org boundary:
- `contacts` step delegates to
  `permanentlyDeleteContactWithRelations({ decrementCount: false })`
  in `lib/contactMutations.ts` — single canonical cascade writer,
  closes the divergent-cascade bug where the pre-deepening
  `deleteOrgBatch` re-implements the contact cascade with subtly
  different semantics (hard-deletes `emailSends` rows instead of
  soft-marking with `deletedAt`).
- `domains` step delegates to
  `sendingDomainLifecycle.remove()` per row — fires
  `delete_with_provider` so SES / MTA-side identity is released.
  This is the *only* place where ordering inside the wipe is
  externally visible — failing to call `remove()` leaves
  provider-side records orphaned.

Every other step hard-deletes. Audit-log noise from delegated
lifecycle calls is acceptable because the `auditLogs` step is
positioned second-to-last in the ordered list — every audit-log row
written during the wipe (including the two delegate calls' rows) is
itself deleted by the end.

The ordered table list is the cascade order — reviewed in one file,
inserted-into when a new schema table lands. Position-sensitive
neighbours (storage-bearing leaves before parents; child tables
before parent tables; domain identities + tracking + reputation
before the `domains` step that delegates) live next to each other
in the list. The terminal step is `instanceSettings` (the singleton
row that owned the org's existence in the first place).

Replaces the open-coded switch + `getNextStep(step: string)` helper
+ `DELETION_STEPS: readonly string[]` constant in
`organizationSettings.ts`. Closes drift bugs:
- Silent contact-cascade divergence between the org-wipe path and
  the soft-delete cron path (today's switch hard-deletes contact-
  related sends; the canonical helper preserves them as soft-deleted
  for audit history — different semantics for the same cascade).
- Coverage gap: today's switch touches ~22 tables; a quick schema
  audit lists ~37 tables in scope. Tables missed today include
  `agentActions`, `inboundMessages`, `conversationThreads`,
  `mailMessages`, `mailboxes`, `mailDrafts`, `contentScanResults`,
  `knowledgeEntries`, `semanticFiles`, `providerHealth`,
  `providerRoutes`, the per-provider sending-domain identity
  tables, `trackingDomains`, `domainReputation`, `mediaAssets`.
  Each lands as one new **Organization deletion step (module)**.
- Storage-blob orphans: today's switch hard-deletes
  `transactionalSends` without purging
  `attachmentStorageIds` from Convex storage. Same gap for
  `mediaAssets`, `semanticFiles`, and any mail-attachment-bearing
  row. The per-table `purgeStorage?` hook on the
  **Organization deletion step (module)** closes these uniformly
  — each storage-bearing module declares the hook, the walker
  calls it before `db.delete(row)` inside the batch loop.
- Provider-side orphans: today's switch hard-deletes `domains`
  without calling `sendingDomainLifecycle.remove()` — SES / MTA-
  side identities are never cleaned up.
- Stringly-typed `step: v.string()` arg making missing-step-type
  a runtime not compile-time error.
- Duplicated "more-batch-in-step vs advance-to-next-step" branching
  per case in the switch (today: nine duplicated blocks; under the
  walker: one).

The module-family does *not* own: the public `remove` mutation (lives
on the **Organization settings (module)** at
`convex/organizations/settings.ts` — auth check, returns the "deletion
started" response, schedules the walker's `start()`); the
contact-deletion cascade itself (lives in
`lib/contactMutations.ts:permanentlyDeleteContactWithRelations`, the
delegated single canonical writer); the per-provider sending-domain
cleanup (lives in `domains.lifecycle.remove()` → per-adapter
`deleteFromProvider` from the **Sending domain provider adapter
(module)**); the `instanceSettings` row's settings columns
(theme / from-email / timezone — owned by the **Organization settings
(module)**) or `featureFlags` map (owned by the **Feature flags
(module)**); or the per-table list-side queries (each table's own files
retain their reads — the deletion module only writes).
_Avoid_: Org deletion (module) (drops "Organization" — the
single-org-per-deployment memory note settles the naming on the
full word; the table being walked is `instanceSettings` but the
*concept* is the organization), Instance deletion (module) (the
mutation says "Instance deletion started" colloquially, but
"organization" is the load-bearing noun for the data being wiped),
Organization wipe (module) (informal), Organization cleanup
(module) (overloaded with the daily soft-deleted-contacts cleanup
cron).

**Organization deletion walker**:
The action-and-internal-mutation pair at
`convex/organizations/deletion/walker.ts` that owns the
self-scheduled per-table dispatch loop. Two entry points:
- `start()` — internal mutation called by the **Organization settings
  (module)**'s `remove` entry. Schedules `runStep` for the first table
  in the ordered list. No batch work in this entry — keeps the public
  mutation's response synchronous.
- `runStep({ table })` — internal mutation. Looks up the
  **Organization deletion step (module)** for `table` via the typed
  registry, calls `module.deleteBatch(ctx)`, then self-schedules:
  `runStep({ table })` if the module reported `hasMore: true`,
  otherwise `runStep({ table: nextTable(table) })`. When `table` is
  the terminal `instanceSettings` and its batch resolves, deletes
  the singleton settings row and stops.

The typed `Record<OrganizationDeletionTable,
OrganizationDeletionStepModule>` makes a missing per-table
registration a compile error — the same `satisfies` discipline as
the **Send provider adapter (module)** and **Sending domain
provider adapter (module)** registries. The walker never branches
on the table name — table-specific work lives entirely behind the
step-module seam. Mirrors the **Step walker** shape (per-step
modules, walker owns lifecycle plumbing) and the **Agent walker**
shape (typed dispatch table, self-scheduled `runStep` hop).
_Avoid_: Org deletion dispatcher (collides with the Convex-side
**Webhook dispatcher**), Deletion pipeline (collides with the MTA
**Dispatch pipeline (module)** vocabulary — the walker is a single
linear flow, not composed of typed `Phase`s with input-typed ctx),
Org deletion executor (we deliberately renamed the automation
`stepExecutor.ts` to `stepWalker.ts` in ADR-0004 for the same
reason — "executor" doesn't signal the dispatch role), Deletion
runner (vague), Org wipe action (informal).

**Organization deletion step (module)**:
A per-table module at
`convex/organizations/deletion/steps/<table>.ts` exporting an
`OrganizationDeletionStepModule`: `table` (the literal-union
discriminator), `batchSize?` (default 100), `deleteBatch(ctx) → {
deletedCount, hasMore }` (one batch of rows; the boolean tells the
walker whether to re-fire the same step), and an optional
`purgeStorage?(row, ctx)` hook called by the module's own
`deleteBatch` before each `db.delete(row)` on tables carrying
storage references (`mediaAssets.storageId`,
`semanticFiles.storageId`, `transactionalSends.attachmentStorageIds`,
`mailMessages.attachments[].storageId`, etc.). Modules either
hard-delete (the common case) or delegate to a lifecycle's
`remove()` (the two-table exception above) — the choice is
internal to each module; the walker doesn't see the difference.
Modules never know the order — they don't peek at sibling tables,
they don't assume children/parents have been cleared. If they
*depended* on ordering (e.g. the `contacts` step assuming
`emailSends` was already empty so the cascade helper's
soft-delete loop is a no-op), that assumption lives in the
*walker's ordered list*, not in the module — making the assumption
local-but-fragile would silently break under a list reshuffle.

Adding a new table to the schema is a one-file change: new
`steps/<table>.ts`, one new entry in
`ORGANIZATION_DELETION_STEPS` (the walker's registry), one literal
added to `OrganizationDeletionTable`, one position chosen in the
ordered list. The compile-time `satisfies` check on the registry
catches missing methods. Forgetting the registry entry is a
compile error.
_Avoid_: Deletion step alone (collides with the automation
**Step** and the **Agent action** vocabulary that already overload
"step"), Table deletion module (names the verb at the wrong level
of abstraction — every database write is a table write), Org
deletion task (collides with `codeWorkTasks` and the agent-pipeline
vocabulary).

## Automations

**Automation**:
A user-defined workflow that fires on a triggering event (contact created,
contact updated, event received, topic subscribed) and runs a sequence of
**Step**s against the triggering contact. Stored in `automations` with
ordered child rows in `automationSteps`; each run is an `automationRuns`
row carrying `currentStepIndex` and `status`. Triggers and Steps and
Conditions each have their own module family (below).
_Avoid_: Workflow (overloaded), Sequence (already used for transactional
email translations), Automation engine (vague — name the moving part).

**Automation status**:
The current state of an Automation at `automations.status`:
`draft | active | paused`. Legal edges:
- `draft → active` (activate — validates trigger config and requires
  ≥1 `automationSteps` row)
- `active → paused` (pause — leaves in-flight `automationRuns` alone;
  they continue stepping to completion. New trigger fanouts are blocked
  because **Trigger fanout** filters on `status === 'active'`)
- `paused → active` (resume — re-validates trigger config, closing the
  silent drift where a paused automation could go stale while the
  referenced topic / property was deleted)
- `paused → draft` (revert to draft for re-editing; new edge added
  with the **Automation lifecycle (module)**)

`active → draft` is refused as `illegal_edge` — admins must `pause`
first. No terminal states; every status can leave via the above edges.
Companion fields written atomically with the status by the
**Automation lifecycle (module)** reducer: `activatedAt` (set on the
first `draft → active` only — preserves "first activated" history
through later pause/resume cycles, same pattern as `verifiedAt` on
**Sending domain**; cleared on `→ draft`), `pausedAt` (set on
`→ paused`, cleared on `→ active` and `→ draft`), and `updatedAt`.

The four stats counters (`statsEntered`, `statsActive`,
`statsCompleted`) are lifetime — they persist through revert-to-draft
cycles. Stats *increments* live in the **Trigger fanout** and in
`stepExecutorQueries.ts:completeAutomationRun` /
`cancelAutomationRun`; the lifecycle owns *no* stats writes — same
split as Campaign lifecycle (which zeroes stats on `→ sending`) vs
Send lifecycle (which bumps the per-recipient counters).
_Avoid_: Automation state (vague — collides with the per-run
`automationRuns.status`), Workflow status (overloaded with workflow
as a noun), Automation lifecycle status (mixes the value with the
module-family suffix).

**Automation lifecycle (module)**:
The module at `convex/automations/lifecycle.ts` that owns transitions
of `automations.status`. Mirrors the **Campaign lifecycle (module)**
shape — typed `TransitionInput` discriminated by `to`, a `LEGAL_EDGES`
graph (above), a private reducer per kind returning `{ patch, effects,
applied }`, and a `TransitionOutcome` reporting `ok | reason` for
illegal / precondition-failed / not-found attempts. Single entry point
`transition({ automationId, input })`; no external-key entry —
automations are identified by their own `Id<'automations'>`.

Effects:
- `audit_log(action, automationId, userId, details)` — fires on every
  transition including idempotent self-loops. New audit actions added
  to the catalog at `auditActions/catalog.ts`:
  `automation.activated`, `automation.paused`, `automation.resumed`,
  `automation.reverted_to_draft`. Closes the silent drift where every
  pre-deepening `activate` / `pause` / `resume` mutation wrote
  `automations.status` with zero audit-log coverage — the only
  lifecycle in the codebase missing it.
- `track_event(event, automationId, userId)` — fires
  `automation_activated`, `automation_paused`, `automation_resumed`,
  `automation_reverted_to_draft`. Closes the PostHog drift where the
  pre-deepening `resume` mutation silently skipped `trackEvent`
  (`automations.ts:408-430` had no `trackEvent` call while `activate`
  and `pause` did).

Preconditions enforced inside the `→ active` reducer (returned as
`{ ok: false, reason }` rather than thrown):
- `no_steps` — the automation has zero `automationSteps` rows.
- `invalid_trigger_config` — the trigger config is missing for a
  trigger kind that requires it (`contact_updated`, `event_received`,
  `topic_subscribed`). Re-validated on every `→ active` including
  `paused → active`, closing the silent drift where the pre-deepening
  resume path skipped validation.

Replaces the open-coded `ctx.db.patch(automation, { status: ... })`
writes in `automations/automations.ts:333-430` (activate / pause /
resume). Introduces a new `revertToDraft` public mutation for the
`paused → draft` edge that did not exist pre-deepening.

The module does *not* own: row creation (the `create` mutation and
`duplicate` mutation stay as direct CRUD inserts at `status: 'draft'`
— same split as Campaign lifecycle vs Campaign create), row deletion
(`remove` mutation stays where it is, refusing `active` automations),
`updateTrigger`'s `status !== 'draft'` field-level write gate (stays
in the CRUD shell — it's a write guard, not a transition),
`assertFeatureEnabled('automations')` gating (per-shell concern, same
as every other lifecycle), stats deltas (driven by **Trigger fanout**
and run-completion, not by parent status), or the `automationRuns` /
`automationStepRuns` machines (each is its own state space; an
in-flight run is unaffected by parent `pause`).
_Avoid_: Automation status module (collides with **Automation status**
the value), Automation engine (vague — names the entire concept, not
the transition surface), Automation reducer (names one part of the
shape), Automation state machine (collides with the
`automationRuns.status` and `automationStepRuns.status` siblings).

**Step**:
One row in `automationSteps`. Has a `kind` (`email | delay | condition`),
a `config` blob whose shape varies by kind, and a `stepIndex` defining
sequential order within the automation. The condition step also writes
`yesBranchStepIndex` / `noBranchStepIndex` into its config for non-
sequential flow.
_Avoid_: Node (graph terminology — too generic), Action (overloaded with
audit actions from ADR-0002).

**Step module**:
A Step's full surface, physically split into two halves — same rationale as
Block module:
- **Walker half** — `apps/api/convex/automations/steps/<kind>/index.ts`
  exporting a `StepModule<T, C>`: `parseConfig`, `execute(ctx, args) →
  StepOutcome`, optional `entryDelay(config) → ms` (only `delay`
  implements).
- **Editor half** — `apps/web/app/composables/automations/steps/<kind>/index.ts`
  exporting a `StepEditorModule<T, C>`: label, description, color,
  `createDefault`, `validateForActivation`, `getDescription`, and an
  `EditorComponent` for the settings panel.

Both halves are keyed by `kind` and dispatched by the **Step walker**
(executor side) or the typed `StepEditorModuleMap` (editor side). Adding
a step kind means adding both halves and an entry to the `StepKind`
union.

**Step outcome**:
What a step module's `execute` returns:
`{ status: 'completed'; emailSendId?; nextStepIndex? } | { status:
'failed'; error }`. `nextStepIndex` overrides the walker's default
`currentStepIndex + 1` — only the `condition` step uses it for branching.
The walker is responsible for marking the step run record, scheduling
the next step, and applying retry policy. The module is responsible only
for the per-kind execution semantics.
_Avoid_: Step result (already used elsewhere for run-record fields).

**Step walker**:
The action at `apps/api/convex/automations/stepWalker.ts` that owns the
per-step execution loop: pulls the run + contact, marks the step
executing, dispatches to the **Step module**, applies the **Step
outcome**, schedules the next step (using the next module's
`entryDelay`), and handles retry. Replaces the old per-kind `if`
chain + the three look-ahead-delay copies in `stepExecutor.ts`.
_Avoid_: Step executor (the name of the file that became this — too
generic, doesn't signal the dispatch role).

**Trigger module**:
A per-trigger-kind module at
`apps/api/convex/automations/triggers/<kind>/index.ts` exporting
`{ kind, parseConfig?, matches(input, config), buildTriggerData?(input,
config) }`. The matching predicate is one to three lines; the
~40-line ceremony around it (query automations, skip-if-in-progress,
skip-if-no-steps, create run, patch stats, schedule walker) belongs to
the **Trigger fanout**, not the module.

**Trigger fanout**:
The internal mutation `fireTrigger(ctx, kind, input)` at
`apps/api/convex/automations/triggers/index.ts` that takes a trigger
kind + a typed input, looks up the **Trigger module**, evaluates
`matches` per active automation, and performs the ceremony to create
a run. Replaces the five near-identical fire mutations
(`fireContactCreatedTrigger`, `fireContactUpdatedTrigger`,
`fireEventReceivedTrigger`, `fireTopicSubscribedTrigger`) plus the
sixth inline copy in `sendEvent`. Mirrors the **Webhook event
fanout** vocabulary from ADR-0003.
_Avoid_: Trigger handler (too generic — that name still applies to the
per-source-of-events shell, not the per-kind fanout).

**Condition**:
The canonical shape used by both segment evaluation and the automation
`condition` step. Discriminated union:
- `{ kind: 'contact_property'; field; operator; value }` — `operator` ∈
  `equals | not_equals | contains | not_contains | gt | lt | gte | lte
  | is_empty | not_empty`.
- `{ kind: 'email_activity'; field: 'opened' | 'clicked';
  operator: 'is_true' | 'is_false' }`.
- `{ kind: 'topic_membership'; topicId; operator: 'equals' | 'not_equals' }`.

One persisted shape across segments (`segments.filters[].condition`) and
automation condition steps (`automationSteps.config.condition`). Replaces
the divergent automation schema (`propertyKey`, `greater_than`,
`is_set`, `emailActivity`) — those names migrated to the canonical
segment vocabulary in ADR-0004.
_Avoid_: Filter (overloaded with UI table filters), Predicate (too
abstract).

**Condition type module**:
A per-condition-kind module at
`apps/api/convex/conditions/<kind>/index.ts` exporting `{ kind,
parseCondition, preloadLookup(ctx, conditions[]) → Lookup,
evaluate(condition, contact, lookup) → boolean }`. Operators applicable
to the kind live inside the module — there is no global operator switch.
Used by the segment evaluator (batched preload across many contacts)
and by the automation `condition` step (preload of one, evaluate
against one contact). This is the *evaluator half*; the editor half is
the **Condition editor module**.
_Avoid_: Condition module alone (collides with **Condition** the value),
Condition evaluator (names the verb, not the unit).

**Condition editor module**:
The editor half of a Condition type module, at
`apps/web/app/composables/conditions/<kind>/index.ts`. Exports `{ kind,
label, description, createDefault(ctx) → ConditionOfKind<K>,
validateForSubmit(condition) → string | null,
getDescription(condition, ctx) → string, EditorComponent }`. The
`EditorComponent` is a Vue component accepting
`modelValue: ConditionOfKind<K>` plus `variant: 'row' | 'panel'` —
`row` is the compact segment-modal table layout, `panel` is the
automation condition step's settings popover. Both halves are keyed by
`kind` and dispatched by the typed `ConditionEditorModuleMap`. Adding a
condition kind means adding both halves (backend Condition type module +
frontend Condition editor module) and updating the `Condition` union.
Consumed by both the segment filter editor (`segments/index.vue` via
`useSegmentFilters`) and the automation condition step editor — neither
consumer holds per-kind editor knowledge directly.
_Avoid_: Condition editor (names the verb), Condition editor walker
(the walker is the dispatch; this names the unit).

**Condition editor context**:
The reactive reference-data bag (`contactProperties`, `topics`, etc.)
that top-level consumers provide and Condition editor modules inject via
`useConditionEditorContext()`. Consumers (segment modal, automation
step panel) fetch the data once at their root and provide it; modules
read what they need. Closes the "every kind's editor triggers its own
query subscription" failure mode and opens a future seam for role-based
filtering of available kinds.
_Avoid_: Filter context (collides with UI table filters), Editor props
(too generic).

## Segments

**Segment**:
A computed audience defined by a set of **Condition**s combined with
`AND`/`OR` logic, stored in `segments` with `filters: { logic,
conditions[] }` and a denormalized `cachedCount` (refreshed by the
`refreshSingleSegmentCount` fire-and-forget task on create/update and the
`refreshAllSegmentCounts` 30-minute cron). Distinct from a **Topic** —
a Segment has no membership table; its members are whoever matches *now*.
One of the two **Audience** kinds (`{ kind: 'segment', segmentId }`); the
**Audience resolution (module)** materializes it into recipients at send
time, freezing the `filters` into `frozenFilters` so an already-sent
Campaign reproduces the definition it targeted.
_Avoid_: List (legacy **Topic** terminology), Filter (overloaded with UI
table filters — that names the `filters` field, not the Segment), Dynamic
list (verbose; "Segment" is the established noun).

**Segment matching (module)**:
The module at `apps/api/convex/conditions/segmentMatch.ts` that owns the
single mapping from a stored filter set to the **Contact**s that match —
the layer above per-**Condition** evaluation. Two layers:
- **Pure core** — `parseSegmentFilters(input) → ParsedSegmentFilters`
  (normalizes the stored `string | { logic, conditions[] }` shape through
  the conditions registry; *throws* on corrupt filters, since they are
  storage-validated — a parse failure is corrupt data, not user input)
  and `makeSegmentPredicate(filters, lookup) → (contact) => boolean`
  (empty conditions match every Contact; otherwise short-circuit AND/OR
  over `evaluateOne`). The predicate is synchronous and pure — the test
  surface.
- **Lenient async conveniences** for the preview / count / cron paths,
  which bake in the live-**Contact** scan (`notSoftDeleted`) and treat a
  corrupt filter as a zero match: `countLiveMatches`, `matchLiveContacts`
  (optional `limit`), and `countLiveMatchesForSegments` (one preloaded
  lookup + one Contact scan shared across many Segments — the cron's
  batch path).
- `evaluateAgainstContact(ctx, conditions, logic, contact)` — the
  single-Contact case, used by the automation `condition` step.

The two-layer split is load-bearing: the **Audience resolution (module)**'s
segment branch and the multi-Segment cron consume the *pure predicate* (so
they can interleave eligibility filtering / share one scan and lookup
across Segments), while the simple preview/count callers want the
conveniences. The send path does NOT use the lenient conveniences — it
composes the pure core so it can log-and-resolve-zero on corrupt filters
(a silent zero means a Campaign reaches nobody) rather than swallow.

Replaces the five open-coded copies of "preload lookup → per-Contact
AND/OR combine": `lib/segmentEvaluation.ts:evaluateSegmentCount` and
`:evaluateMultipleSegments` (now thin wrappers — the names stay because
ADR-0033 relies on them), `segments.ts:getMatchingContactsByTeam` (the
preview — fixing both its soft-deleted-Contact leak and its N×M
size-one-preload), the segment branch of
`campaigns/audienceResolution.ts`, and the prior
`conditions/index.ts:evaluateAgainstContact`. The combine logic and the
empty / corrupt / live-Contact decisions now live in one place.

The module does *not* own: the per-**Condition** primitive (`evaluateOne`
/ `preloadConditionsLookup` stay in the conditions registry), the
eligibility predicate (email-present, suppression, DOI — that is the
**Audience resolution (module)**'s `selectRecipient`), the `segments` CRUD
or `cachedCount` refresh scheduling (stay in `segments.ts`), or the
`frozenFilters` snapshot write (the Campaign send orchestrator).
_Avoid_: Segment evaluation (module) (ADR-0033 parked "Segment
evaluation" as a name because the **Audience** also covers **Topic
membership**; this module is the segment/Condition half only, so
"matching" names the operation without claiming audience resolution),
Condition matching (module) (it matches a *set* of Conditions against a
population, not one Condition — and "Segment" is the domain noun the
filters belong to), Segment matcher (names the returned predicate, not the
module).

## Public endpoints

**Public token endpoint (module)**:
The factory at `convex/lib/publicTokenEndpoint.ts` that owns the shell
around every public, token-keyed, no-session `httpAction` — the path
from a Convex `httpAction` registration to a typed handler signature.
Mirrors the **API-key endpoint** factory (`createAuthenticatedHandler`
at `convex/auth/apiAuth.ts`) — sibling factories, one per auth posture,
both consuming the shared response helpers at
`convex/lib/httpResponse.ts`. Not a lifecycle in the **Outbound
lifecycle** sense; the shell wraps one request/response and exits.

Single entry point:
- `publicTokenEndpoint({ path, method, rateLimit, cors?, body?,
  resultMode }, handler) → httpAction` — declarative route + typed
  handler. The shell extracts the token, runs the rate-limit gate,
  parses the body, and invokes the handler with a typed
  `{ token, body, request }` context. The handler returns a typed
  result; the shell maps it to HTTP per `resultMode`.

Configuration:
- `path`: pattern with named segments (`/unsub/:token`,
  `/prefs/update/:token`, `/confirm/doi`). A small in-module matcher
  (~20 LOC, rolled in-tree — no `path-to-regexp` dep) extracts named
  params. When the path declares no `:token` segment the shell falls
  back to `?token=` (the DOI confirm path). Path-positional indexing
  (`pathParts[2]`) is the bug class it closes.
- `method`: `'GET' | 'POST'`. Other methods short-circuit with 405
  before the handler runs.
- `rateLimit`: a `PublicRateLimitKind` literal —
  `'subscriptionManagement' | 'doiConfirmation' | 'formSubmission' |
  'emailTracking'`. Shell invokes `checkPublicRateLimit` keyed by
  `getClientIp(request)` and returns `rateLimitedResponse` on miss.
- `cors`: `'GET, OPTIONS' | 'POST, OPTIONS' | 'GET, POST, OPTIONS' |
  false`. Shell owns the `OPTIONS` preflight uniformly; `false` opts
  out (RFC 8058 one-click unsubscribe — not a browser-fetch path).
- `body`: `'none' | 'json' | 'formData'`. `'json'` parses and size-
  checks to 100 KB; `'formData'` accepts JSON / urlencoded / multipart
  with the same cap; `'none'` is the default. Body parse failure
  short-circuits with the locked envelope.
- `resultMode`: `'action' | 'outcome'`.

Result modes:
- `'action'`: handler returns
  `{ ok: true, data: T } | { ok: false, reason: string, status?:
  number }`. Shell maps `ok: false` to a 4xx (default 400) with the
  locked envelope `{ error: { message: reason, code: reason } }`. Used
  by one-click unsub, form submit, prefs update, DOI confirm.
- `'outcome'`: handler returns
  `{ ok: true, data: T } | { ok: false, reason: string }`. Shell maps
  both to HTTP 200 with `{ ok, data } | { ok: false, reason }`. The
  "200 on invalid token" verify endpoints land here naturally — a
  successful verification request that returns an "expired token"
  *result* is no longer pretended to be an HTTP error.

Locked response envelope: `{ error: { message, code } }` on action-mode
4xx; `{ ok, data | reason }` on outcome-mode 200; structured JSON only.
Closes the pre-deepening drift across `{ error: 'msg' }`,
`{ valid: false, error, reason }`, `{ success: false, error, reason }`,
and `{ error: { message, code } }`. Frontend callers in `apps/web`
migrate to the single shape in the same commit.

Replaces the open-coded shells at:
- `delivery/unsubscribeHttp.ts:10-88` (one-click POST)
- `delivery/unsubscribeHttp.ts:92-172` (verify GET)
- `delivery/preferencesHttp.ts:10-90` (verify GET)
- `delivery/preferencesHttp.ts:93-223` (update POST)
- `topics/doiHttp.ts:29-91` (verify GET — token in `?token=`)
- `topics/doiHttp.ts:97-158` (confirm POST — token in `?token=`)
- `forms/apiHttp.ts:125-241` (form submit POST — keeps multipart
  body parser)
- `shareLinkHttp.ts:11-85` (share GET)
- `campaigns/archiveHttp.ts:11-77` (archive GET)

Closes drift bugs:
- Path-positional indexing silently misbehaves when route prefixes
  change. Named segments enforce the contract at declaration.
- Error envelope drift across four flavors. Locked under one shape.
- CORS preflight drift: each shell hand-wires the methods list. The
  shell owns it once.
- `decodeURIComponent` discipline: most sites remember to call it but
  the form path pulls token via `pathParts[pathParts.length - 1]`
  without decoding.
- Rate-limit-kind-vs-route drift: today by convention; under the
  shell it's a typed param.
- 500-on-throw discipline scattered across sites with varying
  `logError` calls. Shell owns the catch.

The module does *not* own: the domain handler (each endpoint hands off
to a typed internal action/mutation — the **Form submission (module)**
at `forms/submission.ts`, the **DOI lifecycle (module)**, the
unsubscribe processor — those keep their independent intake / lifecycle
modules), auth (no API key, no session — the auth posture *is* the
token; an endpoint needing both API-key + token would compose this
shell with **API-key endpoint** rather than extend it),
graceful-on-rate-limit short-circuits (the tracking pixel and click
redirect short-circuit with a fallback response —
`delivery/trackingHttp.ts` stays open-coded; the "always return pixel /
always redirect" semantics is too narrow to deepen here),
`httpResponse.ts` (shared `jsonResponse`/`errorResponse`/CORS helpers
consumed by both this module and **API-key endpoint** — siblings, not
parent/child).
_Avoid_: Public endpoint shell (module) ("shell" isn't a noun the
codebase otherwise uses as a module type; "endpoint" is the role),
Token endpoint (module) (drops "public" — collides with future
token-authed admin paths), Public HTTP shell (overlaps with the
"shell" verbiage), Public intake (module) (collides with **Form
submission (module)** / **Contact import (module)** naming — those are
domain intakes, this is the transport-layer shell).

## Operation errors

The one vocabulary for "an operation could not complete," shared across the
thrown (in-app), HTTP, and SDK seams. See ADR-0036.

**Operation error**:
The canonical failure shape an operation returns — `{ category, message, data? }`.
_Avoid_: exception, failure, `ApiError`.

**Error category**:
The closed, lowercase classification of an **Operation error** (`forbidden`,
`not_found`, `invalid_input`, `already_exists`, `conflict`, `invalid_state`,
`rate_limited`, `limit_reached`, `unauthenticated`, `internal`, `network`)
that determines both HTTP status and UI treatment.
_Avoid_: error code, error type, the old `SCREAMING_SNAKE` `ConvexError` codes,
the lowercase `ErrorCodes` HTTP map.

**Operation module**:
The app-side owner that runs a backend call and maps its **Error category** to
UI treatment — `useBackendOperation` for writes, `useBackendQuery` for reactive
reads.
_Avoid_: mutation wrapper, `useConvexMutation`.

## Resource listing

The one read-side surface for "give me a filtered, searched, paginated,
counted page of <entity>." The counterpart to the write-side lifecycle
modules: where a lifecycle owns how an entity *changes*, listing owns how a
collection of them is *read*. A thin generic **Listing engine** dispatches
over per-entity **Listing descriptors**, mirroring the **Walker** /
**Block module** split — thin dispatcher, per-type data ownership. One
Convex-native cursor everywhere. See ADR-0037.

**Listing engine**:
The generic, auth-agnostic reader at `convex/lib/listing.ts` that turns a
**Listing descriptor** plus `{ search?, filters?, sort?, paginationOpts }`
into a uniform `{ page, isDone, continueCursor }` (the existing
`PaginationResult<T>` shape) plus the descriptor's **Facets**. Owns the
load-bearing policy every list query open-codes today: pick the cheapest
Convex access path (the search index when `search` is present, the browse
index otherwise), apply soft-delete, run per-row enrichment over the page,
and emit a single *real* Convex cursor. Takes a `DatabaseReader`, never a
session — auth stays in the calling shell, the same split lifecycle effects
use. Kills the `'search'`-sentinel cursor in `contacts.ts:list` (search
becomes genuinely multi-page) and the stringified-offset cursor in
`paginateArray`.
_Avoid_: Listing walker (it dispatches but walks no tree), query builder /
list helper (names the mechanism, hides that it owns the index + cursor
policy), pagination util (`paginateArray` / `countWithPagination` are the
primitives it subsumes at call sites).

**Listing descriptor**:
One entity's full read surface, declared as data: the search index (and its
`filterFields`), the browse index + the legal sort keys, whether the entity
is soft-deletable, the optional per-row `enrich`, and its **Facets**. The
unit the **Listing engine** consumes; one per listable entity (Contact,
Campaign, Email template, Topic, Segment, Automation). Shared by the
entity's `list` *and* its `get` for the enrichment half, so the two stop
duplicating it (today `topics.ts:list` and `topics.ts:get` both inline the
`contactCount` enrichment). Load-bearing interface fact it encodes:
**search results are relevance-ordered, so sort keys apply to the browse
path only** — passing `search` means relevance order, full stop. The
`enrich` cost (an O(1) cached field vs. a per-row scan) is the descriptor
author's stated responsibility, documented on the descriptor; the engine
runs it without hiding the cost.
_Avoid_: Listing module (collides with the two-half module-family pattern —
Block module, Step module — listing is single-runtime, has no editor half),
list config (undersells that it owns enrichment + facets), List schema.

**Facet**:
A named count the **Listing descriptor** declares alongside the page — the
total plus per-bucket breakdowns (`by status`, `by type`) the dashboards
render next to a list. Each facet names its count strategy, and exactly
three exist in the wild: an index count, a group-by over a small closed
bucket set, or a read of a denormalized cached counter (the contacts
cached-count path, which lives in a *different* table, `instanceSettings`).
Replaces the open-coded `countByStatus` / `countByType` group-by loops and
the bespoke `count` queries.
_Avoid_: stat (overloaded with analytics), count query (names one strategy),
aggregate (collides with the Postbox `outbound.state` aggregate-derivation).

## Relationships

- An **Operation error** carries exactly one **Error category**; the category
  fixes its HTTP status across all three serializations and its UI treatment
  via the **Operation module**.
- A listable entity (**Contact**, **Campaign**, **Email template**, **Topic**,
  **Segment**, **Automation**) has exactly one **Listing descriptor**; the
  **Listing engine** is the only reader of the search→filter→sort→paginate→
  count path. Search routes through the descriptor's search index (relevance-
  ordered); browse routes through its browse index (sortable). The engine takes
  a `DatabaseReader` — the session-auth shell (`contacts.ts:list`) and the
  API-key shell (`*/organization.ts:listByOrganization`) keep their own auth,
  the same effects-vs-shell split the lifecycle modules use. The descriptor's
  `enrich` is shared by the entity's `list` and `get`.
- A **Block** is implemented by exactly one **Block module** (one-to-one,
  keyed by `type`).
- The **Walker** dispatches to a **Block** based on `block.type`, applies
  wrapping based on **Placement**, and threads **Allotted width** through
  the render context.
- A **Send** has exactly one **Send status** at any time. Both kinds of
  Send (campaign + transactional) pre-create their row in `queued` — the
  worker-completion path is uniform across kinds; nothing skips the
  lifecycle. The **Send lifecycle (module)** is the only writer of that
  status; callers identify a Send via **SendRef** and ask the module to
  transition. Three producers of transition calls: the **Webhook
  dispatcher** for external events (provider message-id resolution), the
  **Send completion (module)** for workpool completions (typed SendRef in
  the callback context), and direct callers (open / click trackers). The
  **Send reads (module)** is the only place that reads Send-spanning
  queries keyed by SendRef (single Send + parent join, stats, provider-
  message-id lookup, contact-spanning history).
- A `mailMessage.outbound` row carries 1..N recipients, each with its
  own **Postbox outbound state**. The **Postbox outbound lifecycle
  (module)** is the only writer of any per-recipient state, and it is
  the only writer of the aggregate `outbound.state` (derived from the
  recipient array after every transition). The Send lifecycle and the
  Postbox outbound lifecycle both implement the **Outbound lifecycle**
  shape — same legal-edges + reducer + effects skeleton — but Postbox
  is the first lifecycle in the codebase to transition a *slice* of a
  row (one recipient) rather than the row itself; the Send lifecycle
  still transitions whole Sends. The aggregate-derivation step is unique
  to Postbox and lives inside the lifecycle's reducer; no caller writes
  the aggregate directly.
- An **Inbound adapter** produces **Inbound events** from one provider;
  the **Webhook dispatcher** routes them to domain mutations
  (`sendLifecycle.transition`, `inbox.messages.receiveMessage`,
  `webhooks.channels.processInboundChannel`, etc.). For the `email.*`
  kinds the dispatcher routes by `providerMessageId` prefix: `pb-`-prefixed
  ids go to the **Postbox outbound lifecycle**, everything else goes to
  the **Send lifecycle**. `channel.received` routes by the event's
  `channel` field to `processInboundChannel` (one dispatch entry covers
  all non-email channels — the per-channel fork lives in the adapter,
  not the dispatcher). An `email.bounced` Inbound event causes a Send
  lifecycle transition, which in turn calls **Webhook event fanout** with
  the matching `email.bounced` **Webhook event** literal — so the same
  word travels through inbound, lifecycle, and outbound without
  translation. (Postbox bounces are *not* fanned out
  to customer webhooks today — personal-mail events live behind the user
  UI, not the public webhook surface.)
- An **Automation** is triggered by exactly one **Trigger module** (keyed
  by the automation's `triggerType`). The **Trigger fanout** is the only
  caller of a Trigger module; per-trigger-kind fire mutations no longer
  exist. Each **Step** is implemented by exactly one **Step module**
  (one-to-one, keyed by `kind`). The **Step walker** dispatches to a Step
  based on `step.kind`, applies the **Step outcome** to advance or branch,
  and asks the *next* module for its `entryDelay` to schedule. The
  automation `condition` step is itself a Step module that *consumes* a
  **Condition type module** — the same module family the segment
  evaluator consumes — so the operator and field vocabulary are shared
  across the two evaluation paths. **Condition** is the persisted shape
  in both `segments.filters[].condition` and
  `automationSteps.config.condition`.
- A **Condition** has exactly one **Condition type module** (evaluator
  half, one-to-one keyed by `kind`) and exactly one **Condition editor
  module** (editor half, one-to-one keyed by `kind`). Both halves are
  dispatched by typed registries — adding a kind to one half without the
  other is a compile error. The segment filter editor and the automation
  condition step's settings panel both render `EditorComponent` from the
  same Condition editor module, differing only by the `variant` prop
  (`row` for the segment table, `panel` for the step popover). Each
  consumer provides a **Condition editor context** at its root;
  modules `inject` it instead of duplicating reference-data fetches.
- A **Contact** is identified by 1..N **Contact identities** (one row per
  `(channel, identifier)` pair). Identities are application-unique among
  live Contacts. On soft-delete of a Contact, its identities are
  hard-deleted (cascade) so the identifier is reclaimable on day 1 — the
  next inbound signal for the same `(channel, identifier)` creates a new
  Contact, not a re-link. The **Contact resolution (module)** is the
  only writer of identities at Contact-create time; `addIdentity` is the
  only writer of secondary-link identities afterwards. Four producers of
  resolution calls today: HTTP `POST /contacts` (`strict`),
  `inbox/messages.ts:receiveMessage` (`upsert`),
  `webhooks/channels.ts:processInboundChannel` (`upsert`), and
  `contacts/internal.ts:importContacts` (`upsert` per row when
  `handleDuplicates: 'skip'`, `merge` when `'update'`). Callers decide
  what `contactActivities` rows to insert based on the `action` field of
  the return value — the resolution module never touches activity logs.
- A **Contact** is created — at single-Contact granularity — by exactly
  one operation in the **Contact creation (module)**, which wraps the
  **Contact resolution (module)** and, on `action === 'created'`, fires
  the uniform created-effect trio: `incrementContactCount(ctx, 1)`, the
  `contact_created` automation trigger, and one `created` **Contact
  activity** whose `metadata.source` is the signal's `source`. Nine
  producers route through it: the four strict-mode mutations
  (`contacts/contacts.ts:create` + `createForTeam`,
  `contacts/organization.ts:createForOrganization` +
  `createForOrganizationInternal`) and the five upsert-mode paths
  (`inbox/messages.ts:receiveMessage`,
  `webhooks/channels.ts:processInboundChannel`,
  `transactional/dispatch.ts`, `forms/submission.ts:submit`,
  `automations/triggers.ts:sendEvent`). The module
  owns *only* the trio; callers keep their own domain effects on top
  (inbox's `inbound_received` activity, the form's submission row). It is
  created-effects only — its callers run `strict`/`upsert`, which never
  yield `action: 'updated'`. The **Contact import (module)** is the sole
  exception: it calls `resolveContact` directly and fires *one* batched
  `incrementContactCount(imported)` plus its own per-row composition
  (ADR-0019) — single-create goes through Contact creation, only import
  calls resolution directly (convention, not enforced). Closes the drift
  the scatter produced: `cachedContactCount` was never incremented for
  Contacts born via inbound email / channel webhook / transactional send
  / form / `sendEvent`, the `contact_created` trigger never fired for the
  four inbound paths (and fired ad-hoc in `sendEvent`), and the `created`
  activity was recorded by only one of the nine.
- A **Contact** has exactly one **DOI status** at any time. The
  **Contact resolution (module)** writes the initial `'not_required'`
  at Contact-create time; the **DOI lifecycle (module)** is the only
  later writer of `doiStatus` and its companions
  (`doiConfirmationToken`, `doiTokenExpiresAt`, `doiConfirmedAt`).
  Three producers of DOI transition calls today: the **Topic subscription
  (module)** (request side — `subscribe` / `subscribeMany` call
  `doiLifecycle.transition({ to: 'pending' })` when a Topic requires
  DOI and the Contact is not yet `confirmed`; this is the only request-
  side producer after the per-topic-mutation request calls were
  consolidated), `topics/topics.ts:confirmDoi` (confirm — token-keyed
  via the contact's DOI token), and `forms/endpoints.ts:confirmFormSubmission`
  (confirm — under the unified token namespace, looks up the form
  submission by token then delegates to `transitionByConfirmationToken`
  for the contact-side patch). `email.bounced` and other send-side
  events do *not* feed this lifecycle — DOI is a consent-grant state,
  not a deliverability state. The DOI lifecycle and the **Outbound
  lifecycle** share the *shape* (typed transitions + legal-edges +
  reducer + effects + an external-key entry point) but not the table;
  with the Send lifecycle, Postbox outbound lifecycle, and DOI lifecycle
  all instantiating that shape, the `Lifecycle<S, E, Eff>` factor
  question moves from "hypothetical" to "active design call" (see
  Outbound lifecycle entry).
- A **Topic membership** is created and removed by exactly one
  operation in the **Topic subscription (module)** — `subscribe` /
  `subscribeMany` for membership writes, `unsubscribe` /
  `unsubscribeMany` / `unsubscribeAllForContact` for removals. The
  module is the only writer of `contactTopics` and the only
  maintainer of `topics.cachedMemberCount`. Six producers of
  subscription calls today: `topics/topics.ts:addContact` (single-add
  public mutation), `topics/bulk.ts:addContacts` (bulk-add public
  mutation), `contacts/internal.ts:importBatchInternal` (batch import
  — gains the `skipDoi` knob it was missing pre-deepening),
  `topics/topics.ts:removeContact` (single-remove public mutation),
  `topics/bulk.ts:removeContacts` (bulk-remove public mutation), and
  `delivery/unsubscribeQueries.ts:processUnsubscribe` (public
  unsubscribe link). The form-submission path reaches the module
  through `addContact` (membership is inserted at submission time,
  before DOI confirmation); the pre-deepening `forms/endpoints.ts:
  confirmSubmission` fallback insert is deleted. The module's `source`
  discriminator (`'admin' | 'form' | 'import' | 'public_api' |
  'automation' | 'public_email_link' | 'preferences_page'`) is the
  one place where "which side effects fire for which trigger" lives
  — admin-remove now writes the `topic_unsubscribed` Contact activity
  row it was silently missing; public-link unsubscribe still owns the
  `formSubmissions.confirmedAt` clear, the `campaigns.statsUnsubscribed`
  increment, and the `topic.unsubscribed` **Webhook event** fanout.
  The relationship with the **DOI lifecycle (module)** is asymmetric:
  Topic subscription decides "is DOI needed?" and calls
  `doiLifecycle.transition({ to: 'pending' })` when so; the DOI
  lifecycle then owns the token + email send + (at confirm time) the
  `topic_subscribed` automation-trigger fanout for every DOI-required
  membership the Contact has at confirm time. Topic subscription
  never calls the confirm side of the DOI lifecycle — that's the
  confirm endpoints' job (token-keyed lookup of the Contact).
- A `formSubmissions` row is created and modified by exactly one
  operation in the **Form submission (module)** — `submit` for create
  (writing one of five status literals: `spam`, `invalid`, `duplicate`,
  `pending_confirmation`, or `success`), and `markConfirmedByToken`
  for the only post-create transition (`pending_confirmation →
  success`). The submit HTTP handler at `forms/apiHttp.ts` is the only
  caller of `submit`; the form-confirm HTTP handler at
  `forms/endpoints.ts` chains `doiLifecycle.transitionByConfirmationToken`
  → `submission.markConfirmedByToken` for the confirm path — each
  module owns its own table (DOI patches contact-side state, Form
  submission patches submission-side state). The module routes through
  **Contact resolution (module)** (`upsert` mode) — closing the
  previously-missed find-or-create site in the form path — and through
  **Topic subscription (module)** (`subscribe()`) directly, without the
  redundant auth shell of `api.topics.topics.addContact` (the form HTTP
  endpoint is its own public auth surface). The `confirmationToken`
  stored on each `pending_confirmation` row is the same string as the
  Contact's `doiConfirmationToken` under the unified token namespace
  (ADR-0009), populated from the new `doiToken` field on
  `subscribe()`'s return shape — no contact re-read. Behavior change
  vs pre-deepening: an existing Contact who fills out a form to join a
  new Topic now actually gets added to that Topic — today's open-coded
  path skips `subscribe` whenever the Contact already exists, silently
  dropping the membership.
- A **Dispatch attempt** runs exactly one **Dispatch pipeline**; the
  pipeline composes an ordered tuple of typed **Phase**s. A phase that
  drops or defers ends the attempt without entering the **Dispatch
  outcome** reducer. A continuing pipeline produces an enriched ctx
  (with `pool`, `ip`, and slot data) that feeds the SMTP send. The
  send's result is classified into one of four Dispatch outcome kinds
  (`delivered | hard_bounce | deferred | soft_bounce`) whose reducer
  emits a **Dispatch effect** list. The `notify_convex` effect bridges
  into the **Webhook dispatcher** → **Send lifecycle (module)** chain on
  the Convex side — so one MTA Dispatch attempt that ends in `delivered`
  causes one `email.sent` **Inbound event** which causes one
  `sent → delivered` Send lifecycle transition. The Dispatch pipeline
  and Dispatch outcome modules never throw `DeferError` — they return
  defer data; `apps/mta/src/queue/handler.ts` is the only caller that
  translates to a throw (the GroupMQ boundary).
- An `inboundMessages` row has exactly one **Inbox processing status**
  at any time and 1..N **Agent action** rows over its lifetime (one per
  kind in the happy path, plus retries within a kind). The **Inbox
  processing lifecycle (module)** is the only writer of `processingStatus`,
  the only creator/updater of `agentActions`, and the only writer of
  `conversationThreads.latestDraftStatus`. Two distinct producer
  populations of transition calls: the *agent pipeline* — the **Agent
  walker** dispatching to six **Agent step (module)**s
  (`security_scan → context_retrieval → classify → clarify → draft → route`) plus
  the cron-driven `Agent walker.retryStep` — drives the pipeline-phase
  transitions (`received → security_check → classifying → drafting →
  draft_ready`); the *human review path* (`inbox/mutations.ts:
  approveDraft / rejectDraft / releaseFromQuarantine / blockSender`)
  drives the post-pipeline transitions (`draft_ready → approved → sent |
  rejected`, plus `quarantined → received` and `* → archived`). The seam
  between the two populations is `quarantined → received` (release
  restarts the agent pipeline via `Agent walker.start`) and `failed →
  received` (cron retry restarts the affected step via `Agent walker.
  retryStep`) — both routed through the same lifecycle module so the
  agentAction reset + processingStatus advance happens atomically. The
  thread-state machine (`conversationThreads.status: open/waiting/
  resolved/closed`) is independent of inbox processing — driven only by
  the `updateThreadStatus` mutation, not by this lifecycle.
- The deployment has exactly one **Abuse status** at any time, stored
  on the singleton `instanceSettings` row. The **Abuse status (module)**
  is the only writer; the **Abuse gate (module)** is the only reader
  for sending-allowed decisions. The two modules are split because the
  *concerns* are different (write-side severity rules vs read-side gate
  semantics) and the call-site populations are disjoint (three internal
  writers + one admin-override caller vs many send-path readers). Both
  read/write the same column and share the same four-state value
  vocabulary. Send and transactional send paths consult the Abuse gate
  before reaching the **Send lifecycle (module)** — abuse blocks send
  creation upstream of the lifecycle, so a `suspended` org never produces
  a `queued` Send. The Send lifecycle does *not* check abuse status; by
  the time a transition runs, the gate already cleared. The MTA-side
  circuit breaker produces an `internal.circuit_breaker_tripped`
  **Inbound event** which the Webhook dispatcher routes to
  `abuseStatus.transition({ to: 'warned', changedBy: 'mta_circuit_breaker' })`
  — the same word travels through the inbound vocabulary, the
  transition input, and the audit-log effect without translation.
- A delivery event (`send | deliver | bounce | hard_bounce | complaint`)
  is accumulated into the rolling 30-day window at 1..2 **Reputation
  scope**s — the deployment (`org`) always, the sending **Domain** when
  the event carries one — by exactly one operation in the **Sending
  reputation (module)**, the only writer of the unified scope-
  discriminated `sendingReputation` table. A single `summarize(reader,
  scope)` is the only summarizer of the window; both the public auth-
  shell reads and the platform-admin reads cross it (the shell-vs-engine
  split of ADR-0037), and derived rate/risk is computed on read, never
  stored. One producer today: the **Send lifecycle (module)**'s
  `reputation_update` effect. The module is upstream of the **Abuse
  status (module)**: when a recorded event pushes the org scope's derived
  risk to `high`/`critical` it calls `abuseStatus.transition` — one of
  that module's three internal writers (ADR-0011) — and is the only place
  that enforce decision lives. The **Send lifecycle** → **Sending
  reputation** → **Abuse status** chain carries the same
  `bounce`/`complaint` vocabulary end to end without translation.
- The singleton `instanceSettings` row is shared by four distinct writer
  modules — **Organization settings (module)** owns the settings columns
  (`emailTheme`, `timezone`, `defaultFromName`, `defaultFromEmail`),
  **Feature flags (module)** owns the `featureFlags` map, **Abuse
  status (module)** owns `abuseStatus` and its companions, and the
  **Organization deletion (module)** owns the terminal row delete as
  the last step of the wipe. Each module is the sole writer of its
  column set; they do not share the writer set. The split is by
  *concern*, not by table — the schema's singleton-row shape reflects
  the [[project_single_org_per_deployment]] invariant, but the module-
  family follows the columns. Permission audiences also partition:
  settings writes need `settings:manage` (owner/admin); flag writes
  need `requireAdminContext` (admin); abuse writes are
  internal-system or platform-admin; deletion is owner-only. The
  `update` permission divergence between the pre-deepening
  `organizationSettings.update` (owner/admin) and `instanceSettings.update`
  (any org member) was the smoking gun that motivated the split — one
  row, one column-owner per concern, one permission rule per
  column-owner.
- An IMAP connection runs exactly one **IMAP pump** for its lifetime; the
  pump owns the buffer and the active-session slot. Each parsed line goes
  through the **IMAP command walker** to find the matching **IMAP command
  (module)**, whose `start` returns a **`CommandSession`**. One-shot
  modules return a session with already-resolved `completion`; long-running
  modules (IDLE, APPEND) return a pending session that the pump tracks —
  routing subsequent client lines to `session.onClientLine` (IDLE reads
  bare `DONE`) and literal bytes to `session.onLiteralBytes` (APPEND
  absorbs its `{N+}` body). **Connection state** (`auth`, `selected`) is
  immutable across modules — LOGIN / SELECT / EXAMINE / UNSELECT / CLOSE
  return the next state via their session, and the pump threads it
  forward. The walker's typed `Record<ImapVerb, ImapCommandModule>` makes
  missing a verb a compile error; CAPABILITY-line atoms are aggregated
  from per-module `capabilities?` declarations so adding `MOVE` or
  `UIDPLUS` support is one module edit. The IMAP modules sit *upstream*
  of the Postbox / Inbox lifecycle modules — APPEND lands a message into
  `mailMessages`, but the Postbox outbound lifecycle and Inbox processing
  lifecycle each own their tables once the message is in.
- A **Sending domain** has exactly one **Sending domain status** at any
  time and 1:0..1 **Sending domain identity** (in the per-provider
  sibling table selected by `domain.providerType`). The **Sending domain
  lifecycle (module)** is the only writer of `domains.status`, the only
  insertor/deleter of `domains` rows, and the only caller of the
  **Sending domain provider adapter (module)**'s `writeIdentity` /
  `clearIdentity` methods. Two adapters today (`mta`, `ses`), keyed by
  `providerType` and dispatched by `providerFor(kind)`; the lifecycle
  never branches on `providerType` — provider variation lives entirely
  behind the adapter seam. The DNS verifier action consumes
  `adapter.runProviderCheck` (SES implements it; MTA omits it) before
  calling `lifecycle.recordVerification`, so "what counts as verified"
  is the reducer's combination of a generic DNS rule with one boolean
  from the adapter. The lifecycle sits *upstream* of the Send path: a
  Campaign's send-time domain check (`getEmailDomainVerificationStatus`
  read query) and a transactional send's domain check both consult the
  `domains.status` column the lifecycle owns — but neither the Campaign
  lifecycle nor the Send lifecycle ever writes to it. **Tracking domain**
  is disjoint (separate table, no lifecycle, no per-provider work).
- An **Integration import** has exactly one **Integration import provider
  adapter (module)** for its lifetime, selected by the row's `provider`
  column at the **Integration import walker**'s `startIntegrationImport`
  entry and threaded through every `processIntegrationPage` hop. The
  walker is the sole writer of `integrationImports.cursor`, `imported`,
  `updated`, `skipped`, `failed`, `errors`, `totalEstimate`, and
  `completedAt`; the only other writer of the row is the public
  `cancelImport` mutation, which patches `status: 'failed'` as a
  user-cancel terminal and never touches the counters. Two adapters
  today (`mailchimp`, `stripe`), dispatched by `providerFor(kind)`; the
  walker never branches on `provider` — provider variation lives entirely
  behind the adapter seam. The adapter shape mirrors the **Sending
  domain provider adapter (module)**: typed `kind`, registry dispatch,
  one-folder addition for a new provider. The walker sits *upstream* of
  the **Contact import (module)**: each page's normalized rows feed
  `importBatch` with `source = provider` and `doiAttest` derived from
  the adapter's `defaultDoiAttest`, so DOI attestation policy travels
  with the adapter and not with the walker. The
  [[project_single_org_per_deployment]] invariant plus the walker's
  refusal to schedule when any `integrationImports` row is `'running'`
  gives the deployment a single-in-flight integration discipline; CSV
  / API contact imports (the **Contact import (module)**'s inline
  sources) are disjoint — no `integrationImports` row, no adapter, no
  walker hop.
- An **Email template** has exactly one **Email template status** at
  any time; a **Transactional email** has exactly one **Transactional
  email status** at any time. The **Email template lifecycle (module)**
  and the **Transactional email lifecycle (module)** are siblings on
  parallel tables — same shape, separate `LEGAL_EDGES` (2 states vs
  3), distinct effect lists (transactional adds a content-scan effect).
  The marketing scan runs at send time inside the **Campaign send
  orchestrator (module)**; the transactional scan runs at *publish*
  time inside the lifecycle's `→ published` reducer because the public
  transactional send API can dispatch without an operator in the loop.
  The suspicious-scan outcome routes to `pending_review`, mirroring
  the Campaign lifecycle's `pending_review → sending` admin surface
  (the edges land in the graph now; the surface lands as follow-up).
  Both lifecycles export an `assertEditableForPublishableChange(row,
  force?)` guard consumed by every mutation that touches publishable
  content (`subject`, `previewText`, `content`, `htmlContent`, `slug`,
  `type`, `defaultLanguage`, all translation-related fields), forcing
  callers to either pass `forceWhilePublished: true` or call
  `unpublish` first. The editor UX surfaces an "Unpublish to edit?"
  gate; the public HTTP API doesn't expose publish/unpublish so its
  mutations refuse on published without the knob. Neither lifecycle
  owns the i18n CRUD writes themselves — those stay in
  `emailTemplates/i18n.ts` and `transactional/translations.ts`, just
  routed through the guard.
- The **Email editor bridge (module)** is the only app-side producer of
  the `EmailBuilderHandlers` the `EmailBuilder` injects and the only owner
  of the editor's load→dirty→save loop. Three surfaces consume it — the
  **Email template** editor, the **Transactional email** editor, and the
  **Saved block** editor — each supplying its own `initialize(source)`
  parse and `save()` serialize; the bridge never branches on surface. The
  two publishable surfaces additionally share the **Publishable-email
  save** helper (render HTML + translations + `linkedBlockIds` → the
  **Email template lifecycle (module)** / **Transactional email lifecycle
  (module)** `update`); the **Saved block** editor shares the bridge but
  not the helper — it renders nothing and writes its own `{ blocks: [...] }`
  envelope through the **Saved block (module)**. The bridge sits app-side
  of the `EmailBuilderHandlers` contract, which stays in
  `packages/email-builder`.
- The **DOI lifecycle (module)**, **Inbox processing lifecycle (module)**,
  **Send lifecycle (module)**, **Postbox outbound lifecycle (module)**,
  **Campaign lifecycle (module)**, **AB test lifecycle (module)**,
  **Sending domain lifecycle (module)**, **Email template lifecycle
  (module)**, and **Transactional email lifecycle (module)** all
  instantiate the same skeleton: typed `TransitionInput` discriminated
  by `to`, a `LEGAL_EDGES` graph, a private reducer per kind returning
  `{ patch, effects, applied }`, and a `TransitionOutcome` reporting
  `ok | reason`. The **Abuse status (module)** is the same skeleton plus
  an `adminOverride` second entry point. Ten instances of the shape are
  now in the codebase by convention (no factor). Email template + 
  Transactional email land as the second sibling-pair on parallel
  tables (first pair: Campaign + AB test on the same row). The Send
  lifecycle's pre-deepening role as "the lifecycle that handles two
  table kinds via SendRef" remains unique — Email template and
  Transactional email could have collapsed into one polymorphic
  lifecycle keyed by table kind, but their state graphs genuinely
  diverge (different state counts, different scanning posture) and
  the parallel-modules shape names the asymmetry honestly. Campaign + AB test land
  as siblings on the same row — first time two lifecycles share a row,
  coordinated by a cross-machine effect (`start_ab_test_if_enabled` on
  the Campaign reducer reaches into the AB test lifecycle). Sending
  domain is the first lifecycle that owns row insertion *and* row
  deletion as lifecycle entry points (`create()` and `remove()`),
  bracketing the state machine — Topic subscription is the closest
  precedent but it acts on membership rows, not the parent row. The
  `Lifecycle<S, T, E>` factor question is "active design" rather than
  "hypothetical" but has not yet landed — each instance differs in
  non-trivial ways (external keys, polymorphic identity, override entry
  points, cross-machine coordination, per-kind adapter dispatch) that
  would be lossy to push behind a generic factor. The factor lands when
  the duplication bites at the *reducer-implementation* level, not at
  the type-signature level — and so far the reducers genuinely diverge.

## Example dialogue

> **Dev:** "If we add a new social-icons block, what do I touch?"
> **Domain expert:** "Add a Block module — `blocks/socialIcons/` with the
> renderer, plaintext, validators, default factory, and a `placement`
> declaration of which parents accept it. The Walker dispatches
> automatically — there are no switches to edit."

> **Dev:** "Can a button render differently inside a hero?"
> **Domain expert:** "Yes — but it doesn't inspect its parent. The Walker
> enriches the Block's `ctx` with parent-derived data (`allottedWidth`,
> `parentEmitsVml`) and the Block does math on those. The Block stays
> ignorant of its parent's identity. MJML's maintainer documented why
> parent-detection in children is brittle (issue #2107)."

> **Dev:** "If we add a `wait_for_event` step kind, what do I touch?"
> **Domain expert:** "Two folders. Backend
> `automations/steps/wait_for_event/index.ts` with `parseConfig`,
> `execute`, and probably `entryDelay`. Frontend
> `composables/automations/steps/wait_for_event/index.ts` with the editor
> module + its EditorComponent. Plus the `StepKind` union. The Step
> walker dispatches automatically — there are no switches to edit."

> **Dev:** "Does the automation `condition` step duplicate the segment
> filter logic?"
> **Domain expert:** "No, they share a **Condition type module**. The
> condition step's `execute` calls
> `conditionTypeModuleFor(condition.kind).preloadLookup([condition])` then
> `evaluate`; the segment evaluator batch-preloads many conditions at
> once but goes through the same `evaluate`. Operators live inside the
> per-kind module, not in a global switch. Adding `not_starts_with` to
> `contact_property` is a one-place change."

> **Dev:** "What about the segment filter UI and the automation condition
> step's settings panel — don't they each have their own per-kind editor?"
> **Domain expert:** "They share a **Condition editor module**, the
> editor half keyed by `kind` at `composables/conditions/<kind>/`. Each
> kind ships one `EditorComponent` with a `variant: 'row' | 'panel'`
> prop — segments slot the `row` variant into the table modal, the
> automation condition step slots the `panel` variant into its popover.
> Reference data (contactProperties, topics) is provided by each
> top-level consumer as **Condition editor context** and injected by the
> module — no module owns its own queries. Adding a new condition kind
> means adding a Condition type module on the backend AND a Condition
> editor module on the frontend; missing either half is a compile error."

> **Dev:** "If I add a new IMAP command — say `XLIST` or `SETANNOTATION`
> — what do I touch?"
> **Domain expert:** "One folder. `apps/imap/src/commands/<verb>/index.ts`
> with `parseArgs`, `start`, the declared `verbs` and `capabilities`. The
> IMAP command walker dispatches automatically — no switch to edit, no
> CAPABILITY-line edit. If your command is long-running (timer-driven or
> needs to absorb a literal), return a pending session and the pump will
> route subsequent client lines / bytes to its `onClientLine` /
> `onLiteralBytes` hooks. The pump does not know what your verb means."

> **Dev:** "IDLE has timers and APPEND absorbs bytes from the stream —
> aren't those special cases?"
> **Domain expert:** "They share the same interface as one-shot
> commands. `start` returns a `CommandSession` with a `completion`
> promise. One-shot sessions return with `completion` already resolved.
> IDLE returns with `completion` pending and owns its own poll timer;
> the pump calls `session.onClientLine('DONE')` when it sees the bare
> DONE on the next line. APPEND returns with `awaitingLiteral: { bytes:
> N }` and the pump absorbs N bytes into `onLiteralBytes` before the
> session resolves. The pump never special-cases IDLE or APPEND — the
> session declares its shape and the pump routes accordingly."

> **Dev:** "If we add a new sending provider — say Postmark — what do I
> touch?"
> **Domain expert:** "One folder. `convex/domains/providers/postmark/`
> with the adapter (`registerDomain`, `deleteFromProvider`,
> `writeIdentity`/`clearIdentity`, optionally
> `runProviderCheck`) and the `registerAction` effect handler. Plus
> one new sibling table `sendingDomainPostmarkIdentities` in
> `schema/domains.ts` and one entry in `SENDING_DOMAIN_PROVIDERS`.
> The Sending domain lifecycle dispatches via the registry — there's
> no `if` to edit. The `satisfies` check on the registry catches
> missing methods at compile time."

> **Dev:** "Does the DNS verifier know whether SES is happy?"
> **Domain expert:** "The verifier loads the domain, runs DNS lookups,
> then calls `adapter.runProviderCheck?(domain)` — SES implements it
> (live `getVerificationStatus` API call); MTA doesn't. The verifier
> never reads `providerType` itself; the registry picks the right
> adapter and the absent method short-circuits to
> `{ verified: true }`. The lifecycle reducer combines the generic
> DNS rule with one boolean from the adapter to derive
> `verified | failed | pending`. Adding a new provider with its own
> idea of 'verified' is one extra method on its adapter, nothing
> else."

> **Dev:** "If we add a new email editor surface — say a signature editor
> — what do I touch?"
> **Domain expert:** "Reuse the **Email editor bridge**. Write a page that
> calls it with an `initialize(source)` parsing your row into
> `blocks`/`subject`/`name` and a `save()` that serializes and writes your
> mutation — plus `extraWatch` for any surface-specific fields. You get the
> `uploadImage` pipeline, the saved-blocks bridge, the media picker, and
> the dirty / unsaved-changes loop for free; you never re-wire
> `provideEmailBuilderHandlers`. If your surface renders HTML and
> publishes, call **Publishable-email save** inside `save()`; if it
> doesn't — like the Saved block editor — don't."

## Flagged ambiguities

- "Component" was historically used in code for both Vue/React UI components
  AND Block renderer files. Resolved: UI components are *components*; content
  blocks are *Blocks*. Files under `email-renderer/src/blocks/` are Block
  modules, not components.
- Error vocabulary was historically three overlapping systems in
  `_utils/errors.ts` — `SCREAMING_SNAKE` `ConvexError` codes, a separate
  lowercase `ErrorCodes` HTTP map, and bare-`Error` creators with colliding
  names (`createNotFoundError` vs `throwNotFound`). Resolved (ADR-0036): one
  closed, lowercase **Error category** union serialized three ways; the
  bare-`Error` creators and the `isErrorType` substring matcher are removed.

## Deliberate asymmetries

Decisions that look like accidents to a reviewer but are intentional. Recorded
here so intent is legible at the spot AND in one glossary place. Each has a
matching code comment at the cited file.

- **Open-tracking pixel is unsigned; click-tracking is HMAC-bound.**
  `delivery/trackingHttp.ts` — `trackClick` requires an HMAC that binds the
  redirect target to its `emailSendId` (it signs `id+URL`, so there is a target
  to forge → an open redirect risk), but `trackOpen` accepts any well-formed
  `emailSendId` with no signature. Intentional: the id must be visible in the
  `<img>` src for the mail client to fetch it (it can't be a secret), an open
  has no separate target to forge, forging one exposes no data and grants no
  redirect — only an inflated open count, which the per-IP `emailTracking` rate
  limit caps. Opens are analytics-only. Future option: sign the pixel path
  (id + short expiry) like `trackClick` if open-count integrity ever needs to
  be stronger than rate-limited best-effort.

- **`platformAdmin/*` is control-plane-only and inert on OSS self-host.**
  No production path populates the `platformAdmins` table on an OSS
  deployment (`seedPlatformAdmin` is an `internalMutation` with no production
  caller; `addPlatformAdmin` needs an existing admin to bootstrap), so
  `requirePlatformAdmin` always throws FORBIDDEN and the console renders empty.
  Intentional: the multi-tenant control plane that would seed and use these
  admins lives in the separate private Nest repo (see *Nest Extracted*); this
  repo is single-org-per-deployment OSS. The module is kept so the control
  plane reuses it unchanged, but no OSS bootstrap is wired — granting one
  operator instance-wide power is a deployer decision, not a default. Intended
  authz model: each `platformAdmin/*` function is an `authedMutation` /
  `authedQuery` whose handler calls `requirePlatformAdmin(ctx)` first
  (superadmin-only ops also check `role === 'superadmin'`).

- **File `semanticSearch` is vector-only; knowledge retrieval is hybrid
  (vector + FTS + RRF).** `semanticFileProcessing.ts` vs
  `knowledge/retrieval.ts` — both share the identical contact-scoping gate, but
  knowledge fuses a full-text leg with Reciprocal Rank Fusion so a draft can
  ground on exact tokens (order number, SKU, surname) that pure vector recall
  blurs. The asymmetry is **not** a missing index: the `search_files` FTS index
  already exists on `semanticFiles` (`schema/knowledge.ts`), `searchableText` is
  populated from the extracted body, and it is already queried by
  `semanticFiles.search` (`semanticFiles.ts`). The narrower asymmetry is that
  the agent retrieval action (`semanticFileProcessing.semanticSearch`) does not
  add an FTS leg over that existing index and fuse it via RRF. Fusing the
  existing FTS leg is a **tracked follow-up**, not a permanent decision — and it
  should reuse `lib/rrf.ts` (`reciprocalRankFusion`), not a parallel fusion.
