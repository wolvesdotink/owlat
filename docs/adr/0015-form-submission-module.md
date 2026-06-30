# Form submission module — single intake path for public form endpoints

**Status:** proposed

## Context

ADR-0008 deepened find-or-create of a Contact into the
**Contact resolution (module)** with four declared callers. ADR-0013
deepened all `contactTopics` writes into the **Topic subscription
(module)** with six declared callers. ADR-0009 unified the DOI
confirmation token namespace under the **DOI lifecycle (module)** so
the form-confirm endpoint chains
`doiLifecycle.transitionByConfirmationToken` followed by a separate
`formSubmissions.status: 'success'` patch.

What never got deepened is the **submit** side of the form path itself.
`forms/apiHttp.ts:submitForm` is a 285-line `httpAction` that owns CORS,
rate-limit, URL parsing, body parsing, honeypot detection, field
validation, contact find-or-create (open-coded — missed by ADR-0008's
migration), conditional topic-add via the public `addContact` mutation,
DOI token re-read, response shaping, and five separate
`recordSubmission` writes for the five status literals (`spam`,
`invalid`, `duplicate`, `pending_confirmation`, `success`). The submit
half of `formSubmissions` writes lives in this file; the
`pending_confirmation → success` patch lives in
`forms/endpoints.ts:confirmSubmission`. No single writer.

### Drift landscape

Six drift signals across the submit path.

#### 1. Open-coded find-or-create missed by ADR-0008

`apiHttp.ts:301-334`:

```ts
const existingContact = await ctx.runQuery(
  internal.contacts.organization.getByEmailForOrganizationInternal,
  { email },
);

if (existingContact) {
  contactId = existingContact._id;
  await ctx.runMutation(internal.forms.endpoints.recordSubmission, {
    formEndpointId: form._id, contactId, data: submissionData,
    status: 'duplicate' as const, ipAddress, userAgent,
  });
} else {
  // 90 lines of contact create, topic add, DOI token read, recordSubmission
}
```

The other four pre-ADR-0008 sites (`inbox/messages.ts:receiveMessage`,
`webhooks/channels.ts:processInboundChannel`,
`contacts/internal.ts:importContacts`,
`contacts/contacts.ts:createForTeam`) all migrated to
`resolveContact({ ..., mode: 'upsert' })`. The form path was missed.
Today it carries its own `getByEmail` + `createForTeam` pair, with its
own `searchableText` shape, its own soft-delete filter (or lack
thereof), and its own decision of what to do with the `action`.

#### 2. Silently-dropped Topic membership for existing-contact-joins-new-topic

`apiHttp.ts:307-318`: when `existingContact` is truthy, the path writes
`status: 'duplicate'` and **returns** — it never calls the topic-add
branch on `:338-345`. So a Contact already in the org who fills out a
form to join a *new* Topic gets a `duplicate` row written and is **not**
added to the topic. A real bug, present in main, masked by the
ambiguous `duplicate` literal (meaning "duplicate Contact" rather than
"duplicate Topic membership").

#### 3. Split `formSubmissions.status` writer

Two files write the status field:

| Site | Statuses written |
|---|---|
| `forms/apiHttp.ts:submitForm` (5 separate `recordSubmission` calls) | `spam`, `invalid`, `duplicate`, `pending_confirmation`, `success` |
| `forms/endpoints.ts:confirmSubmission` (inline `ctx.db.patch`) | `success` (from `pending_confirmation`) |

No single owner. When the `success`-on-confirm patch grows a sibling
field (e.g., `confirmationIp`, `confirmedSource`), two files have to
agree on what's atomic.

#### 4. Redundant contact re-read for the DOI token

`apiHttp.ts:354-357`:

```ts
const contactAfter = await ctx.runQuery(
  internal.contacts.organization.getByEmailForOrganizationInternal,
  { email },
);
await ctx.runMutation(internal.forms.endpoints.recordSubmission, {
  ..., confirmationToken: contactAfter?.doiConfirmationToken,
});
```

The token was just written by the **DOI lifecycle (module)** *inside*
`subscribe`'s `request_doi` effect — but the chain
`apiHttp → addContact → subscribe → doiLifecycle.transition` doesn't
return the freshly-written token to the original caller. The form path
has to re-read the contact to find it. The fix is a small return-shape
bump on `subscribe()` — `{ action, doiToken? }` — which other callers
ignore but the form path consumes.

