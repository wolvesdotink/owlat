# Topic subscription module — single writer of `contactTopics`, source-conditional effects

**Status:** accepted

## Context

`contactTopics` is the membership table linking Contacts to Topics. The
table has **seven writers** spread across four files, each varying in
which side effects it fires, whether it consults DOI, whether it
maintains the `topics.cachedMemberCount` denormalization, and whether
it logs an activity row. The asymmetry is small in line count (≈220
LOC across writers) but corrosive in compliance posture — one of the
writer paths silently bypasses `requireDoubleOptIn`.

### Writer landscape

| Producer | Path | Insert/Delete | DOI gate | Trigger fired | Activity row | `cachedMemberCount` |
|---|---|---|---|---|---|---|
| Single-add public mutation | `topics/topics.ts:addContact:280-331` | insert | ✅ checks `requireDoubleOptIn` + `contact.doiStatus` + `skipDoi` | ✅ when DOI not in the way | ❌ no row written | ✅ per-row increment |
| Bulk-add public mutation | `topics/bulk.ts:addContacts:34-95` | insert (N) | ✅ same gate | ✅ in a second loop after all inserts | ❌ | ❌ **drift** — no count patch |
| Batch import (internal) | `contacts/internal.ts:importBatchInternal:81-117` | insert (N) | ❌ **drift** — no gate, silently bypasses `requireDoubleOptIn` | ❌ never fires | ❌ | ✅ per-batch increment, but written differently from the public path |
| Form-confirm safety fallback | `forms/endpoints.ts:confirmSubmission:478-490` | insert | n/a (already DOI-confirmed at this point) | ❌ relies on DOI lifecycle's own trigger fanout | ❌ | ❌ **drift** — no count patch |
| Single-remove public mutation | `topics/topics.ts:removeContact:338-364` | delete | n/a | n/a | ❌ **drift** — no activity row | ✅ per-row decrement |
| Bulk-remove public mutation | `topics/bulk.ts:removeContacts:103-128` | delete (N) | n/a | n/a | ❌ **drift** | ❌ **drift** — no count patch |
| Public unsubscribe link | `delivery/unsubscribeQueries.ts:processUnsubscribe:38-168` | delete (1..N topics for one contact) | n/a | n/a | ✅ writes `topic_unsubscribed` | ❌ doesn't touch `cachedMemberCount` |

Seven drift signals concentrate.

### 1. Batch import silently bypasses `requireDoubleOptIn`

`contacts/internal.ts:importBatchInternal:81-117` inserts membership
rows directly:

```ts
if (args.topicId && importedContactIds.length > 0) {
  const now = Date.now();
  let newMembersCount = 0;
  for (const contactId of importedContactIds) {
    const existingMembership = await ctx.db.query('contactTopics')...first();
    if (!existingMembership) {
      await ctx.db.insert('contactTopics', {
        contactId,
        topicId: args.topicId!,
        addedAt: now,
      });
      newMembersCount++;
    }
  }
  // ... cachedMemberCount patch
}
```

No consult of `topic.requireDoubleOptIn`. No call to the **DOI lifecycle
(module)**. No `skipDoi` knob to make the bypass explicit. A CSV / API
import against a Topic with `requireDoubleOptIn: true` silently
subscribes every imported Contact without asking them to confirm —
which is the exact compliance posture DOI is designed to prevent.

The other two add paths (`addContact`, `addContacts`) take a
`skipDoi: v.optional(v.boolean())` arg and explicitly gate. Batch
import has no such knob.

### 2. `skipDoi` parameter has two meanings

`topics/topics.ts:addContact:247`:
```ts
// Optional: skip DOI for this specific addition (e.g., when confirming DOI)
skipDoi: v.optional(v.boolean()),
```

`topics/bulk.ts:addContacts:16`:
```ts
// Optional: skip DOI for this batch (e.g., admin import)
skipDoi: v.optional(v.boolean()),
```

The two comments name two different reasons for the same parameter.
`addContact`'s "we already DOI-confirmed; don't re-ask" is an internal
plumbing concern. `addContacts`'s "admin authoritative; treat as
subscribed" is a product-level decision. The semantics are different
even though the flag is named the same — one is "the system already
knows the answer," the other is "the admin is overriding the rule."
No call site uses `addContact`'s `skipDoi: true` today (every internal
caller goes through other paths), so the divergence is latent rather
than active, but it's there.

### 3. Admin-remove paths write no activity row

`topics/topics.ts:removeContact:353` and `topics/bulk.ts:removeContacts:123`
both `ctx.db.delete(membership._id)` without writing a Contact activity
row. By contrast, `delivery/unsubscribeQueries.ts:91-100` writes a
`topic_unsubscribed` activity row on every removal:

```ts
await ctx.db.insert('contactActivities', {
  contactId: args.contactId,
  activityType: 'topic_unsubscribed',
  metadata: { topicId, topicName, reason: 'unsubscribe' },
  occurredAt: now,
});
```

The Contact's activity timeline is the user-facing audit surface in
the dashboard. An admin removing a Contact from a Topic creates an
invisible delete — the Contact's timeline shows their `topic_subscribed`
event from earlier, then nothing, even though they were removed. The
public-link unsubscribe path correctly logs.

### 4. Bulk-remove silently drifts `cachedMemberCount`

`topics/topics.ts:removeContact:356-360` patches `cachedMemberCount`:
```ts
if (topic) {
  await ctx.db.patch(args.topicId, {
    cachedMemberCount: Math.max(0, (topic.cachedMemberCount ?? 1) - 1),
    cachedCountUpdatedAt: Date.now(),
  });
}
```

