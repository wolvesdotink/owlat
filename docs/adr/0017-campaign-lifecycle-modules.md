# Campaign lifecycle modules — single writers of `campaigns.status` and `campaigns.abTestStatus`, sibling machines

**Status:** proposed

## Context

`campaigns.status` and `campaigns.abTestStatus` together form the state
surface of a Campaign. The table has **at least sixteen writers** spread
across five files, each varying in what audit it records, what scheduler
hop it emits, what PostHog event it tracks, and what companion fields
it patches. The asymmetry is small in line count (≈260 LOC across
writers) but corrosive at the *contract* level — `pending_review` is a
one-way door, `'testing'` and `'completed'` are dead literals on the
AB-test side, and a content-scan revert mid-`sending` runs from a file
two folders away from `campaigns/`.

### Writer landscape — `campaigns.status`

| Producer | Path | Transition | Audit log | `trackEvent` | Schedules orchestrator |
|---|---|---|---|---|---|
| Create (session) | `campaigns/campaigns.ts:404` | `(insert) → draft` | ❌ | ✅ `campaign_created` | n/a |
| Create (org HTTP) | `campaigns/organization.ts:164` | `(insert) → draft` | ❌ | ❌ **drift** | n/a |
| Duplicate | `campaigns/campaigns.ts:240` | `(insert) → draft` | ❌ | ❌ | n/a |
| Schedule (session) | `campaigns/scheduling.ts:182` | `draft → scheduled` | ❌ **drift** | ❌ **drift** | ✅ `runAfter(delayMs)` |
| Schedule (org HTTP) | `campaigns/organization.ts:232` | `draft → scheduled` | ❌ **drift** | ❌ **drift** | ✅ duplicate scheduler call |
| Cancel | `campaigns/scheduling.ts:36` | `scheduled → cancelled` | ✅ **only one** | ❌ | n/a |
| Unschedule | `campaigns/scheduling.ts:114` | `scheduled → draft` | ❌ **drift** | ❌ **drift** | n/a |
| Send-now (session) | `campaigns/campaigns.ts:469` | `draft|scheduled → sending` | ❌ **drift** | ✅ `campaign_sent` | ✅ `runAfter(0)` |
| Send-now (org HTTP) | `campaigns/organization.ts:302` | `draft|scheduled → sending` | ❌ **drift** | ❌ **drift** | ✅ duplicate scheduler call |
| Scheduler-tick → sending | `emailsQueries.ts:updateCampaignToSending` | `scheduled → sending` | ❌ | ❌ | n/a |
| Mark sent | `emailsQueries.ts:32` | `sending → sent` | ❌ **drift** | ❌ **drift** | n/a |
| Content-scan revert | `emailsQueries.ts:315` | `sending → draft` | ❌ | ❌ | n/a |
| Content-scan flag | `emailsQueries.ts:300` | `sending → pending_review` | ❌ | ❌ | n/a |
| `updateStats` backdoor | `campaigns/campaigns.ts:313` | arbitrary (tests only) | ❌ | ❌ | n/a |

Thirteen real status writers (excluding the tests-only backdoor); fourteen
counting the deferred admin approval surface that the `pending_review`
literal anticipates but never wires up.

### Writer landscape — `campaigns.abTestStatus`

| Producer | Path | Transition | Audit log |
|---|---|---|---|
| Enable AB test | `campaigns/abTest.ts:89` | `(none) → pending` | ❌ |
| Disable AB test | `campaigns/abTest.ts:117` | `* → (none)` | ❌ |
| Declare winner | `campaigns/abTest.ts:156` | `testing → winner_selected` | ❌ |
| `pending → testing` | — | — | **no writer** — dead literal |
| `winner_selected → completed` | — | — | **no writer** — dead literal |

Three real AB-test writers; two declared literals with no writer at all.

### 1. Two pairs of near-identical mutations

`campaigns/scheduling.ts:schedule` and `campaigns/organization.ts:scheduleForOrganization`
share 35 lines of body word-for-word: load campaign, load session, check
permission, require sending allowed, guard status === 'draft', validate
template/audience/fromEmail, validate domain, validate scheduledAt
future, patch the row, schedule the orchestrator. The only diverging
lines are the permission-error string and the absent `trackEvent` call
in the org variant.

`campaigns/campaigns.ts:sendNow` and `campaigns/organization.ts:sendNowForOrganization`
share 38 lines similarly. Same pre-flight block, same patch, same
orchestrator hop. Same `trackEvent` drift (the org variant skips it).

These were forked for an HTTP-API vs in-app split that is no longer
load-bearing — both shells run inside Convex mutations, both consult
`getMutationContext`, both check `hasPermission`. The deepening
collapses each pair to one entry.

### 2. Audit log only fires on `cancel`

`campaigns/scheduling.ts:42` calls `recordAuditLog({ action:
'campaign.cancelled', ... })`. The other ten Campaign-status transitions
(schedule, unschedule, sendNow × 2, content-scan revert, mark-sent,
pending-review flag, duplicate, create × 2) write no audit row. Same
silent-drift pattern that [[abuse_status_module]] closed for
`abuseStatus` writes — internal escalations there used to patch the
status without recording the change.

A platform admin auditing "who scheduled this campaign at 3am" finds
nothing. The cancel reason is preserved; everything else is silent.

### 3. `trackEvent` drift between session and org variants

