# DOI lifecycle module — single writer of contact-level double-opt-in state

**Status:** accepted

## Context

Four sites in `apps/api/convex/` re-implement the double-opt-in (DOI) flow
against `contacts.doiStatus` and its companion fields
(`doiConfirmationToken`, `doiTokenExpiresAt`, `doiConfirmedAt`). Each varies
in subtle, drift-prone ways. There is no module owning the three-state
machine (`not_required → pending → confirmed`); each producer holds its own
slice of the contract.

| Site | Mode | Token namespace | Patches contact DOI | Schedules confirmation email | Fires `topic_subscribed` trigger | Writes `topic_confirmed` activity |
|---|---|---|---|---|---|---|
| `topics/topics.ts:addContact:292-318` | request | `contacts.doiConfirmationToken` | ✅ | ✅ | only if already `confirmed` | ❌ |
| `topics/bulk.ts:addContacts:59-83` | request | `contacts.doiConfirmationToken` | ✅ | ✅ | only if already `confirmed` | ❌ |
| `topics/topics.ts:confirmDoi:362-420` | confirm | `contacts.doiConfirmationToken` (lookup) | ✅ | — | ✅ (for all DOI-required memberships) | ❌ |
| `forms/endpoints.ts:confirmFormSubmission:410-479` | confirm | `formSubmissions.confirmationToken` (lookup) → cascades to contact | ✅ | — | ❌ **(divergence)** | ❌ |

Four drift signals concentrate.

### 1. Form-confirm path silently skips the topic-subscribed trigger

`topics.confirmDoi:400-414` reads the contact's `contactTopics` rows at
confirm time and fires `fireTopicSubscribedTrigger` for each DOI-required
membership. `forms/endpoints.ts:confirmFormSubmission` runs the parallel
confirm logic — patches `contacts.doiStatus: 'confirmed'`, inserts the
`contactTopics` row, returns success — but **never fires the trigger**.
Form-driven DOI confirmations leave automations unrun. Customer-visible bug.

### 2. No path writes a `topic_confirmed` `contactActivities` row

CONTEXT.md's `contactActivities` catalog (and the schema validator at
`schema/contacts.ts`) includes `'topic_confirmed'` as a valid activity
type. None of the four sites insert it. The activity timeline silently
omits "this contact confirmed their subscription," a fact users can see in
the UI is missing.

### 3. Token TTL drift: 7 days vs 48 hours

`topics/topics.ts:8` and `topics/bulk.ts:8` set
`DOI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000` (7 days). The form path at
`forms/endpoints.ts:428` uses
`TOKEN_EXPIRY_MS = 48 * 60 * 60 * 1000` (48 hours). A contact who
subscribes via a topic-API call and a form simultaneously can have one
token expire while the other still works.

### 4. Two token namespaces for one user-visible event

The form path tracks its own `formSubmissions.confirmationToken`, separate
from `contacts.doiConfirmationToken`. The two are populated independently:
`addContact` writes the contact-level token, then the form ingest writes
its own. Each is checked by its own HTTP endpoint
(`POST /confirm/doi` vs `POST /forms/confirm/:formId`). For the common
case of "submit a form whose topic requires DOI," the user receives
*one* email but two backend tokens exist for it. The form-confirm
endpoint then cascades to the contact-side patch separately
(`forms/endpoints.ts:446-475`) without going through the DOI write path.

### 5. Expired-token handling diverges

