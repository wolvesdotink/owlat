# ADR-0046 — execution plan for ADR-0006 (Send completion module)

> Companion execution plan for [ADR-0006](./0006-send-completion-module.md).
> Renumbered from `0006-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the Send completion module ADR. Each phase is one
shippable PR. Existing tests pass at every phase boundary; behavior is
unchanged until the phase that explicitly migrates a wire path.

Pre-prod: no feature flags, no shadow window, no parallel-literal period.
Wire-visible changes (the `email.sent` customer webhook drift bug fix,
the per-campaign `email_sent` contact_activity) land in the phase that
adds the effect — they're additive and don't gate on a flag.

## Order rationale

**Effects before the unification.** The four new sendLifecycle effects
land first, each in its own PR, each replacing the matching imperative
in `onEmailComplete` atomically. Two reasons:

1. Each effect addition is a small, independently-reviewable change
   with a clear deletion target.
2. Once phase 5 unifies the transactional path, *transactional* sends
   start going through `queued → sent` — at which point the effects
   need to already be in place, or transactional sends regress
   (today's inline `email_sent` contact_activity for transactional
   would stop firing without the effect to replace it).

**`email.sent` customer webhook before the unification, not after.** The
drift bug existed pre-ADR; fixing it for campaign sends is independent
of the unification. Transactional joins automatically once phase 5
lands.

**Attachment cleanup last among effects.** It's the only one that
requires a schema change beyond the status union (a new field), so it
ships after the unification — the queue-time creation flow added in
phase 5 is the right home for the new field-write.

**Cleanup last.** Once all effects are wired and the path is unified,
the `CAMPAIGN_ONLY_TARGETS` guard, the
`transactionalSends.createInternal` mutation, and `emailWorkerMutations.
onEmailComplete` collapse together.

---

## Phase 1 — Foundation (no behavior change)

**Changes**

- `apps/api/convex/schema/messaging.ts` (or wherever
  `transactionalSends` is defined): status union gains `'queued'` and
  `'failed'`; new optional `attachmentStorageIds: v.optional(v.array(v.string()))`.
- `apps/api/convex/delivery/sendCompletion.ts` (new file, scaffolded):
  exports `completeSend` internalMutation that today simply delegates
  to the existing `onEmailComplete` logic (a copy). Not yet wired into
  the workpool — the existing callback registration stays. This is a
  *parallel* path, used by tests only.
- `apps/api/convex/delivery/sendLifecycle.ts`: add the four new
  `Effect` variants to the union — `campaign_stats_failed`,
  `contact_activity` with `'email_sent'` activityType,
  `customer_webhook` with `email.sent` literal (already covered by
  existing `customer_webhook` shape), `attachment_cleanup` — with
  matching runner branches in `applyEffects`. No reducer fires them
  yet; the union expansion is type-only until phase 2.
  - For `contact_activity`, extend the `activityType` field to include
    `'email_sent'` (already a valid `contactActivities` literal — see
    ADR-0002 catalog).
- `apps/api/convex/__tests__/factories.ts`: add fixture builders for
  the new effects so per-reducer tests can assert on them.

**Tests**

- `delivery/__tests__/sendLifecycle.test.ts` extended: type-level
  assertions that the effect union now includes the four new kinds.
- `delivery/__tests__/sendCompletion.test.ts` (new, scaffold only):
  smoke test that `completeSend` round-trips a fixture campaign
  completion identically to `onEmailComplete`.

**Done when**

- `tsc -p convex/tsconfig.json` clean.
- Existing tests pass.
- `rg "CAMPAIGN_ONLY_TARGETS"` still returns one hit (`sendLifecycle.ts`).
- `rg "onEmailComplete"` still returns its current hits — no callers
  migrated yet.

---

## Phase 2 — `campaign_stats_failed` effect

**Changes**

- `delivery/sendLifecycle.ts`: `reduceFailed` pushes
  `{kind: 'campaign_stats_failed', campaignId, at}` to its effects
  list (campaign only — guard on `ref.kind === 'campaign'`). Runner
  branch in `applyEffects` increments
  `campaigns.statsFailed`/`statsHardBounced`-equivalent counter
  (matching the existing `recordEmailSendResult` shape exactly).
- `apps/api/convex/emailWorkerMutations.ts`: the inline
  `ctx.runMutation(internal.emailsQueries.recordEmailSendResult, {
  failed: 1 })` call at `onEmailComplete:82–89` is deleted. The
  effect now handles it via the lifecycle.

**Tests**

- `delivery/__tests__/sendLifecycle.test.ts`: a `failed` transition on
  a campaign Send produces a `campaign_stats_failed` effect; the
  runner patches the campaign's failure counter.
- `__tests__/sendFlow.integration.test.ts`: a failed-worker scenario
  ends with the campaign counter incremented identically to before.

**Done when**

- `rg "recordEmailSendResult" apps/api/convex/emailWorkerMutations.ts`
  returns no hits.
- Campaign counters in the integration test match pre-migration
  values exactly.

---

## Phase 3 — `email.sent` customer_webhook effect (drift bug fix)

**Changes**

- `delivery/sendLifecycle.ts`: `reduceSent` pushes
  `{kind: 'customer_webhook', spec: {literal: 'email.sent', input: …}}`
  to its effects list. The input shape is the one already declared by
  the `emailSent` Webhook event module
  (`webhooks/events/emailSent/index.ts`).
  - For campaign Sends, `input.campaignId` is populated from
    `(send as EmailSendDoc).campaignId`.
  - For transactional Sends, today nothing fires (transactional
    bypasses the lifecycle); phase 5 unifies and transactional starts
    firing too.
- No change to `onEmailComplete` — nothing was firing `email.sent`
  before; this is net new wire behavior.

**Tests**

- `delivery/__tests__/sendLifecycle.test.ts`: a `sent` transition on a
  campaign Send schedules a fanout with literal `email.sent` and the
  expected payload shape.
- `webhooks/events/__tests__/registry.test.ts`: smoke that the
  `emailSent` module's `build` produces a payload that satisfies
  `schema` (likely already covered; verify).

**Done when**

- Customers subscribed to `email.sent` receive payloads for campaign
  Sends.
- `rg "scheduleFanout.*email\\.sent"` returns at least one hit in
  `sendLifecycle.ts`.

**Wire-visible** — additive only. No existing customer relied on the
event *not* firing.

---

## Phase 4 — `email_sent` contact_activity effect

**Changes**

- `delivery/sendLifecycle.ts`: `reduceSent` pushes a `contact_activity`
  effect with `activityType: 'email_sent'` when `send.contactId` is
  present.
  - Metadata shape: `{campaignId?, transactionalEmailId?, emailSubject?}`
    matching the existing `email_bounced`/`email_complained` activity
    metadata pattern.
  - For campaign Sends, `emailSubject` is denormalized on
    `emailSends.subject` (verify); for transactional Sends, joined
    from the parent `transactionalEmails` row in the runner.
- `apps/api/convex/emailWorkerMutations.ts`: the inline
  `ctx.db.insert('contactActivities', { activityType: 'email_sent', …
  })` block at `onEmailComplete:108–119` is deleted.
  - Note: until phase 5 unifies the path, transactional `email_sent`
    activity logging stops because:
    - The inline insert is removed in this phase, AND
    - The effect can only fire from a lifecycle transition, AND
    - Transactional bypasses the lifecycle pre-phase-5.
  - **To avoid this regression**, this phase's PR removes the inline
    insert *only after* phase 5 has landed. Two equivalent options:
    1. Ship phase 4 and phase 5 in the same PR (combined).
    2. Keep the inline insert in this phase; remove it in phase 5.
  - Pick (2) for safety: this phase only adds the effect (which fires
    for campaign Sends, net new); phase 5 removes the inline insert
    once transactional goes through the lifecycle.

**Tests**

- `delivery/__tests__/sendLifecycle.test.ts`: `sent` transition with a
  contactId produces a `contact_activity` effect with `email_sent`;
  the runner inserts the row.
- Integration: campaign sends with a contactId produce one
  `email_sent` row per recipient (new behavior; assert it).

**Done when**

- Campaign sends produce `email_sent` contactActivities.
- Inline insert in `onEmailComplete` is unchanged (removed in phase 5).

**Wire-visible** — volume increase on `contactActivities` for
campaign-heavy installs. Flagged in ADR consequences.

---

## Phase 5 — Unify path: pre-create transactional + Send completion module

The structural phase. Everything else either feeds into this or
cleans up after it.

**Changes**

- **Schema:** the `'queued'`/`'failed'` literals added in phase 1
  become live values — the public transactional API mutations start
  writing `'queued'` rows.
- `apps/api/convex/transactionalApi.ts` (and any sibling API entry
  points — verify with `rg "transactionalSends.*insert"` and the
  `processInboundChannel` adjacent inbound paths):
  - Insert a `transactionalSends` row in `'queued'` state with all
    the fields previously passed to `createInternal` (transactional
    email id, recipient, dataVariables, providerType?, correlationId?,
    attachmentStorageIds?). Return the Send id to the API caller.
  - Enqueue the worker with `context: { sendRef: {kind:
    'transactional', id: insertedSendId} }`. The old per-kind
    context fields (`transactionalEmailId`, `email`, `contactId`,
    `dataVariables`, `emailSubject`, `attachmentStorageIds`) drop
    from the context — the row has them now.
- `apps/api/convex/emailsQueries.ts` (or wherever the campaign
  enqueue lives — verify): campaign enqueue updated to pass
  `context: { sendRef: {kind: 'campaign', id: emailSendId} }`.
  Existing per-kind context fields drop.
- `apps/api/convex/delivery/sendCompletion.ts`: real implementation
  lands. The `completeSend` mutation takes
  `{ sendRef, result?, error? }`, builds the matching transition
  input, calls `sendLifecycle.transition`, then calls
  `healthTracker.recordSendResult` if `result?.providerType`. No
  per-kind branching anywhere.
- `apps/api/convex/lib/emailWorkpool.ts`: `emailOnComplete` callback
  now points at `internal.delivery.sendCompletion.completeSend`
  instead of `internal.emailWorkerMutations.onEmailComplete`.
- `apps/api/convex/emailWorkerMutations.ts::onEmailComplete`: deleted
  (or kept as a thin compatibility shim for one PR cycle if needed).
- `apps/api/convex/transactionalSends.ts::createInternal`: deleted.
- `apps/api/convex/emailWorkerMutations.ts`: phase 4's inline
  contact_activity insert is also removed here — the lifecycle effect
  now handles both kinds.

**Tests**

- `delivery/__tests__/sendCompletion.test.ts`: full unit tests for
  `completeSend` per SendRef kind × success/failure outcome (4 cases),
  asserting the right `TransitionInput` is built and provider health
  is recorded with the right args.
- `__tests__/sendFlow.integration.test.ts`: transactional send
  end-to-end test updated — the API returns the Send id immediately,
  the worker transitions it from `queued` to `sent`, the same
  `transactionalSends` row carries all the expected fields.
- Existing campaign integration tests pass unchanged (campaign path
  was always uniform).

**Done when**

- `rg "CAMPAIGN_ONLY_TARGETS"` returns no hits.
- `rg "transactionalSends.createInternal"` returns no hits.
- `rg "onEmailComplete"` returns no hits outside the workpool
  registration (and if the shim was kept, that's removed in phase 7).
- A new transactional send produces: one `queued` row → one `sent`
  row (same id) → one `email_sent` contact_activity → one customer
  `email.sent` webhook fanout.

**Wire-visible** — transactional API surface change (Send id returned
earlier); failed transactional sends start persisting; transactional
sends start firing `email.sent` webhooks.

---

## Phase 6 — `attachment_cleanup` effect

**Changes**

- `delivery/sendLifecycle.ts`: `reduceSent` and `reduceFailed` push
  `{kind: 'attachment_cleanup', storageIds: send.attachmentStorageIds
  ?? []}` when the field is non-empty. Runner branch in `applyEffects`
  loops `ctx.storage.delete(id)` over the list, with `try/catch` per
  id (matching the existing inline behavior).
- `apps/api/convex/emailWorkerMutations.ts` (if any inline cleanup
  remains after phase 5): the `ctx.storage.delete` loop at
  `onEmailComplete:125–133` is removed.
- `apps/api/convex/transactionalApi.ts`: ensures
  `attachmentStorageIds` is written on the `transactionalSends`
  insert at queue time (likely already done in phase 5; verify).

**Tests**

- `delivery/__tests__/sendLifecycle.test.ts`: a `sent` transition on
  a transactional Send with attachments produces an
  `attachment_cleanup` effect; the runner deletes each blob.
- Integration: send-with-attachments end-to-end leaves no orphan
  storage rows.

**Done when**

- `rg "ctx.storage.delete" apps/api/convex/emailWorkerMutations.ts`
  returns no hits.
- Test send-with-attachments fixture leaves the storage table empty
  after completion.

---

## Phase 7 — Cleanup + drift verification

**Changes**

- Delete `emailWorkerMutations.ts` entirely if `onEmailComplete` was
  its only export (the workpool callback registration moved to
  `lib/emailWorkpool.ts` pointing at `sendCompletion.completeSend` in
  phase 5).
- Delete `emailsQueries.recordEmailSendResult` (no callers post-phase-2).
- Remove the historical comment block on
  `transactionalSends.createInternal` (the function is gone, the
  comment about consolidation can stay as a brief note in the
  file-level header).
- Verify the `lib/emailProviders/healthTracker.ts::recordSendResult`
  callers: only `sendCompletion.completeSend` should remain after
  cleanup.

**Verification greps**

- `rg "CAMPAIGN_ONLY_TARGETS"` → 0 hits.
- `rg "onEmailComplete"` → 0 hits (workpool callback uses
  `completeSend`).
- `rg "createInternal" apps/api/convex/transactionalSends.ts` → 0 hits.
- `rg "recordEmailSendResult"` → 0 hits outside the deletion commit's
  diff history.
- `rg "context\\.type === '"` in
  `apps/api/convex/emailWorkerMutations.ts` → file does not exist.
- `rg "context\\.attachmentStorageIds"` → 0 hits (data now lives on
  the Send row).
- `rg "scheduleFanout.*email\\.sent"` → exactly one hit
  (`sendLifecycle.ts:reduceSent`).

**Tests** — Full test suite green; `tsc -p apps/api/convex/tsconfig.json`
clean.

**Done when**

- All verification greps return the expected counts.
- The Send completion (module) vocabulary in CONTEXT.md matches the
  code: one module, one mutation, one workpool entry point, one
  caller of `healthTracker.recordSendResult`.

---

## Phase summary

| Phase | What | Wire-visible risk |
|---|---|---|
| 1 | Foundation: schema literals + new effect kinds + scaffold module | None |
| 2 | `campaign_stats_failed` effect | None (replaces existing imperative; same counter math) |
| 3 | `email.sent` customer_webhook effect | **Drift bug fix** (customers start receiving the event for campaign sends) |
| 4 | `email_sent` contact_activity effect (additive only; inline insert kept for now) | **Volume increase** on campaign-heavy installs (new contactActivities rows) |
| 5 | Unify path: queue-time transactional create + Send completion module + remove phase 4's inline insert | **Public API change** (transactional Send id returned earlier); **failed transactional sends persist**; transactional sends join the `email.sent` and `email_sent` paths |
| 6 | `attachment_cleanup` effect (storage IDs on Send row) | None |
| 7 | Cleanup + drift verification | None |

Estimated 7 PRs.

## Verification checkpoints

- After phase 2: campaign failure counters match pre-migration values
  exactly on a fixture corpus.
- After phase 3: a campaign-send integration test produces a
  byte-identical `email.sent` webhook payload to the
  `webhooks/events/emailSent/index.ts` schema expectation.
- After phase 5: a transactional send produces exactly one
  `transactionalSends` row that walks `queued → sent`; the API
  caller observed the Send id before the worker started.
- After phase 7: `rg "onEmailComplete"` is empty; the workpool
  callback resolves to `sendCompletion.completeSend`; CONTEXT.md
  vocabulary matches the code.