`campaigns/campaigns.ts:create` calls `trackEvent(ctx, session,
'campaign_created', ...)`. The HTTP-API sibling
`campaigns/organization.ts:createForOrganization` does not. Same for
`sendNow` (calls `trackEvent`) vs `sendNowForOrganization` (doesn't).

Analytics dashboards built on the PostHog `campaign_*` events
under-report any campaign created or sent via the HTTP API. The drift
exists because the org variants were copy-pasted from the session
variants but the `trackEvent` line was missed.

### 4. `pending_review` is a one-way door

`emailsQueries.ts:setCampaignPendingReview:300` writes `status:
'pending_review'` when the content scanner returns level `'suspicious'`.
No mutation anywhere writes a `pending_review → *` transition. The
literal is in the schema validator
(`lib/validators.ts:campaignStatusValidator`), the type system enforces
it everywhere, but operationally the campaign is stuck.

`emailsQueries.ts:revertCampaignToDraft` exists for the harder
`'blocked'` case (writes `sending → draft` with a
`contentBlockReason`), but the soft `'suspicious'` case has no exit. A
campaign held for review can be neither approved nor rejected through
any code path that exists today — the literal anticipates an admin
review surface that was never built.

### 5. AB test has two dead literals

`campaigns.abTestStatus` declares
`pending | testing | winner_selected | completed`. Greps find writers
for `pending` (one), `winner_selected` (one), and `(none)`-reset (one).
No writer ever sets `testing` or `completed`.

`testing` is the state the AB test enters when the campaign begins
sending its variant-A/B split. Today, an admin enabling AB test on a
draft campaign sees `abTestStatus: 'pending'`; the campaign goes to
`sending`; the AB test's `abTestStatus` stays at `'pending'`; the user
manually declares a winner and `abTestStatus` jumps `pending →
winner_selected`. The "testing" phase has no on-the-record state.

`completed` is the state after the winning variant is sent to the
remaining audience. Today, that send doesn't happen as a tracked
event; the campaign goes to `sent` and the AB test stays at
`winner_selected` forever. The literal anticipates a follow-up.

### 6. `updateStats` is a status backdoor

`campaigns/campaigns.ts:277-316` declares
`internalMutation updateStats` with an optional `status:
campaignStatusValidator` arg. Inspection shows the only callers are
test fixtures setting status directly:

```ts
await t.mutation(internal.campaigns.campaigns.updateStats, {
  campaignId,
  status: 'sent',
  statsSent: 100,
});
```

The production paths route through `markCampaignSent` or
`setCampaignPendingReview` (which don't take a status arg). The
backdoor exists, isn't used in production, and undermines any future
"single writer" guarantee. Pre-deepening this is latent; post-deepening
it actively contradicts the contract.

### 7. Pre-flight checks duplicated four times

Every send-path entry runs the same six checks:

1. Campaign exists.
2. Caller has `campaigns:send` permission (or `campaigns:schedule`).
3. `requireSendingAllowed(ctx)` — abuse gate clear.
4. Status is `draft` (or `draft | scheduled` for sendNow).
5. Template selected, audience configured, fromEmail set.
6. Domain verified (`getEmailDomainVerificationStatus`).
7. Scheduled time is in the future (schedule only).

`campaigns/scheduling.ts:schedule`,
`campaigns/organization.ts:scheduleForOrganization`,
`campaigns/campaigns.ts:sendNow`, and
`campaigns/organization.ts:sendNowForOrganization` each run their own
copy. The schedule variants run all seven; the sendNow variants run
six (skipping #7). 35 lines × 4 = ~140 LOC of duplicated checks. The
domain-verification check involves a `ctx.runQuery` — repeated four
times in the codebase, easy to drift on the timeout / error handling.

### 8. Defense-in-depth abuse re-check inside the orchestrator

`emails.ts:413` (inside `startCampaignSendInternal`) reruns
`isSendingAllowed(internalOrgSettings?.abuseStatus ?? null)` and returns
early with `skipped: true` if the org has been suspended between the
schedule call and the orchestrator firing. Today this is a safety net
because the gate could go from `clean` to `suspended` while a scheduled
campaign waits in the scheduler. Under this deepening, the
`schedule_campaign_send_orchestrator` effect still fires from the
scheduled-state transition, but the orchestrator must re-validate at
fire time — that re-validation moves into `validateReadyToSend` called
from the scheduler-tick path.

### 9. CONTEXT.md has no Campaign vocabulary

Pre-this-ADR, CONTEXT.md describes the **Send lifecycle**, the **Postbox
outbound lifecycle**, the **DOI lifecycle**, the **Inbox processing
lifecycle**, the **Abuse status** — five instances of the Outbound
lifecycle shape — but does not name the Campaign or its status machine
at all. A new dev asking "where does scheduling a campaign live?" has
no single answer; the writer-landscape table above is the answer they
need.

### Shared framing

Per LANGUAGE.md's deletion test: deleting the four schedule/send
mutations and inlining their bodies reveals four near-mirror copies of
"check the gates, patch the status, schedule the orchestrator." Deleting
the three `emailsQueries.ts` campaign-status writers and inlining them
into the orchestrator reveals the missing audit-log and `trackEvent`
calls drift across the agent-pipeline boundary. Inlining either set
spreads the drift across files rather than concentrating it — and the
`pending_review` one-way door is the highest-cost example because it's
a contract gap, not just a code-duplication gap.

The friction is moderate in LOC but architectural: Campaign is the only
top-level row in the codebase with a multi-state lifecycle that has no
lifecycle module. Send, Postbox, DOI, Inbox, and Abuse all have one.
Campaign is the conspicuous absentee.

## Decision

Two new modules and one helper, all under `apps/api/convex/campaigns/`:

- **`lifecycle.ts`** — **Campaign lifecycle (module)** owns transitions
  of `campaigns.status`.
- **`abTestLifecycle.ts`** — **AB test lifecycle (module)** owns
  transitions of `campaigns.abTestStatus`. Sibling, not parent — same
  row, different column.
- **`preflight.ts`** — `validateReadyToSend(ctx, campaign)` helper.
  Called by callers *before* `lifecycle.transition`, reducer trusts its
  input. Closes the four-way pre-flight duplication.

### Campaign lifecycle (module) shape

```ts
// apps/api/convex/campaigns/lifecycle.ts

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';

export type CampaignStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent'
  | 'cancelled' | 'pending_review';

export type CampaignTransitionInput =
  | { to: 'scheduled'; scheduledAt: number; useRecipientTimezone?: boolean;
      scheduledHour?: number; scheduledMinute?: number }
  | { to: 'draft' /* from scheduled (unschedule) | sending (revert) | pending_review (reject) */;
      contentBlockReason?: string /* set only on sending → draft */ }
  | { to: 'cancelled'; reason?: string }
  | { to: 'sending' /* from draft | scheduled | pending_review */ }
  | { to: 'sent' }
  | { to: 'pending_review' };

export type CampaignTransitionOutcome =
  | { ok: true; from: CampaignStatus; to: CampaignStatus; applied: true }
  | { ok: true; from: CampaignStatus; to: CampaignStatus; applied: false;
      reason: 'duplicate' /* already in target state */ }
  | { ok: false; reason: 'illegal_edge' | 'terminal' | 'campaign_not_found' };

export const transition: (ctx, args: {
  campaignId: Id<'campaigns'>;
  input: CampaignTransitionInput;
  /* Optional source-of-transition metadata for audit + tracking;
     defaults derived from input.to when omitted. */
  source?: 'user' | 'scheduler_tick' | 'content_scan' | 'admin_review';
}) => Promise<CampaignTransitionOutcome>;
```

### Campaign status — legal edges

```
draft         → scheduled
draft         → sending
scheduled     → draft           (unschedule)
scheduled     → cancelled
scheduled     → sending          (sendNow on scheduled; scheduler-tick path)
sending       → sent             (orchestrator terminal)
sending       → draft            (content scan blocked; contentBlockReason)
sending       → pending_review   (content scan suspicious)
pending_review → sending         (admin approve)
pending_review → draft           (admin reject)
```

Terminal: `sent`, `cancelled`. Transitions out of terminal are refused
as `{ ok: false, reason: 'terminal' }`. Duplicate same-state attempts
return `{ ok: true, applied: false, reason: 'duplicate' }` — idempotent.

### Campaign lifecycle effects

```ts
type CampaignEffect =
  | {
      kind: 'audit_log';
      action: string;       // 'campaign.scheduled' | 'campaign.sent' | ...
      campaignId: Id<'campaigns'>;
      details?: Record<string, unknown>;
    }
  | {
      kind: 'schedule_campaign_send_orchestrator';
      campaignId: Id<'campaigns'>;
      delayMs: number;      // 0 for sendNow, scheduledAt - now for scheduled
    }
  | {
      kind: 'track_event';
      event: 'campaign_scheduled' | 'campaign_sent' | 'campaign_cancelled';
      campaignId: Id<'campaigns'>;
    }
  | {
      kind: 'start_ab_test_if_enabled';
      campaignId: Id<'campaigns'>;
    };
```

Per-transition effect table:

| Transition | `audit_log` | `schedule_orchestrator` | `track_event` | `start_ab_test_if_enabled` |
|---|---|---|---|---|
| `→ scheduled` | ✅ `campaign.scheduled` | ✅ `delayMs = scheduledAt - now` | ✅ `campaign_scheduled` | ❌ |
| `scheduled → draft` (unschedule) | ✅ `campaign.unscheduled` | ❌ | ❌ | ❌ |
| `→ cancelled` | ✅ `campaign.cancelled` | ❌ | ✅ `campaign_cancelled` | ❌ |
| `→ sending` | ✅ `campaign.send_started` | ✅ `delayMs = 0` | ✅ `campaign_sent` | ✅ |
| `sending → sent` | ✅ `campaign.sent` | ❌ | ❌ (the user-facing `campaign_sent` fires on the `→ sending` edge, not the terminal) | ❌ |
| `sending → draft` (content blocked) | ✅ `campaign.content_blocked` | ❌ | ❌ | ❌ |
| `sending → pending_review` | ✅ `campaign.flagged_for_review` | ❌ | ❌ | ❌ |
| `pending_review → sending` (approve) | ✅ `campaign.review_approved` | ✅ `delayMs = 0` | ❌ | ✅ |
| `pending_review → draft` (reject) | ✅ `campaign.review_rejected` | ❌ | ❌ | ❌ |

The `→ sending` row from `pending_review` is structurally identical to
the `→ sending` row from `draft|scheduled` — same effects, same
companion patches. The reducer dispatches on `to`, not on the source
state, so the table collapses to one branch per `to` value at the
implementation level.

### Campaign companion-field patches

Atomic with the status patch in the reducer:

| Transition | Field writes |
|---|---|
| `→ scheduled` | `scheduledAt`, `useRecipientTimezone?`, `scheduledHour?`, `scheduledMinute?`, `updatedAt` |
| `scheduled → draft` (unschedule) | `scheduledAt: undefined`, `updatedAt` |
| `→ cancelled` | `cancelledAt: Date.now()`, `scheduledAt: undefined`, `updatedAt` |
| `→ sending` | `sentAt: Date.now()`, `scheduledAt: undefined`, `statsSent..statsUnsubscribed: 0`, `updatedAt` |
| `sending → sent` | `updatedAt` only (stats are bumped by Send lifecycle, not reset here) |
| `sending → draft` (content blocked) | `contentBlockReason: input.contentBlockReason`, `updatedAt` |
| `sending → pending_review` | `updatedAt` |
| `pending_review → sending` (approve) | same as `→ sending` (stats reset, sentAt) |
| `pending_review → draft` (reject) | `updatedAt` |

The `→ sending` stats-zero block is the Campaign lifecycle's
*reset* — per-Send *increments* land via the **Send lifecycle (module)**'s
`campaign_stats_*` effects. The two writers cooperate: Campaign resets,
Send bumps.

### AB test lifecycle (module) shape

```ts
// apps/api/convex/campaigns/abTestLifecycle.ts

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';

export type AbTestStatus = 'pending' | 'testing' | 'winner_selected';

export type AbTestTransitionInput =
  | { to: 'pending'; config: AbTestConfig }
  | { to: 'testing' }
  | { to: 'winner_selected'; winner: 'A' | 'B' }
  | { to: 'none' /* disable / reset */ };

export type AbTestTransitionOutcome =
  | { ok: true; from: AbTestStatus | 'none'; to: AbTestStatus | 'none'; applied: true }
  | { ok: true; from: AbTestStatus | 'none'; to: AbTestStatus | 'none'; applied: false;
      reason: 'duplicate' }
  | { ok: false; reason: 'illegal_edge' | 'campaign_not_found' };

export const transition: (ctx, args: {
  campaignId: Id<'campaigns'>;
  input: AbTestTransitionInput;
}) => Promise<AbTestTransitionOutcome>;
```

### AB test status — legal edges

```
(none) → pending          (enableABTest)
pending → testing         (cross-machine — Campaign lifecycle's start_ab_test_if_enabled)
testing → winner_selected (declareABTestWinner)
* → (none)                (disableABTest — full reset)
```

The `completed` literal is **dropped** from the union as a pre-prod
schema change. No production data exists at this status, and no writer
ever set it. The follow-up "send the winning variant to the rest of the
audience" workflow lands as a new transition kind (likely `testing →
won_and_distributed` or a `winner_selected → finalized` edge) when the
follow-up actually ships — not as a placeholder literal that anticipates
work that may never happen.

### AB test effects

```ts
type AbTestEffect =
  | {
      kind: 'audit_log';
      action: string;      // 'ab_test.enabled' | 'ab_test.testing_started' | ...
      campaignId: Id<'campaigns'>;
      details?: Record<string, unknown>;
    };
```

Per-transition:

| Transition | `audit_log` |
|---|---|
| `(none) → pending` | ✅ `ab_test.enabled` |
| `pending → testing` | ✅ `ab_test.testing_started` |
| `testing → winner_selected` | ✅ `ab_test.winner_declared` |
| `* → (none)` | ✅ `ab_test.disabled` |

### AB test companion-field patches

| Transition | Field writes |
|---|---|
| `(none) → pending` | `isABTest: true`, `abTestConfig: input.config`, `updatedAt` |
| `pending → testing` | `updatedAt` only |
| `testing → winner_selected` | `abWinner: input.winner`, `abWinnerSelectedAt: Date.now()`, `updatedAt` |
| `* → (none)` | `isABTest: false`, `abTestConfig: undefined`, `abVariantBSent..abWinner*: undefined`, `updatedAt` |

The reset block on `→ (none)` mirrors the open-coded reset block in
today's `disableABTest:114-124` — the lifecycle owns the full erasure
so that "disable" is one transition, not seven inline field writes.

### Cross-machine bridge

The Campaign lifecycle's `start_ab_test_if_enabled` effect reads the
campaign row to check `isABTest`. If true, it calls the AB test
lifecycle's `transition({ to: 'testing' })`. The cross-machine call is
inside the effect runner (same Convex mutation as the Campaign
lifecycle's patch), so atomicity is preserved — `status: 'sending'` and
`abTestStatus: 'testing'` land in the same write.

Same pattern as the **DOI lifecycle (module)**'s
`fire_topic_subscribed_triggers` effect, which reads the contact's
DOI-required Topic memberships and fans out to
`automations.triggers.fireTopicSubscribedTrigger` for each. The
cross-module reach happens at effect-application time, not transition
time.

### Pre-flight helper

```ts
// apps/api/convex/campaigns/preflight.ts

import { ctx } from '...';
import type { Doc } from '../_generated/dataModel';

export type PreflightResult =
  | { ok: true }
  | { ok: false;
      reason:
        | 'domain_not_verified'   /* details.domain, details.error */
        | 'no_template'
        | 'no_audience'
        | 'no_from_email'
        | 'sending_not_allowed'   /* abuseGate */
        | 'scheduled_in_past';    /* scheduled only */
      details?: Record<string, unknown>;
    };

export const validateReadyToSend: (
  ctx,
  campaign: Doc<'campaigns'>,
  options?: {
    scheduledAt?: number;   /* enables the future-date check */
  },
) => Promise<PreflightResult>;
```

Called by the surviving `schedule`, `sendNow`, and the orchestrator's
scheduler-tick path *before* `lifecycle.transition`. The reducer
assumes the campaign passes pre-flight; if the orchestrator's tick
finds the campaign no longer ready (e.g., org went `suspended` between
schedule and tick), the orchestrator skips the transition and logs a
deferred-skip event.

### Call-site shape after the cut

```ts
// campaigns/scheduling.ts:schedule (was lines 125-199 — surviving entry)
export const schedule = mutation({
  args: {
    campaignId: v.id('campaigns'),
    scheduledAt: v.number(),
    useRecipientTimezone: v.optional(v.boolean()),
    scheduledHour: v.optional(v.number()),
    scheduledMinute: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    requirePermission(hasPermission(session.role, 'campaigns:schedule'),
      'Only owners and admins can schedule campaigns');

    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throwNotFound('Campaign');

    const preflight = await validateReadyToSend(ctx, campaign,
      { scheduledAt: args.scheduledAt });
    if (!preflight.ok) {
      throwInvalidState(`Cannot schedule: ${preflight.reason}`);
    }

    const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
      campaignId: args.campaignId,
      input: {
        to: 'scheduled',
        scheduledAt: args.scheduledAt,
        ...(args.useRecipientTimezone !== undefined && { useRecipientTimezone: args.useRecipientTimezone }),
        ...(args.scheduledHour !== undefined && { scheduledHour: args.scheduledHour }),
        ...(args.scheduledMinute !== undefined && { scheduledMinute: args.scheduledMinute }),
      },
      source: 'user',
    });

    if (!outcome.ok) {
      throwInvalidState(`Cannot schedule: ${outcome.reason}`);
    }

    return args.campaignId;
  },
});
```

```ts
// campaigns/organization.ts:scheduleForOrganization — DELETED.
// HTTP routes that called it now call api.campaigns.scheduling.schedule.
```

```ts
// campaigns/scheduling.ts:cancel (was lines 17-52)
export const cancel = mutation({
  args: { campaignId: v.id('campaigns') },
  handler: async (ctx, args) => {
    const session = await getMutationContext(ctx);
    requirePermission(hasPermission(session.role, 'campaigns:schedule'),
      'Only owners and admins can cancel campaigns');

    const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
      campaignId: args.campaignId,
      input: { to: 'cancelled' },
      source: 'user',
    });

    if (!outcome.ok) {
      throwInvalidState(`Cannot cancel: ${outcome.reason}`);
    }

    return args.campaignId;
  },
});
```

```ts
// emails.ts:startCampaignSendInternal (was lines 396-590)
// The "defense-in-depth abuse re-check" at line 413 moves into
// validateReadyToSend; the inline status patch on scheduler-tick
// (call to updateCampaignToSending) moves to lifecycle.transition;
// the inline markCampaignSent at the terminal moves to
// lifecycle.transition({ to: 'sent' }); the content-scan revert /
// pending_review writes move to lifecycle.transition.