`topics.confirmDoi:377-383` clears the token but **leaves
`doiStatus: 'pending'`**, returning a generic error. `forms/endpoints.ts:429`
returns `token_expired` and **touches nothing**. After a contact's token
expires, the topic path "cleans up" by clearing the token (so the contact
is now stuck pending forever); the form path leaves both the contact and
the form submission in their pre-expiry states.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one site's DOI block
reveals the same request-then-set or lookup-then-confirm pattern
re-implemented at three other sites with conflicting trigger-fire,
activity-log, TTL, and token-namespace semantics. The four sites have no
module; each holds its own slice of the contract. CONTEXT.md's
"Outbound lifecycle" entry flags the shape ("**Replicated by convention,
not by a generic `Lifecycle<S, E, Eff>` factor — when a third instance
lands and the duplication bites, that's when the factor lands.**") — DOI
is the third instance after Send lifecycle (ADR-0006) and Postbox
outbound lifecycle (ADR-0006).

## Decision

One module at `apps/api/convex/contacts/doiLifecycle.ts` owns
transitions of `contacts.doiStatus`. The four call sites collapse to one
typed `transition(...)` or `transitionByConfirmationToken(...)` call each.
A schema breaking change unifies the token namespace.

### Schema breaking change

`formSubmissions.confirmationToken` and `contacts.doiConfirmationToken`
are the **same string** when a form submission triggers a DOI request.
The form's `confirmationToken` column persists as a read-side lookup key
(the form-confirm HTTP handler queries `formSubmissions.by_confirmation_token`
first to validate the form-side state), but its value equals the
contact's token. The `topics/topics.ts:addContact` flow generates the
token once; whichever caller schedules the confirmation email passes
that token through; the form's `recordSubmission` stores it in its own
column. Pre-prod: no data migration needed — the new invariant holds
from the first deployment with this module.

`contacts.doiStatus` is no longer `v.optional(...)`. It is initialized
to `'not_required'` at Contact-create time by the
**Contact resolution (module)** (per ADR-0008's owner-list extension).
`undefined` is no longer a legal value at rest.

The `'throttled'`-like ambiguity in the legal-edges graph is closed:
`not_required → confirmed` (skip pending) and `confirmed → pending`
(revoke) are refused as `illegal_edge`. There is no admin force-confirm
today; if one lands later, it gets its own transition input
(`{ to: 'confirmed'; by: 'admin'; ... }`) with an audit-log effect.

### `DOI lifecycle (module)` shape

```ts
type DoiStatus = 'not_required' | 'pending' | 'confirmed';

type TransitionInput =
  | {
      to: 'pending';
      at: number;
      token: string;
      ttlMs: number;
      // Optional; if absent, the send_confirmation_email effect is omitted
      // (admin-import-style flows that pre-confirm out-of-band).
      siteUrl?: string;
    }
  | {
      to: 'confirmed';
      at: number;
    };

type TransitionOutcome =
  | {
      ok: true;
      applied: 'transitioned' | 'recorded';
      from: DoiStatus;
      to: DoiStatus;
      contactId: Id<'contacts'>;
    }
  | {
      ok: false;
      reason:
        | 'contact_not_found'
        | 'token_not_found'
        | 'token_expired'
        | 'illegal_edge'
        | 'terminal';
      from?: DoiStatus;
      to?: DoiStatus;
    };

// Direct path
export const transition: (
  ctx,
  args: { contactId: Id<'contacts'>; input: TransitionInput }
) => Promise<TransitionOutcome>;

// Token-keyed path (symmetric to Send lifecycle's transitionByProviderMessageId)
export const transitionByConfirmationToken: (
  ctx,
  args: { token: string; input: TransitionInput }
) => Promise<TransitionOutcome>;
```

Legal edges:

- `not_required → pending` (request) — sends confirmation email
- `pending → pending` (request, idempotent) — `applied: 'recorded'`,
  no second email
- `pending → confirmed` (confirm) — fires topic-subscribed triggers
- `confirmed → confirmed` (confirm, idempotent) — `applied: 'recorded'`
- All other transitions refused

### Reducer effects

The reducer returns `{ patch, effects, applied }`. The effect list:

- **`send_confirmation_email { email, firstName, token, siteUrl }`** —
  fires on `to: 'pending'` from `not_required`, only when `siteUrl` is
  present. Schedules `internal.confirmationEmail.sendConfirmationEmail`
  via `ctx.scheduler.runAfter(0, ...)`.
- **`fire_topic_subscribed_triggers { contactId, topicIds }`** — fires
  on `to: 'confirmed'` from `pending`. The mutation entry point reads
  `contactTopics` joined to `topics.requireDoubleOptIn` and passes the
  resulting topic ids to the reducer; the effect schedules one call to
  `internal.automations.triggers.fireTopicSubscribedTrigger` per id.
- **`contact_activity_topic_confirmed { contactId, topicIds }`** —
  fires on `to: 'confirmed'`, writes one `contactActivities` row per
  DOI-required topic with `activityType: 'topic_confirmed'`. Closes
  drift signal #2.

The module owns:

- **Token generation and TTL.** `nanoid(32)` for the token; the canonical
  TTL `DOI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000` is exported as a
  module constant. Callers do not generate tokens or set expiries; they
  pass the token (when known — e.g. from a prior `addContact` call) or
  let the request transition mint a new one.
- **Companion-field atomicity.** `doiStatus`, `doiConfirmationToken`,
  `doiTokenExpiresAt`, `doiConfirmedAt`, and `updatedAt` are all
  written/cleared by the reducer in one patch. No caller patches the
  companions directly.
- **Token-keyed contact lookup.** `transitionByConfirmationToken` uses
  `contacts.by_doi_confirmation_token` — the only existing
  production caller of that index (today's `topics.getContactByDoiToken`
  query becomes a thin wrapper).

The module does *not* own:

- Form-submission lifecycle (`formSubmissions.status`). The form-confirm
  endpoint coordinates: it patches the form submission to `'success'`
  separately, after calling `transitionByConfirmationToken`. The two
  state machines remain distinct (one row per submission, one
  `doiStatus` per contact).
- Topic membership writes (`contactTopics`). Callers manage memberships
  directly; the lifecycle module only fires triggers for memberships
  that exist at confirm time.
- Activity-log emission for non-`topic_confirmed` events (e.g. a
  `'created'` activity on first signup stays in the calling path).

### Call-site shape after the cut

```ts
// topics/topics.ts:addContact (was lines 292-318)
const requiresDoi = topic.requireDoubleOptIn === true && args.skipDoi !== true;
if (requiresDoi) {
  const token = nanoid(32);
  const outcome = await doiLifecycle.transition(ctx, {
    contactId: args.contactId,
    input: { to: 'pending', at: now, token, ttlMs: DOI_TOKEN_TTL_MS, siteUrl: args.siteUrl },
  });
  // outcome.applied === 'recorded' if already pending or already confirmed
}
```

```ts
// topics/topics.ts:confirmDoi (was lines 362-420)
const outcome = await doiLifecycle.transitionByConfirmationToken(ctx, {
  token: args.token,
  input: { to: 'confirmed', at: Date.now() },
});
if (!outcome.ok) return { success: false, error: outcome.reason };
return { success: true, alreadyConfirmed: outcome.applied === 'recorded' };
```

```ts
// forms/endpoints.ts:confirmFormSubmission (was lines 410-479)
const submission = await ctx.db
  .query('formSubmissions')
  .withIndex('by_confirmation_token', (q) => q.eq('confirmationToken', token))
  .first();
if (!submission) return { success: false, error: 'invalid_token' };
if (submission.status === 'success') return { success: true, alreadyConfirmed: true };

// Unified token: the contact-side patch + trigger fanout + activity log
// happens here, in the lifecycle module.
const outcome = await doiLifecycle.transitionByConfirmationToken(ctx, {
  token,
  input: { to: 'confirmed', at: now },
});
if (!outcome.ok) return { success: false, error: outcome.reason };

// Form-submission patch is the form's own concern.
await ctx.db.patch(submission._id, { status: 'success', confirmedAt: now });

// Topic membership insert (form-specific concern; the lifecycle module
// already fired the trigger for it via the fanout).
const form = await ctx.db.get(submission.formEndpointId);
if (form?.topicId && submission.contactId) {
  const existing = await ctx.db.query('contactTopics')
    .withIndex('by_contact_and_topic', (q) =>
      q.eq('contactId', submission.contactId!).eq('topicId', form.topicId!),
    )
    .first();
  if (!existing) {
    await ctx.db.insert('contactTopics', {
      contactId: submission.contactId,
      topicId: form.topicId,
      addedAt: now,
    });
  }
}
```

## Considered options

### Token namespace

1. **Unify token namespaces** *(chosen)*. One token per pending
   confirmation. `formSubmissions.confirmationToken` and
   `contacts.doiConfirmationToken` are the same string. Closes drift
   signal #4. Pre-prod: trivial.
2. **Two tokens, DOI module ignores the form token.** Form path stays
   a separate state machine; DOI module only knows the contact-level
   token. Rejected — preserves the dual-namespace bookkeeping that
   produces drift signal #4 and keeps the form-side and contact-side
   triggers/activities offset.
3. **Form's confirmation is a separate lifecycle, calls into DOI as a
   downstream effect.** Form lifecycle's `confirm` transition fires a
   `confirm_doi` effect that drives the DOI lifecycle. Rejected — two
   state machines for one user-visible "click the link" event, with
   two emails possible if the boundary is decoupled.

### Trigger fanout on confirm

1. **Fan out to all DOI-required memberships** *(chosen — keeps today's
   contact-level DOI semantics)*. The contact, not the topic, owns the
   DOI grant. One click confirms the contact; every DOI-required topic
   the contact is in receives its `topic_subscribed` trigger.
2. **Fan out only to the topic that originated the email.** Requires
   storing "which topic requested this token" alongside the token —
   complicates the schema for a different mental model that contradicts
   the contact-level DOI invariant. Rejected.

### Token TTL

1. **7 days** *(chosen, longer of the two existing values)*. Matches
   today's `topics/*` paths; more user-friendly (people open marketing
   emails days after sending). Form-path's 48h was tighter without
   apparent justification.
2. **48 hours.** Stricter anti-abuse signal. Rejected as the change is
   user-visible (more tokens expire) without a corresponding security
   gain.
3. **Configurable per-org.** Speculative; no caller needs it. Rejected.

### Admin force-confirm

1. **No skip-pending transition** *(chosen)*. `not_required → confirmed`
   is `illegal_edge`. No existing producer skips pending; YAGNI.
2. **Add `{ to: 'confirmed'; by: 'admin' }` skip-pending input.**
   Speculative; rejected. Lands as an additive transition when the
   admin-override UI does.

### `doiStatus` representation

1. **Always-write `'not_required'` at Contact-create time** *(chosen,
   pre-prod)*. `undefined` no longer appears at rest. The
   **Contact resolution (module)** writes `'not_required'` (per
   ADR-0008's owner-list extension). Cleaner reads; no `?? 'not_required'`
   defaulting needed downstream.
2. **Treat `undefined` and `'not_required'` as equivalent.** Lower
   blast radius but the union-with-undefined leaks into every reader.
   Rejected as pre-prod, where the cleanup is cheap.

### Operation surface

1. **Two entry points: direct + token-keyed** *(chosen)*. Mirrors the
   Send lifecycle's `transition` + `transitionByProviderMessageId`
   pattern. The token-keyed entry is the customer-facing surface; the
   direct entry is for internal admin / migration paths.
2. **One operation with optional token.** `transition({contactId?, token?, input})`. Less typed; lookup-by-key ambiguity at the
   call site. Rejected.
3. **Three operations matching today's three call shapes** (`request`,
   `confirm`, `confirmByToken`). Verb-keyed rather than `to`-keyed.
   Rejected — drifts from the Send-lifecycle template and forces
   every caller to know whether they're a verb-x or verb-y caller.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/topics/topics.ts:292-318` — request block in
  `addContact` collapses to one `doiLifecycle.transition` call.
- `apps/api/convex/topics/topics.ts:362-420` — `confirmDoi` mutation
  becomes a thin wrapper around `transitionByConfirmationToken` that
  returns a customer-shaped error envelope. The `contactTopics`-scan +
  trigger-fanout loop disappears (now an effect of the transition).
- `apps/api/convex/topics/topics.ts:8` and `topics/bulk.ts:8` —
  `DOI_TOKEN_TTL_MS` constant duplicated in both files collapses to one
  export from the lifecycle module.
- `apps/api/convex/topics/bulk.ts:58-83` — per-contact request block
  in `addContacts` collapses; the `for` loop calls `transition` per id
  but the trigger-fanout follow-up (lines 88-107) goes away (handled
  by the `to: 'confirmed'` effect path when the user eventually clicks).
- `apps/api/convex/forms/endpoints.ts:410-479` — `confirmFormSubmission`
  loses the open-coded contact patch + topic-membership insert
  + missing trigger-fire. Contact-side write delegates to
  `transitionByConfirmationToken`; form-side patch and topic-membership
  insert stay in the handler.
- `apps/api/convex/topics/topics.ts:getContactByDoiToken` —
  preserved (used by the GET `/confirm/doi/verify` endpoint for pre-confirm
  display). The lookup logic now reuses the lifecycle module's
  `findContactByConfirmationToken` helper.

### Files that grow

- `apps/api/convex/contacts/doiLifecycle.ts` (new, ~280 LOC). Exports
  the `DoiStatus` literal tuple and validator, the `TransitionInput` /
  `TransitionOutcome` types and validators, the `transition` and
  `transitionByConfirmationToken` `internalMutation`s, the
  `findContactByConfirmationToken` lookup primitive, and the
  `DOI_TOKEN_TTL_MS` constant.
- `apps/api/convex/contacts/resolution.ts` — `doiStatus: 'not_required'`
  added to the create-side patch (one-line addition per `mode`).
- `apps/api/convex/schema/contacts.ts` — `doiStatus` becomes
  non-optional with a short comment pointing to this ADR.

Net LOC change is favourable: the four call sites shed ~140 LOC of
duplicated DOI plumbing; the new module adds ~280 LOC. The value is
locality, typed contract, and the deletion of five drift bugs.

### Migration

Pre-production: no data backfill is required for the token unification
(no existing pending tokens). The `doiStatus` non-optional schema change
is additive over rows that have it; pre-prod means a one-shot backfill
to write `'not_required'` on existing rows can land atomically with the
schema change (`apps/api/convex/_internal/migrations/backfillDoiStatus.ts`).
Documented as an internal mutation that runs once at deploy time.

If/when production data exists, the migration would need a one-pass
backfill to populate `formSubmissions.confirmationToken` from each
submission's linked `contacts.doiConfirmationToken` (joined via
`submission.contactId`), so the two columns agree before the lifecycle
module's `transitionByConfirmationToken` becomes load-bearing.

