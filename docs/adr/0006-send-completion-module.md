# Send completion module — unified worker-completion path

**Status:** accepted

## Context

`onEmailComplete` in `apps/api/convex/emailWorkerMutations.ts` is the
*third* producer of **Send** state transitions, alongside the **Webhook
dispatcher** (`webhooks/dispatcher.ts`, ADR-0003) and direct callers of
the **Send lifecycle (module)** (the open/click trackers). It's the only
one of the three without its own module — the workpool-completion path
is open-coded inside the file that registers the workpool callback.

Three structural problems compound.

### Asymmetric Send creation paths

The two Send kinds reach the `sent` state through fundamentally
different routes:

- **Campaign Sends** pre-exist in `queued` (created upstream by
  `emails.ts` / the scheduler before enqueue). `onEmailComplete` calls
  `sendLifecycle.transition({to: 'sent' | 'failed', …})`. Full lifecycle.
- **Transactional Sends** do *not* pre-exist. `onEmailComplete` calls
  `transactionalSends.createInternal` on success, inserting a row
  directly in `'sent'` state. The lifecycle never sees `queued → sent`
  for transactional. Failed transactional sends are dropped entirely
  ("no record is created" — `onEmailComplete:121`).

The asymmetry is documented in code by a guard at
`sendLifecycle.ts:146`:

```ts
// Transactional sends are created in `sent` state by
// `transactionalSends.createInternal`. They never carry `queued` or
// `failed` — both worker-stage states. Reject those targets at the kind
// boundary so the discriminated union doesn't have to fork.
const CAMPAIGN_ONLY_TARGETS: ReadonlySet<TransitionInput['to']> =
  new Set(['sent', 'failed']);
```

This contradicts CONTEXT.md's **Send status** section, which lists
`queued → sent` and `queued → failed` as universal edges for all Sends.
The drift is load-bearing — it cascades into the other two problems.

### Send-completion concerns smeared outside the effect system

Five things happen at Send completion today *outside* the
`sendLifecycle` effect list, four of which are Send-state-driven (i.e.
they would also fire from a webhook-triggered transition once the
asymmetry is fixed):

1. **`campaign_stats_failed` increment** — inline
   `recordEmailSendResult({failed: 1})` call. `campaign_stats_sent`
   *is* an effect; the failure counter is its asymmetric twin.
2. **`email.sent` customer webhook** — drift bug.
   `apps/api/convex/webhooks/events/emailSent/index.ts` defines the
   Webhook event module; customers can subscribe; nobody calls
   `scheduleFanout({literal: 'email.sent', …})` anywhere. The other
   five `email.*` events all fire from `sendLifecycle` reducers.
3. **`email_sent` contact_activity** — inline `ctx.db.insert(
   'contactActivities', { activityType: 'email_sent', … })` for
   transactional only. `email_bounced` and `email_complained` *are*
   effects on the bounced/complained reducers.
4. **Attachment storage cleanup** — inline `ctx.storage.delete` loop
   over `context.attachmentStorageIds`. Transactional-only.
5. **Provider health tracking** — inline
   `healthTracker.recordSendResult({providerType, success, latencyMs})`.
   The only item legitimately outside the lifecycle: webhook-triggered
   transitions report *recipient outcomes* (bounce, complaint), not
   worker-attempt outcomes. `latencyMs` exists only on the worker path.

Items 1–4 are Send-state-driven. Item 5 is worker-attempt-driven. The
current layout treats all five identically (imperative in
`onEmailComplete`), which is the wrong cut.

### "Worker-completion" has no module

The concept doesn't exist in the vocabulary. `onEmailComplete` is named
for its mechanism (workpool callback registration), not its role
(translating a worker outcome into a lifecycle transition). The
**Webhook dispatcher** named the symmetric inbound role — there's no
equivalent on the outbound side.

The deletion test concentrates: deleting `onEmailComplete` reveals the
same logic re-implemented at every future worker-completion site (a
second workpool, a direct-send path, a janitor that retries
stuck-`queued` rows). One module, named for the role, removes that
duplication before it lands.

## Decision

Four moves, settled in the grilling conversation that produced this
ADR.

### 1. Pre-create transactional Sends in `queued`