export const startCampaignSendInternal = internalAction({
  args: { campaignId: v.id('campaigns') },
  handler: async (ctx, args) => {
    const campaign = await ctx.runQuery(
      internal.emailsQueries.getCampaignForSending, { campaignId: args.campaignId });
    if (!campaign) throw new Error('Campaign not found');

    const preflight = await ctx.runQuery(
      internal.campaigns.preflight.validateReadyToSendQuery, { campaignId: args.campaignId });
    if (!preflight.ok) {
      // Org might have been suspended between schedule and tick, etc.
      return { totalRecipients: 0, totalBatches: 0, skipped: true,
        reason: `Pre-flight failed: ${preflight.reason}` };
    }

    // Status defensive checks (cancelled / draft = orchestrator was racing
    // with unschedule/cancel; sending/sent = duplicate scheduler invocation).
    if (campaign.status === 'cancelled' || campaign.status === 'draft') {
      return { totalRecipients: 0, totalBatches: 0, skipped: true,
        reason: campaign.status === 'cancelled' ? 'Campaign was cancelled' : 'Campaign was unscheduled' };
    }
    if (campaign.status === 'sending' || campaign.status === 'sent') {
      return { totalRecipients: 0, totalBatches: 0, skipped: true,
        reason: 'Campaign is already sending or was already sent' };
    }

    // Transition scheduled → sending (lifecycle owns the patch + AB-test kickoff).
    if (campaign.status === 'scheduled') {
      await ctx.runMutation(internal.campaigns.lifecycle.transition, {
        campaignId: args.campaignId,
        input: { to: 'sending' },
        source: 'scheduler_tick',
      });
    }

    // ... template load, content scan, archive snapshot, recipient resolution
    //     (unchanged) ...

    // Content-scan results route through the lifecycle module:
    if (internalCombined.level === 'blocked') {
      await ctx.runMutation(internal.campaigns.lifecycle.transition, {
        campaignId: args.campaignId,
        input: { to: 'draft', contentBlockReason:
          `Content blocked: ${internalCombined.flags.map(f => f.description).join('; ')}` },
        source: 'content_scan',
      });
      return { totalRecipients: 0, totalBatches: 0, skipped: true,
        reason: `Content blocked by scanner (score: ${internalCombined.score}/100)` };
    }
    if (internalCombined.level === 'suspicious') {
      await ctx.runMutation(internal.campaigns.lifecycle.transition, {
        campaignId: args.campaignId,
        input: { to: 'pending_review' },
        source: 'content_scan',
      });
      return { totalRecipients: 0, totalBatches: 0, skipped: true,
        reason: `Content flagged for review (score: ${internalCombined.score}/100)` };
    }

    // ... batch sending ...

    // Terminal: mark sent.
    await ctx.runMutation(internal.campaigns.lifecycle.transition, {
      campaignId: args.campaignId,
      input: { to: 'sent' },
      source: 'scheduler_tick',  // or pass through original source
    });

    return { totalRecipients, totalBatches };
  },
});
```

```ts
// campaigns/abTest.ts:enableABTest — auth shell, delegates.
export const enableABTest = mutation({
  args: { /* unchanged */ },
  handler: async (ctx, args) => {
    await getMutationContext(ctx);

    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throwNotFound('Campaign');
    if (campaign.status !== 'draft') {
      throwInvalidState('A/B testing can only be enabled on draft campaigns');
    }

    // Validation (split %, variant config) stays here — pre-condition,
    // not lifecycle territory.
    if (args.splitPercentage < 10 || args.splitPercentage > 50) {
      throwInvalidInput('Split percentage must be between 10 and 50');
    }
    // ... other validations unchanged ...

    const abTestConfig: ABTestConfig = { /* unchanged construction */ };

    const outcome = await ctx.runMutation(internal.campaigns.abTestLifecycle.transition, {
      campaignId: args.campaignId,
      input: { to: 'pending', config: abTestConfig },
    });

    if (!outcome.ok) {
      throwInvalidState(`Cannot enable AB test: ${outcome.reason}`);
    }

    return args.campaignId;
  },
});
```

### Files deleted

- `campaigns/organization.ts:scheduleForOrganization` (deleted; HTTP
  callers route through `api.campaigns.scheduling.schedule`).
- `campaigns/organization.ts:sendNowForOrganization` (deleted; HTTP
  callers route through `api.campaigns.campaigns.sendNow`).
- `emailsQueries.ts:updateCampaignToSending` (deleted; orchestrator
  calls `lifecycle.transition({ to: 'sending' })`).
- `emailsQueries.ts:markCampaignSent` (deleted; orchestrator calls
  `lifecycle.transition({ to: 'sent' })`).
- `emailsQueries.ts:setCampaignPendingReview` (deleted; orchestrator
  calls `lifecycle.transition({ to: 'pending_review' })`).
- `emailsQueries.ts:revertCampaignToDraft` (deleted; orchestrator
  calls `lifecycle.transition({ to: 'draft', contentBlockReason })`).
- `campaigns/campaigns.ts:updateStats`'s `status: v.optional(...)` arg
  (removed; the function still updates `statsSent..statsUnsubscribed`,
  but never `status`). Tests that used the backdoor switch to direct
  `lifecycle.transition` calls.

### Schema changes

`campaigns.abTestStatus` validator (lives at the `defineTable` call in
`schema/campaigns.ts`) drops the `'completed'` literal:

```ts
abTestStatus: v.optional(
  v.union(
    v.literal('pending'),
    v.literal('testing'),
    v.literal('winner_selected'),
    // v.literal('completed'),  ← removed (no writer ever set it)
  )
),
```

`campaigns.status` validator is unchanged — `pending_review` stays
(legal edges out are now defined, even if the admin approval surface
is a follow-up).

No `campaigns` table column additions. No data migration: no
production row has `abTestStatus: 'completed'`.

### What stays put

- **Auth checks.** Public mutations still consult `hasPermission` /
  `requirePermission`. The lifecycle module never decides who can call
  it.
- **Pre-flight checks.** `validateReadyToSend` is a helper, not part of
  the lifecycle. Callers run it; the reducer trusts its input. Q4(b)
  decision.
- **Archive snapshot.** `archiveQueries.setArchiveSnapshot` continues
  to write `archiveToken` / `archiveHtmlContent` / `archiveSubject`
  during the campaign-send orchestrator's mid-`sending` work. The
  snapshot is not a transition effect — it happens *during* the
  `sending` state, not *on transition to it*.
- **Send lifecycle's `campaign_stats_*` effects.** Per-Send stats
  bumps continue to land via the Send lifecycle's effect list. Campaign
  lifecycle owns the reset on `→ sending`; Send lifecycle owns the
  bumps.
- **AB test variant fanout.** The per-recipient variant assignment
  (which contact gets variant A vs B) lives in the campaign-send
  orchestrator's batch builder, not in the AB test lifecycle. The
  lifecycle owns the `abTestStatus` column and the AB test config;
  the orchestrator owns the variant-assignment ceremony.
- **AB test winner-criteria evaluation.** The auto-pick timer that
  declares a winner based on open/click rate is not wired today and
  not landed by this ADR. When it ships, it calls
  `abTestLifecycle.transition({ to: 'winner_selected', winner })`
  from whatever scheduler/cron decides.
- **Public mutation names.** `cancel`, `unschedule`, `schedule`,
  `sendNow`, `enableABTest`, `disableABTest`, `declareABTestWinner`
  stay. Public surface unchanged; only the open-coded patches inside
  change.

## Considered options

### Module scope — one module vs two siblings

1. **Two sibling modules — one for `status`, one for `abTestStatus`** *(chosen)*.
   The two state machines have disjoint legal-edges graphs, disjoint
   triggers (one is user-driven + orchestrator, the other is
   AB-test-specific), and only one cross-machine effect coupling them.
   Splitting matches the [[abuse_status_module]] pattern (writer
   module separate from reader module — different concerns, same row).
2. **One module owns both fields.** Single `lifecycle.transition` with
   a `TransitionInput` that's a union of status-transitions and
   ab-status-transitions. Rejected — the input union balloons (10 +
   4 = 14 input variants), most callers care about only one machine,
   and "is this transition about status or abTestStatus?" becomes a
   constant dispatch concern. The cross-machine coupling
   (`start_ab_test_if_enabled`) is one direction, so a one-module
   design wouldn't save the cross-call anyway.
3. **One lifecycle module for both, with `kind: 'campaign_status' |
   'ab_test_status'` discriminator on transitions.** A namespaced
   union variant. Rejected — same con as (2), worse because it
   pretends the two machines are the same when their effect lists
   diverge sharply (Campaign has four effect kinds; AB test has one).

### `pending_review` exit edges — design now vs land as the admin surface ships

1. **Design the exit edges now; ship the lifecycle with them in the
   graph** *(chosen — Q1(b))*. `pending_review → sending` and
   `pending_review → draft` land in `LEGAL_EDGES` even though no public
   mutation calls them today. The admin approval surface plugs into
   the existing entry point when it ships, no graph re-litigation
   required.
2. **Drop the literal as part of this deepening; reintroduce when the
   admin surface ships** (Q1(a)). Rejected — `setCampaignPendingReview`
   is *active code* (called from `emails.ts:538` when content scan
   returns `'suspicious'`), so dropping the literal requires either
   removing the suspicious-content code path or rerouting suspicious
   content to `blocked` semantics. The current behavior (flagging for
   review) is the right product behavior; only the *reviewer* surface
   is missing.
3. **Keep the literal but no legal edges out — same as today.**
   Rejected — under this deepening the lifecycle module *is* the
   contract. A literal with no exit edges in the graph is a documented
   one-way door, which is a worse contract than today's accidental
   one-way door (which at least leaves room for a future patch to
   open the door).

### `forOrganization` duplicates — consolidate vs keep separate

1. **Consolidate; delete the `forOrganization` duplicates** *(chosen —
   Q3)*. Each pair shares ~35 LOC word-for-word with diverging
   `trackEvent` calls (the org variants forgot them) and slightly
   different permission-error wording. The fork was for an HTTP-API
   vs in-app split that no longer matters; both shells run inside
   Convex mutations with `getMutationContext`. Routes that called the
   `forOrganization` variant now call the surviving entry.
2. **Keep both shells; both delegate to one lifecycle entry.** Rejected
   — preserves the duplication of pre-flight, args parsing, and
   permission checks for no benefit, and codifies the
   `trackEvent`-drift bug as a feature.
3. **Keep both shells but mark `forOrganization` deprecated, delete in
   a follow-up.** Rejected — the deprecation creates a maintenance
   window during which the drift can re-emerge. Pre-prod is the right
   time to delete.

### Pre-flight — inside the reducer vs caller-side helper

1. **Pre-flight as a helper called *before* `lifecycle.transition`;
   reducer trusts its input** *(chosen — Q4(b))*. The reducer stays
   pure (no `runQuery`s for domain verification). Tests assert against
   the reducer with a "campaign that passes pre-flight" fixture.
   `validateReadyToSend(ctx, campaign)` is the one place the four-way
   duplicated checks live.
2. **Pre-flight inside the reducer for `→ scheduled` and `→ sending`
   transitions.** Q4(a). Rejected — the reducer becomes async-heavy
   (needs `ctx.runQuery` for domain verification, abuse gate read),
   tests get harder, and the pure-reducer pattern that all five other
   lifecycle modules use breaks.
3. **Pre-flight scattered as in today.** Rejected — the
   four-way-duplicated check blocks are the second-largest line-count
   payoff of this deepening after the audit-log consolidation.

### Cross-machine bridge — effect vs caller coordination

1. **Cross-machine effect — `start_ab_test_if_enabled` fires from
   Campaign lifecycle's `→ sending` reducer and calls AB test lifecycle's
   `transition({ to: 'testing' })`** *(chosen — Q7(a))*. Atomicity:
   `status: 'sending'` and `abTestStatus: 'testing'` land in the same
   Convex mutation, so a caller can't forget to drive the second
   machine. Established convention — [[doi_lifecycle_module]] reaches
   into [[topic_subscription_module]] the same way.
2. **Caller coordination — the orchestrator (and any other transition
   producer) calls Campaign lifecycle, then AB test lifecycle,
   sequentially.** Q7(b). Rejected — moves the "if isABTest, transition
   ab_test" coupling to N callers instead of one effect. Same anti-
   pattern this deepening is closing for audit logs and `trackEvent`.
3. **AB test lifecycle exposes a "campaign just transitioned" hook
   that watches.** Convex doesn't have row-change triggers; the watcher
   would have to be a polling cron. Rejected — adds infrastructure for
   nothing.

### Companion-field scope — lifecycle owns vs orchestrator owns

1. **Lifecycle owns `sentAt`, `cancelledAt`, `scheduledAt`,
   `contentBlockReason`, and stats-zero** *(chosen — Q5)*. These are
   strictly per-transition fields; their values are derivable from
   the transition input alone. Atomicity with the status patch is
   the point of owning them in the reducer.
2. **Orchestrator owns `sentAt` and `contentBlockReason`; lifecycle
   owns only `cancelledAt` and `scheduledAt`.** Rejected — splits the
   "atomic with status" guarantee. If the orchestrator forgets the
   `sentAt` write, the row has `status: 'sent'` with no `sentAt` and
   downstream queries break.
3. **Lifecycle owns the entire campaign row (CRUD too).** Rejected —
   the lifecycle owns *transitions*, not field-level edits. Updating
   the `name`, `fromName`, `audienceType`, etc. is not a lifecycle
   concern; those stay in the existing `updateBasics`,
   `updateAudience`, `updateContent` mutations (which still guard on
   `status === 'draft'`).

### Archive snapshot — lifecycle effect vs orchestrator concern

1. **Archive snapshot stays in `archiveQueries.setArchiveSnapshot`,
   called by the campaign-send orchestrator mid-`sending`** *(chosen —
   Q5)*. The snapshot's timing is "after content scan passes, before
   first batch sends" — that's mid-state, not on-transition. Making it
   a lifecycle effect would force the lifecycle to load the template,
   evaluate the archive-enabled flag, generate the HTML, and write the
   token — all of which are squarely orchestrator concerns.
2. **Archive snapshot fires as a `write_archive_snapshot` lifecycle
   effect on `→ sending`.** Rejected — the effect would have to load
   the template and call `replaceVariables`, which couples the lifecycle
   to the email-renderer. The lifecycle stays Convex-only.
3. **Archive snapshot fires from a Send lifecycle effect on the first
   Send transition.** Rejected — happens too late (the first
   recipient's open pixel would already have rendered before the
   "view in browser" link exists), and the Send lifecycle is per-Send,
   not per-Campaign, so it would need a guard to fire only on the
   first.

### `completed` literal — keep or drop

1. **Drop `'completed'` from `abTestStatus`** *(chosen)*. No writer
   ever set it; no caller reads it; no production data carries it.
   The follow-up workflow ("send winning variant to rest of audience")
   lands as an explicit new transition kind when it ships, not as a
   placeholder literal that anticipates work that may never happen.
2. **Keep `'completed'`; design the legal edges into the graph as we
   did for `pending_review`.** Rejected — `pending_review` has an
   *active writer* (the content scanner) and a *defined product
   intent* (admin review). `completed` has neither today; it's pure
   speculation about a follow-up that hasn't been scoped.
3. **Keep `'completed'` but mark the literal `@deprecated` and remove
   in a follow-up.** Rejected — pre-prod is the right time to remove
   dead literals (same pattern [[abuse_status_module]] used to drop
   the `throttled` literal).

### AB test winner auto-pick — land here vs follow-up

1. **Follow-up.** The auto-pick timer that declares a winner based on
   open/click rate is a separate concern (a scheduled action + a
   decision rule + a reducer call). Out of scope for this ADR. The
   AB test lifecycle's `→ winner_selected` entry is ready when the
   timer lands. *(chosen)*
2. **Land it here as a second cross-machine effect from the AB test
   lifecycle.** Rejected — couples two scope-distinct deepenings and
   the auto-pick timer hasn't been product-scoped yet (manual winner
   selection is the current product behavior).

### Module naming

1. **`Campaign lifecycle (module)` at `convex/campaigns/lifecycle.ts`**
   and **`AB test lifecycle (module)` at
   `convex/campaigns/abTestLifecycle.ts`** *(chosen)*. Matches the
   Outbound-lifecycle naming pattern (Send lifecycle, Postbox outbound
   lifecycle, DOI lifecycle, Inbox processing lifecycle, Abuse status —
   each named after the column they own).
2. **`Campaign module` / `AB test module`.** Rejected — the modules own
   *transitions*, not the entire concept. CRUD, validation, audience
   resolution all live elsewhere; "Campaign module" suggests it owns
   all of them.
3. **`Campaign state module`.** Rejected — collides with the value
   noun ("Campaign status"). The module is the writer of the column,
   not the value itself.

## Consequences

### Files that collapse / disappear

- `campaigns/organization.ts:scheduleForOrganization` (deleted —
  duplicate of `scheduling.ts:schedule`).
- `campaigns/organization.ts:sendNowForOrganization` (deleted —
  duplicate of `campaigns.ts:sendNow`).
- `emailsQueries.ts:updateCampaignToSending` (deleted — replaced by
  `lifecycle.transition({ to: 'sending' })` in the orchestrator).
- `emailsQueries.ts:markCampaignSent` (deleted — replaced by
  `lifecycle.transition({ to: 'sent' })`).
- `emailsQueries.ts:setCampaignPendingReview` (deleted — replaced by
  `lifecycle.transition({ to: 'pending_review' })`).
- `emailsQueries.ts:revertCampaignToDraft` (deleted — replaced by
  `lifecycle.transition({ to: 'draft', contentBlockReason })`).
- `campaigns/campaigns.ts:updateStats` loses its `status` arg (the
  test backdoor).
- The seven open-coded `ctx.db.patch(campaignId, { status: ..., ...
  })` calls and the three open-coded `ctx.db.patch(campaignId, {
  abTestStatus: ..., ... })` calls enumerated in the writer-landscape
  tables all go.
- The defense-in-depth `isSendingAllowed(...)` re-check at `emails.ts:413`
  collapses into `validateReadyToSend`.

### Files that grow

- `apps/api/convex/campaigns/lifecycle.ts` — new module (~360 LOC).
  Exports the `transition` entry point, the
  `CampaignStatus` / `CampaignTransitionInput` /
  `CampaignTransitionOutcome` types, the `CampaignEffect` union, the
  legal-edges graph, the reducer per `to` value, and the effect runner.
- `apps/api/convex/campaigns/abTestLifecycle.ts` — new module
  (~180 LOC). Smaller because the effect list is just `audit_log` and
  the reducer is simpler.
- `apps/api/convex/campaigns/preflight.ts` — new module (~80 LOC).
  Exports `validateReadyToSend` and the `PreflightResult` type. The
  domain-verification call is wrapped here.
- `apps/api/convex/campaigns/__tests__/lifecycle.integration.test.ts`
  — new (~28 tests; see §Test surface).
- `apps/api/convex/campaigns/__tests__/abTestLifecycle.integration.test.ts`
  — new (~12 tests).
- `apps/api/convex/campaigns/scheduling.ts` — `schedule`, `cancel`,
  `unschedule` shrink to ~20 LOC each (auth + pre-flight + lifecycle
  delegate). Net ~100 LOC down.
- `apps/api/convex/campaigns/campaigns.ts` — `sendNow` shrinks
  similarly. `duplicate` and `remove` stay roughly the same (they're
  not lifecycle territory).
- `apps/api/convex/campaigns/abTest.ts` — three mutations shrink to
  auth + lifecycle delegate; net ~50 LOC down.
- `apps/api/convex/campaigns/organization.ts` — the duplicates are
  deleted; the surviving HTTP-only mutations (`createForOrganization`,
  `listByOrganization`, `countByStatusByOrganization`,
  `getAudienceCountByOrganization`) stay. `createForOrganization`
  gains the `trackEvent` call it was missing.
- `apps/api/convex/emailsQueries.ts` — the four campaign-status
  writers are deleted; remaining read queries (`getCampaignForSending`,
  `getCampaignsToProcess`, `getEmailTemplate`, etc.) unchanged.
- `apps/api/convex/emails.ts` — `startCampaignSendInternal` shrinks
  modestly (the defense-in-depth re-check disappears, the four
  status-writing internal mutations collapse to one `transition`
  pattern). Net ~30 LOC down.

Net LOC change: ~250 LOC down (across removed inline ceremony and
deleted duplicates) plus ~620 LOC up (new modules) plus ~500 LOC up
(new tests). Net ~+870 LOC. Value: locality (the ten status transitions
in one place), typed contract (input + outcome unions), audit-log
universality (every transition fires it), `trackEvent` universality
(no more org/session drift), pre-flight consolidation (four → one),
`pending_review` exit edges, three dead literals (`completed`,
`updateStats`'s `status` arg, and the second copies of
schedule/sendNow) eliminated.

### Migration

Pre-production: one schema change (`abTestStatus` drops the
`'completed'` literal — no production data uses it). No `campaigns`
row backfill. The `campaigns.status` validator is unchanged; existing
rows keep their current statuses.

The deleted `forOrganization` mutations: HTTP routes that called them
(`apps/api` HTTP layer) update to call the surviving session-keyed
variant. Same auth check, same args, same return shape.

The `updateStats` status-arg removal: test files that used the
backdoor switch to direct `internal.campaigns.lifecycle.transition`
calls. Pre-prod: no production callers exist.

### Test surface

`apps/api/convex/campaigns/__tests__/lifecycle.integration.test.ts`
(new, ~28 tests):

**Legal edges — happy path:**
- `→ scheduled` from `draft`: asserts patch, `audit_log` action
  `campaign.scheduled`, `track_event` `campaign_scheduled`,
  `schedule_campaign_send_orchestrator` with `delayMs = scheduledAt -
  now`.
- `→ scheduled` from `scheduled` (same scheduledAt): asserts
  `{ ok: true, applied: false, reason: 'duplicate' }`, no effects.
- `→ sending` from `draft`: asserts stats-zero patch, audit log,
  `track_event` `campaign_sent`, `schedule_orchestrator` with
  `delayMs = 0`, `start_ab_test_if_enabled` (asserts effect fires;
  AB-test-side assertions in the AB test test file).
- `→ sending` from `scheduled`: same effects as from `draft`.
- `scheduled → cancelled`: asserts `cancelledAt`, `scheduledAt:
  undefined`, audit log, `track_event` `campaign_cancelled`, no
  orchestrator schedule.
- `scheduled → draft` (unschedule): asserts `scheduledAt: undefined`,
  audit log, no `track_event`.
- `sending → sent`: asserts audit log, no orchestrator schedule (the
  orchestrator's terminal call is the writer; it doesn't re-schedule
  itself).
- `sending → draft` (content blocked): asserts
  `contentBlockReason` patch, audit log `campaign.content_blocked`,
  no orchestrator schedule.
- `sending → pending_review`: asserts audit log, no orchestrator
  schedule.
- `pending_review → sending` (approve): asserts stats-zero,
  `start_ab_test_if_enabled` if `isABTest`, audit log
  `campaign.review_approved`.
- `pending_review → draft` (reject): asserts audit log
  `campaign.review_rejected`, no orchestrator schedule.

**Legal edges — illegal:**
- `sent → sending`: `{ ok: false, reason: 'terminal' }`.
- `sent → draft`: `{ ok: false, reason: 'terminal' }`.
- `cancelled → scheduled`: `{ ok: false, reason: 'terminal' }`.
- `draft → sent`: `{ ok: false, reason: 'illegal_edge' }`.
- `draft → pending_review`: `{ ok: false, reason: 'illegal_edge' }`.
- `scheduled → pending_review`: `{ ok: false, reason: 'illegal_edge' }`.

**Cross-machine:**
- `draft → sending` on an `isABTest: true` campaign: asserts
  `start_ab_test_if_enabled` fires AND the AB test transitions to
  `'testing'` in the same mutation (read-back asserts
  `abTestStatus: 'testing'`).
- `draft → sending` on a non-AB-test campaign: asserts
  `start_ab_test_if_enabled` is a no-op (no AB test patch).
- `pending_review → sending` (approve) on an AB-test campaign:
  asserts the AB test re-enters `'testing'` if its current state is
  `'pending'`.

**Outcome shapes:**
- Idempotent re-application (`→ sent` twice) returns `applied: false,
  reason: 'duplicate'`.
- Unknown campaign returns `{ ok: false, reason: 'campaign_not_found' }`.

`apps/api/convex/campaigns/__tests__/abTestLifecycle.integration.test.ts`
(new, ~12 tests):

- `(none) → pending`: asserts `isABTest: true`, config patch, audit log.
- `(none) → pending` with bad config: rejected (pre-condition, not
  lifecycle; lifecycle assumes valid config).
- `pending → testing`: asserts patch, audit log (this transition is
  normally triggered by the cross-machine effect; the test calls it
  directly).
- `testing → winner_selected`: asserts `abWinner`,
  `abWinnerSelectedAt`, audit log.
- `pending → winner_selected`: `{ ok: false, reason: 'illegal_edge' }`.
- `* → (none)`: asserts full reset block (all `ab*` companion fields
  cleared), audit log.
- Duplicate re-application returns `applied: false`.

`apps/api/convex/campaigns/__tests__/preflight.integration.test.ts`
(new, ~8 tests): one per `PreflightResult.reason` literal, asserting
each gate fires under the right conditions.

### Behavior

- **Drift signal #1 (two pairs of near-identical mutations) —
  closed.** One `schedule` mutation, one `sendNow` mutation. HTTP
  callers and in-app callers share the surviving entry.
- **Drift signal #2 (audit log only on cancel) — closed.** Every
  transition fires `audit_log` with a per-transition action literal.
- **Drift signal #3 (`trackEvent` skipped on org variants) — closed.**
  `track_event` fires on `→ scheduled` / `→ sending` / `→ cancelled`
  regardless of which entry point produced the transition.
- **Drift signal #4 (`pending_review` is a one-way door) — closed.**
  `pending_review → sending` and `pending_review → draft` are in the
  legal-edges graph. The admin approval mutation lands as a follow-up
  PR that calls the existing entry point.
- **Drift signal #5 (dead AB test literals) — closed.** `'testing'`
  gets its writer via the cross-machine effect; `'completed'` is
  dropped from the union.
- **Drift signal #6 (`updateStats` status backdoor) — closed.** The
  `status` arg is removed; tests transition via lifecycle directly.
- **Drift signal #7 (pre-flight checks duplicated 4×) — closed.**
  `validateReadyToSend(ctx, campaign)` is the one consolidated check.
- **Drift signal #8 (defense-in-depth abuse re-check) — closed.** The
  re-check inside the orchestrator collapses into the
  scheduler-tick-time `validateReadyToSend` call.
- **Drift signal #9 (no Campaign vocabulary in CONTEXT.md) — closed.**
  CONTEXT.md gains a `## Campaigns` section with **Campaign**,
  **Campaign status**, **Campaign lifecycle (module)**, **AB test
  status**, **AB test lifecycle (module)** entries. The lifecycle-
  shape count in `## Relationships` updates from five to seven; the
  cross-machine bridge convention is documented.