`topics/bulk.ts:removeContacts:103-128` does *not* — it just deletes.
A bulk-remove of N contacts leaves `cachedMemberCount` overstated by
N until the daily `topics.reconcileMemberCounts` cron runs. The
contact counts shown on the topics list view are stale for up to 24
hours after a bulk remove. The increment side has the same drift on
bulk: `bulk.ts:addContacts` doesn't patch `cachedMemberCount` either
(only the per-batch count, but never written to the topic).

### 5. Public-unsubscribe path is the most-effectful, admin-paths the least

`delivery/unsubscribeQueries.ts:processUnsubscribe:38-168` runs the
full ceremony on every unsubscribe:
- Delete membership(s).
- Write `topic_unsubscribed` activity row(s).
- Patch `contacts.updatedAt`.
- Clear `formSubmissions.confirmedAt` for every confirmed submission
  the Contact has (forces re-confirmation on resubscribe).
- Increment `campaigns.statsUnsubscribed` on the most-recent `emailSends`.
- Fire `topic.unsubscribed` **Webhook event** with the array of removed
  topics.

`topics.ts:removeContact` and `bulk.ts:removeContacts` run none of
those. The product line "external systems learn about subscription
changes via the `topic.unsubscribed` webhook" silently means "external
systems learn about *self-service* subscription changes." Admin removes
are invisible to integrations.

There's no place to say "every unsubscribe writes an activity row" —
each writer holds its own slice of that decision.

### 6. Form-confirm fallback insert and the membership-then-DOI ordering

`forms/endpoints.ts:confirmSubmission:478-490` reads:

```ts
if (submission.contactId) {
  const form = await ctx.db.get(submission.formEndpointId);
  if (form?.topicId) {
    const existingMembership = await ctx.db.query('contactTopics')...first();
    if (!existingMembership) {
      await ctx.db.insert('contactTopics', {
        contactId: submission.contactId,
        topicId: form.topicId,
        addedAt: now,
      });
    }
  }
}
```

This is a safety fallback. The actual form-submission path inserts
the `contactTopics` row at submission time (via `forms/apiHttp.ts:340`
calling `addContact`), *before* DOI is confirmed. The DOI lifecycle's
`fire_topic_subscribed_triggers` effect at confirm time then sees the
membership and fires the trigger for it. The fallback at lines 486-490
fires only if the submission-time insert somehow didn't happen (e.g.,
the `addContact` call hit the `logError` catch at `apiHttp.ts:383`).

The fallback writes membership without count increment, without
activity row, without any of the ceremony the public `addContact`
runs. If it ever fires in production, it leaves the topic in an
inconsistent state. Dead code in the happy path; a quiet drift bug
in the failure path.

### 7. CONTEXT.md has no Topic vocabulary

Pre-this-ADR, CONTEXT.md describes the **Contact resolution (module)**,
the **DOI lifecycle (module)**, the **Send lifecycle**, the **Postbox
outbound lifecycle**, the **Abuse status (module)**, the **Inbox
processing lifecycle**, and several others — but the Topic concept
itself has no entry, and the seven writer paths above have no shared
vocabulary. A new dev asking "where does subscription-to-a-topic live?"
has no single answer; the language drift mirrors the code drift.

### Shared framing

Per LANGUAGE.md's deletion test: deleting the four add writers and
inlining their bodies reveals four near-mirror copies of "check
membership, insert row, gate on DOI, maybe-fire-trigger, maybe-patch-
count." Deleting the three remove writers reveals three copies of
"find membership, delete row, maybe-write-activity, maybe-decrement-
count, maybe-clear-form-submissions, maybe-fire-webhook." Inlining
either set spreads the drift across files rather than concentrating
it — and the silent DOI bypass on batch import is the highest-cost
example.

The friction is small in LOC but architectural: it is the last
high-traffic relationship table in the codebase without a single
writer, and the silent `requireDoubleOptIn` bypass is the first
deepening on a compliance-load-bearing path.

## Decision

One new module at `apps/api/convex/topics/subscription.ts` owning all
writes to `contactTopics` and all maintenance of `topics.cachedMemberCount`.
Five entry points keyed by shape (one topic + one contact, one topic +
many contacts, one contact + one-or-all topics).

### Module shape

```ts
// apps/api/convex/topics/subscription.ts

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';

export type SubscribeSource =
  | 'admin'              // dashboard add (single or bulk)
  | 'form'               // form-submission path via apiHttp
  | 'import'             // CSV / integration batch import
  | 'public_api'         // HTTP API POST /topics/:id/contacts
  | 'automation';        // future automation step

export type UnsubscribeSource =
  | 'admin'              // dashboard remove (single or bulk)
  | 'public_email_link'  // email-footer unsubscribe link
  | 'preferences_page'   // hosted preferences page
  | 'public_api';        // HTTP API DELETE /topics/:id/contacts/:cid

export type SubscribeOutcome =
  | { ok: true; action: 'subscribed';     membershipId: Id<'contactTopics'> }
  | { ok: true; action: 'pending_doi';    membershipId: Id<'contactTopics'> }
  | { ok: true; action: 'already_member'; membershipId: Id<'contactTopics'> }
  | { ok: false; reason: 'contact_not_found' | 'topic_not_found' | 'contact_soft_deleted' };

export type UnsubscribeOutcome =
  | { ok: true; action: 'unsubscribed' }
  | { ok: true; action: 'not_member' }
  | { ok: false; reason: 'contact_not_found' | 'topic_not_found' };

// ── Subscribe side ────────────────────────────────────────────────

export const subscribe: (ctx, args: {
  topicId: Id<'topics'>;
  contactId: Id<'contacts'>;
  source: SubscribeSource;
  skipDoi?: boolean;     // admin-authoritative override
  siteUrl?: string;      // forwarded to DOI lifecycle when transitioning to pending
}) => Promise<SubscribeOutcome>;

export const subscribeMany: (ctx, args: {
  topicId: Id<'topics'>;
  contactIds: Id<'contacts'>[];
  source: SubscribeSource;
  skipDoi?: boolean;
  siteUrl?: string;
}) => Promise<{ outcomes: SubscribeOutcome[] }>;

// ── Unsubscribe side ──────────────────────────────────────────────

export const unsubscribe: (ctx, args: {
  topicId: Id<'topics'>;
  contactId: Id<'contacts'>;
  source: UnsubscribeSource;
  reason?: string;       // free-text; defaults derived from source
}) => Promise<UnsubscribeOutcome>;

export const unsubscribeMany: (ctx, args: {
  topicId: Id<'topics'>;
  contactIds: Id<'contacts'>[];
  source: UnsubscribeSource;
  reason?: string;
}) => Promise<{ outcomes: UnsubscribeOutcome[] }>;

// One contact, one-or-all topics. Per-contact effects fire ONCE;
// per-topic effects fire N times. Emits ONE webhook with the array
// of removed topics. Used by the public unsubscribe link.
export const unsubscribeAllForContact: (ctx, args: {
  contactId: Id<'contacts'>;
  topicId?: Id<'topics'>;    // undefined = remove from all topics
  source: UnsubscribeSource;
  reason?: string;
}) => Promise<{ outcomes: Array<UnsubscribeOutcome & { topicId: Id<'topics'> }> }>;
```

