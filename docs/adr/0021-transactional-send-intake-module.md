# Transactional send intake module — single intake path for the public transactional send API

**Status:** proposed

## Context

ADR-0008 deepened find-or-create of a Contact into the **Contact
resolution (module)** with four declared callers and an `upsert` mode.
ADR-0006 pre-created `transactionalSends` rows in `queued` so they walk
the same Send lifecycle as campaign sends. ADR-0015 deepened the form
submit path into the **Form submission (module)**, proving the intake
pattern for a public HTTP API surface. ADR-0019 deepened the contact
import path into the **Contact import (module)**, proving the intake
pattern again with a different batch shape. ADR-0020 retired the
pre-deepening `lib/emailProviders/` factory in favor of the **Send
provider adapter (module)** registry and the **Send dispatch
(helper)**, and explicitly named the remaining intake gap:

> the HTTP shell that wraps transactional sends
> (`transactionalApiHttp.ts`, or its successor under the **Transactional
> send intake (module)** if that deepening lands)

That deepening hasn't landed. `apps/api/convex/transactionalApiHttp.ts`
is a 659-line `httpAction` whose `sendTransactional` handler (lines
165-636) owns auth, CORS, body parsing, email validation, blocklist
check, attachment validation, attachment storage upload,
transactional-email lookup (by id or slug), publish-state check,
HTML-content check, sender resolution, domain verification,
`dataVariables` schema validation, **contact find-or-create with an
open-coded race-retry `try/catch` hack**, language resolution, provider
route resolution, template+request attachment merging, enqueue, and
daily-counter increment. The bottom of the path is a thin
`transactionalApi.ts:enqueueTransactionalEmail` internal mutation (107
LOC) that inserts the `transactionalSends` row in `queued` and enqueues
the workpool job.

Form submission and transactional send intake are the same shape: a
public HTTP API that resolves a Contact, dispatches downstream, and
returns a classified outcome. ADR-0015 closed the form-side gap. This
ADR closes the transactional-side gap.

### Pre-deepening landscape — `transactional*.ts`

| File | LOC | Role |
|---|---|---|
| `transactionalApiHttp.ts` | 659 | `sendTransactional` httpAction (lines 165-636) + `transactionalCollection` OPTIONS/405 handler + `validateDataVariables` pure function (lines 98-160) + the `SendTransactionalBody` / `SendTransactionalResponse` / `TransactionalEmail` / `HtmlTranslation` / `Contact` / `AttachmentInput` type aliases |
| `transactionalApi.ts` | 107 | `enqueueTransactionalEmail` internal mutation — inserts `transactionalSends` row + enqueues workpool |
| `transactionalSends.ts` | 396 | `transactionalSends` row CRUD: `listByTransactionalEmail`, `listAll`, `get`, `getByProviderMessageId`, `getStatsByTransactionalEmail`, `getCountByTransactionalEmail`, `getCounts`, `create` (the pre-ADR-0006 mutation inserting directly in `sent`), `deleteByTransactionalEmail`, `getByEmail` |
| `transactionalEmails.ts` | 483 | `transactionalEmails` row CRUD: create / list / get / get-by-slug / update / publish / unpublish / duplicate / delete + the template-side attachments management |
| `transactionalEmailsTranslations.ts` | 343 | Per-language translation CRUD for `transactionalEmails` (subject, htmlContent per locale) |

Five files at the top level of `convex/` — past the convention threshold
where the area gets a subdirectory (`forms/`, `contacts/`, `campaigns/`,
`delivery/`, `domains/`, `topics/`, `inbox/`, `mail/`, `webhooks/`,
`automations/`, `organizations/`, `platformAdmin/`).

### Drift landscape

Five drift signals across the intake path.

#### 1. Open-coded find-or-create missed by ADR-0008

`transactionalApiHttp.ts:466-512`:

```ts
const existingContact = await ctx.runQuery<Contact | null>(
  require('./_generated/api').internal.contacts.contacts.getByEmailForTeam,
  { email: body.email.toLowerCase().trim() },
);

if (existingContact) {
  contactId = existingContact._id;
  contactLanguage = existingContact.language;
} else {
  // Always create contact for history tracking
  try {
    contactId = await ctx.runMutation<Id<'contacts'>>(
      require('./_generated/api').internal.contacts.contacts.createForTeam,
      { email: body.email, source: 'transactional' as const },
    );
    contactCreated = true;
  } catch (error) {
    // Race condition: another concurrent send created the contact
    if (error instanceof Error && error.message?.includes('already exists')) {
      const raceContact = await ctx.runQuery<Contact | null>(
        require('./_generated/api').internal.contacts.contacts.getByEmailForTeam,
        { email: body.email.toLowerCase().trim() },
      );
      if (raceContact) {
        contactId = raceContact._id;
        contactLanguage = raceContact.language;
      }
    } else {
      throw error;
    }
  }
}
```

47 lines of open-coded find-or-create with a string-match `try/catch`
race-retry. Every other public-API intake path now routes through
**Contact resolution (module)** with `mode: 'upsert'`, which handles
the race internally and returns `{ contactId, action }`. The
transactional path was the fifth site listed in ADR-0008's scope but
was migrated only partially (the `source: 'transactional'` field name
agreement landed; the actual call-site swap did not).