User-visible effects:
- Audit log shows the full Campaign lifecycle for every campaign —
  who scheduled, who sent, when it was sent, who cancelled.
- PostHog analytics no longer under-counts HTTP-API-driven campaigns.
- The `abTestStatus` column now accurately reflects whether an AB
  test is in progress (`'testing'`) vs queued (`'pending'`) — the
  builder UI's AB-test-progress widget gains a real signal.
- The `'completed'` literal disappears from the schema (pre-prod
  schema change, no data impact).

### Vocabulary

CONTEXT.md updated inline during the grilling session that produced
this ADR (see [`CONTEXT.md`](../../CONTEXT.md)):

- New `## Campaigns` section with **Campaign**, **Campaign status**,
  **Campaign lifecycle (module)**, **AB test status**, **AB test
  lifecycle (module)** entries (inserted before `## Outbound
  lifecycle`).
- `## Relationships` section's lifecycle-shape paragraph updates: from
  five instances (DOI / Inbox / Send / Postbox / Abuse) to seven
  (adds Campaign / AB test). The paragraph also documents Campaign +
  AB test as the first siblings sharing one row, coordinated by a
  cross-machine effect.

No new audit-action literal namespace — `campaign.scheduled`,
`campaign.sent`, `campaign.cancelled`, etc. plug into the existing
audit-action catalog from ADR-0002. Same for `ab_test.enabled` /
`ab_test.testing_started` / `ab_test.winner_declared` /
`ab_test.disabled`.