All entry points are `internalMutation`. The public mutations in
`topics/topics.ts` and `topics/bulk.ts` become auth-bearing shells
that delegate to the module.

### Subscribe effects

Per-`subscribe` (or per-array-element in `subscribeMany`):

```ts
type SubscribeEffect =
  | {
      kind: 'insert_membership';
      contactId: Id<'contacts'>;
      topicId: Id<'topics'>;
      addedAt: number;
    }
  | {
      kind: 'fire_topic_subscribed_trigger';
      contactId: Id<'contacts'>;
      topicId: Id<'topics'>;
    }
  | {
      kind: 'request_doi';
      contactId: Id<'contacts'>;
      siteUrl?: string;
    };
```

Per-call coalesced (once regardless of array size):

```ts
type SubscribeCallEffect =
  | {
      kind: 'patch_cached_member_count_delta';
      topicId: Id<'topics'>;
      delta: number;       // sum of new memberships in this call
    };
```

Decision tree inside the reducer for one (`topicId`, `contactId`)
pair:

1. If `contact.deletedAt !== undefined`: outcome `{ ok: false, reason:
   'contact_soft_deleted' }`. No effects.
2. If existing membership: outcome `{ ok: true, action:
   'already_member', membershipId }`. No effects.
3. Else: emit `insert_membership`. Add `+1` to the call's count delta.
   Then:
   - If `skipDoi || !topic.requireDoubleOptIn || contact.doiStatus
     === 'confirmed'`: emit `fire_topic_subscribed_trigger`. Outcome
     `{ ok: true, action: 'subscribed' }`.
   - Else: emit `request_doi`. Outcome `{ ok: true, action:
     'pending_doi' }`. The trigger fanout is deferred to the **DOI
     lifecycle (module)**'s `fire_topic_subscribed_triggers` effect
     at confirm time.

### Unsubscribe effects

Per-`unsubscribe` (or per-array-element in `unsubscribeMany`, or
per-topic in `unsubscribeAllForContact`):

```ts
type UnsubscribeEffect =
  | {
      kind: 'delete_membership';
      membershipId: Id<'contactTopics'>;
    }
  | {
      kind: 'contact_activity_topic_unsubscribed';
      contactId: Id<'contacts'>;
      topicId: Id<'topics'>;
      topicName: string;
      reason: string;
      at: number;
    };
```

Per-call coalesced (once regardless of how many topics):

```ts
type UnsubscribeCallEffect =
  | {
      kind: 'patch_cached_member_counts';
      deltas: Array<{ topicId: Id<'topics'>; delta: number }>;  // typically all -1
    }
  | {
      kind: 'patch_contact_updated_at';
      contactId: Id<'contacts'>;
      at: number;
    }
  | {
      kind: 'clear_form_submission_confirmations';
      contactId: Id<'contacts'>;
    }
  | {
      kind: 'increment_campaign_unsubscribed_stats';
      contactId: Id<'contacts'>;
    }
  | {
      kind: 'fire_topic_unsubscribed_webhook';
      contactId: Id<'contacts'>;
      removedTopics: Array<{ topicId: Id<'topics'>; topicName: string }>;
      at: number;
    };
```

Decision tree:

1. If `contact.deletedAt !== undefined` or `contact == null`: outcome
   `{ ok: false, reason: 'contact_not_found' }`.
2. If no membership exists for the `(topicId, contactId)` pair:
   outcome `{ ok: true, action: 'not_member' }`. No effects.
3. Else: emit `delete_membership`, `contact_activity_topic_unsubscribed`.

Per-call gating on `source`:

| Effect | `admin` | `public_email_link` | `preferences_page` | `public_api` |
|---|---|---|---|---|
| `patch_cached_member_counts` | ✅ | ✅ | ✅ | ✅ |
| `patch_contact_updated_at` | ✅ | ✅ | ✅ | ✅ |
| `clear_form_submission_confirmations` | ❌ | ✅ | ✅ | ❌ |
| `increment_campaign_unsubscribed_stats` | ❌ | ✅ | ❌ | ❌ |
| `fire_topic_unsubscribed_webhook` | ❌ | ✅ | ✅ | ❌ |

The webhook-firing rule is the load-bearing line. If product later
decides admin-remove *should* fire the webhook, the change is one
table entry. Today's behavior (no admin-side webhook) is preserved.