The race-retry hack is the smoking gun: the path knows the race is
possible but works around it inline instead of pushing the concern
behind the seam that exists for exactly this.

#### 2. Daily counter incremented outside the row-insert transaction

Two counters fire on every accepted dispatch:

| Counter | Site | Atomic with row insert? |
|---|---|---|
| `instanceSettings.transactionalSendCount` | `transactionalApi.ts:76-81` (inside `enqueueTransactionalEmail`) | yes — same mutation as the row insert |
| daily send count via `incrementDailySendCountInternal` | `transactionalApiHttp.ts:610-612` (in the HTTP shell, *after* the enqueue mutation returns) | no — separate mutation, fired by the HTTP shell |

Today the only caller is the HTTP shell, so the drift is invisible. But
the seam is open: any future non-HTTP shell (admin replay, batch
transactional dispatch, SDK trigger) would have to remember to fire the
daily counter or it silently drifts. The campaign path already has this
problem (`emails.ts:500` and `emails.ts:821` both call it from
campaign-orchestrator code), so the lesson is recorded — every send
intake that doesn't route through one canonical mutation grows its own
counter call site.

#### 3. `transactionalSends.create` is pre-ADR-0006 dead code

`transactionalSends.ts:295-328` defines a public `create` mutation that
inserts a `transactionalSends` row directly in `status: 'sent'`. This
is the pre-ADR-0006 shape — before the worker pre-creates in `queued`
and the Send lifecycle owns the transition. ADR-0006's plan called for
`createInternal` to be deleted (see the "Cleanup last" note under the
"Order rationale" section of `0046-execution-plan.md`)
and that deletion happened. The public-mutation sibling `create` was
left behind.

Grep confirms zero live callers:

```sh
$ rg "api\.transactionalSends\.create\b|transactionalSends\.create\(" apps/
(no matches)
```

It would only be reachable if a frontend or test referenced
`api.transactionalSends.create` directly — none does. The mutation
exists, increments `transactionalSendCount`, and writes the row in a
status that the Send lifecycle would refuse as an illegal pre-state.
Dead code that violates the lifecycle invariant.

#### 4. Resolved `language` lives on the response, not the row

`transactionalApiHttp.ts:522-552` resolves the recipient's language
through the fallback chain (request → contact → template default →
`'en'`) and pulls the matching `htmlContent` + `subject` from
`htmlTranslations[language]`. The resolved language is returned in
the response (`SendTransactionalResponse.language`) but **never
persisted on the `transactionalSends` row**.

Analytics queries (`getStatsByTransactionalEmail`, dashboards,
audience-language breakdowns) can't tell which language a transactional
send was delivered in. The drift is silent — the language was computed,
used to select content, then dropped.

#### 5. Inline ~400-line orchestration in an `httpAction`

The 22-step intake flow (auth → abuse → blocklist → body parse →
attachment validate → attachment store → template lookup → publish
check → content check → sender resolve → domain verify → variable
validate → contact upsert → language resolve → content select → route
resolve → attachment merge → row insert → counter1 increment →
counter2 increment → enqueue → respond) lives as one linear handler.
Asking "what error code fires when the template is published but has
no HTML?" requires reading the whole handler. No isolatable surface for
unit-testing the rejection classification. No way to call the intake
path from an internal trigger (admin replay, retry tool, programmatic
re-dispatch) without reimplementing the orchestration.

### Shared framing

The intake friction is the same pattern ADR-0015 closed for forms:
per-call ceremony around a small core of intake work, with the
per-table writer scattered between the HTTP shell and a thin downstream
mutation. The fix is the **Transactional send intake (module)** —
single intake function, classifies internally, routes through the
existing **Contact resolution (module)**, writes one `transactionalSends`
row in `queued`, returns a discriminated outcome. Mirrors the **Form
submission (module)** shape (one intake mutation + flat reason union)
and the **Contact import (module)** shape (single batch entry with a
discriminated source). Not the **Outbound lifecycle** shape — every
successful intake lands directly in `queued`, and the Send lifecycle
owns every transition after.

## Decision

Introduce **Transactional send intake (module)** at
`convex/transactional/dispatch.ts`. Single `dispatch` internalMutation
for the (no row) → `queued` edge. The Send lifecycle owns everything
after `queued`. CONTEXT.md vocabulary lands alongside this ADR (already
landed: see the `## Transactional sends` section).

### Module shape