No new Webhook event literals. Campaign lifecycle does not fan out
customer-facing webhooks today; Send lifecycle's existing
`customer_webhook` effect (per ADR-0006) covers the per-recipient
events that customers actually subscribe to. If the product later
decides to add `campaign.scheduled` or `campaign.cancelled` as
customer-subscribable Webhook events, those add as catalog entries
(ADR-0002) plus a new `customer_webhook` effect kind on the Campaign
lifecycle's effect union — one-line change.

## Follow-up work

1. **Admin approval surface for `pending_review`.** Public mutations
   `approvePendingReview` and `rejectPendingReview` that platform
   admins call. Each runs auth + `validateReadyToSend` (approval
   only) + `lifecycle.transition({ to: 'sending' | 'draft' })`.
   Out of scope here; the lifecycle's legal-edges graph is ready.
2. **AB test winner auto-pick.** A scheduled action that runs N hours
   after `pending → testing` (per `abTestConfig.testDuration`),
   evaluates per-variant open/click rates against `winnerCriteria`,
   and calls `abTestLifecycle.transition({ to: 'winner_selected',
   winner })`. Out of scope; lands when the product specifies the
   tie-breaker rules.
3. **Send winning variant to remaining audience after winner_selected.**
   A second send orchestration that runs after `→ winner_selected`,
   sends the winning variant to the contacts who weren't in the
   variant-A/B split, and marks the AB test "done." Probably warrants
   a new `winner_selected → finalized` transition (or a new literal),
   to be decided as part of that work.
