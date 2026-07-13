# Mail draft lifecycle module — single writer of `mailDrafts.state`, closing the storage leak and audit gap on personal-mail sends

**Status:** accepted

## Context

`mailDrafts.state` is a real state machine — three literals, four
revert reasons, one terminal-by-delete branch with a six-table effect
sequence — and the conspicuous absentee from the lifecycle deepening
ADRs 0006/0009/0010/0011/0017/0018/0022/0024. ADR-0024 framed
`automations.status` as "the last untyped state machine"; that framing
silently excluded `mailDrafts.state` because the row's terminal is a
*delete* rather than a status literal, so it didn't show up in the
"row-status writer" pattern-match. The drift signatures are otherwise
identical to every prior lifecycle deepening.

Beyond the missing lifecycle shape, the surface carries three distinct
drift bugs that are visible in the code today and that the deepening
will close as part of the same edit.

### Writer landscape — `mailDrafts.state`

| Producer | Path | Transition | Audit log | Effects |
|---|---|---|---|---|
| `drafts.create` | `mail/drafts.ts:44` | `(insert) → draft` | ❌ | none |
| `drafts.update` (and `setIdentity`, attachment ops) | `mail/drafts.ts:106,140,261` | guards `state !== 'draft'` | n/a | (field edit, not transition) |
| `drafts.send` | `mail/drafts.ts:250` | `draft → pending_send` / `→ scheduled` | ❌ **drift** | inline `scheduler.runAt` |
| `drafts.cancelPendingSend` | `mail/drafts.ts:291` | `pending_send | scheduled → draft` | ❌ **drift** | inline patch (clear `scheduledSendAt` / `undoToken`) |
| `drafts.markDispatching` (dead) | `mail/drafts.ts:322` | **zero callers**, body sets `state: 'draft'` | n/a | n/a |
| `drafts.deleteAfterSend` | `mail/drafts.ts:334` | terminal (deletes row) | ❌ **drift** | row delete; no audit |
| `outboundQueries.claimForDispatch` | `mail/outboundQueries.ts:47` | (validates only; reverts on from-address mismatch) | ❌ **drift** | inline patch on revert (`state: 'draft'`, clear scheduled fields) |
| `outboundQueries.markDispatchFailed` | `mail/outboundQueries.ts:87` | revert on ClamAV malware | ❌ **drift** | inline patch (`state: 'draft'`, clear scheduled fields) |
| `outbound.dispatchDraft` | `mail/outbound.ts:276` | calls claim + writeSentMessage + deleteAfterSend | ❌ **drift** | calls `writeSentMessage` (6-table dance) + `internalRecordRecipients` + `deleteAfterSend` |
| `outboundQueries.writeSentMessage` | `mail/outboundQueries.ts:102` | terminal effect set | ❌ **drift** | 6 patches (see below) |

Nine producers across four files for one state column. Six distinct
drift signals.

### 1. Silent attachment-storage leak on send-success

```ts
// drafts.ts:207-219 — `discard`: properly frees the blobs
for (const att of draft.attachments) {
  await ctx.storage.delete(att.storageId);
}
await ctx.db.delete(args.draftId);

// outboundQueries.ts:102-282 — `writeSentMessage`: does NOT free blobs
// drafts.ts:334-340 — `deleteAfterSend`: only deletes the row
```

The `mailMessages.attachments` array shape (`outboundQueries.ts:118-128`)
carries `{ filename, contentType, size, contentId, partIndex }` — no
`storageId`. The raw `.eml` is freshly stored in `rawStorageId` at
`outbound.ts:372-376` (containing the attachment bytes embedded in
MIME), so the original storage blobs from the draft become unreferenced
after `deleteAfterSend`. The `discard` path correctly cleans them up;
the happy path leaks every blob.

Convex storage charges per stored byte. For an active mailbox sending
attachments over time, this is potentially gigabytes of orphaned
storage. Same drift signature as the storage-blob orphan bug ADR-0025
closed for the organization-deletion path.

### 2. Zero audit-log coverage on any Mail-draft transition

`auditActions/catalog.ts` declares actions for every other lifecycle
that touches user-visible state: `campaign.scheduled`,
`sending_domain.verified`, `doi.confirmed`, `inbound.draft_approved`,
`postbox_outbound_transition`, `abuse_status_changed`,
`email_template.published`, `automation.activated`. There is no
`postbox_draft.*` action declared and no `recordAuditLog` call in any
of the four state-mutating mutations (`send`, `cancelPendingSend`,
`claimForDispatch` revert, `markDispatchFailed`).