### Invariants

- **Soft-delete refusal.** Subscribe refuses to subscribe a contact
  with `deletedAt !== undefined`. Returns `{ ok: false, reason:
  'contact_soft_deleted' }`. Mirrors the **Contact resolution
  (module)**'s skip-soft-deleted invariant.
- **Idempotent already-member.** Re-subscribing an already-member is
  a no-op returning `{ ok: true, action: 'already_member' }`. Does
  not re-fire trigger, does not re-request DOI, does not re-patch
  count.
- **Idempotent not-member.** Unsubscribing a not-member is a no-op
  returning `{ ok: true, action: 'not_member' }`. Does not write
  activity row, does not patch count, does not fire webhook.
- **DOI handoff.** When DOI is required and the contact is not
  `confirmed`, subscribe calls `doiLifecycle.transition({ to:
  'pending' })`. The subscription module does not fire the
  `topic_subscribed` automation trigger in that case — the DOI
  lifecycle's own `fire_topic_subscribed_triggers` effect fires it
  at confirm time. No double-firing.
- **Cache coherence.** The module is the only writer of
  `cachedMemberCount`. Both increments and decrements are coalesced
  per call. The daily `topics.reconcileMemberCounts` cron remains
  as the drift-check; under this module it should always find
  `actualCount === cachedMemberCount`.

### Call-site shape after the cut

```ts
// topics/topics.ts:addContact (was lines 242-335)
export const addContact = mutation({
  args: {
    topicId: v.id('topics'),
    contactId: v.id('contacts'),
    skipDoi: v.optional(v.boolean()),
    siteUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth check stays here (public mutation surface).
    const session = await getMutationContext(ctx);
    requirePermission(hasPermission(session.role, 'topics:manage'),
      'Only owners and admins can add contacts to topics');

    const outcome = await ctx.runMutation(
      internal.topics.subscription.subscribe,
      {
        topicId: args.topicId,
        contactId: args.contactId,
        source: 'admin',
        ...(args.skipDoi ? { skipDoi: true } : {}),
        ...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
      },
    );

    if (!outcome.ok) {
      // Map the typed outcome to the legacy throwNotFound shape.
      if (outcome.reason === 'contact_not_found') throwNotFound('Contact');
      if (outcome.reason === 'topic_not_found') throwNotFound('Topic');
      throw new ConvexError(`Contact is soft-deleted`);
    }

    // Preserve the legacy return shape — { membershipId, doiStatus }.
    const contact = await ctx.db.get(args.contactId);
    const doiStatus =
      outcome.action === 'pending_doi'    ? 'pending' :
      outcome.action === 'subscribed'     ? (contact?.doiStatus ?? 'not_required') :
      /* already_member */                  (contact?.doiStatus ?? 'not_required');

    return { membershipId: outcome.membershipId, doiStatus };
  },
});
```

```ts
// topics/bulk.ts:addContacts (was lines 11-100)
export const addContacts = mutation({
  args: {
    topicId: v.id('topics'),
    contactIds: v.array(v.id('contacts')),
    skipDoi: v.optional(v.boolean()),
    siteUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await getUserIdFromSession(ctx);

    const { outcomes } = await ctx.runMutation(
      internal.topics.subscription.subscribeMany,
      {
        topicId: args.topicId,
        contactIds: args.contactIds,
        source: 'admin',
        ...(args.skipDoi ? { skipDoi: true } : {}),
        ...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
      },
    );

    // Preserve the legacy return shape — array of membership IDs for
    // newly-inserted memberships only.
    return outcomes
      .filter((o): o is SubscribeOutcome & { action: 'subscribed' | 'pending_doi' } =>
        o.ok && (o.action === 'subscribed' || o.action === 'pending_doi'))
      .map((o) => o.membershipId);
  },
});
```

```ts
// contacts/internal.ts:importBatchInternal (was lines 81-117 — the
// topic-handling block; lines 1-80 stay unchanged)
if (args.topicId && importedContactIds.length > 0) {
  await ctx.runMutation(internal.topics.subscription.subscribeMany, {
    topicId: args.topicId,
    contactIds: importedContactIds,
    source: 'import',
    skipDoi: args.skipDoi ?? false,  // new arg — see schema change
    ...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
  });
  // No manual cachedMemberCount patch — the module owns it now.
}
```

```ts
// topics/topics.ts:removeContact (was lines 338-364)
export const removeContact = mutation({
  args: {
    topicId: v.id('topics'),
    contactId: v.id('contacts'),
  },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    requirePermission(hasPermission(session.role, 'topics:manage'),
      'Only owners and admins can remove contacts from topics');

    await ctx.runMutation(internal.topics.subscription.unsubscribe, {
      topicId: args.topicId,
      contactId: args.contactId,
      source: 'admin',
    });
    // Legacy shape returns void; preserved.
  },
});
```

```ts
// topics/bulk.ts:removeContacts (was lines 103-128)
export const removeContacts = mutation({
  args: {
    topicId: v.id('topics'),
    contactIds: v.array(v.id('contacts')),
  },
  handler: async (ctx, args) => {
    await getUserIdFromSession(ctx);
    await ctx.runMutation(internal.topics.subscription.unsubscribeMany, {
      topicId: args.topicId,
      contactIds: args.contactIds,
      source: 'admin',
    });
  },
});
```