#### 5. Redundant auth shell on `addContact`

`apiHttp.ts:340-344` calls `api.topics.topics.addContact` — the
*public* mutation. The form HTTP endpoint is already its own public
auth surface (CORS, IP-keyed rate-limit, honeypot, form `isActive`
check). Going through the public `addContact` runs *that* mutation's
auth shell on top: a second round of context resolution, role lookups,
and permission checks. None of which add anything (the form endpoint is
the front door). The deepening calls `subscribe()` directly,
bypassing the auth shell entirely. Topic subscription's
**not-owned-by-the-module** list (ADR-0013) explicitly notes "auth
(public mutations stay as auth-bearing shells)" — the form path is the
case where the public auth shell is redundant and the direct
`subscribe()` call is appropriate.

#### 6. Inline status branches in a 285-line `httpAction`

The five status literals are decided by control flow scattered across
lines 226-396 of `apiHttp.ts`, intermixed with HTTP plumbing, body
parsing, contact resolution, topic add, and response shaping. Asking
"which submission status fires for a malformed email when the form has
no topic?" requires reading the whole handler. No isolatable surface
for unit-testing the classification logic. No way to call the intake
path from an internal trigger (e.g., a CSV-as-form-submission import or
a programmatic form replay) without re-implementing the 285 lines.

### Shared framing

The submit path's friction is the same pattern that ADR-0008 closed for
contacts and ADR-0013 closed for topic memberships: per-call ceremony
around a small core of intake work, with the per-table writer scattered
across the call sites that classify into terminal states. The fix is
the **Form submission (module)** — single intake function, classifies
internally, routes through the existing `resolveContact` and
`subscribe` modules, writes one `formSubmissions` row, returns a
discriminated `action`. Mirrors the **Contact resolution (module)**
shape (also classifier + `action`), not the **Outbound lifecycle**
shape (rows here land directly in terminal state at create time).

## Decision

Introduce **Form submission (module)** at `convex/forms/submission.ts`.
Single intake mutation `submit` for the (no row) → terminal-or-pending
edges; small companion `markConfirmedByToken` for the only true
transition (`pending_confirmation → success`). The vocabulary entry
in CONTEXT.md ships alongside this ADR (already landed: see the
`## Forms` section + Relationships bullet).

### Module shape

```ts
// convex/forms/submission.ts

export type SubmitAction =
  | 'spam'
  | 'invalid'
  | 'duplicate'
  | 'pending_confirmation'
  | 'success';

export type SubmitOutcome =
  | {
      ok: true;
      submissionId: Id<'formSubmissions'>;
      action: SubmitAction;
      contactId?: Id<'contacts'>;
      redirectUrl?: string;     // surfaced for the HTTP shell — see below
      confirmationRequired?: boolean;
    }
  | { ok: false; reason: 'form_not_found' | 'form_inactive' };

export const submit = internalMutation({
  args: {
    formEndpointId: v.id('formEndpoints'),
    submissionData: v.record(v.string(), v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SubmitOutcome> => {
    // 1. Load form, check isActive
    // 2. Honeypot → 'spam' (write row, return)
    // 3. Field validation, extract email → 'invalid' (write row, return)
    // 4. resolveContact({ channel: 'email', mode: 'upsert', source: 'form', contactFields })
    // 5. If form.topicId: subscribe({ topicId, contactId, source: 'form', siteUrl })
    // 6. Classify action from (resolveContact action, subscribe result)
    // 7. Write row with status + confirmationToken (from subscribe's doiToken)
    // 8. Return { ok: true, submissionId, action, contactId, redirectUrl?, confirmationRequired? }
  },
});

export type MarkConfirmedOutcome =
  | { ok: true; submissionId: Id<'formSubmissions'> }
  | {
      ok: false;
      reason: 'no_submission_for_token' | 'already_confirmed' | 'invalid_state';
    };

export const markConfirmedByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<MarkConfirmedOutcome> => {
    // Look up via by_confirmation_token index.
    // already 'success' → { ok: false, reason: 'already_confirmed' } (idempotent re-confirm)
    // not 'pending_confirmation' → { ok: false, reason: 'invalid_state' }
    // not found → { ok: false, reason: 'no_submission_for_token' }
    // else patch { status: 'success', confirmedAt: Date.now() }
  },
});
```