The transactional API mutation (`transactionalApi.send` and friends)
inserts the `transactionalSends` row in `'queued'` state *before*
enqueueing the worker. The Send id is returned to the API caller
immediately. The workpool's context carries a typed
`sendRef: SendRef` — uniform across kinds.

The `CAMPAIGN_ONLY_TARGETS` guard is deleted. The comment on
`transactionalSends.createInternal` ("created in `sent` state") becomes
historical and the function is reshaped or removed in cleanup
(callers go through queue-time creation).

This unblocks a future scheduled-transactional feature: scheduled sends
*need* a row to exist before dispatch — α makes that natural rather
than requiring a parallel data path.

### 2. Expand the sendLifecycle effect list

Four new effect kinds. Each replaces an imperative that lives in
`onEmailComplete` today:

| Effect | Fires on | Replaces |
|---|---|---|
| `campaign_stats_failed` | `failed` reducer (campaign only) | `recordEmailSendResult({failed:1})` |
| `contact_activity` with `email_sent` | `sent` reducer | inline `ctx.db.insert('contactActivities', …)` |
| `customer_webhook` with `email.sent` literal | `sent` reducer | nothing — closes drift bug |
| `attachment_cleanup` | `sent` and `failed` reducers (terminal worker outcomes) | inline `ctx.storage.delete` loop |

Attachment storage IDs move from the workpool callback context to the
`transactionalSends` row (`attachmentStorageIds?: string[]`, written
at queue time). The Send row is now the truth about all data tied to a
single dispatch attempt; the cleanup effect reads from the row.

Provider health stays outside. See §4 below.

### 3. New module — Send completion

`apps/api/convex/delivery/sendCompletion.ts` — the **Send completion
(module)**. Owns the workpool `onComplete` path:

```ts
export const completeSend = internalMutation({
  args: { sendRef, result?, error? },
  handler: async (ctx, { sendRef, result, error }) => {
    const transition = buildTransition(result, error);
    const outcome = await ctx.runMutation(
      internal.delivery.sendLifecycle.transition,
      { send: sendRef, transition }
    );
    if (result?.providerType) {
      await recordProviderHealth(ctx, {
        providerType: result.providerType,
        success: result.success,
        latencyMs: result.sendLatencyMs ?? 0,
      });
    }
    return outcome;
  },
});
```

The workpool callback registration in `lib/emailWorkpool.ts` now
points at `completeSend` directly. `emailWorkerMutations.ts` either
becomes empty (callback registration moves) or shrinks to a one-line
re-export.

### 4. Provider health stays in the orchestration module

Provider health answers *"did this provider's API accept the send?"* —
a worker-attempt concern. Webhooks fire about *recipient outcomes*
(bounced, complained); a webhook-triggered transition has no
`latencyMs` to record and recording another "success" against the
provider would double-count (the worker already recorded the attempt).
The two concerns are temporally distinct: provider health is "did the
HTTP call succeed?", lifecycle effects are "what happens to the Send
state?". Keep them apart.

The cost: a tiny adapter in `sendCompletion` per recorded outcome
(one `recordSendResult` call). The win: the lifecycle effect list
stays Send-state-driven and never grows arguments only the workpool
can supply.

## Considered options

### 1. Send-creation asymmetry

1. **Pre-create transactional in `queued`** *(chosen — α)*. Unblocks
   scheduled transactional. Failed transactional sends start being
   tracked (feature, not regression). Schema migration is small (add
   `queued` and `failed` to the transactional status union). Aligns
   the code with CONTEXT.md as already written.
2. **Keep asymmetry; module forks on shape**. Orchestration module
   has two entry shapes: `completeCampaignSend(sendRef, result)` vs
   `completeTransactionalSend(args, result)`. The first calls
   `sendLifecycle.transition`; the second calls
   `transactionalSends.createInternal` on success. Persists the
   structural difference; `email.sent` drift bug stays unfixed for
   transactional; future scheduled transactional needs a third path.
   Rejected.
3. **Hybrid: queue only with contact**. Transactional sends with a
   `contactId` pre-create in `queued`; sends without stay
   create-on-success. Two paths but principled split.
   Half-symmetric; more decision logic to remember; doesn't actually
   simplify because the orchestration module still needs both
   shapes. Rejected.