4. **`Lifecycle<S, T, E>` factor consideration.** With seven instances
   of the shape now in the codebase, the factor question moves from
   "active design" to "actively binding." A future ADR may collapse
   the common skeleton (typed `TransitionInput`, `LEGAL_EDGES`
   matcher, reducer + effects runner, `TransitionOutcome` shape) into
   a generic helper that each instance specializes. The factor lands
   when the duplication bites at the *reducer-implementation* level,
   not at the type-signature level — and Campaign + AB test add two
   more reducers without surfacing that bite. Defer.
5. **Campaign-level customer webhook events.** `campaign.scheduled`,
   `campaign.cancelled`, `campaign.sent` as customer-subscribable
   Webhook event literals. Adds the catalog entries (ADR-0002) and
   a `customer_webhook` effect kind on the Campaign lifecycle.
   Out of scope; lands when product calls for it.
6. **Reputation / blocklist integration on `→ pending_review`.** Today
   the content scanner's `'suspicious'` verdict flags for review.
   The reputation system in `analytics/sendingReputation.ts` could
   ingest the per-flag count as a signal. Out of scope.

## Execution

Implemented in a single pre-production pass — no separate execution
plan needed, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/campaigns/lifecycle.ts` — new module.
- `apps/api/convex/campaigns/abTestLifecycle.ts` — new module.
- `apps/api/convex/campaigns/preflight.ts` — new helper.
- `apps/api/convex/campaigns/scheduling.ts` — `schedule`, `cancel`,
  `unschedule` rewritten as pre-flight + module-delegating shells.
- `apps/api/convex/campaigns/campaigns.ts` — `sendNow` rewritten as
  pre-flight + delegating shell. `updateStats` loses its `status`
  arg.
- `apps/api/convex/campaigns/organization.ts` — `scheduleForOrganization`
  and `sendNowForOrganization` deleted. `createForOrganization`
  gains the `track_event` call.
- `apps/api/convex/campaigns/abTest.ts` — `enableABTest`,
  `disableABTest`, `declareABTestWinner` rewritten as delegating
  shells.
- `apps/api/convex/emailsQueries.ts` — `updateCampaignToSending`,
  `markCampaignSent`, `setCampaignPendingReview`,
  `revertCampaignToDraft` deleted.
- `apps/api/convex/emails.ts` — `startCampaignSendInternal` rewires
  to call `lifecycle.transition` at the four status-writing sites;
  defense-in-depth `isSendingAllowed` re-check moves into
  `validateReadyToSend`.
- `apps/api/convex/schema/campaigns.ts` — `abTestStatus` validator
  drops the `'completed'` literal.
- `apps/api/convex/campaigns/__tests__/lifecycle.integration.test.ts`
  — new.
- `apps/api/convex/campaigns/__tests__/abTestLifecycle.integration.test.ts`
  — new.
- `apps/api/convex/campaigns/__tests__/preflight.integration.test.ts`
  — new.
- HTTP route handlers (wherever they wire `scheduleForOrganization` /
  `sendNowForOrganization`) repoint to the surviving entries.
- `CONTEXT.md` — `## Campaigns` section and updated `## Relationships`
  lifecycle-count paragraph already landed during the grilling
  session.