Two entry points. `submit` is the one-shot intake. `markConfirmedByToken`
is the only true transition — called by the form-confirm HTTP handler
*after* `doiLifecycle.transitionByConfirmationToken` commits the
contact-side state, keeping each module table-pure.

### Classification rules

```ts
function classifyAction(
  resolveAction: 'matched' | 'created',
  subscribeResult: { action: 'inserted' | 'already_member'; doiToken?: string } | undefined,
): SubmitAction {
  // No topicId — classify on Contact resolution alone.
  if (!subscribeResult) {
    return resolveAction === 'matched' ? 'duplicate' : 'success';
  }
  // topicId set — subscribe was called.
  if (subscribeResult.action === 'already_member') return 'duplicate';
  if (subscribeResult.doiToken) return 'pending_confirmation';
  return 'success';
}
```

A single 7-line pure function. Replaces the 90-line scattered branch in
`apiHttp.ts:307-396`. Directly unit-testable across all 6 inputs without
a Convex harness.

### Topic subscription return-shape bump

`subscribe()` and `subscribeMany()` extend their return shape:

```ts
// Before (ADR-0013):
type SubscribeResult = { action: 'inserted' | 'already_member' };

// After (this ADR):
type SubscribeResult = { action: 'inserted' | 'already_member'; doiToken?: string };
```

`doiToken` is populated when the `request_doi` effect fires — the DOI
lifecycle's `transition({ to: 'pending', token, ttlMs, siteUrl })` writes
the token to the contact, and `subscribe` captures it from the
transition's result (the lifecycle's `TransitionOutcome` already carries
the patch payload internally; we surface the token from there). All
existing callers ignore the new optional field; the form submission
module is the first consumer.

For `subscribeMany`, the return is per-membership (today already an
array), so each entry independently carries its `doiToken?`. Bulk-add
callers ignore the field; same compatibility story.

### HTTP shell shrinkage

`forms/apiHttp.ts:submitForm` collapses from 285 lines to ~60:

```ts
export const submitForm = httpAction(async (ctx, request) => {
  // CORS preflight, method check, rate-limit (unchanged)
  // Extract formId from URL
  // Parse body (parseFormData helper stays in this file)

  const outcome = await ctx.runMutation(internal.forms.submission.submit, {
    formEndpointId: formId,
    submissionData,
    ipAddress,
    userAgent,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'form_not_found')
      return jsonResponse({ error: { message: 'Form not found', code: 'form_not_found' } }, 404);
    if (outcome.reason === 'form_inactive')
      return jsonResponse({ error: { message: 'Form inactive', code: 'form_inactive' } }, 403);
  }

  // Map outcome to response
  if (outcome.action === 'invalid') {
    return jsonResponse({ error: { message: outcome.errorMessage, code: 'validation_error' } }, 400);
  }
  if (outcome.redirectUrl) {
    if (outcome.confirmationRequired) {
      const url = new URL(outcome.redirectUrl);
      url.searchParams.set('confirmation', 'pending');
      return redirectResponse(url.toString());
    }
    return redirectResponse(outcome.redirectUrl);
  }
  if (outcome.confirmationRequired) {
    return jsonResponse({
      success: true,
      message: 'Please check your email to confirm your subscription',
      confirmationRequired: true,
    });
  }
  return jsonResponse({ success: true, message: 'Form submitted successfully' });
});
```

CORS / rate-limit / parse / dispatch / respond. No classification logic,
no contact resolution, no topic add, no DOI bookkeeping.

`forms/endpoints.ts:confirmSubmission` simplifies to:

```ts
export const confirmFormSubmission = httpAction(async (ctx, request) => {
  // Extract token from URL (unchanged)
  const doiResult = await ctx.runMutation(internal.contacts.doiLifecycle.transitionByConfirmationToken, {
    token,
    input: { to: 'confirmed' },
  });
  if (!doiResult.ok) {
    // Map doiResult.reason to HTTP status (unchanged)
  }
  const submissionResult = await ctx.runMutation(
    internal.forms.submission.markConfirmedByToken,
    { token },
  );
  // Map submissionResult to response (success page, redirect, etc.)
});
```

The chain reads in two module calls. Each module touches its own table.
DOI does not learn about `formSubmissions`.

### Why `redirectUrl` rides on the outcome