```ts
// convex/transactional/dispatch.ts

export type DispatchOutcome =
  | {
      ok: true;
      sendId: Id<'transactionalSends'>;
      contactId: Id<'contacts'>;
      contactCreated: boolean;
      language: string;
      queued: true;
    }
  | {
      ok: false;
      reason:
        | 'abuse_blocked'
        | 'recipient_blocked'
        | 'template_not_found'
        | 'template_not_published'
        | 'template_no_content'
        | 'domain_unverified'
        | 'invalid_variables';
      detail?: string;
    };

export const dispatch = internalMutation({
  args: {
    // Pre-validated by the HTTP shell. The shell did JSON-shape
    // validation (required fields, types, email format, language
    // format, attachment count + size limits, https-only URL check)
    // and attachment storage upload (base64 decode →
    // ctx.storage.store, which can only run in an httpAction
    // context). The module's input is typed, well-formed data.
    templateLookup: v.union(
      v.object({ kind: v.literal('id'), id: v.id('transactionalEmails') }),
      v.object({ kind: v.literal('slug'), slug: v.string() }),
    ),
    email: v.string(),             // already lowercased + trimmed
    dataVariables: v.optional(v.record(v.string(), jsonPrimitiveValue)),
    language: v.optional(v.string()),
    attachmentRefs: v.optional(v.array(v.object({
      filename: v.string(),
      contentType: v.optional(v.string()),
      url: v.string(),
      storageId: v.optional(v.string()),
    }))),
  },
  handler: async (ctx, args): Promise<DispatchOutcome> => {
    // 1. Abuse gate → 'abuse_blocked'
    // 2. Blocklist → 'recipient_blocked'
    // 3. Template lookup + published + has-HTML
    //      → 'template_not_found' | 'template_not_published' | 'template_no_content'
    // 4. Sender + domain verification → 'domain_unverified'
    // 5. Validate dataVariables against template schema → 'invalid_variables'
    // 6. resolveContact({ channel: 'email', identifier: email, mode: 'upsert',
    //                     source: 'transactional', contactFields: { language } })
    // 7. Language resolution (request → contact → template default → 'en')
    //    Pulls htmlContent + subject from htmlTranslations[language] when present
    // 8. Provider route resolution (providerRoutes.getRoute + provider health → resolveRoute)
    // 9. Template + request attachment merge
    // 10. Insert transactionalSends row in 'queued' (with resolved language)
    // 11. Increment instanceSettings.transactionalSendCount AND
    //     incrementDailySendCountInternal — atomic with the row insert
    // 12. Enqueue transactionalEmailPool.enqueueAction
    //     ({ onComplete: emailOnComplete, sendRef: { kind: 'transactional', id: sendId } })
    // 13. Return { ok: true, sendId, contactId, contactCreated, language, queued: true }
  },
});
```

One entry point. No companion mutation needed — the post-queue
transitions belong to the **Send lifecycle (module)** (via **Send
completion (module)** on workpool callback, via the **Webhook
dispatcher** on provider callback). Different from Form submission
which has a `markConfirmedByToken` companion for the
`pending_confirmation → success` edge; transactional has no such edge
that this module owns.

### HTTP shell shrinkage

`convex/transactional/api.ts:sendTransactional` (renamed from
`transactionalApiHttp.ts`) collapses from ~470 lines of handler logic
to ~80:

```ts
export const sendTransactional = createAuthenticatedHandler(
  async (ctx, request, _auth) => {
    // 1. Parse body (parseTransactionalBody helper — kept local)
    let body: SendTransactionalBody;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400, 'invalid_json');
    }

    // 2. JSON-shape validation (validateRequestShape helper — kept local)
    const shapeError = validateRequestShape(body);
    if (shapeError) return shapeError;

    // 3. Attachment storage upload (uploadAttachments helper — kept local;
    //    requires action context for ctx.storage.store)
    const uploadResult = await uploadAttachments(ctx, body.attachments);
    if (!uploadResult.ok) return uploadResult.response;
    const attachmentRefs = uploadResult.refs;

    // 4. Build templateLookup discriminator
    const templateLookup = body.transactionalId
      ? { kind: 'id' as const, id: body.transactionalId as Id<'transactionalEmails'> }
      : { kind: 'slug' as const, slug: body.slug! };

    // 5. Dispatch
    const outcome = await ctx.runMutation(internal.transactional.dispatch.dispatch, {
      templateLookup,
      email: body.email.toLowerCase().trim(),
      dataVariables: body.dataVariables,
      language: body.language,
      attachmentRefs,
    });

    // 6. Map outcome → response
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'abuse_blocked':
          return errorResponse('Your account has been suspended. Please contact support for assistance.', 403, 'account_suspended');
        case 'recipient_blocked':
          return errorResponse('This email address is blocked. The recipient may have previously bounced or filed a complaint.', 400, 'email_blocked');
        case 'template_not_found':
          return errorResponse(outcome.detail ?? 'Transactional email not found', 404, 'not_found');
        case 'template_not_published':
          return errorResponse(outcome.detail ?? 'Transactional email is not published.', 400, 'not_published');
        case 'template_no_content':
          return errorResponse(outcome.detail ?? 'Transactional email has no HTML content.', 400, 'no_content');
        case 'domain_unverified':
          return errorResponse(outcome.detail ?? 'Sending domain is not verified.', 400, 'domain_not_verified');
        case 'invalid_variables':
          return errorResponse(outcome.detail ?? 'Invalid data variables', 400, 'invalid_variables');
      }
    }

    return jsonResponse({
      data: {
        status: 'queued' as const,
        email: body.email,
        transactionalEmailId: outcome.sendId,
        slug: body.slug ?? '',
        contactId: outcome.contactId,
        contactCreated: outcome.contactCreated,
        language: outcome.language,
      },
    }, 202);
  },
);
```