A platform admin investigating "who sent this email at 3am" finds the
`mailMessages` row in Sent but no trail of the draft → send transition
that produced it. The from-address revocation and scan-blocked reverts
are completely invisible — the row simply reappears in the user's
Drafts folder with no explanation.

Same silent-drift pattern that ADR-0011 closed for `abuseStatus` writes
and ADR-0017 closed for ten Campaign-status transitions.

### 3. Dead code with a misleading name

```ts
// drafts.ts:322-332
export const markDispatching = internalMutation({
  args: { draftId: v.id('mailDrafts') },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return null;
    // Only proceed if still pending_send/scheduled (i.e. wasn't cancelled).
    if (draft.state !== 'pending_send' && draft.state !== 'scheduled') return null;
    await ctx.db.patch(args.draftId, { state: 'draft', lastEditedAt: Date.now() });
    //                                  ^^^^^^^^^^^^^^ — note the literal
    return draft;
  },
});
```

Zero callers anywhere in the codebase. The name suggests it claims the
draft for dispatch, but the body reverts the state to `'draft'`. This
is an aborted refactor — a function pre-staged for a `dispatching`
state literal that never landed in the schema. The comment on
`outboundQueries.ts:40` ("Atomic claim: transition pending_send/
scheduled → dispatching") mirrors the same fiction. The actual
production `claimForDispatch` *validates* the draft and returns it
unchanged on success — never writing `'dispatching'` because that
literal does not exist.

### 4. Inline reverts that should be transitions

`claimForDispatch` does the from-address binding check inline. On
mismatch, it patches the row back to `'draft'` directly
(`outboundQueries.ts:60-67`). `markDispatchFailed` does the same on
ClamAV malware verdict (`outboundQueries.ts:93-98`). Both are silent —
no audit log, no callback to surface the revert reason to the user.

Same drift the **Send lifecycle (module)** (ADR-0006) closed by routing
every status patch through one reducer with typed `reason` outcomes.

### 5. Open-coded `state !== 'X'` guards across six call sites

`drafts.ts:106, 140, 261, 301, 328` and `outboundQueries.ts:53` each
write their own `state !== 'draft'` (or `state !== 'pending_send' &&
state !== 'scheduled'`) check. Each throws or returns a different
shape: some throw, some return `null`, some return `{ ok: false }`.

Same drift the **Mailbox gate (helper)** (ADR-0023) closed for the
eleven duplicate `loadOwnedMailbox` declarations across the `mail/*`
files.

### 6. Six-table dance inline in `writeSentMessage`

`outboundQueries.ts:102-282` is one 180-line internalMutation that:
1. Inserts the new `mailMessages` row in `outbound.state: 'queued'`
2. Patches `recipients[]` with deterministic `pb-<id>-<idx>` mtaJobIds
3. Patches the Sent folder (`uidNext`, `highestModseq`, `totalCount`)
4. Inserts or patches the thread (`messageCount`, `lastMessageAt`,
   `latestSnippet`, etc.)
5. Patches the in-reply-to message (`flagAnswered: true`) when set
6. Patches the mailbox (`usedBytes += rawSize`)

Six table writes in one mutation, no typed effect list, no isolated
test surface. To test "does send-success update the Sent folder
counters?" you mount the full integration harness, dispatch a draft
end-to-end, and grep the resulting Convex state. Mirrors the open-
coded `writeXResult` shells ADR-0006 (Send lifecycle) and ADR-0017
(Campaign lifecycle) replaced with typed effect lists.

### Shared framing

Per LANGUAGE.md's deletion test: deleting `outboundQueries.ts:
markDispatchFailed`, `outboundQueries.ts:claimForDispatch`'s revert
branch, `drafts.ts:markDispatching`, `drafts.ts:deleteAfterSend`, and
inlining their bodies at the call sites reveals five distinct
locations writing the same state column with subtly different
contracts (different revert reasons, different audit posture, one
deleting the row, one leaking storage). The complexity is real — it
concentrates into a state machine — but it currently lives nowhere.

The interface is the test surface: pre-deepening, the only way to test
"what happens when ClamAV verdicts malware mid-dispatch?" is the
integration test at `__tests__/postboxAttachmentScan.integration.test.ts`.
Post-deepening, the same scenario is unit-testable as a single
`transition({ to: 'draft', reason: 'scan_blocked' })` call against a
stub `ctx`.

Confidence: high. Pattern mirrors ADR-0012 (sibling lifecycle on the
adjacent `mailMessages.outbound.state` column), ADR-0006 (typed
TransitionInput + LEGAL_EDGES + reducer + effects on a row's status),
ADR-0009 (`transitionBy<external-key>` mirror for the
`cancelPendingSend` token path). No new architectural ground.

## Decision

One new module, one new module-helper, three CONTEXT.md entries
already landed inline with the grilling, four files reshaped (no
schema change), one dead mutation deleted.

### New module: Mail draft lifecycle (module)

```
convex/mail/draftLifecycle.ts
```

Three entry points — `create`, `transition`, `transitionByUndoToken`.
Sole writer of `mailDrafts.state`, `scheduledSendAt`, and `undoToken`.
Sole writer of the multi-table send-success cascade (was
`writeSentMessage`).

```ts
// convex/mail/draftLifecycle.ts (sketch)

export type DraftState = 'draft' | 'pending_send' | 'scheduled';

export type RevertReason = 'user_cancel' | 'from_revoked' | 'scan_blocked';

export type TransitionInput =
  | { to: 'pending_send'; undoSendDelayMs?: number }
  | { to: 'scheduled'; scheduledSendAt: number }
  | { to: 'draft'; reason: RevertReason }
  | { to: 'sent' };  // terminal — row is deleted, mailMessages row inserted

export type TransitionOutcome =
  | { ok: true; applied: boolean }
  | { ok: false; reason:
      | 'draft_not_found'
      | 'illegal_edge'
      | 'no_recipients'
      | 'from_revoked'         // re-checked inside the `→ sent` reducer
      | 'undo_token_mismatch'  // transitionByUndoToken only
      | 'already_draft'        // transitionByUndoToken idempotent
    };

const LEGAL_EDGES: Record<DraftState, ReadonlySet<TransitionInput['to']>> = {
  draft:        new Set(['pending_send', 'scheduled']),
  pending_send: new Set(['draft', 'sent']),
  scheduled:    new Set(['draft', 'sent']),
};

export const create = internalMutation({ /* inserts at 'draft' */ });
export const transition = internalMutation({ /* see Effects below */ });
export const transitionByUndoToken = internalMutation({
  /* looks up via by_undo_token index; refuses input.to !== 'draft' */
});
export function assertStateIs(draft: Doc<'mailDrafts'>, state: DraftState): void {
  if (draft.state !== state) {
    throw new Error(`Draft state is ${draft.state}, expected ${state}`);
  }
}
```

### Effects per transition kind

`→ pending_send` / `→ scheduled`:
- `schedule_dispatch_action({ draftId, undoToken, sendAt })` —
  schedules `internal.mail.outbound.dispatchDraft`. Replaces the
  inline `scheduler.runAt` in `drafts.send`.
- `audit_log('postbox_draft.send_initiated', mailboxId, draftId,
  { sendAt, undoSendDelayMs? })`.

`→ draft` (revert):
- `audit_log` — literal picked by `reason`:
  - `user_cancel` → `'postbox_draft.cancelled'`
  - `from_revoked` → `'postbox_draft.from_revoked'`
  - `scan_blocked` → `'postbox_draft.scan_blocked'`
  - `seal_consent_required` → `'postbox_draft.seal_consent_required'`

The previously-scheduled dispatch hop becomes a no-op when it later
runs — the claim-side `transition({ to: 'sent' })` returns
`illegal_edge` against `state === 'draft'`.

`→ sent` (terminal, deletes the draft row):
- `insert_mail_message({ draftRow, sentFolderId, rawStorageId,
  rawSize, rfc822MessageId, references, inReplyToHeaderValue })` —
  writes the new `mailMessages` row in `outbound.state: 'queued'`
  with the deduplicated `recipients[]` array carrying the
  deterministic `pb-<id>-<idx>` mtaJobIds.
- `patch_sent_folder({ folderId, uidNext: prev+1, modseq: prev+1,
  totalCount: prev+1 })`.
- `patch_thread({ threadId, lastMessageAt, latestSnippet,
  latestFromAddress, latestSubject, folderRoles+, messageCount+,
  hasAttachments? })`. Inserts the thread row if absent.
- `patch_in_reply_to_flag({ messageId, flagAnswered: true })` —
  conditional on `inReplyToMessageId`.
- `patch_mailbox_bytes({ mailboxId, deltaBytes: +rawSize })`.
- `delete_attachment_storage({ storageIds })` — frees the draft's
  attachment blobs. **Closes drift bug #1.**
- `record_recipients_in_address_book({ mailboxId, emails })` —
  intent-based: fires regardless of per-recipient MTA POST outcome.
  Replaces the inline `internalRecordRecipients` call in
  `outbound.dispatchDraft:499`.
- `delete_draft_row({ draftId })` — terminal.
- `audit_log('postbox_draft.sent', mailboxId, draftId,
  { messageId, recipientCount, rawSize })`.

Effect order matters: `insert_mail_message` runs first (so the new
`messageId` is available for `record_recipients_in_address_book`'s
follow-up read), and `delete_draft_row` runs last (so a crash mid-
sequence leaves the draft intact for retry rather than a half-applied
send with no draft to recover from).

### Invariants

- The `→ sent` reducer re-runs the from-address binding check inside
  the reducer (not as an effect) — if the address is no longer in the
  allowed set, the kind is rejected with
  `outcome: { ok: false, reason: 'from_revoked' }`. The caller (the
  dispatch action) must instead call `transition({ to: 'draft',
  reason: 'from_revoked' })` to trigger the revert path. The reducer
  never silently downgrades a transition kind.
- `transitionByUndoToken` skips entries whose `state` is `'draft'`
  with `outcome: { ok: false, reason: 'already_draft' }` — idempotent
  on double-click of the undo button.
- The `→ pending_send` reducer refuses when `toAddresses.length === 0`
  with `outcome: { ok: false, reason: 'no_recipients' }`. Closes the
  same check at `drafts.ts:262` that currently throws.
- `lastEditedAt` is bumped on every transition.

### Producers of transition calls (post-deepening)

| Producer | Path | Call |
|---|---|---|
| `drafts.send` mutation | `mail/drafts.ts` | `transition({ to: 'pending_send' \| 'scheduled', ... })` |
| `drafts.cancelPendingSend` mutation | `mail/drafts.ts` | `transitionByUndoToken({ undoToken, input: { to: 'draft', reason: 'user_cancel' }})` |
| `outbound.dispatchDraft` action — from-address mismatch | `mail/outbound.ts` | `transition({ to: 'draft', reason: 'from_revoked' })` |
| `outbound.dispatchDraft` action — ClamAV malware | `mail/outbound.ts` | `transition({ to: 'draft', reason: 'scan_blocked' })` |
| `outbound.dispatchDraft` action — happy path | `mail/outbound.ts` | `transition({ to: 'sent' })` |
| `outboundCron.dispatchOverdueDrafts` | `mail/outboundCron.ts` | reschedules the dispatch hop (no transition; the action itself calls `transition({ to: 'sent' })` or revert) |

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `mail/drafts.ts:250-285` `send` | inline state patch + scheduler.runAt | `transition({ to: 'pending_send' \| 'scheduled', ... })` |
| `mail/drafts.ts:291-313` `cancelPendingSend` | inline state patch | `transitionByUndoToken({ undoToken, input: { to: 'draft', reason: 'user_cancel' }})` |
| `mail/drafts.ts:322-332` `markDispatching` | dead code with misleading name | Deleted outright |
| `mail/drafts.ts:334-340` `deleteAfterSend` | inline row delete | Subsumed into `delete_draft_row` effect |
| `mail/outboundQueries.ts:47-74` `claimForDispatch` | validation + inline revert on from-address mismatch | Replaced by the dispatch action calling `transition({ to: 'sent' })`; on `from_revoked` outcome the action calls `transition({ to: 'draft', reason: 'from_revoked' })` |
| `mail/outboundQueries.ts:87-100` `markDispatchFailed` | inline revert patch | `transition({ to: 'draft', reason: 'scan_blocked' })` |
| `mail/outboundQueries.ts:102-282` `writeSentMessage` | 180-line 6-table mutation | The `→ sent` reducer's effect list (each effect is its own runner) |
| Six `state !== 'X'` open-coded guards across `drafts.ts` + `outboundQueries.ts` | inline throws / null returns / `{ok:false}` shapes | `assertStateIs(draft, 'draft')` helper exported from the lifecycle module |

### Closes drift bugs

1. **Silent attachment-storage leak on send-success** — closed by the
   `delete_attachment_storage` effect on `→ sent`. The previously
   orphaned blobs are now freed atomically with the row delete (drift #1).
2. **Zero audit-log coverage** — every transition fires an
   `audit_log` effect with a typed literal. Five new audit actions
   added to `auditActions/catalog.ts`: `postbox_draft.send_initiated`,
   `postbox_draft.sent`, `postbox_draft.cancelled`,
   `postbox_draft.from_revoked`, `postbox_draft.scan_blocked` (drift #2).
3. **Dead `markDispatching` mutation** — deleted (drift #3).
4. **Misleading comments in `claimForDispatch`** — the "Atomic
   claim: transition pending_send/scheduled → dispatching" comment is
   removed alongside its dead-code companion (drift #3).
5. **Inline reverts in `claimForDispatch` and `markDispatchFailed`** —
   become typed `transition` calls, surfacing the revert reason in
   audit logs (drift #4).
6. **Six open-coded `state !== 'X'` guards** — replaced by one
   exported `assertStateIs` helper (drift #5).
7. **Six-table dance inline in `writeSentMessage`** — collapses into
   the `→ sent` reducer's typed effect list. Each effect is its own
   runner with its own test surface (drift #6).

### Tests

Three new test surfaces, one migration:

1. **Per-transition unit tests** at
   `mail/__tests__/draftLifecycle.test.ts`. Each transition kind has
   its own describe block — `to: 'pending_send'`, `to: 'scheduled'`,
   `to: 'draft' x 3 reasons`, `to: 'sent'`. Assertions are against the
   `TransitionOutcome` shape and the typed effect list. No Convex
   integration harness required for the bulk of cases — only the
   `→ sent` reducer's invariant re-check needs a stub `ctx` for the
   `resolveAllowedFromAddressesForCtx` call.
2. **Storage-leak regression test** at the same file — asserts the
   `→ sent` effect list contains `delete_attachment_storage` with the
   correct storage IDs. Catches the silent leak if it ever recurs.
3. **`transitionByUndoToken` idempotency test** — asserts double-fire
   on the same token (e.g. user clicks undo twice rapidly) returns
   `already_draft` rather than throwing or re-firing the audit log.
4. **Existing integration tests migrate**:
   - `__tests__/postboxFromBinding.integration.test.ts` — four call
     sites update from `internal.mail.outboundQueries.claimForDispatch`
     to the new flow (the dispatch action calls
     `transition({ to: 'sent' })`; assertions move to the
     `from_revoked` outcome path).
   - `__tests__/postboxAttachmentScan.integration.test.ts` — two
     call sites update from
     `internal.mail.outboundQueries.markDispatchFailed` to
     `internal.mail.draftLifecycle.transition` with
     `{ to: 'draft', reason: 'scan_blocked' }`.

### Caller migration

| Old surface | New surface | Sites |
|---|---|---|
| `internal.mail.outboundQueries.claimForDispatch` | (deleted; dispatch action calls `internal.mail.draftLifecycle.transition` with `{ to: 'sent' }`) | 1 production (`mail/outbound.ts:281`) + 4 tests |
| `internal.mail.outboundQueries.markDispatchFailed` | `internal.mail.draftLifecycle.transition` with `{ to: 'draft', reason: 'scan_blocked' }` | 1 production (`mail/outbound.ts:323`) + 2 tests |
| `internal.mail.drafts.markDispatching` | (deleted; zero callers) | 0 |
| `internal.mail.drafts.deleteAfterSend` | (subsumed into `delete_draft_row` effect; the dispatch action no longer calls it) | 1 production (`mail/outbound.ts:505`) |
| `internal.mail.outboundQueries.writeSentMessage` | (subsumed into the `→ sent` reducer's effects; the dispatch action no longer calls it directly) | 1 production (`mail/outbound.ts:379`) |
| `internal.mail.outboundQueries.getMessage` | (unchanged — used for threading header lookup, not lifecycle) | 1 production (`mail/outbound.ts:343`) |
| Public `api.mail.drafts.send` | (unchanged signature) — body delegates to lifecycle | 1 frontend caller |
| Public `api.mail.drafts.cancelPendingSend` | (unchanged signature) — body delegates to lifecycle | 1 frontend caller |
| Public `api.mail.drafts.create`, `.update`, `.setIdentity`, `.addAttachment`, `.removeAttachment`, `.discard`, `.get`, `.listForMailbox` | (unchanged) | unchanged |

No frontend changes. No schema change. No data migration.

### Out of scope for this ADR

- **Per-mailbox UI notification on revert.** Today the user discovers
  a revert by finding the draft back in Drafts with no message. A
  notification surface (toast, in-app banner, etc.) would consume the
  new audit-log rows but the notification system itself doesn't
  exist yet. Lands in a follow-up alongside the surface.
- **The `audit_log` rows on Postbox-side personal-mail transitions**
  showing up in the org-level platform-admin audit log surface. The
  rows are written; the surface filter to display them as a separate
  "Postbox activity" tab is deferred.
- **Per-recipient address-book scoring.** The
  `record_recipients_in_address_book` effect currently writes every
  recipient flat; a follow-up could weight by frequency, last-sent,
  etc. Out of scope here.
- **The Postbox outbound lifecycle is unchanged.** This ADR covers
  the lifecycle that ends where ADR-0012's begins. The handoff is
  one effect (`insert_mail_message`) writing the new row in
  `outbound.state: 'queued'`; the Postbox outbound lifecycle picks
  up from there.

## Consequences

**Closes the implicit "last untyped state machine" gap from
ADR-0024.** That ADR named `automations.status` as the last one, but
`mailDrafts.state` was hiding behind the terminal-by-delete pattern.
After this lands, every row in the codebase with state literals is
owned by a typed lifecycle module.

**Surface area:** modest reduction. `mail/drafts.ts` shrinks from
341 LOC to ~270 LOC (removing the six guard branches, `send` body,
`cancelPendingSend` body, dead `markDispatching`, `deleteAfterSend`).
`mail/outboundQueries.ts` shrinks from ~100 LOC to ~30 LOC (only
`getMessage` survives; the two reverts and `writeSentMessage` move to
the lifecycle's effect runners). New file `mail/draftLifecycle.ts`
~250 LOC (lifecycle skeleton + reducers + effect runners). Plus
~200 LOC of new test coverage where there was effectively none at
the per-transition level. Net: roughly flat production LOC, +200 LOC
of test coverage, six drift bugs closed.

**One re-tightened invariant:** the singleton `mailDrafts.state`
column has exactly *one* writer module — the **Mail draft lifecycle
(module)**. Future writers of new state-affecting fields (e.g. a
`pending_review` literal for an admin-gated personal-mail send
feature) choose: extend the lifecycle if the concern fits its
transition shape, or define a new module if not. They do not append
to `drafts.ts` or `outboundQueries.ts`.

**Migration:** one PR. Schema unchanged. No data backfill. Cutover:
1. New `mail/draftLifecycle.ts` file added with full bodies.
2. Old internal mutations deleted from `drafts.ts` and
   `outboundQueries.ts`. `_generated/api.d.ts` regenerates.
3. `mail/drafts.ts` `send` and `cancelPendingSend` bodies rewired to
   the lifecycle.
4. `mail/outbound.ts` dispatch action rewired (claim →
   `transition({ to: 'sent' })`; revert paths → `transition({ to:
   'draft', reason })`).
5. Test migrations land in the same PR.

No risk to in-flight runs: drafts already in `pending_send` or
`scheduled` with scheduler hops pending will be picked up by the
unchanged `outbound.dispatchDraft` action signature. The first
`transition({ to: 'sent' })` call gates on the same conditions
`claimForDispatch` gated on (from-address allowed, state still
pending). The cron rearm at `outboundCron.dispatchOverdueDrafts`
continues to fire `dispatchDraft` for overdue rows.

**Out of scope for follow-up:** the Lifecycle factor question. This
ADR is the eleventh lifecycle module sharing the **Outbound
lifecycle** shape (typed `TransitionInput` + `LEGAL_EDGES` + reducer
+ effects + `TransitionOutcome`). CONTEXT.md still records the
"should the ten existing modules collapse into a generic
`Lifecycle<S, E, Eff>`?" question as "active design but not landed."
Eleven is not the trigger; the trigger is when the duplication bites
at maintenance time, and it has not yet.