```ts
// delivery/unsubscribeQueries.ts:processUnsubscribe (was lines 38-168)
export const processUnsubscribe = internalMutation({
  args: {
    contactId: v.id('contacts'),
    topicId: v.optional(v.id('topics')),
  },
  handler: async (ctx, args) => {
    const { outcomes } = await ctx.runMutation(
      internal.topics.subscription.unsubscribeAllForContact,
      {
        contactId: args.contactId,
        ...(args.topicId ? { topicId: args.topicId } : {}),
        source: 'public_email_link',
        reason: 'unsubscribe',
      },
    );

    // Map to the legacy response shape.
    const removedCount = outcomes.filter((o) => o.ok && o.action === 'unsubscribed').length;
    if (removedCount === 0) {
      return { success: true, alreadyUnsubscribed: true };
    }
    return { success: true, alreadyUnsubscribed: false };
  },
});
```

```ts
// forms/endpoints.ts:confirmSubmission (was lines 478-490 — the
// fallback insert block; lines 415-477 and 495-497 stay unchanged)
// The fallback insert is DELETED. The submission-time addContact call
// in forms/apiHttp.ts already inserted the membership via subscribe;
// the fallback was dead code in the happy path.
//
// Replacement: a one-line safety belt that detects the inconsistency
// for observability, without writing.
if (submission.contactId) {
  const form = await ctx.db.get(submission.formEndpointId);
  if (form?.topicId) {
    const existingMembership = await ctx.db.query('contactTopics')
      .withIndex('by_contact_and_topic', (q) =>
        q.eq('contactId', submission.contactId!).eq('topicId', form.topicId!))
      .first();
    if (!existingMembership) {
      logError(`[Forms] confirmSubmission found no membership for ` +
        `(${submission.contactId}, ${form.topicId}) at confirm time — ` +
        `submission-time addContact may have failed silently`);
    }
  }
}
```

### Schema additions

`contacts/internal.ts:importBatchInternal` gains a new arg:

```ts
args: {
  contacts: ...,
  handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
  source: v.optional(...),
  topicId: v.optional(v.id('topics')),
  skipDoi: v.optional(v.boolean()),    // ← new
  siteUrl: v.optional(v.string()),     // ← new (forwarded to subscribeMany when topicId set)
},
```

Default `skipDoi: false`. CSV / integration import code paths must
explicitly pass `skipDoi: true` to bypass DOI — closing drift signal
#1. The default is "honor DOI" because the per-this-ADR grilling
established admin-authoritative behavior must be opt-in.

No `contactTopics` schema change. No `topics` schema change. No new
audit-action literals (the activity-type `topic_unsubscribed` already
exists in the **ADR-0002 catalog**).

### What stays put

- **Auth checks.** Public mutations still consult `hasPermission` /
  `requirePermission`. The module never decides who can call it.
- **The DOI lifecycle.** This module calls
  `doiLifecycle.transition({ to: 'pending' })` for new pending-DOI
  subscriptions, but never the confirm side. The two confirm endpoints
  (`topics/topics.ts:confirmDoi` and `forms/endpoints.ts:confirmSubmission`)
  stay as direct DOI lifecycle callers.
- **The form-submission `addContact` call.** `forms/apiHttp.ts:340-344`
  still calls `addContact` at submission time — `addContact` now
  routes through the module, but the form path's logic is unchanged.
- **The Webhook event module.** `topic.unsubscribed` is built by the
  **Webhook event module** for that literal (per ADR-0003); the
  subscription module schedules fanout but never assembles the payload.
- **The `reconcileMemberCounts` cron.** Drift check stays —
  defense-in-depth.
- **The `removeContact` / `removeContacts` / `addContact` /
  `addContacts` public mutation names.** Preserved for now to keep
  the frontend wiring simple. A future rename to `subscribe` /
  `unsubscribe` aligned with the Topic vocabulary is a separate ADR.

## Considered options

### Module scope — add only vs add+remove vs split into two modules

1. **Single module owns add + remove + denormalization** *(chosen)*.
   The drift bugs concentrate symmetrically on both sides (count
   patches drift on bulk-add and bulk-remove; activity rows drift
   on admin-remove; effects drift on the public-unsubscribe vs
   admin-remove split). A single seam closes them all.
2. **Module owns add only; remove stays open-coded.** Smaller scope,
   less invasive. Rejected — leaves the bulk-remove
   `cachedMemberCount` drift and the admin-remove missing-activity-
   row drift untouched, and the public-link unsubscribe path still
   has no co-located peer to mirror.
3. **Subscribe module + separate Unsubscribe module.** Two modules
   instead of one. The argument for splitting was that the side
   effects diverge sharply (subscribe fires `topic_subscribed`
   trigger; unsubscribe fires webhook + form-clear + campaign-stats
   + activity row, conditional on source). Rejected — the two
   sides share the table, the cache, and the auth surface; splitting
   doubles the boundary maintenance for negligible separation.

### Entry-point shape — single-contact only vs accept N vs separate single/many

1. **Two entry points per side: single + many** *(chosen)*. Single-
   contact callers get a clean typed return; bulk callers get the
   coalesced cache patch and the per-contact outcome array. Five
   entry points total (`subscribe`, `subscribeMany`, `unsubscribe`,
   `unsubscribeMany`, `unsubscribeAllForContact`).
2. **Single-contact module, bulk loop in callers.** One entry point
   per side. Rejected — bulk callers would emit N cache patches
   instead of 1, regressing performance for CSV imports of 10K
   rows. Also the public-link unsubscribe path's per-contact
   effects (form-clear, campaign-stats, webhook) need a per-call
   coalescing shape — looping a single-contact entry point can't
   express it.
3. **Module accepts 1..N contactIds.** Single entry point per side
   that takes an array. Rejected — single-contact callers (the
   majority — admin UI individual add/remove, automation triggers)
   would always pass `[contactId]`, and the return type becomes a
   one-element array. Per-contact outcome assertion in tests
   becomes index-fiddly.

### Unsubscribe-all shape — separate entry point vs source-gated effects