### 2. Effect-list scope

1. **Push Send-state-driven concerns into effects** *(chosen)*. Four
   new effect kinds; provider health stays out.
2. **Add provider health as effect too**. Requires `latencyMs?` on
   `sent`/`failed` transitions; webhook callers pass `undefined`.
   Lifecycle effect list gains an arg only one producer can supply.
   Conflates worker-attempt with recipient-outcome. Rejected.
3. **Keep all five in orchestration**. Smallest change to the
   lifecycle; leaves the drift bug in place (`email.sent` never
   fires) and keeps `campaign_stats_failed` as a stray that future
   webhook-triggered failure transitions will silently miss.
   Rejected.

### 3. Attachment cleanup home

1. **Store IDs on Send row, fire effect** *(chosen)*. Schema add
   (`attachmentStorageIds?: string[]` on `transactionalSends`).
   Cleanup transactional with the lifecycle. A future janitor cron
   for stuck-`queued` rows reads from the same data location.
2. **Keep in orchestration module**. Workpool result still carries
   `attachmentStorageIds`; orchestration loops `ctx.storage.delete`
   after transition. No schema change but the Send row stops being
   the truth about dispatch data — the workpool's context becomes a
   parallel data path. Rejected.
3. **Deferred cleanup task**. Schedule a 24h-deferred cleanup at
   queue time, decoupled from completion. Adds infrastructure (one
   scheduled mutation per send); at scale that's many no-op
   wake-ups. Decoupling is a non-goal here — cleanup wants to be
   *atomic* with the transition, not deferred from it. Rejected.

### 4. Module naming

1. **Send completion (module) at `delivery/sendCompletion.ts`**
   *(chosen)*. Reads as "what happens when a Send dispatch attempt
   resolves." Sibling of **Send lifecycle (module)** and **Send reads
   (module)**.
2. **Send dispatcher (module)**. Symmetric with Webhook dispatcher in
   name, but collides — the webhook dispatcher routes events, this
   routes worker results. Two "dispatchers" in `delivery/` and
   `webhooks/` would invite re-litigation. Rejected.