### Test surface

- `apps/api/convex/__tests__/doiLifecycle.integration.test.ts` (new,
  ~12 tests) — table-driven per `from-state × transition × idempotency`.
  Covers `not_required → pending` (email scheduled), `pending → pending`
  (no second email, `applied: 'recorded'`), `pending → confirmed`
  (trigger fanout, activity rows), `confirmed → confirmed` (recorded),
  `illegal_edge` refusals, `token_expired` handling, multi-topic trigger
  fanout, and the form-confirm path's atomic contact-patch + form-patch.
- The four pre-existing integration tests of the four call sites
  (`__tests__/topics.integration.test.ts`,
  `__tests__/topicsBulk.integration.test.ts`,
  `__tests__/forms.integration.test.ts`) stay; assertions shift from
  "contact's doiStatus is patched" to "DOI lifecycle returns
  `applied: 'transitioned'`" — the lifecycle's interface becomes the
  test surface.

### Behavior

All four caller-visible behaviors are preserved (with the four drift
bugs fixed opportunistically):

- Topic-subscribe (single, bulk) still queues confirmation email on
  first request.
- Topic-confirm via `/confirm/doi?token=` still patches the contact and
  fires triggers for every DOI-required membership.
- Form-confirm via `/forms/confirm/:formId?token=` still patches the
  contact, inserts the topic membership, and (newly) **fires the
  `topic_subscribed` trigger** — closes drift signal #1.