1. **Separate `unsubscribeAllForContact` entry point with per-
   contact coalesced effects** *(chosen)*. The public-link
   unsubscribe path fires ONE `topic.unsubscribed` webhook with the
   array of removed topics — that wire contract is preserved by
   having a dedicated entry point that aggregates per-topic outcomes
   into one per-contact effect batch. Three unsubscribe shapes
   instead of two; the asymmetry mirrors actual usage.
2. **One unsubscribe entry point with `topicIds: v.array(...)`.**
   Single shape covers all cases. Rejected — the per-contact
   coalesced effects (form-clear, campaign-stats, webhook with
   array) are an N+1 modeling pain when the array can be one or
   many; the entry-point's signature drifts toward "do everything"
   and the implementation becomes a switch on array length.
3. **`unsubscribe(topicId, contactId)` only; public-link path loops
   and de-dupes webhooks itself.** Rejected — re-introduces the
   exact "per-call vs per-row effects" drift this is closing. The
   public-link caller would have to assemble the topic list itself
   and call a separate webhook scheduling function — same number
   of moving parts as today's open-coded `processUnsubscribe`.

### `skipDoi` semantics

1. **`skipDoi: true` means "admin authoritative; treat as
   subscribed without DOI."** *(chosen — matches the bulk-add
   comment's intent, not the single-add comment's).* The flag is
   a product-level override. The "we already DOI-confirmed; don't
   re-ask" use case (the single-add comment's stated intent) no
   longer exists as a separate concept — the only path that reaches
   that situation is the form-confirm path, which uses the DOI
   lifecycle's confirm transition, not subscribe.
2. **Two separate flags: `skipDoi` ("admin override") and
   `assumeConfirmed` ("plumbing").** Rejected — the second flag has
   no caller today, and adding two flags codifies a divergence the
   deepening is closing.
3. **No `skipDoi` flag; admin-import goes through a different entry
   point.** Rejected — the only difference between admin-add and
   admin-import is the source label and the `skipDoi` default, not
   the operation shape.

### Webhook fanout ownership — module owns vs caller owns

1. **Module owns `fire_topic_unsubscribed_webhook` as a source-gated
   effect** *(chosen)*. Direct precedent: the **Send lifecycle
   (module)** owns `customer_webhook` as a typed effect (per
   CONTEXT.md:295). Pushing the decision back to callers
   re-introduces the exact drift this deepening closes — admin-remove
   wouldn't fire the webhook because the admin-side caller wouldn't
   bother to call the fanout.
2. **Module returns outcome; caller calls
   `webhookEventFanout.schedule(...)` if needed.** Rejected —
   moves the source-conditional logic out of one map and into N
   call sites. The next person adding a new caller (e.g., the future
   automation-driven unsubscribe step) would have to remember the
   webhook semantics.
3. **Module emits `topic.unsubscribed` for every unsubscribe
   regardless of source.** Rejected — admin-removes are an internal
   action, not a customer-facing event in the product's current
   model. Customers integrating with the `topic.unsubscribed`
   webhook would see unexpected events from admin tooling. (Could
   land in a follow-up if the product calls for it; the source-gated
   map makes that a one-line change.)

### Soft-delete refusal — module enforces vs caller filters

1. **Module refuses with `{ ok: false, reason: 'contact_soft_deleted' }`**
   *(chosen)*. Mirrors the **Contact resolution (module)**'s
   skip-soft-deleted invariant — the property "live Contacts only"
   lives at the same seam that owns the membership writes.
2. **Module subscribes regardless; caller filters.** Rejected — every
   caller would have to remember the filter. The existing public
   mutations don't filter (drift signal not in the table above, but
   verifiable via `topics/topics.ts:272-275` checking only `if
   (!contact)` and not `deletedAt`).
3. **Module silently no-ops for soft-deleted contacts.** Rejected —
   silent no-ops are a cousin of the silent DOI bypass we're closing.
   Explicit refusal lets callers log or surface the case.

### Module naming

1. **`Topic subscription (module)` at `convex/topics/subscription.ts`**
   *(chosen)*. Reads as "the subscription seam for Topics." Matches
   the verb the public unsubscribe link already uses
   (`subscribed: hasActiveSubscriptions` at `unsubscribeQueries.ts:30`).
2. **`Topic membership module`.** Collides with **Topic membership**
   the value (the `contactTopics` row). Rejected — naming the value
   and the writer module the same compounds confusion.
3. **`Subscribe module`.** Collides with email-subscription /
   `email.subscribed` semantics from the webhook surface. Rejected.
4. **`List subscription module`.** Legacy "list" vocabulary —
   memory-noted as fully replaced by Topics. Rejected.

## Consequences

### Files that collapse / disappear

- `forms/endpoints.ts:478-490` — the fallback insert block is deleted.
  Replaced by a one-line observability log (see §Call-site shape above).
- The four open-coded `ctx.db.insert('contactTopics', ...)` calls and
  the three open-coded `ctx.db.delete(membership._id)` calls
  enumerated in the writer-landscape table all go.
- The two divergent `skipDoi` comments collapse to one meaning.

### Files that grow

- `apps/api/convex/topics/subscription.ts` — new module (~420 LOC).
  Exports the five entry points, the typed outcome types, the
  `SubscribeSource` / `UnsubscribeSource` unions, the per-operation
  effect types, the source→effects gating map, and the per-kind
  reducers.
- `apps/api/convex/topics/__tests__/subscription.integration.test.ts`
  — new (~24 tests; see §Test surface).
- `apps/api/convex/topics/topics.ts` — `addContact` and `removeContact`
  shrink to ~20 LOC each (auth + module call + outcome mapping). Net
  ~80 LOC down.