`switch (outcome.reason)` is exhaustive — the TypeScript compiler will
catch a missing case when a future reason literal is added. No
classification logic, no contact resolution, no domain check, no
route resolution, no `transactionalSends` writes, no counter
increments. The shell is HTTP boundary work and outcome → response
mapping only.

The helpers `validateRequestShape` and `uploadAttachments` stay in the
HTTP shell because they (a) work over the raw HTTP request body, not
domain types, and (b) `uploadAttachments` requires action context for
`ctx.storage.store` — the dispatch module is a mutation and can't
write storage.

### Why attachment uploads stay at the HTTP boundary

Convex's transactional guarantees apply to mutations, not actions. An
`internalAction` can call `ctx.storage.store` but can't transact a
mutation alongside it — the storage write happens, then a separate
mutation does the row insert + counter increments + enqueue. If the
storage write succeeds but the enqueue mutation fails (or vice versa),
state diverges.

By keeping attachment storage at the HTTP shell, the module remains an
`internalMutation` that transacts the row insert + both counters +
enqueue atomically. Failed attachment uploads return a 500 before
`dispatch` is called and no row exists; failed `dispatch` returns a
4xx-or-5xx with the storage already written (unreferenced, GC-eligible
— Convex storage rows are reachable only via stored `storageId`s and
become orphaned cleanly).

This is the same trade-off the form path makes implicitly (form
submissions have no attachments, so the problem doesn't surface there).
The cost: orphaned blob storage on partial-failure paths until a
sweeper picks them up. The benefit: a mutation-shaped module that
participates in Convex's atomicity model.

## Considered options

### Shape — lifecycle vs intake

**Chosen: intake.**

Eight existing modules instantiate the **Outbound lifecycle** shape
(DOI, Inbox processing, Send, Postbox outbound, Campaign, AB test,
Sending domain, Abuse status). All eight share a feature this candidate
doesn't: their rows transition through multiple states over time, and
the lifecycle owns the legal-edges graph. Transactional intake is
different — the row is created directly in `queued` and the **Send
lifecycle (module)** owns every subsequent transition (`queued → sent
| failed → delivered | bounced | complained | opened | clicked`).
There is no second state this module writes.

The intake shape (one entry point, classifier, flat outcome) matches
the actual work. The lifecycle bookkeeping (typed `TransitionInput`,
`LEGAL_EDGES` graph including `(no row) → queued` synthetic create
kinds, reducer per kind, effects list) would be pure ceremony for a
module whose only state write is "row in `queued`". Form submission
and Contact import are the right parallels: also one-shot intake from
public API into the domain, also return a discriminated outcome.

### Scope — thin vs thick

**Chosen: thick.**

Thin (module owns only the row write + enqueue; HTTP shell orchestrates
Contact resolution, abuse, blocklist, template lookup, language
resolution, route resolution) fails the deletion test — delete the thin
module and the 22-step orchestration in the HTTP handler stays put.
Most of the drift bugs live in the orchestration, not the row write.

Thick (module owns the full intake from "validated, well-formed input"
through "row in `queued`, workpool enqueued") closes drift bug #1
(transactional path now goes through Contact resolution, race-retry
hack deleted), drift bug #2 (both counters fire atomically with the row
insert), drift bug #4 (`language` on the row), and drift bug #5
(orchestration lives in a single mutation with isolated tests).
Drift bug #3 (dead `transactionalSends.create`) is fixed in passing —
the deepening's discipline forces the audit.

### Scope — include automation step's email send path or not

**Chosen: leave automation step separate.**