The HTTP shell needs `form.redirectUrl` to shape the response. Two
options:
- Submit module returns `redirectUrl?: string` in the outcome (and a
  `confirmationRequired?: boolean` flag for the
  `pending_confirmation` redirect-with-query-param case).
- HTTP shell re-fetches the form via `getForSubmission` after `submit`.

The first is pragmatic — the module already loaded the form, passing
the field up saves a second query. The field is response-shaping
metadata, not domain state; the module doesn't read it for any decision
of its own. Choice is locked at A1.

## Considered options

### Shape — lifecycle vs intake

**Chosen: intake.**

Five existing modules in CONTEXT.md instantiate the **Outbound
lifecycle** shape (DOI, Inbox processing, Send, Postbox outbound, Abuse
status). All five share a feature this candidate doesn't: their rows
are *pre-created in a known state* (`queued`, `received`,
`not_required`), and the lifecycle owns transitions between subsequent
states. Form submission is different — 4 of 5 rows land directly in a
terminal state at create time (`spam`, `invalid`, `duplicate`,
`success`), and only `pending_confirmation → success` is a real
transition over time.

The intake shape (one entry point + classifier + small companion
transition entry) matches the actual work; the lifecycle bookkeeping
(typed `TransitionInput`, `LEGAL_EDGES` graph including `(no row) → X`
synthetic create kinds, reducer per kind, effects list) would be
ceremony per state literal for what is fundamentally a one-shot decision
+ a single 1-state-pair transition. The Contact resolution module is
the right parallel: also one-shot intake from HTTP into the domain,
also returns `{ contactId, action }` with `action` as the discriminator.

### Scope — thin vs thick

**Chosen: thick.**

Thin (module owns submission row writes only; caller orchestrates
Contact resolution and Topic subscription) fails the deletion test —
delete the thin module and the 90-line orchestration block in
`apiHttp.ts` stays put. Most of the friction in drift bugs #1–#6 lives
in the orchestration, not the row write.

Thick (module owns the full intake from "form loaded + body parsed"
through final classification, calling Contact resolution and Topic
subscription internally) closes drift bug #1 (form path now goes
through Contact resolution like the other 4 sites), drift bug #2
(existing-contact-joins-new-topic stops being a no-op since `subscribe`
is now called unconditionally when a topicId is set), drift bug #4
(token return through `subscribe` bump), drift bug #5 (no
`addContact` auth shell), and drift bug #6 (orchestration lives in a
single mutation with a small classify function).

### Duplicate semantics — preserve vs new

**Chosen: new (always subscribe when topicId is set; classify on the
subscribe result).**