- Bulk subscribe still respects `skipDoi: true` (no email scheduled).

Five drift bugs are fixed opportunistically:

1. The form-confirm path now fires `topic_subscribed` triggers (was
   silently skipped — drift signal #1).
2. All confirm paths now insert `topic_confirmed` `contactActivities`
   rows (was silently omitted in all four paths — drift signal #2).
3. The 7d-vs-48h TTL is unified to 7d (drift signal #3).
4. The dual-token namespace collapses to one token per pending
   confirmation (drift signal #4).
5. Expired-token handling is uniform (`token_expired` outcome with no
   side effects — neither token-clear nor status-stuck — drift signal #5).

### Vocabulary

CONTEXT.md gains two entries in the **Contacts** section — **DOI status**
and **DOI lifecycle (module)** — and a relationships paragraph linking
the four producers to the lifecycle. The **Contact resolution (module)**
entry is amended to list `doiStatus: 'not_required'` among the fields it
owns at create time. The Outbound-lifecycle factor question advances to
"active design" with DOI as the third instance; see Relationships
section.

## Follow-up work

1. **Lifecycle factor (`Lifecycle<S, T, E>`).** With Send lifecycle
   (ADR-0006), Postbox outbound lifecycle (ADR-0006), DOI lifecycle
   (this ADR), Inbox processing lifecycle (ADR-0010), and Abuse status
   (ADR-0011) all instantiating the same skeleton, the factor question
   is active. Held off because reducers genuinely diverge at the
   implementation level — the factor would dedup type signatures only.
   Revisit on instance #6.
2. **`topic_confirmed` activity → `Webhook event`?** The
   `topic.confirmed` Webhook event literal does not exist today. If/when
   customer webhooks need DOI-confirm signals, add the event to the
   ADR-0002 catalog and wire a `webhook_event_fanout` effect to the
   lifecycle's `to: 'confirmed'` reducer.
3. **DOI on inbound-created Contacts.** Inbound channels
   (`processInboundChannel`, `receiveMessage`) create Contacts with no
   DOI implication. Policy decision deferred — they default to
   `'not_required'` and never request DOI. If a future topic-based
   subscription flow lands for inbound contacts, the request transition
   runs naturally.
4. **Form submission's own `'pending_confirmation' | 'success' |
   'invalid' | 'spam' | 'duplicate'` lifecycle.** Today the form
   handler open-codes its status transitions. If/when a fifth status
   appears or the drift becomes painful, that's its own deepening
   candidate (ADR-pending). Out of scope here.

## Execution

Implemented in a single pre-production pass — no separate execution
plan, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/contacts/doiLifecycle.ts` — new module.
- `apps/api/convex/contacts/resolution.ts` — initial `doiStatus`
  write on create (one-line addition per mode).
- `apps/api/convex/schema/contacts.ts` — `doiStatus` becomes
  non-optional.
- Four call sites migrated across `topics/` and `forms/`.
- `apps/api/convex/_internal/migrations/backfillDoiStatus.ts` — one-shot
  internal mutation, runs at deploy time.
- `apps/api/convex/__tests__/doiLifecycle.integration.test.ts` — new.

CONTEXT.md is updated in the same pass (DOI status + DOI lifecycle
(module) entries + Relationships paragraph). The
**Contact resolution (module)** entry is amended to list `doiStatus`
among its create-time writes.