`convex/automations/steps/email/index.ts` is an `ActionCtx`-bound
`execute` that personalizes a template, resolves a provider route, and
calls `sendProviderDispatch` directly. It does **not** write a
`transactionalSends` row, does **not** use the workpool, dispatches
synchronously, and operates on an already-resolved Contact (the
automation's runtime gives it a `contact` arg, not an email string).

The two paths share three concerns (template lookup, route resolution,
provider dispatch) but diverge on everything else:
- Sync vs async (workpool queueing)
- Row-writing vs row-less
- Contact-by-id vs email-upsert
- Schema validation vs none (automations don't accept user
  `dataVariables` — they personalize from `contact.firstName` etc.)
- Counter semantics (transactional increments
  `transactionalSendCount`; automation increments
  `automations.emailsSent`)

Unifying would mean inventing a higher-level abstraction over both
that paramaterizes every divergence. The deletion test fails — removing
the shared layer would distribute almost-identical complexity back
across both paths. Keeping them separate is the right call until a
third path appears with the same divergence pattern.

### Attachment processing — module-action vs HTTP-shell

**Chosen: HTTP-shell.**

Module-as-action (internalAction owns attachment base64 decode +
storage upload + the rest of the intake) would gain the property
"attachments are 100% inside the module" but cost mutation atomicity.
Convex actions can't transact a mutation; an action that writes
storage then calls a mutation has a window where storage is written
but the row isn't inserted (or vice versa).

HTTP-shell handles storage upload, then calls the dispatch mutation
with already-resolved `attachmentRefs`. The shell pays an orphan-blob
cost on partial-failure paths (the storage row exists; the dispatch
fails or the row isn't inserted; the blob is unreferenced until a
sweeper picks it up). The module gains transactional atomicity over
row insert + counter1 + counter2 + enqueue.

The orphan-blob cost is real but tolerable: on the unhappy path the
customer's blob is uploaded, the API returns 4xx, the customer retries
(or doesn't). Storage blobs from failed dispatches become unreferenced
and GC-eligible. The flip side — non-atomic row insert + counter
increments — would mean per-org counters that diverge from reality on
partial failures. Counters as durable state matter more than
unreferenced blobs.

### Outcome shape — flat reason vs action literal vs throw

**Chosen: flat reason union.**

Three options:

(a) **Flat reason union (chosen).** `{ ok: true, ... } | { ok: false,
reason: <literal>, detail? }`. The HTTP shell maps each reason to a
status code + error code. Compile-time exhaustiveness on the mapper's
`switch`.

(b) **Action literal like Form submission.** `{ action: 'queued' |
'abuse_blocked' | 'recipient_blocked' | 'rejected_template' |
'rejected_domain' | 'rejected_variables' }`. The form path uses
`action` because four of five literals are real classification
outcomes (`spam`, `invalid`, `duplicate`, `success`). The transactional
path has one success literal and six rejection literals — the
classification framing doesn't match the asymmetry. The flat `ok:
true | ok: false + reason` shape names it more honestly: there is one
path through to `queued`, and six guards on the way.

(c) **Throw typed errors on rejection.** `ok-only` outcome; the module
throws `TransactionalAbuseBlockedError` etc. Less ergonomic for non-HTTP
callers (every caller wraps in `try/catch`); out of step with the
project's pattern (Form submission, Contact resolution, lifecycle
modules all return discriminated outcomes rather than throwing).

(a) matches the asymmetry, gives the compiler something to enforce,
and keeps the call-site shape consistent with Contact resolution
(`{ contactId, action }`) and Form submission
(`{ ok, submissionId, action } | { ok: false, reason }`).

### Naming

**Chosen: Transactional send intake (module).**

Reserved by CONTEXT.md line 1477 (ADR-0020's `does not own` clause).
Parallels the project's intake-module vocabulary: **Form submission
(module)**, **Contact import (module)**, **Contact resolution
(module)**. Rejected alternatives — see `_Avoid_` list in the CONTEXT.md
entry: **Transactional dispatch (module)** (collides with **Send
dispatch (helper)**), **Transactional API (module)** (names the shell,
not the module), **Transactional send (module)** (collides with
**Transactional send** the row), **Transactional send orchestrator**
(the orchestrator role is reserved for the **Campaign send
orchestrator**).

### File layout — new subdirectory vs partial vs flat

**Chosen: new `convex/transactional/` subdirectory.**

Five existing top-level `transactional*.ts` files. The project
convention is a subdirectory once an area has ≥3 files (`forms/`,
`contacts/`, `campaigns/`, `delivery/`, `domains/`, `topics/`,
`inbox/`, `mail/`, `webhooks/`, `automations/`,
`organizations/`, `platformAdmin/`). The transactional area is the
largest cluster still at the top level.

Move all five files under `convex/transactional/`:
- `transactionalApiHttp.ts → transactional/api.ts`
- `transactionalApi.ts → DELETED` (absorbed into
  `transactional/dispatch.ts`)
- `transactionalSends.ts → transactional/sends.ts`
- `transactionalEmails.ts → transactional/emails.ts`
- `transactionalEmailsTranslations.ts → transactional/translations.ts`

Add the new file:
- `transactional/dispatch.ts` (the module)

Partial moves (subdirectory for the new module only, others stay at
top level) leave the area half-split — reads-side at the top level,
writes-side under the subdirectory. Rejected.

Flat (add `transactionalDispatch.ts` beside the existing five files,
no reorg) doubles down on the messy top-level structure that should
have been a subdirectory two ADRs ago. Rejected.

Cost: import-path churn. Callers of `internal.transactionalApi.*`,
`internal.transactionalSends.*`, `internal.transactionalEmails.*`,
`api.transactionalEmails.*`, `api.transactionalEmailsTranslations.*`
all rewrite. The convex codegen at `_generated/api.d.ts` regenerates
to match. Migrations are mechanical search-and-replace; Convex's
typed `api` / `internal` namespaces make missed references a compile
error, not a runtime surprise.

## Consequences

### Files that collapse / disappear

| File | What happens |
|---|---|
| `convex/transactionalApiHttp.ts` | Renamed → `convex/transactional/api.ts`. `sendTransactional` shrinks from ~470 lines of handler logic to ~80. Open-coded contact upsert with race-retry (lines 466-512), inline language resolution (lines 514-552), domain verification block (lines 427-454), variable validation block (lines 456-463), attachment merging (lines 574-593), and the four `runMutation` / `runQuery` orchestration calls (lines 555-612) all move into `transactional/dispatch.ts`. `validateDataVariables` moves to `transactional/dispatch.ts` as a private helper. CORS / OPTIONS handler (`transactionalCollection`) stays. `validateRequestShape` and `uploadAttachments` extract as new private helpers in `transactional/api.ts`. |
| `convex/transactionalApi.ts` | Deleted. Its sole export `enqueueTransactionalEmail` is absorbed into `transactional/dispatch.ts`. The intermediate internal mutation no longer exists. |
| `convex/transactionalSends.ts:create` | Deleted — the pre-ADR-0006 public mutation inserting directly in `sent`. Grep-confirmed zero callers. |
| `convex/transactionalSends.ts` (the file as a whole) | Renamed → `convex/transactional/sends.ts`. Otherwise unchanged. Read queries stay (`listByTransactionalEmail`, `listAll`, `get`, `getByProviderMessageId`, `getStatsByTransactionalEmail`, `getCountByTransactionalEmail`, `getCounts`, `getByEmail`, `deleteByTransactionalEmail`). |
| `convex/transactionalEmails.ts` | Renamed → `convex/transactional/emails.ts`. Otherwise unchanged. |
| `convex/transactionalEmailsTranslations.ts` | Renamed → `convex/transactional/translations.ts`. Otherwise unchanged. |

### Files that grow

| File | What it gains |
|---|---|
| `convex/transactional/dispatch.ts` (new) | `dispatch` internalMutation, the 22-step intake handler, private helpers: `validateDataVariables` (ported from `api.ts`), `resolveLanguage`, `selectContent`, `mergeAttachments`. ~280 LOC total. |
| `convex/transactional/api.ts` (was `transactionalApiHttp.ts`) | New private helpers: `validateRequestShape` (~70 LOC, ports the JSON-shape gates from the original handler) and `uploadAttachments` (~50 LOC, ports the base64-decode + storage.store loop). |
| `convex/schema/transactional.ts` (or wherever `transactionalSends` schema lives) | New field: `language: v.optional(v.string())` on the `transactionalSends` table. Drift bug #4 fix. |

### Migration

Pre-prod. Single shot:

1. Create the `convex/transactional/` directory.
2. Schema: add `language: v.optional(v.string())` to the
   `transactionalSends` table. The field is optional — historical rows
   carry `undefined` until backfilled (or stay undefined; the
   resolved-language drift goes forward, not backward).
3. Add `convex/transactional/dispatch.ts` with the `dispatch` mutation
   and its private helpers.
4. Move the four existing files into the subdirectory:
   `transactionalApiHttp.ts → transactional/api.ts`,
   `transactionalSends.ts → transactional/sends.ts`,
   `transactionalEmails.ts → transactional/emails.ts`,
   `transactionalEmailsTranslations.ts → transactional/translations.ts`.
   Update internal cross-references between these files.
5. Rewire `transactional/api.ts:sendTransactional` to call
   `internal.transactional.dispatch.dispatch` and map the outcome.
   Extract `validateRequestShape` and `uploadAttachments` as private
   helpers in this file.
6. Delete `convex/transactionalApi.ts` (the
   `enqueueTransactionalEmail` mutation; absorbed into `dispatch`).
7. Delete `transactional/sends.ts:create` (the pre-ADR-0006 dead
   mutation).
8. Update all callers of the renamed namespaces:
   - `internal.transactionalApi.*` → `internal.transactional.dispatch.*`
     (or deleted)
   - `internal.transactionalSends.*` → `internal.transactional.sends.*`
   - `internal.transactionalEmails.*` → `internal.transactional.emails.*`
   - `api.transactionalEmails.*` → `api.transactional.emails.*`
   - `api.transactionalEmailsTranslations.*` → `api.transactional.translations.*`
   The Convex codegen at `_generated/api.d.ts` regenerates;
   missed references are compile errors.

No back-compat shims. No deprecation period. Pre-prod cut.

### Test surface

| Surface | Before | After |
|---|---|---|
| Rejection classification ("template missing → `template_not_found`; template draft → `template_not_published`; recipient blocked → `recipient_blocked`; ...") | Implicit in 470-line `sendTransactional` handler. Requires HTTP test harness, body parsing setup, abuse-gate seed, blocklist seed, contacts seed, templates seed, domains seed. ~50-80 LOC per case. | Mutation test: `expect(await dispatch({ templateLookup, email, ... })).toEqual({ ok: false, reason: 'template_not_found' })`. No HTTP harness, no body parsing setup — just call `dispatch` with typed args. ~10 LOC per case. Seven reason literals cover the matrix. |
| Happy-path dispatch (success → `queued`) | One end-to-end HTTP test that seeds everything, calls the endpoint, asserts the response shape AND the row in `transactionalSends` AND the workpool job exists. ~150 LOC. | One mutation test per assertion class. ~30 LOC each: dispatch returns `{ ok: true, ... }`; row exists in `queued` with the right `language`; both counters incremented; workpool job enqueued with the right `sendRef`. |
| Race-retry on concurrent contact creation | No test (the race-retry try/catch is the test). | Inherited from **Contact resolution (module)** — race coverage lives once, in `convex/contacts/resolution.ts` tests, and every caller benefits. The transactional path no longer carries its own race-retry test. |
| Language resolution fallback chain | Hidden inside the handler. End-to-end tests with different `language` request values, different contact `language` fields, different template defaults. Hard to set up. | Pure-function test on `resolveLanguage(requestLang, contactLang, templateDefault, availableLangs)`. Eight cases cover the fallback matrix. |
| HTTP layer | Mixed with classification logic — every test is end-to-end. | Isolated. HTTP-shell tests cover auth, CORS, JSON-shape validation, attachment storage upload, and outcome → response mapping. They mock `internal.transactional.dispatch.dispatch` and verify the response shape per outcome — no contacts, templates, abuse settings, or domain rows needed. |

### Behavior

Identical to today on every accepted path, *except*:

- **The race-retry hack is gone.** The four lines of `if
  (error.message?.includes('already exists'))` try/catch disappear.
  Replaced by the Contact resolution module's internal race handling.
  Same observable outcome: a concurrent send for the same email
  returns the same `contactId`. The mechanism moves behind a seam.
- **Both counters fire atomically with the row insert.** Today the
  daily counter is fired by the HTTP shell *after* the enqueue mutation
  returns; under this module both increments are part of the same
  mutation as the row insert. Net effect: counters can no longer
  diverge from `transactionalSends.length` on partial failure.
- **Resolved `language` is persisted on the row.** New field on
  `transactionalSends`. Visible in `getStatsByTransactionalEmail` and
  any future per-language analytics query. Pre-deepening the field was
  only on the API response.
- **One `httpAction` returns a different error mapping for the
  domain-unverified case.** Today: the HTTP shell builds the message
  from `domainStatus.error || (fallback)`. After: the dispatch
  module composes the same message string in `detail` and the shell
  passes it through verbatim. Same string, different code path.
- **`transactionalSends.create` (the dead mutation) is gone.** Zero
  observable change (no callers).

No other observable changes. Customers see exactly today's responses on
every input they send today, with the language now visible on the row
and the row guaranteed to exist atomically with the counter increments.

### Vocabulary

Adds three terms to CONTEXT.md (already landed alongside this ADR — see
the new `## Transactional sends` section):

- **Transactional email** — the row in `transactionalEmails`
- **Transactional send** — the row in `transactionalSends`
- **Transactional send intake (module)** — the intake module

Updates one existing entry: **Send dispatch (helper)** (line 1516)
lists "the transactional HTTP send (`transactionalApiHttp.ts`)" as one
of the six producers of dispatch calls. After this ADR the producer is
the **Transactional send intake (module)**'s downstream workpool
enqueue → `emailWorker.sendSingleEmail` chain — the dispatch helper
producer is no longer the HTTP shell but the workpool worker. The text
update reflects the chain.

Adds one Relationships bullet describing **Transactional send intake
(module)**'s relationships to **Contact resolution (module)**, **Send
lifecycle (module)** (downstream), and the **Send dispatch (helper)**
(downstream via workpool).

## Follow-up work

- **`transactionalEmails` lifecycle (module).** The `draft → published`
  state machine on `transactionalEmails` (and the parallel one on
  `emailTemplates`) is open-coded across `publish`, `unpublish`,
  `update`, `changeType`, `duplicate`, `addTranslation`,
  `removeTranslation`, `setDefaultLanguage` mutations. The same shape
  that landed for Send / Postbox / Campaign / AB-test / Sending-domain
  lifecycles applies here. Discussed but out of scope for this ADR.
- **Automation step email path consolidation.** If a third send path
  with the same divergence pattern (sync-vs-async, row-vs-rowless,
  contact-by-id-vs-email-upsert) appears, the unification question
  re-opens. Today: two paths, divergence pays its keep, separate.
- **Orphan-blob sweeper for failed dispatches.** Customers' attachment
  blobs uploaded to Convex storage on the path where `dispatch`
  rejects (`template_not_found` etc.) are unreferenced. A periodic
  sweeper that GCs storage rows older than N days with no referencing
  `transactionalSends.attachmentStorageIds` would close the orphan
  pile-up. Cleanup-class follow-up.

## Execution

### Steps

1. **Schema bump.** Add `language: v.optional(v.string())` to the
   `transactionalSends` table definition. Run the schema migration; no
   backfill (historical rows stay `undefined`).
2. **Create the module.** Write `convex/transactional/dispatch.ts` with
   the `dispatch` internalMutation. Port `validateDataVariables` from
   `transactionalApiHttp.ts` as a private helper. Add private
   `resolveLanguage` and `selectContent` and `mergeAttachments`
   helpers. Use `resolveContact` from `convex/contacts/resolution.ts`
   (upsert mode, `source: 'transactional'`, pass `contactFields:
   { language }` so the resolution module patches the field for
   `mode: 'upsert'` per its existing semantics).
3. **Move four files under `convex/transactional/`.**
   - `transactionalApiHttp.ts → transactional/api.ts`
   - `transactionalSends.ts → transactional/sends.ts`
   - `transactionalEmails.ts → transactional/emails.ts`
   - `transactionalEmailsTranslations.ts → transactional/translations.ts`
   Update internal `import` statements between these files (the new
   relative paths will need adjusting).
4. **Rewire the HTTP shell.** Edit `transactional/api.ts:sendTransactional`
   to:
   - Extract `validateRequestShape(body)` — JSON-shape validation that
     today lives inline (required fields, types, email format, language
     format, attachment count + size limits, https-only URL check).
     Returns either `null` or an `errorResponse(...)`. Stays in this
     file.
   - Extract `uploadAttachments(ctx, attachments)` — base64 decode +
     `ctx.storage.store` loop that today lives inline. Stays in this
     file (requires action context).
   - Call `ctx.runMutation(internal.transactional.dispatch.dispatch,
     { ... })`.
   - Map `outcome.reason` via an exhaustive `switch` to
     `errorResponse(...)`.
   - Compose the success response from `{ ok: true, ... }` fields.
5. **Delete `transactionalApi.ts`.** Search for any remaining caller of
   `internal.transactionalApi.enqueueTransactionalEmail`; expect zero
   after step 4.
6. **Delete `transactional/sends.ts:create`.** Verify zero callers
   (grep). Remove the mutation.
7. **Update cross-namespace imports.** Find every caller of:
   - `internal.transactionalApi.*` → `internal.transactional.dispatch.*`
     (or deleted)
   - `internal.transactionalSends.*` → `internal.transactional.sends.*`
   - `internal.transactionalEmails.*` → `internal.transactional.emails.*`
   - `api.transactionalEmails.*` → `api.transactional.emails.*`
   - `api.transactionalEmailsTranslations.*` →
     `api.transactional.translations.*`
   Mechanical search-and-replace. The Convex codegen runs as part of
   `bun dev`/`bun run codegen`; missed references are compile errors.
8. **Tests.** Add per-case unit tests for each `reason` literal on
   `dispatch`. Add the happy-path mutation test (assert row in
   `queued`, `language` on the row, both counters incremented,
   workpool job enqueued with the right `sendRef`). Add a regression
   test that asserts a Contact created from the transactional path
   has `source: 'transactional'` (closes the Contact-resolution
   integration). Add an HTTP-shell test that mocks `dispatch` and
   asserts the response mapping for each `reason`.

### Verification greps

After execution, these should return zero matches:

```sh
# No file outside the module writes transactionalSends.status
rg "transactionalSends.*status:" apps/api/convex/ -g '!**/transactional/dispatch.ts' -g '!**/delivery/sendLifecycle.ts' -g '!**/__tests__/**'

# The open-coded contact upsert is gone
rg "internal\.contacts\.contacts\.createForTeam" apps/api/convex/transactional/

# The race-retry hack is gone
rg "already exists.*raceContact|raceContact.*already exists" apps/api/convex/

# transactionalSends.create is gone
rg "api\.transactionalSends\.create\b|transactionalSends\.create\(" apps/

# transactionalApi.ts is gone
test ! -f apps/api/convex/transactionalApi.ts

# transactionalApiHttp.ts, transactionalSends.ts, transactionalEmails.ts,
# transactionalEmailsTranslations.ts are gone (top-level)
test ! -f apps/api/convex/transactionalApiHttp.ts && \
test ! -f apps/api/convex/transactionalSends.ts && \
test ! -f apps/api/convex/transactionalEmails.ts && \
test ! -f apps/api/convex/transactionalEmailsTranslations.ts
```

These should return matches:

```sh
# The new module exists
test -f apps/api/convex/transactional/dispatch.ts

# The four moved files are at the new path
test -f apps/api/convex/transactional/api.ts && \
test -f apps/api/convex/transactional/sends.ts && \
test -f apps/api/convex/transactional/emails.ts && \
test -f apps/api/convex/transactional/translations.ts

# The HTTP shell routes through dispatch
rg "internal\.transactional\.dispatch\.dispatch" apps/api/convex/transactional/api.ts

# Contact resolution is used
rg "resolveContact" apps/api/convex/transactional/dispatch.ts

# language field is on the row insert
rg "language:" apps/api/convex/transactional/dispatch.ts
```

### Done when

- `convex/transactional/dispatch.ts` exists with the `dispatch`
  internalMutation, `validateDataVariables` / `resolveLanguage` /
  `selectContent` / `mergeAttachments` private helpers.
- `transactional/api.ts:sendTransactional` is ≤120 lines and contains
  no contact resolution, no template lookup, no domain verification,
  no language resolution, no route resolution, no `transactionalSends`
  writes, no counter increments.
- The `outcome.reason` mapping in the HTTP shell is an exhaustive
  `switch` (TypeScript compiler-enforced).
- `convex/transactionalApi.ts` is deleted.
- `convex/transactional/sends.ts:create` is deleted.
- The four other top-level `transactional*.ts` files have moved under
  `convex/transactional/`.
- The race-retry `try/catch` hack at the old line 484-512 is gone.
- The `language` field is on the `transactionalSends` schema and is
  populated on every new row.
- Both counters (`transactionalSendCount` and daily) are incremented
  inside `dispatch`'s mutation handler, atomic with the row insert.
- Per-`reason` unit tests pass.
- The CONTEXT.md `## Transactional sends` section, the **Send dispatch
  (helper)** producer list update, and the Relationships bullet match
  this ADR.
- The grep verification matches above all hold.