- `apps/api/convex/topics/bulk.ts` — `addContacts` and `removeContacts`
  shrink similarly. Net ~60 LOC down.
- `apps/api/convex/contacts/internal.ts` — the topic-handling block
  (lines 81-117) shrinks to ~6 LOC. The `skipDoi` and `siteUrl` args
  are added.
- `apps/api/convex/forms/endpoints.ts` — the fallback insert block
  (lines 478-490) shrinks to a 4-LOC observability log.
- `apps/api/convex/delivery/unsubscribeQueries.ts` —
  `processUnsubscribe` shrinks from ~130 LOC to ~20 LOC. The CORS /
  HTTP shells stay; the body delegates to
  `unsubscribeAllForContact`.

Net LOC change: ~280 LOC down (across removed inline ceremony) plus
~420 LOC up (new module) plus ~280 LOC up (new test file). Net ~+420
LOC. Value: locality, typed contract, the silent-DOI-bypass closed,
admin-remove activity rows landed, source→effects gating in one place.

### Migration

Pre-production: no schema change, no data migration. The
`contactTopics` rows stay byte-for-byte identical. `cachedMemberCount`
values may drift by ±N due to the bulk-remove decrement bug being
fixed mid-flight; the next daily `reconcileMemberCounts` cron run
heals the drift. (For tighter guarantees, run
`reconcileMemberCounts` once immediately post-deploy.)

The new `importBatchInternal.skipDoi` arg is `v.optional` and
defaults to `false`. Existing callers (none today pass it) get the
default behavior. CSV import UI / integration import paths that
*want* the legacy bypass behavior must explicitly pass `skipDoi:
true` post-this-ADR. Pre-prod: no production callers exist; the
default flip is safe.

### Test surface

`apps/api/convex/topics/__tests__/subscription.integration.test.ts`
(new, ~24 tests):

**Subscribe — single:**
- `subscribed` outcome when DOI not required.
- `subscribed` outcome when DOI required but contact already `confirmed`.
- `pending_doi` outcome when DOI required and contact `not_required` —
  asserts DOI lifecycle was called with `{ to: 'pending' }`.
- `pending_doi` outcome when DOI required and contact already `pending`
  — asserts DOI lifecycle returned `recorded` (no second email).
- `already_member` outcome (idempotent) — asserts no trigger, no DOI
  call, no count patch.
- `refused / contact_soft_deleted` outcome — asserts no DB write.
- `refused / contact_not_found` outcome.
- `refused / topic_not_found` outcome.
- `skipDoi: true` bypasses DOI even when topic requires it — fires
  trigger immediately.

**Subscribe — bulk:**
- 10 contacts, mixed DOI states, asserts one coalesced
  `cachedMemberCount` patch (= +N newly-subscribed).
- Per-contact outcomes match the single-contact expectations.

**Unsubscribe — single (admin source):**
- `unsubscribed` outcome — asserts activity row written, count
  decremented, contact.updatedAt patched, **no** webhook fired, **no**
  form-clear, **no** campaign-stats patch.
- `not_member` outcome — no effects.

**Unsubscribe — single (public_email_link source):**
- `unsubscribed` — asserts all effects fire including the webhook
  with `lists: [{ topicId, topicName }]` (single-element array).

**Unsubscribe — bulk (admin source):**
- 5 contacts, asserts one coalesced count patch, N activity rows, N
  contact.updatedAt patches, **no** webhook.

**Unsubscribe-all-for-contact (public_email_link source):**
- Contact in 3 topics, removed from all 3 — asserts one webhook with
  3-element `lists` array, one form-clear effect, one campaign-stats
  patch.
- Contact in 3 topics, removed from 1 (with `topicId` set) — asserts
  one webhook with 1-element `lists` array.

**Audit trail symmetry:**
- Bulk-remove now decrements `cachedMemberCount` — drift signal #4
  closed.
- Admin-remove now writes `topic_unsubscribed` activity row — drift
  signal #3 closed.
- Batch import with `skipDoi: false` and `requireDoubleOptIn: true`
  routes through DOI lifecycle — drift signal #1 closed.

### Behavior

- **Drift signal #1 (silent DOI bypass on batch import) — closed.**
  Batch imports honor DOI by default. The `skipDoi: true` arg
  preserves the legacy behavior for admin-authoritative imports.
- **Drift signal #2 (divergent `skipDoi` semantics) — closed.**
  One meaning: "admin authoritative; treat as subscribed."
- **Drift signal #3 (admin-remove writes no activity row) — closed.**
  Every unsubscribe (regardless of source) writes a
  `topic_unsubscribed` Contact activity row.
- **Drift signal #4 (bulk-remove `cachedMemberCount` drift) —
  closed.** The module is the single writer of the cache; one patch
  per call coalesces the deltas.
- **Drift signal #5 (admin-remove no webhook) — *preserved by
  design*.** The source→effects map encodes today's behavior:
  admin-remove does not fire `topic.unsubscribed`. If product later
  decides otherwise, one table entry changes.
- **Drift signal #6 (form-confirm fallback insert) — closed.**
  Dead code path deleted; replaced by an observability log.
- **Drift signal #7 (no Topic vocabulary in CONTEXT.md) — closed.**
  CONTEXT.md gains Topic, Topic membership, and Topic subscription
  (module) entries; Relationships gains a paragraph.

User-visible effects:
- Admin removing a Contact from a Topic via the dashboard now leaves
  a `topic_unsubscribed` row in the Contact's activity timeline.
- Bulk-remove of N contacts immediately decrements
  `cachedMemberCount` by N (today: drift until the daily cron).
- CSV / API imports against `requireDoubleOptIn: true` Topics no
  longer subscribe contacts without confirmation unless `skipDoi:
  true` is explicitly passed.