Preserving today's behavior (existing contact → `duplicate`, skip
topic-add) carries the silent-drop bug forward. The behavior change
makes `duplicate` mean "duplicate Topic membership" (consistent with the
literal name and with how every other module-aware path treats an
existing Contact — `matched` doesn't drop the downstream work). The
shape is:

| Path | `subscribe` result | Submission status |
|---|---|---|
| No `topicId`; Contact resolution `created` | n/a | `success` |
| No `topicId`; Contact resolution `matched` | n/a | `duplicate` |
| `topicId` set; subscribe returns `already_member` | `{ action: 'already_member' }` | `duplicate` |
| `topicId` set; subscribe returns `inserted` no DOI | `{ action: 'inserted' }` | `success` |
| `topicId` set; subscribe returns `inserted` DOI-pending | `{ action: 'inserted', doiToken }` | `pending_confirmation` |

A real (small) behavior change visible to users: an existing Contact who
fills out a form to join a *new* Topic now gets added. The deepening
ships with one new test asserting this case ends in
`already_member` (or `inserted` if not previously subscribed) rather
than today's silent skip.

### DOI token plumbing — extend `subscribe()` vs extra contact read

**Chosen: extend `subscribe()`'s return shape.**

Two options:
1. Extend `subscribe()` / `subscribeMany()` to return `{ action,
   doiToken? }` — small interface bump on **Topic subscription
   (module)**; the existing callers ignore the new field; the form
   submission module consumes it.
2. Keep the redundant `ctx.db.get(contactId)` in the form submission
   module to fetch `doiConfirmationToken` after `subscribe` returned
   DOI-pending. Two reads for what is essentially the same domain fact.

(1) is tidier. The token lives in scope inside `subscribe` immediately
after `doiLifecycle.transition({ to: 'pending' })` — surfacing it
through the return value is a few lines in the existing module, and it
turns "redundant contact re-read" into a property of an existing
function's interface.

### Pending → success edge — token-keyed module entry vs DOI effect vs submissionId-keyed

**Chosen: token-keyed module entry.**

(a) `formSubmission.markConfirmedByToken({ token })` — the
form-confirm HTTP handler calls DOI first, then this. Each module owns
its own table. Symmetric with DOI's own `transitionByConfirmationToken`.
`formSubmissions.confirmationToken` is already indexed; one lookup.

(b) Add `mark_form_submission_success` to DOI's `to: 'confirmed'`
reducer effects. Reads cleanly at the confirm call site (handler only
calls DOI), but DOI becomes a writer of `formSubmissions` — violating
the "share the shape, not the table" discipline established in the DOI
lifecycle entry. The DOI lifecycle is intentionally Contact-table-only;
the topic-side effects fire `fire_topic_subscribed_triggers` etc. by
calling out, not by writing other tables directly.

(c) `formSubmission.markConfirmed({ submissionId })` — caller looks up
the submission by token first, then calls. Two queries instead of one,
and the per-token lookup is the index that the deepening would force the
module to own anyway.

(a) is the natural shape.

### Naming

**Chosen: Form submission (module).**

Parallels **Contact resolution (module)** (one-shot intake + `action`
discriminator) and **Topic subscription (module)** (per-domain-noun,
owns one table). Rejected alternatives — see the `_Avoid_` list in the
CONTEXT.md entry: Form intake (module) (verb mismatch), Submission
(module) alone (overloaded), Form endpoint (module) (collides with
`formEndpoints` configuration), Form submission lifecycle (module)
(rows mostly land in terminal state — the lifecycle framing inflates
bookkeeping for one true edge).

## Consequences

### Files that collapse / disappear

| File | What happens |
|---|---|
| `convex/forms/apiHttp.ts` | `submitForm` shrinks 285 → ~60 lines. Open-coded find-or-create (lines 301-334), inline classification (lines 226-396), contact re-read for token (lines 354-357), and the five `recordSubmission` call sites all move into `convex/forms/submission.ts`. CORS / rate-limit / body parsing helpers stay. |
| `convex/forms/endpoints.ts:confirmSubmission` | Inline `ctx.db.patch(submission._id, { status: 'success', confirmedAt })` removed. Replaced by `submission.markConfirmedByToken` call. The handler shrinks from ~70 lines to ~25. |
| `convex/forms/endpoints.ts:recordSubmission` (internal mutation) | Deleted. All `formSubmissions` writes now live in `convex/forms/submission.ts`. The form-submission row write is no longer a separate mutation called from outside. |
| `convex/forms/api.ts` (the file as a whole) | Audit pass. `generateConfirmationToken` (lines 10-15) is no longer called by the submit path (token is generated by DOI lifecycle inside `subscribe`). If unused, delete. If still called by a non-form caller, keep. `getSiteUrl` (lines 18-23) likewise — Form submission module reads `SITE_URL` itself via `getOptional`. |

### Files that grow

| File | What it gains |
|---|---|
| `convex/forms/submission.ts` (new) | `submit` mutation, `markConfirmedByToken` mutation, the `classifyAction` pure function, private `validateFields` + `extractEmail` helpers. ~220 LOC total. |
| `convex/topics/subscription.ts` | `subscribe()` and `subscribeMany()` return shape adds `doiToken?: string` on the `'inserted'`-action branch, populated when the `request_doi` effect fired. ~10 LOC of changes. |

### Migration

Pre-prod. Single shot:

1. Bump **Topic subscription (module)**'s `subscribe()` and
   `subscribeMany()` return shapes to include `doiToken?`. Existing
   callers (single-add, bulk-add, batch-import, public-API, automation,
   public-email-link, preferences-page) ignore the field — no behavior
   change for them. The form submission module is the first consumer.
2. Add `convex/forms/submission.ts` with `submit` and
   `markConfirmedByToken`.
3. Rewire `forms/apiHttp.ts:submitForm` to call `submit` and map the
   outcome to a response.
4. Rewire `forms/endpoints.ts:confirmSubmission` to chain
   `doiLifecycle.transitionByConfirmationToken` →
   `submission.markConfirmedByToken`.
5. Delete `forms/endpoints.ts:recordSubmission` (and any other
   `formSubmissions` writers).
6. Audit `forms/api.ts` for dead exports post-rewire.

No back-compat shims. No deprecation period. Pre-prod cut.

### Test surface

| Surface | Before | After |
|---|---|---|
| Classification logic ("matched + no topic → duplicate; created + DOI-pending → pending_confirmation; ...") | Implicit in 285-line `submitForm`. Requires HTTP test harness, rate-limiter mock, contacts seed, topics seed, DOI lifecycle integration. ~30 LOC per case. | Pure-function test: `expect(classifyAction('matched', { action: 'already_member' })).toBe('duplicate')`. ~3 LOC per case. Six cases cover the matrix. |
| Submit happy paths (each of 5 actions) | One HTTP harness test per action; ~80 LOC each. | One mutation test per action; ~25 LOC each. No HTTP test framework, no body parsing setup — just call `submit({ formEndpointId, submissionData, ... })`. |
| `pending_confirmation → success` transition | Integration test runs the full HTTP confirm endpoint, mocks DOI under the covers, asserts `formSubmissions.status === 'success'`. | Unit test on `markConfirmedByToken`. Four cases: success, already_confirmed, no_submission_for_token, invalid_state. |
| HTTP layer | Mixed with classification logic — every test is end-to-end. | Isolated. HTTP-shell tests cover CORS, rate-limit, body parsing, error mapping. They mock `internal.forms.submission.submit` and verify the response is shaped correctly per outcome — no contacts or topics needed. |
| Existing-contact-joins-new-topic | No test today (the silent drop is undetected). | New test: contact already exists, submit form with new topic ID, assert `subscribe` was called, assert `action === 'success'`. |

### Behavior

Identical to today on the five existing terminal paths *except*:

- **Existing-contact-joins-new-topic now adds the membership.** Today:
  `duplicate` row written, no topic-add. After: `subscribe` called,
  outcome classified on its result, `duplicate` only if
  `subscribe` returned `already_member`. The Contact ends up on the
  topic.
- **`searchableText` and soft-delete invariants now uniformly applied.**
  The form path joins the four sites already covered by ADR-0008; the
  form-side find-or-create stops silently diverging.
- **Auth shell no longer runs on the topic-add path.** Today: form's
  CORS+rate-limit+honeypot, then `api.topics.topics.addContact`'s
  auth-bearing mutation runs *again*. After: form's auth surface only;
  `subscribe()` called directly.

No other observable changes. The five status literals are unchanged.
The HTTP responses (redirect, JSON success, validation error) are
unchanged on every existing path. Customers see exactly today's
responses on every input they send today, plus the
existing-contact-joins-new-topic membership write that should have been
happening all along.

### Vocabulary

Adds two terms to CONTEXT.md (already landed alongside this ADR — see
the `## Forms` section):

- **Form submission** — the row in `formSubmissions`
- **Form submission (module)** — the intake module

Updates one existing entry (**Topic subscription (module)**) Invariants
section to document the new `doiToken?` return field. Adds one
Relationships bullet describing Form submission's relationships to
Contact resolution, Topic subscription, and DOI lifecycle.

## Follow-up work

- **Transactional send intake (module).** The transactional API HTTP
  path (`apps/api/convex/transactionalApiHttp.ts:sendTransactional`) is
  the same shape as the form path: 659-line `httpAction` doing
  auth-gate + body parsing + email validation + blocklist + attachment
  validation + transactional-email lookup + domain verification + its
  own contact find-or-create + translation selection + workpool
  enqueue. Form submission proves the intake pattern; transactional
  intake is the next instance. Out of scope for this ADR.
- **Campaign pre-send gate (module).** The same 5-check pre-send
  validation (`requireSendingAllowed` + 4 data-shape checks + domain
  verification) is duplicated across `campaigns/scheduling.ts:148-180`,
  `campaigns/organization.ts:202-225`, `campaigns/organization.ts:277-300`,
  and `emails.ts:76-101`. Sibling of the **Abuse gate (module)** — one
  more guard tier. Out of scope.
- **`forms/api.ts` reduction.** If both `generateConfirmationToken`
  and `getSiteUrl` are unused post-rewire, the whole `'use node'` file
  collapses. Cleanup PR.

## Execution

### Steps

1. **Topic subscription return-shape bump.** Edit
   `convex/topics/subscription.ts:subscribe` and `:subscribeMany` to
   return `{ action, doiToken? }`. Capture the token from the
   `request_doi` effect's call path (`doiLifecycle.transition({ to:
   'pending', token, ... })`'s `TransitionOutcome` payload). Update the
   inline type definitions and the JSDoc.
2. **Create the module.** Write `convex/forms/submission.ts` with the
   `submit` internalMutation, `markConfirmedByToken` internalMutation,
   `classifyAction` pure function, and the private `validateFields`
   helper (ported from `apiHttp.ts:247-275`). Use `resolveContact` from
   `convex/contacts/resolution.ts` (upsert mode), `subscribe` from
   `convex/topics/subscription.ts`.
3. **Rewire submit HTTP shell.** Edit `forms/apiHttp.ts:submitForm` to
   call `ctx.runMutation(internal.forms.submission.submit, { ... })`
   and map the outcome to a Response. CORS preflight, method check,
   rate-limit, formId extraction, body parsing stay in this file
   (they're HTTP-shell concerns).
4. **Rewire confirm HTTP shell.** Edit
   `forms/endpoints.ts:confirmSubmission` to chain
   `internal.contacts.doiLifecycle.transitionByConfirmationToken` →
   `internal.forms.submission.markConfirmedByToken`. Remove the inline
   `ctx.db.patch(submission._id, { status: 'success', confirmedAt })`.
5. **Delete `recordSubmission`.** Remove the `recordSubmission`
   internalMutation from `forms/endpoints.ts`. Grep for any other
   caller; expect zero.
6. **Audit `forms/api.ts`.** Check if `generateConfirmationToken` and
   `getSiteUrl` are still called. If not, delete the file.
7. **Tests.** Add the per-case unit tests for `classifyAction`, the
   mutation tests for `submit` (six matrix cases covering the action
   classifications) and `markConfirmedByToken` (four reason paths +
   happy path). Add the existing-contact-joins-new-topic regression
   test. Add the HTTP-shell tests that mock `submit` and verify
   response shaping.

### Verification greps

After execution, these should return zero matches:

```sh
# No file outside the module writes formSubmissions.status
rg "formSubmissions.*status:" apps/api/convex/ -g '!**/forms/submission.ts'