3. **Send worker bridge**. Explicit but couples the name to one
   workpool implementation; a future direct-send path would make
   the name lie. Rejected.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/emailWorkerMutations.ts` shrinks from 216 LOC to
  either an empty stub or a one-line re-export of `completeSend`. The
  `onEmailComplete` mutation — 147 LOC of per-kind branching,
  imperative effect dispatch, attachment cleanup, and contact-activity
  inserts — is gone.
- The `CAMPAIGN_ONLY_TARGETS` guard at `sendLifecycle.ts:146` and the
  surrounding comment are deleted. The `dispatch` function's
  invalid_for_kind check loses one of its two cases.
- `transactionalSends.createInternal` is reshaped or removed:
  callers (the public transactional API) now insert in `queued`
  state at queue time. The "Status writes consolidated into
  sendLifecycle" comment block stays (it's still true).
- `emailsQueries.recordEmailSendResult` loses its only caller and
  becomes dead code, deleted in cleanup.

### Files that grow

- `apps/api/convex/delivery/sendCompletion.ts` (new, ~80 LOC).
- `apps/api/convex/delivery/sendLifecycle.ts` grows four new
  `Effect` variants and four corresponding runner branches in
  `applyEffects`. The `sent` reducer's effect list expands from
  `[campaign_stats_sent]` to
  `[campaign_stats_sent, contact_activity(email_sent), customer_webhook(email.sent), attachment_cleanup?]`.
- `apps/api/convex/transactionalApi.ts` (and any sibling API
  handlers) gain a queue-time `ctx.db.insert('transactionalSends',
  {status: 'queued', attachmentStorageIds, …})` step before
  enqueueing.
- `apps/api/convex/schema/messaging.ts` (or wherever
  `transactionalSends` is defined): status union gains `'queued'`
  and `'failed'`; new optional `attachmentStorageIds: v.array(v.string())`.

### Schema migration (pre-prod, breaking)

- `transactionalSends.status`: union gains `'queued'` and `'failed'`.
  Existing rows live in `'sent'/'delivered'/'opened'/…` — no
  rewriting needed.
- `transactionalSends.attachmentStorageIds`: new optional field;
  null on existing rows; populated for new rows that carry
  attachments.
- No migration mutation required for the status change (existing
  literals stay valid). The `attachmentStorageIds` field is
  schema-only.
- The old `transactionalSends.createInternal` mutation is removed —
  no readers depend on its specific shape.

### Wire / behavior changes

- **Public transactional API surface.** The API mutation that
  accepts a transactional send request now returns the Send id
  *immediately* (after the queue-time insert), rather than later
  (after the worker succeeds). Customers can track Sends before
  dispatch — strictly additive.
- **Failed transactional sends persist.** Today: dropped entirely.
  Post-α: appear as `failed` rows in the transactional sends
  dashboard. Feature, not regression.
- **`email.sent` customer webhook starts firing.** Closes the drift
  bug. Customers subscribed to `email.sent` start receiving events
  for the first time. Strictly additive — no existing customer
  relied on it not firing.
- **Campaign sends emit `email_sent` contact_activity.** Today only
  transactional sends emit this activity (and only inline). Post-α
  both kinds emit via the effect. Per-recipient row count in
  `contactActivities` increases for campaign sends; for high-volume
  installs this is the largest behavior delta. Mitigations
  (toggle-per-campaign, aggregate, retention policy) are deferred
  follow-ups — the contact-history view is materially incomplete
  without the activity, so the volume cost is the right trade.

### Test surface

- Per-effect unit tests in `delivery/__tests__/sendLifecycle.test.ts`
  for each new effect's reducer path (assert the effect appears in
  `result.effects`) and runner branch (assert `applyEffects`
  performs the right write).
- `delivery/__tests__/sendCompletion.test.ts` — unit tests for
  `completeSend` per SendRef kind, per success/failure outcome.
  Asserts the right `TransitionInput` is built and provider health
  is recorded.
- Integration tests in `__tests__/sendFlow.integration.test.ts` and
  `__tests__/sendLifecycle.integration.test.ts` stay; their fixture
  shape changes (transactional sends now start in `queued`).

### Vocabulary

CONTEXT.md updated inline during the grilling session:

- **Send lifecycle (module)** entry — effect list expanded to 10
  effects; three producers of transition calls named.
- **Send completion (module)** — new entry. Names the workpool →
  SendRef + transition role; symmetric to **Webhook dispatcher**.
- **Relationships** section — uniform `queued` start for both Send
  kinds; three transition producers documented.

The drift between CONTEXT.md's `queued → sent` claim and the
code's `CAMPAIGN_ONLY_TARGETS` guard is closed in the direction of
CONTEXT.md (the doc was right, the code was wrong).

## Follow-up work

1. **Stuck-`queued` janitor cron.** Pre-α this never mattered
   (transactional sends couldn't be stuck — they didn't exist
   pre-completion). Post-α a transactional Send can stick in
   `queued` if the worker dies before calling `completeSend`. A
   periodic sweep marks rows older than N hours as `failed`
   (triggering `attachment_cleanup` and `campaign_stats_failed`
   effects via the lifecycle). Out of scope here; tracked as the
   first natural follow-up.
2. **Scheduled transactional sends.** α makes this trivial — the
   API mutation accepts a `scheduleAt?` field, inserts the row in
   `queued` with `scheduledFor: scheduleAt`, and the worker dequeues
   after that time. No new architecture; a feature on top.
3. **Volume controls on `email_sent` contact_activity.** If
   contact-activity volume becomes a problem on high-volume
   installs, add a per-campaign opt-out, an aggregation pass, or a
   retention policy. Defer until measured.
4. **Postbox parallel.** Postbox dispatches *synchronously* per
   recipient (`mail/outbound.ts`); there is no workpool callback
   and no parallel "Postbox completion" module to extract. The
   Postbox outbound lifecycle's writers are the synchronous
   dispatcher itself and the MTA webhook path — both already named.
   Documented here to prevent re-suggestion in future architecture
   reviews.

## Execution

See `docs/adr/0046-execution-plan.md`.