### Vocabulary

CONTEXT.md updated inline during the grilling session that produced
this ADR (see [`CONTEXT.md`](../../CONTEXT.md)):

- New `## Topics` section with **Topic**, **Topic membership**, and
  **Topic subscription (module)** entries.
- `## Relationships` section gains a paragraph describing the
  one-writer invariant and the six producer sites.
- The DOI lifecycle paragraph in `## Relationships` is updated: four
  producers of DOI transition calls become three (the Topic
  subscription module replaces the two per-mutation request-side
  callers; the two confirm endpoints stay direct).

No new audit-action literals (the `topic_unsubscribed` Contact
activity-type literal already exists in the **ADR-0002 catalog**).
No new Webhook event literals (the `topic.unsubscribed` literal
already exists per ADR-0003).

## Follow-up work

1. **Public mutation rename to `subscribe` / `unsubscribe`.** The
   public mutations stay as `addContact` / `removeContact` /
   `addContacts` / `removeContacts` for now to keep the frontend
   wiring simple. Renaming aligns the public surface with the Topic
   vocabulary but is a wider change (touches Vue components, the
   public HTTP API surface, and the SDKs). Defer to a dedicated ADR.
2. **Automation trigger / step for "subscribe to topic."** No
   automation step today subscribes a Contact to a Topic. When that
   step lands, it calls `subscribe({ source: 'automation' })` and
   the source→effects map decides what fires (likely the
   `topic_subscribed` automation trigger, no webhook).
3. **Bulk webhook batching.** Today admin-bulk-remove of N contacts
   emits 0 webhooks (admin source). If the source→effects map ever
   adds `fire_topic_unsubscribed_webhook` to the admin source, the
   bulk path should batch (one webhook per call with N contacts,
   not N webhooks). Out of scope here.
4. **Sender-paths reputation update on unsubscribe.** The
   `topic.unsubscribed` event is a signal worth feeding to
   `analytics/sendingReputation.ts`. Out of scope; lands when the
   reputation surface gains a per-event ingest path.
5. **Re-subscribe ergonomics.** Today `unsubscribe(publicemail_link)`
   clears all `formSubmissions.confirmedAt` for the Contact, forcing
   re-confirmation on resubscribe — across all forms, not just the
   one tied to the unsubscribed topic. That cross-topic blast
   radius is a latent UX concern (re-subscribing to Topic A
   requires re-confirming submissions for Topic B). Out of scope;
   the deepening preserves the current behavior. A dedicated ADR
   can scope-narrow the clear later.

## Execution

Implemented in a single pre-production pass — no separate execution
plan needed, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/topics/subscription.ts` — new module.
- `apps/api/convex/topics/topics.ts` — `addContact` / `removeContact`
  rewritten as module-delegating shells.
- `apps/api/convex/topics/bulk.ts` — `addContacts` / `removeContacts`
  rewritten as module-delegating shells.
- `apps/api/convex/contacts/internal.ts` — `importBatchInternal`
  topic-handling block replaced with a `subscribeMany` call; gains
  `skipDoi` and `siteUrl` args.
- `apps/api/convex/forms/endpoints.ts` — `confirmSubmission` fallback
  insert deleted; replaced by an observability log.
- `apps/api/convex/delivery/unsubscribeQueries.ts` —
  `processUnsubscribe` rewritten as a thin
  `unsubscribeAllForContact` delegate.
- `apps/api/convex/topics/__tests__/subscription.integration.test.ts`
  — new.
- `CONTEXT.md` — Topics section and Relationships paragraph already
  landed during the grilling session.

### Verification greps

- `rg "ctx.db.insert\\('contactTopics'" apps/api/convex` → exactly
  one hit, inside `topics/subscription.ts`.
- `rg "ctx.db.delete.*contactTopics|delete.*membership._id" apps/api/convex`
  → exactly one hit, inside `topics/subscription.ts`.
- `rg "cachedMemberCount" apps/api/convex` → hits only inside
  `topics/subscription.ts`, `topics/topics.ts` (the cron in
  `reconcileMemberCounts` and the queries that read it), and
  `topics/__tests__/`. No writes outside the module.
- `rg "subscription\\.(subscribe|unsubscribe)" apps/api/convex` →
  at least one hit each in `topics/topics.ts`, `topics/bulk.ts`,
  `contacts/internal.ts`, and `delivery/unsubscribeQueries.ts`.
- `rg "fireTopicSubscribedTrigger" apps/api/convex` → hits only
  inside `topics/subscription.ts` (the module fires it) and
  `contacts/doiLifecycle.ts` (the DOI lifecycle fires it at confirm
  time). No fires from the public mutations directly.

### Done when

- All verification greps return the expected counts.
- `npx vitest run` in `apps/api` is green.
- Adding a Contact to a `requireDoubleOptIn: true` Topic via the
  admin dashboard sends one DOI confirmation email and creates one
  pending Topic membership.
- Removing the same Contact via the admin dashboard creates a
  `topic_unsubscribed` row in the activity timeline and does **not**
  fire the `topic.unsubscribed` webhook.
- Removing the Contact via the email-footer unsubscribe link creates
  the same activity row, fires the webhook with the array of removed
  topics, clears `formSubmissions.confirmedAt`, and increments
  `campaigns.statsUnsubscribed`.
- Importing 100 contacts via CSV against a `requireDoubleOptIn: true`
  Topic with `skipDoi: false` (default) sends 100 confirmation
  emails and creates 100 pending memberships; with `skipDoi: true`
  it skips the emails and creates 100 confirmed memberships.
- Subscribing a soft-deleted Contact returns `{ ok: false, reason:
  'contact_soft_deleted' }` and writes no membership row.