# No file outside the module patches confirmedAt on formSubmissions
rg "formSubmissions.*confirmedAt|confirmedAt.*formSubmissions" apps/api/convex/ -g '!**/forms/submission.ts'

# The open-coded find-or-create in apiHttp.ts is gone
rg "getByEmailForOrganizationInternal" apps/api/convex/forms/

# The redundant contact re-read for the DOI token is gone
rg "contactAfter\?\.doiConfirmationToken" apps/api/convex/

# The recordSubmission mutation is gone
rg "internal\.forms\.endpoints\.recordSubmission" apps/api/convex/
```

These should return matches:

```sh
# The new mutations are wired
rg "internal\.forms\.submission\.(submit|markConfirmedByToken)" apps/api/convex/forms/

# subscribe() now returns the doiToken
rg "doiToken" apps/api/convex/topics/subscription.ts
```

### Done when

- `convex/forms/submission.ts` exists with `submit` + `markConfirmedByToken`
  + `classifyAction` + the field-validation helper.
- `forms/apiHttp.ts:submitForm` is ≤80 lines and contains no contact
  resolution, no topic-add, no `formSubmissions.status` literal.
- `forms/endpoints.ts:confirmSubmission` chains DOI then
  `markConfirmedByToken`; the inline status patch is gone.
- `forms/endpoints.ts:recordSubmission` is deleted; no caller remains.
- **Topic subscription (module)**'s `subscribe()` and `subscribeMany()`
  return `{ action, doiToken? }` with `doiToken` populated when
  `request_doi` fired.
- The existing-contact-joins-new-topic regression test passes — an
  existing contact submitting a form for a new topic ends up on the
  topic and the submission carries `action: 'success'` (or
  `'pending_confirmation'` for DOI-required topics), not `'duplicate'`.
- The `classifyAction` function has unit tests covering all six matrix
  inputs.
- The CONTEXT.md `## Forms` section, the **Topic subscription
  (module)** Invariants update, and the Relationships bullet match this
  ADR.
- The grep verification matches above all hold.