### Verification greps

- `rg "ctx.db.patch\\(.*\\{[^}]*status:\\s*['\"]" apps/api/convex/campaigns` →
  zero hits in `campaigns/` outside `lifecycle.ts`. Hits inside
  `lifecycle.ts` only (the reducer's patches).
- `rg "ctx.db.patch\\(.*\\{[^}]*abTestStatus" apps/api/convex/campaigns` →
  zero hits outside `abTestLifecycle.ts`.
- `rg "scheduleForOrganization|sendNowForOrganization" apps/api` →
  zero hits anywhere (the duplicate mutations are gone).
- `rg "updateCampaignToSending|markCampaignSent|setCampaignPendingReview|revertCampaignToDraft" apps/api` →
  zero hits anywhere (the open-coded internal mutations are gone).
- `rg "'completed'" apps/api/convex/schema/campaigns.ts` → zero hits
  (the literal is dropped).
- `rg "campaigns\\.lifecycle\\.transition" apps/api/convex` → hits in
  `campaigns/scheduling.ts`, `campaigns/campaigns.ts`,
  `campaigns/abTest.ts` (cross-machine reach via the AB test
  lifecycle is NOT here — see next), `emails.ts` (orchestrator).
- `rg "abTestLifecycle\\.transition" apps/api/convex` → hits in
  `campaigns/abTest.ts` (three caller mutations) and
  `campaigns/lifecycle.ts` (the `start_ab_test_if_enabled` effect
  runner — exactly one hit).
- `rg "isSendingAllowed" apps/api/convex/emails.ts` → zero hits in
  `startCampaignSendInternal` (the defense-in-depth re-check is
  gone; the gate now runs once via `validateReadyToSend`).
- `rg "recordAuditLog" apps/api/convex/campaigns` → hits only inside
  `lifecycle.ts` and `abTestLifecycle.ts` (the effect runners). No
  call-site direct logging.

### Done when

- All verification greps return the expected counts.
- `npx vitest run` in `apps/api` is green.
- Scheduling a campaign via the dashboard creates one audit-log row
  (`campaign.scheduled`), fires one PostHog event
  (`campaign_scheduled`), and schedules `startCampaignSendInternal`
  for the chosen time.
- Scheduling the same campaign via the HTTP API does the same — no
  drift between session and HTTP paths.
- Cancelling a scheduled campaign creates one audit-log row
  (`campaign.cancelled`), fires PostHog `campaign_cancelled`, sets
  `cancelledAt`, clears `scheduledAt`.
- Sending a campaign with content that scores `'suspicious'` writes
  the row to `pending_review`, leaves an audit-log trail
  (`campaign.flagged_for_review`), and exposes the
  `pending_review → sending` / `pending_review → draft` edges for the
  future admin-approval surface to call.
- Enabling AB test on a draft campaign and then sending the campaign
  writes both `status: 'sending'` and `abTestStatus: 'testing'` in
  the same Convex mutation (asserted by a single read-after-write
  observing both values).
- Disabling AB test on a draft campaign clears `isABTest`,
  `abTestConfig`, and all six `abVariantBSent..abWinner*` companions
  in one transition.
- Attempting to set `status: 'sent'` via the deleted `updateStats`
  backdoor fails at the validator (the optional arg is gone) and at
  the runtime (no caller can patch status outside the lifecycle).
- Attempting to set `abTestStatus: 'completed'` fails at the schema
  validator.
