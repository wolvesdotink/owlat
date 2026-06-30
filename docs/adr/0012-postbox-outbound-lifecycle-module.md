# Postbox outbound lifecycle module — per-recipient state, derived aggregate, drop unused literals

**Status:** accepted

## Context

`mailMessages.outbound.state` is a six-literal column
(`queued | sending | sent | bounced | failed | pending`) tracking the
dispatch outcome of a personal-mail message. The schema declares all
six; the writers only ever set three (`queued | sent | bounced`).
`sending`, `pending`, and `failed` are unused literals — present in
the validator, never written by any path that actually exists.
The state machine has **three writers**, the terminal-state rule is
enforced asymmetrically across two of them, the `pb-<id>-<idx>` MTA-id
parser lives in one file while the prefix-routing dispatch lives in
another, the multi-recipient fan-out collapses to last-writer-wins on
a single row-level `state` column, and per-recipient MTA POST failures
are silently logged rather than recorded as transitions. CONTEXT.md
describes a **Postbox outbound lifecycle (module)** as if implemented;
in code the module does not exist.

### Writer landscape

| Producer | Path | State written | Terminal guard | Audit log |
|---|---|---|---|---|
| Synchronous dispatcher insert | `mail/outboundQueries.ts:writeSentMessage:210-214` | `queued` (at row insert, for every recipient on the row) | n/a (first write) | ❌ |
| MTA webhook → sent | `mail/outboundState.ts:markSent:30-52` | `sent` | ✅ refuses if already `bounced` or `failed` | ❌ |
| MTA webhook → bounce | `mail/outboundState.ts:markBounced:54-76` | `bounced` | ❌ no guard (overwrites `sent` unconditionally) | ❌ |

Note on a fourth path that is **not** a writer of this column:
`mail/outboundQueries.ts:markDispatchFailed` (referenced from
`mail/outbound.ts:323`) is a writer of `mailDrafts.state`, not
`mailMessages.outbound.state` — it reverts a draft from `pending_send`
back to `draft` when ClamAV rejects an attachment, *before*
`writeSentMessage` runs. No `mailMessages` row exists at that point.
The `.catch` in the caller is over-defensive Convex-deployment-lag
paranoia rather than evidence of a half-built mutation. The draft-state
path is out of scope for this ADR.

Seven drift signals concentrate.

### 1. Two dead literals in the schema

`apps/api/convex/schema/mail.ts:155-167`:

```ts
outbound: v.optional(v.object({
  mtaJobId: v.optional(v.string()),
  state: v.union(
    v.literal('queued'),
    v.literal('sending'),     // never written
    v.literal('sent'),
    v.literal('bounced'),
    v.literal('failed'),
    v.literal('pending'),     // never written
  ),
  bounceMessage: v.optional(v.string()),
  sentAt: v.optional(v.number()),
})),
```

`rg "state: ['\"]sending['\"]" apps/api/convex` returns no hits. Same
for `'pending'`. Both are vestigial from an earlier draft of the state
graph. CONTEXT.md (pre-this-ADR) described a five-state machine with
`sending` between `queued` and `sent` — but the synchronous dispatcher
does the MTA POST inline and waits for the webhook to mark `sent`;
there is no intermediate "actively sending" state in the writers.

### 2. CONTEXT.md describes a module that does not exist

`docs/adr/0006-send-completion-module.md` Follow-up §4 explicitly noted
"no parallel Postbox completion module to extract" — but the **state
machine** itself was always Postbox's, not the workpool's. CONTEXT.md
filled in the **Postbox outbound lifecycle (module)** entry as if
implemented (five states, two entry points, two effects). On disk:

- `convex/mail/postboxOutboundLifecycle.ts` — does not exist.
- `convex/mail/outboundState.ts` — 76 LOC, holds the `markSent` /
  `markBounced` pair the entry claims is "replaced."
- `webhooks/dispatcher.ts:32, 64` — routes directly to `outboundState`,
  not to a lifecycle module.

The doc was forward-dated. The ADR was never written. This is that ADR.

### 3. Terminal-state guard is asymmetric

`outboundState.ts:38-40`:

```ts
if (message.outbound.state === 'bounced' || message.outbound.state === 'failed') {
  return { matched: true, skipped: true };
}
```

`markSent` refuses to transition out of `bounced` or `failed`. `markBounced`
has no symmetric check — it patches state to `bounced` regardless of prior
state, which is *intentional* for the `sent → bounced` async-bounce path
but also unintentionally clobbers `failed` rows with `bounced` if a late
webhook arrives. The rule "bounced and failed are terminal" is encoded
once, in one direction, in a string-compare buried inside one of two
mutations.

### 4. Multi-recipient fan-out is lossy

The synchronous dispatcher in `mail/outbound.ts:404-461` POSTs to MTA
once per recipient with `pb-<mailMessageId>-<idx>` as the MTA messageId.
Multiple webhook outcomes come back against the *same* `mailMessages`
row. Today the row carries one scalar `state`: whichever webhook arrives
last wins (modulo the asymmetric terminal guard in §3).

A bcc'd message to 5 recipients where 4 succeed and 1 bounces ends in
state `bounced`. A user looking at their Sent folder sees "bounced"
even though most copies were delivered. The per-recipient outcome data
is in MTA logs but not in Convex.

### 5. Per-recipient MTA POST failures silently disappear

`mail/outbound.ts:454-460`:

```ts
if (!res.ok) {
  const body = await res.text().catch(() => '');
  logError(`[Outbound] MTA /send failed for ${to}: ${res.status} ${body}`);
}
} catch (err) {
  logError(`[Outbound] MTA /send error for ${to}:`, err);
}
```

When the MTA POST returns 5xx for one recipient — or throws (network
error) — the dispatcher logs and continues. The `mailMessages` row's
recipient stays in `queued` forever (or until a stray webhook arrives).
A user sending to five addresses where the second POST fails sees a
`queued` row in Sent that never resolves; no signal that anything went
wrong.

With per-recipient state in `recipients[]`, the per-recipient
synchronous failure becomes a real transition: 5xx maps to
`transition({recipientIdx, to: 'bounced'})`, network error maps to
`transition({recipientIdx, to: 'failed'})`. The recipient resolves
immediately and stops blocking the row's aggregate.

### 6. `pb-` prefix parser is split from prefix dispatch

`mail/outboundState.ts:20-28` defines `parsePostboxMtaId(mtaMessageId)`
— extracts the `mailMessages` id from a `pb-<id>-<idx>` string. The
`webhooks/dispatcher.ts:32, 64` routing decides "this provider message
id starts with `pb-`, route to Postbox" without going through the
parser. Two files own pieces of the same prefix convention; adding a
second postbox-style routing path (e.g. agent reply dispatch) would
require touching both.

### 7. No audit trail for outbound state transitions

The other recent lifecycle modules emit an `audit_log` effect on every
transition (ADR-0011 abuse status, ADR-0010 inbox processing).
Postbox outbound state changes are silent — bounce events, dispatch
failures, send confirmations all patch the row without leaving an
observability trail. Asymmetric with the rest of the lifecycle family.

### Shared framing

Per LANGUAGE.md's deletion test: deleting `outboundState.ts` and
inlining `markSent` / `markBounced` reveals four independent writers
all patching one column with conflicting guards, an absent parser
co-located with a present dispatcher, and a multi-recipient outcome
that the row's shape cannot represent. The friction is small in line
count (≈100 LOC across the writers) but architectural — it is the
last lifecycle in the codebase without a module, the last `email.*`
dispatch path the **Webhook dispatcher** routes outside the lifecycle
family, and the only outbound state machine without per-event audit.

This deepening lands the module that CONTEXT.md already named, makes
multi-recipient state truth-preserving, and drops the dead literals
in the same breaking-changes pass.

## Decision

One new module at `apps/api/convex/mail/postboxOutboundLifecycle.ts`,
a schema breaking change to `mailMessages.outbound`, and the deletion
of `mail/outboundState.ts`. `mail/outboundQueries.ts:markDispatchFailed`
is left intact — it is a writer of `mailDrafts.state` and is unrelated
to this lifecycle.

### Schema breaking change

`mailMessages.outbound` becomes:

```ts
outbound: v.optional(v.object({
  // Aggregate state — derived from recipients[] by the lifecycle.
  // Denormalized for index reads (e.g. "show me bounced mail in Sent").
  state: v.union(
    v.literal('queued'),
    v.literal('sent'),
    v.literal('bounced'),
    v.literal('failed'),
    v.literal('partial'),   // mix of sent/bounced (or sent/failed)
  ),
  recipients: v.array(v.object({
    idx: v.number(),         // 0-based position in dedup'd To+Cc+Bcc
    address: v.string(),     // recipient email (metadata; not unique)
    mtaJobId: v.string(),    // 'pb-<mailMessageId>-<idx>' — deterministic
    state: v.union(
      v.literal('queued'),
      v.literal('sent'),
      v.literal('bounced'),
      v.literal('failed'),
    ),
    sentAt: v.optional(v.number()),
    bounceMessage: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  })),
})),
```

The four-literal per-recipient union replaces the previous six-literal
union; `sending` and `pending` are dropped. The top-level `mtaJobId` /
`sentAt` / `bounceMessage` fields move into `recipients[]`. The
aggregate `state` gains `'partial'`.

Pre-prod: a one-shot internal mutation at
`apps/api/convex/_internal/migrations/postboxOutboundRecipients.ts`
finds every `mailMessages` row with `outbound != null` and rewrites:

```ts
// before
outbound: { state: 'sent', mtaJobId: 'pb-xxx-0', sentAt: 123, bounceMessage: undefined }

// after
outbound: {
  state: 'sent',                            // unchanged; recomputed identically
  recipients: [{
    idx: 0,
    address: message.toAddresses[0] ?? '',  // best-effort from the row's toAddresses
    mtaJobId: 'pb-xxx-0',
    state: 'sent',
    sentAt: 123,
    bounceMessage: undefined,
    errorCode: undefined,
  }],
}
```

Multi-recipient legacy rows backfill as single-element arrays — the
per-recipient history is genuinely lost (it never existed in the data),
and the aggregate matches what the UI showed before. The migration runs
at deploy time alongside the schema change.

Existing `sending` / `pending` literals — if any dev rows have them —
re-map to `'queued'` and `'sent'` respectively during the migration.
(In practice the migration query returns zero rows for those literals
because nothing ever wrote them.)

### Per-recipient state machine

Per-recipient `state ∈ { queued, sent, bounced, failed }`.

Legal edges:

- `queued → sent` (MTA webhook accepts)
- `queued → bounced` (synchronous bounce from MTA POST 5xx)
- `queued → failed` (pre-MTA error: attachment scan failure, dispatcher
  exception, network error before MTA accepted the request)
- `sent → bounced` (async bounce after MTA acceptance)

`bounced` and `failed` are terminal at the per-recipient level. Each
recipient transitions independently. There is no row-wide downgrade
guard — recipients can simultaneously be in different states.

### Aggregate state derivation

After every per-recipient transition the lifecycle re-derives
`outbound.state` from `outbound.recipients[]`:

```ts
function deriveAggregateState(recipients: Recipient[]): AggregateState {
  if (recipients.length === 0) return 'queued';  // defensive; never written empty
  const states = new Set(recipients.map(r => r.state));
  if (states.size === 1) return [...states][0] as AggregateState;
  return 'partial';
}
```

`partial` covers any mix: `(sent, bounced)`, `(sent, failed)`,
`(queued, sent)`, `(bounced, failed)`, etc. The UI treats `partial` as
"some delivered, some did not" — distinct from a clean `sent` and from
a clean `bounced`. Callers never write the aggregate directly; the
reducer is the only writer.

### Module shape

```ts
// apps/api/convex/mail/postboxOutboundLifecycle.ts

export type RecipientState = 'queued' | 'sent' | 'bounced' | 'failed';
export type AggregateState = RecipientState | 'partial';

export type TransitionInput =
  | { to: 'sent';     sentAt: number }
  | { to: 'bounced';  bounceMessage?: string; at: number }
  | { to: 'failed';   errorMessage: string; errorCode?: string; at: number };

export type TransitionOutcome =
  | {
      ok: true;
      applied: 'transitioned' | 'recorded';
      mailMessageId: Id<'mailMessages'>;
      affectedIndices: number[];          // empty for 'recorded'
      from: RecipientState[];             // per affected recipient, before
      to: RecipientState;                 // shared across all affected
      aggregateBefore: AggregateState;
      aggregateAfter: AggregateState;
    }
  | {
      ok: false;
      reason:
        | 'message_not_found'
        | 'message_has_no_outbound'
        | 'recipient_not_found'
        | 'illegal_edge'
        | 'terminal'
        | 'unknown_mta_id_prefix';
      mailMessageId?: Id<'mailMessages'>;
      recipientIdx?: number;
      from?: RecipientState;
      to?: RecipientState;
    };

// Per-recipient transition — used by mail/outbound.ts:dispatchDraft for
// synchronous MTA POST failures (5xx → bounced, network error → failed).
export const transition: (ctx: MutationCtx, args: {
  mailMessageId: Id<'mailMessages'>;
  recipientIdx: number;
  input: TransitionInput;
}) => Promise<TransitionOutcome>;

// External-key transition — takes the raw 'pb-<id>-<idx>' string from
// the MTA webhook, parses both ids internally, transitions one
// recipient. Used by the Webhook dispatcher.
export const transitionByMtaMessageId: (ctx: MutationCtx, args: {
  rawProviderMessageId: string;
  input: TransitionInput;
}) => Promise<TransitionOutcome>;

// Re-exported from this module for any caller that needs to recognize
// a postbox MTA id without dispatching (e.g. logging). The parser
// is no longer split from the dispatch.
export function parsePostboxMtaId(
  raw: string
): { mailMessageId: Id<'mailMessages'>; idx: number } | null;
```

A bulk `transitionAllRecipients` entry point was considered but rejected
as YAGNI — the only callers under Path 2 of the design (per-recipient
synchronous failures, per-recipient webhook outcomes) are inherently
single-recipient. A bulk entry point would land alongside the
stuck-`queued` janitor follow-up if and when that work needs to mark
many recipients failed at once.

### Reducer effects

```ts
type Effect =
  | {
      kind: 'audit_log';
      action: 'postbox_outbound_transition';
      mailMessageId: Id<'mailMessages'>;
      mailboxId: Id<'mailboxes'>;
      recipientIdx: number;
      from: RecipientState;
      to: RecipientState;
      aggregateBefore: AggregateState;
      aggregateAfter: AggregateState;
      at: number;
      details?: { bounceMessage?: string; errorMessage?: string; errorCode?: string };
    };
```

One effect kind at launch: `audit_log`. Fires on every transition,
including `recorded` outcomes (so the audit timeline captures
duplicate-webhook arrivals and same-state attempts). The action literal
is `'postbox_outbound_transition'` (new audit-action literal added to
the ADR-0002 catalog). One audit row per recipient transition.

Per-mailbox UI notification on bounce and per-domain reputation update
on send/bounce — both named in pre-this-ADR CONTEXT.md — are
*deferred to follow-up ADRs*. Both require infrastructure that does
not exist today: there is no notification surface in
`apps/api/convex/`, and the existing reputation tracking
(`analytics/sendingReputation.ts`) is org-level, not per-domain.
Coupling either to this deepening would inflate it into "build a
notification surface + build per-domain reputation + ship the
lifecycle" — three concerns smeared together. The lifecycle ships
with `audit_log` only; the two effects land in short follow-up PRs
once their target surfaces exist.

### Effects Postbox does *not* emit

- `campaign_stats_*` — Postbox is personal mail, not campaign mail.
- `contact_activity` — Postbox recipients are not Contacts (they are
  arbitrary email addresses); the contact-activity timeline is the
  campaign/transactional surface.
- `content_scan_complaint` / `reputation_update` (today's org-level) —
  a misdelivered personal email must not blocklist that address from
  the entire org or alter org-level reputation.
- `customer_webhook` — personal mail is not a customer-fanned-out
  event surface.

The exclusion list is intentional and is the principal reason this is
a sibling of the **Send lifecycle (module)** rather than a generic
factor — the effect sets diverge by design, not by accident.

### Call-site shape after the cut

```ts
// webhooks/dispatcher.ts (was lines 32, 64 — two paths)
'email.sent': async (ctx, e) => {
  if (e.providerMessageId.startsWith('pb-')) {
    await postboxOutboundLifecycle.transitionByMtaMessageId(ctx, {
      rawProviderMessageId: e.providerMessageId,
      input: { to: 'sent', sentAt: e.sentAt ?? Date.now() },
    });
    return;
  }
  // Existing Send lifecycle path stays unchanged.
  await sendLifecycle.transitionByProviderMessageId(ctx, { ... });
},

'email.bounced': async (ctx, e) => {
  if (e.providerMessageId.startsWith('pb-')) {
    await postboxOutboundLifecycle.transitionByMtaMessageId(ctx, {
      rawProviderMessageId: e.providerMessageId,
      input: {
        to: 'bounced',
        bounceMessage: e.bounceMessage,
        at: e.at ?? Date.now(),
      },
    });
    return;
  }
  await sendLifecycle.transitionByProviderMessageId(ctx, { ... });
},
```

```ts
// mail/outbound.ts:dispatchDraft — per-recipient MTA POST loop
// (was lines 423-461, the silent-log path)
for (let i = 0; i < recipients.length; i++) {
  const to = recipients[i];
  const mtaMessageId = `pb-${insertResult.messageId}-${i}`;
  try {
    const res = await fetch(`${mta.baseUrl}/send`, { ... });
    if (!res.ok) {
      // 5xx → per-recipient bounced transition (was: log only)
      const body = await res.text().catch(() => '');
      logError(`[Outbound] MTA /send failed for ${to}: ${res.status} ${body}`);
      await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
        mailMessageId: insertResult.messageId,
        recipientIdx: i,
        input: {
          to: 'bounced',
          bounceMessage: `MTA POST ${res.status}: ${body.slice(0, 200)}`,
          at: Date.now(),
        },
      });
    }
  } catch (err) {
    // Network error → per-recipient failed transition (was: log only)
    logError(`[Outbound] MTA /send error for ${to}:`, err);
    await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
      mailMessageId: insertResult.messageId,
      recipientIdx: i,
      input: {
        to: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        errorCode: 'MTA_POST_NETWORK',
        at: Date.now(),
      },
    });
  }
}
```

Pre-MTA failure paths (attachment scan via ClamAV, dispatcher exception
before `writeSentMessage`) are unchanged. `markDispatchFailed` still
reverts the draft from `pending_send`/`scheduled` back to `draft`; no
`mailMessages` row gets created. The lifecycle module is only involved
once the row exists.

### What stays put

- The synchronous dispatcher itself (`mail/outbound.ts:dispatchDraft`)
  stays where it is. The lifecycle owns transitions; the dispatcher
  owns the RFC822 build, the attachment scan loop, the MTA POST
  per-recipient call, and the draft cleanup. These are dispatch
  mechanics, not state-machine concerns.
- The `webhooks/dispatcher.ts` prefix dispatch (`pb-`-prefixed →
  postbox, anything else → send lifecycle) stays. The lifecycle
  module owns the parsing once routed; the dispatcher owns the
  routing decision. Mirrors how the Send lifecycle handles
  `transitionByProviderMessageId` — caller routes by prefix, module
  parses the rest.

## Considered options

### State unit — per-row vs per-recipient

1. **Per-recipient state on `recipients[]`, derived aggregate**
   *(chosen)*. Multi-recipient outcomes are truth-preserving; the
   aggregate is denormalized for index reads. Schema change is
   structural but pre-prod-free.
2. **Per-row state, last-writer-wins-with-downgrade-guard** (today's
   behavior). No schema change; the lifecycle codifies the existing
   asymmetric guard as a legal-edges declaration. The 4-of-5 success
   case still appears as `bounced` in the UI. Rejected — going to
   the trouble of a lifecycle module without solving the multi-recipient
   truth-loss leaves the principal user-facing drift intact.
3. **Per-row state, first-writer-wins** (terminal-on-first-outcome).
   The first webhook wins; later outcomes log-but-ignored. Loses the
   `sent → bounced` async-bounce path entirely. Rejected — the
   async-bounce path is genuine MTA behavior that the lifecycle
   needs to model.

### Aggregate state — partial vs collapse

1. **Aggregate includes `partial`** *(chosen)*. The mixed-outcome
   case is its own UI affordance. Per-recipient data is visible at
   the aggregate level; the deepening pays for itself in the Sent
   folder UI.
2. **Aggregate collapses mixed outcomes to `bounced`.** Matches
   today's behavior (last-writer-wins-with-guard). Loses the
   "delivered to most" signal at the aggregate. Rejected — without
   `partial`, the per-recipient array is invisible at the index-read
   surface and the UX delta is zero.
3. **Aggregate collapses mixed outcomes to `sent`.** Strictly worse;
   users would see "sent" for messages where some recipients
   bounced. Rejected.

### State graph — 4 vs 5 vs 6 literals

1. **4 per-recipient literals** *(chosen)*. Matches what the writers
   actually set today. `sending` and `pending` were never written;
   they go.
2. **5 per-recipient literals (keep `sending`)**. Would represent
   "MTA POST in flight, webhook not yet received." Mechanically the
   synchronous dispatcher could write `sending` between POST and
   webhook, but the window is short and no caller reads the value.
   Rejected — adds a literal nobody consumes.
3. **Keep all 6 literals, document `sending` / `pending` as reserved.**
   Reserved-for-future literals are a tax on every reader (they have
   to handle the case). Rejected — pre-prod cleanup is essentially
   free.

### Bulk transition — bulk path vs loop

1. **Per-recipient entry point only** *(chosen)*. Every concrete caller
   under this design is inherently single-recipient: synchronous MTA
   POST failures arise per recipient (one POST per recipient), webhook
   events arrive per `pb-<id>-<idx>`. A bulk entry point would have no
   call site today.
2. **`transitionAllRecipients` for "this row's dispatch failed."**
   Considered for the ClamAV pre-MTA-failure path, but that path lives
   *before* `writeSentMessage` runs and operates on the `mailDrafts`
   row via `markDispatchFailed`, not on a `mailMessages` row. The
   `mailMessages` row only exists post-`writeSentMessage`, by which
   point every recipient is independent. Rejected — no caller.
3. **`transition` accepts a list of indices.** Variadic surface that
   nothing today needs. Rejected — YAGNI.

A bulk entry would land alongside the stuck-`queued` janitor follow-up
if and when that work needs to mark many recipients failed at once.

### `pb-` parser location

1. **Parser inside the lifecycle module** *(chosen)*. The convention
   is part of the lifecycle's external-key contract; the parser is
   the lifecycle's responsibility. The dispatcher only needs to
   recognize the prefix, not parse the structure.
2. **Parser in the dispatcher**. The dispatcher already routes by
   prefix; keeping the parser there makes the dispatcher the single
   owner of the convention. Rejected — the parser is for the
   transition's external-key lookup, not for routing; the dispatcher
   would still need to know the parsed shape to call the lifecycle.
3. **Parser in a shared utility.** Three-way split between
   dispatcher, lifecycle, and utility. Rejected — over-decomposed.

### Effects scope at launch

1. **`audit_log` only; notification + reputation deferred** *(chosen)*.
   Both deferred effects require new domain surfaces that don't
   exist; landing them with the lifecycle inflates the deepening
   into three concerns. The lifecycle ships clean; the effects land
   when their surfaces do.
2. **Ship lifecycle + notification effect + reputation effect.**
   Three concerns in one ADR. Per-domain reputation is itself a new
   concept; the notification surface is a new module. Rejected
   for scope.
3. **Ship lifecycle with empty effect list.** The audit-log gap
   becomes drift signal #7 left unfixed. Rejected — `audit_log` is
   the one effect we have all the infrastructure to land today.

### Module naming

1. **`Postbox outbound lifecycle (module)` at
   `convex/mail/postboxOutboundLifecycle.ts`** *(chosen — matches the
   pre-existing CONTEXT.md entry)*. Sibling of **Send lifecycle**;
   reads as "the lifecycle of Postbox outbound dispatch."
2. **`Mail outbound lifecycle (module)`.** Mail is overloaded with
   IMAP / folders / threads (per CONTEXT.md's existing `_Avoid_`
   list); ambiguous. Rejected.
3. **`Personal mail dispatch lifecycle`.** Verbose; "Postbox" is the
   established product term. Rejected.

## Consequences

### Files that collapse / disappear

- `apps/api/convex/mail/outboundState.ts` — entire file deleted.
  `markSent`, `markBounced`, and `parsePostboxMtaId` move into the
  new lifecycle module (the first two become reducer paths, the
  third becomes a named export).
- `apps/api/convex/webhooks/dispatcher.ts:32, 64` — the two direct
  calls to `outboundState.markSent` / `outboundState.markBounced`
  swap to `postboxOutboundLifecycle.transitionByMtaMessageId`.
  The prefix-check stays in the dispatcher (routing decision);
  the parsing moves into the lifecycle.

`mail/outboundQueries.ts:markDispatchFailed` is **not** deleted —
it writes `mailDrafts.state`, not `mailMessages.outbound.state`,
and is unrelated to this lifecycle.

### Files that grow

- `apps/api/convex/mail/postboxOutboundLifecycle.ts` — new module
  (≈240 LOC). Exports the per-recipient + aggregate state literals
  and validators, the `TransitionInput` / `TransitionOutcome` types
  and validators, the two transition entry points (`transition`,
  `transitionByMtaMessageId`), the per-kind reducers, the aggregate
  derivation function, and `parsePostboxMtaId`.
- `apps/api/convex/schema/mail.ts:155-167` — the `outbound` validator
  is rewritten per §"Schema breaking change."
- `apps/api/convex/mail/outbound.ts:423-461` — the per-recipient MTA
  POST loop adds per-recipient `transition` calls on 5xx (→ `bounced`)
  and network error (→ `failed`). The `writeSentMessage` call stays
  where it is; the `recipients[]` array is populated at insert time
  (one entry per dedup'd To+Cc+Bcc, `idx` = 0..N, `mtaJobId` =
  `pb-<id>-<idx>`, `state` = `'queued'`).
- `apps/api/convex/mail/outboundQueries.ts:writeSentMessage` — the
  insert shape changes; the per-recipient array is built from the
  passed-in `to`/`cc`/`bcc` arrays.
- `apps/api/convex/_internal/migrations/postboxOutboundRecipients.ts`
  — new one-shot internal mutation that rewrites existing
  `outbound` objects to the new shape. Runs at deploy time alongside
  the schema change.
- `apps/api/convex/contactActivities/catalog.ts` (or the audit
  catalog from ADR-0002) — adds `'postbox_outbound_transition'`
  to the audit-action literal set.

Net LOC change: ~76 LOC down (`outboundState.ts` deleted), ~240 LOC
up across the new lifecycle module, plus ~30 LOC of per-recipient
transition calls in `outbound.ts`. Value is locality, typed contract,
terminal-state declaration, per-recipient truth preservation, an
audit trail, and per-recipient MTA POST failures becoming real
transitions instead of silent log entries.

### Migration

Pre-production: a one-shot internal mutation rewrites every
`mailMessages` row with `outbound != null`:

```ts
// _internal/migrations/postboxOutboundRecipients.ts
export const migrate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('mailMessages')
      .filter((q) => q.neq(q.field('outbound'), undefined))
      .collect();

    for (const row of rows) {
      const old = row.outbound!;
      const mappedState = (
        old.state === 'sending' ? 'queued' :
        old.state === 'pending' ? 'sent' :
        old.state
      ) as RecipientState;

      const primaryAddress = row.toAddresses[0] ?? '';
      const mtaJobId = old.mtaJobId ?? `pb-${row._id}-0`;

      await ctx.db.patch(row._id, {
        outbound: {
          state: mappedState,
          recipients: [{
            idx: 0,
            address: primaryAddress,
            mtaJobId,
            state: mappedState,
            sentAt: old.sentAt,
            bounceMessage: old.bounceMessage,
            errorCode: undefined,
          }],
        },
        updatedAt: Date.now(),
      });
    }
  },
});
```

Multi-recipient legacy rows backfill as single-element arrays —
the per-recipient history was never stored, so reconstructing it
is impossible. The aggregate `state` matches what the UI rendered
before; user-visible state is preserved.

Production: no production rows exist today (single-org-per-deployment,
pre-launch). Same migration applies whenever real rows exist.

### Test surface

- `apps/api/convex/__tests__/postboxOutboundLifecycle.integration.test.ts`
  (new, ≈16 tests) — table-driven per `from-state × to-state ×
  producer-path` for the per-recipient transitions, plus the
  aggregate-derivation cases. Coverage:
  - Each legal edge (4 per-recipient edges) succeeds and patches.
  - Each illegal edge returns `{ ok: false, reason: 'illegal_edge' }`.
  - Terminal-state writes (`bounced`/`failed` → anything) return
    `{ ok: false, reason: 'terminal' }`.
  - Same-state writes return `{ ok: true, applied: 'recorded' }`
    and emit an `audit_log` effect.
  - Aggregate derivation: all-`queued` → `'queued'`; mix of
    `(sent, bounced)` → `'partial'`; all-`bounced` → `'bounced'`;
    etc.
  - `transitionByMtaMessageId` parses valid `pb-<id>-<idx>` strings,
    returns `{ ok: false, reason: 'unknown_mta_id_prefix' }` for
    non-`pb-` strings, and `{ ok: false, reason:
    'recipient_not_found' }` for out-of-range indices.
  - Audit-log effect fires on every transition with the right
    payload shape.
- `apps/api/convex/__tests__/postboxOutboundLifecycle.unit.test.ts`
  (new, ≈6 tests) — pure unit tests for `parsePostboxMtaId` and
  `deriveAggregateState`.
- The existing `mail/__tests__/outboundState.test.ts` (if any) is
  deleted alongside `outboundState.ts`; its assertions are absorbed
  into the integration suite.
- The webhook-dispatcher integration test updates: `email.sent` /
  `email.bounced` events with a `pb-`-prefixed messageId route to
  `transitionByMtaMessageId` rather than `markSent` / `markBounced`.

### Behavior

All caller-visible behaviors are preserved, with six drift signals
fixed opportunistically (drift signal #5 — the "markDispatchFailed
is half-built" misreading — is invalidated rather than fixed):

- The Sent folder UI shows `sent` / `bounced` / `failed` for
  single-recipient messages exactly as before. Multi-recipient mixed
  outcomes change from "whichever webhook arrived last" to
  `'partial'` — the user-visible label changes, but the underlying
  data is now correct (where today it was an arbitrary winner).
- Per-recipient MTA POST failures (5xx synchronous bounces,
  network errors) now produce real per-recipient transitions
  (today they're silently logged and the recipient stays in
  `queued` forever). Drift signal #5.
- Async bounces (`sent → bounced`) still update the recipient's
  state; the row's aggregate may go `'sent'` → `'partial'` (mixed
  recipients) or `'sent'` → `'bounced'` (all recipients).
- Audit log captures every transition (today: silent across all
  outbound writers). Drift signal #7.
- `sending` / `pending` literals dropped from the schema. Drift
  signal #1.
- Terminal-state rule encoded once in `LEGAL_EDGES` instead of
  asymmetrically across `markSent` and `markBounced`. Drift
  signal #3.
- The ClamAV-attachment-scan pre-MTA failure path is unchanged:
  `markDispatchFailed` still reverts the draft to `'draft'`, no
  `mailMessages` row gets created, the user can edit and try again.

### Vocabulary

CONTEXT.md updated in the same pass:

- **Postbox outbound state** entry — rewritten to describe the
  two granularities (per-recipient + derived aggregate), the
  4-state per-recipient graph, the 5-state aggregate, and the
  recipient-array shape (idx-keyed; `pb-<id>-<idx>` deterministic).
  The dropped `sending` and `pending` literals are noted.
- **Postbox outbound lifecycle (module)** entry — rewritten to
  describe the slice-not-row transition unit, the two entry
  points (`transition`, `transitionByMtaMessageId`), the
  `audit_log`-only effect set at launch, and the deferred
  notification + reputation effects.
- **Relationships** section — the `mailMessage.outbound` row
  paragraph rewritten to describe per-recipient state + derived
  aggregate. The lifecycle-factor paragraph stays unchanged (the
  count of instances stays at 5; Postbox was already counted as
  one).

The audit-action catalog gains `'postbox_outbound_transition'`.

## Follow-up work

1. **Per-mailbox UI notification effect.** A `per_mailbox_ui_notification`
   effect on bounce, wired to a future mailbox-notification surface
   in `apps/api/convex/`. Defer until the notification surface ADR
   lands; add as one effect kind + one runner branch at that time.
2. **Per-domain reputation effect.** A `per_domain_reputation_update`
   effect on send/bounce, wired to a future per-domain reputation
   table. Existing `analytics/sendingReputation.ts` tracks org-level
   reputation; per-domain is a new dimension. Defer until the
   per-domain reputation ADR lands.
3. **Stuck-`queued` recipient janitor.** Today the synchronous
   dispatcher loops MTA POSTs in one action; if it dies mid-loop,
   some recipients stay `queued` indefinitely. Post-this-ADR they
   are visible per-recipient. A periodic cron sweeping recipients
   `queued` for >N hours and transitioning them to `'failed'` with
   `errorCode: 'STUCK_QUEUED'` is the natural follow-up. Out of
   scope here.
4. **Webhook deduplication.** MTA webhooks can fire twice for the
   same `pb-<id>-<idx>`. Today this is silent (last-writer-wins);
   post-this-ADR a duplicate webhook returns `{ ok: true, applied:
   'recorded' }` and emits an audit row. If the audit-row noise
   becomes a problem, add an idempotency-key check on the
   webhook-handler side. Out of scope.
5. **Lifecycle factor revisit.** With the Postbox lifecycle live,
   five lifecycle instances exist by convention. The
   `Lifecycle<S, E, Eff>` factor question stays "active design"
   per CONTEXT.md. The Postbox slice-not-row transition unit is
   the first divergence at the type-signature level — if a sixth
   lifecycle lands with a similar shape, the factor question moves
   from "active" to "now."

## Execution

Implemented in a single pre-production pass — no separate execution
plan needed, since pre-launch nothing needs PR-splitting. Change set:

- `apps/api/convex/mail/postboxOutboundLifecycle.ts` — new module.
- `apps/api/convex/mail/outboundState.ts` — deleted.
- `apps/api/convex/mail/outboundQueries.ts:writeSentMessage` —
  insert shape gains `recipients[]`.
- `apps/api/convex/mail/outbound.ts:dispatchDraft` — per-recipient
  MTA POST loop adds `transition({to:'bounced'})` on 5xx and
  `transition({to:'failed'})` on network error. ClamAV pre-MTA path
  and `writeSentMessage` location stay unchanged.
- `apps/api/convex/webhooks/dispatcher.ts` — `email.sent` and
  `email.bounced` handlers swap their `pb-`-branch from
  `outboundState.markSent`/`markBounced` to
  `postboxOutboundLifecycle.transitionByMtaMessageId`.
- `apps/api/convex/schema/mail.ts` — `outbound` validator rewritten.
- `apps/api/convex/_internal/migrations/postboxOutboundRecipients.ts`
  — one-shot migration.
- `apps/api/convex/__tests__/postboxOutboundLifecycle.integration.test.ts`
  — new.
- `apps/api/convex/__tests__/postboxOutboundLifecycle.unit.test.ts`
  — new.
- CONTEXT.md updates (already landed inline during the grilling
  session that produced this ADR).
- Audit-action catalog adds `'postbox_outbound_transition'`.

### Verification greps

- `rg "outboundState\\." apps/api/convex` → 0 hits.
- `rg "state: ['\"]sending['\"]" apps/api/convex` → 0 hits.
- `rg "v.literal\\(['\"]sending['\"]\\)" apps/api/convex/schema` → 0 hits.
- `rg "v.literal\\(['\"]pending['\"]\\)" apps/api/convex/schema/mail.ts` → 0 hits.
- `rg "outbound\\.recipients" apps/api/convex` → at least one hit each
  in `mail/postboxOutboundLifecycle.ts`, `mail/outboundQueries.ts`,
  `mail/outbound.ts`, the migration file, and the new test files.
- `rg "postboxOutboundLifecycle\\.(transition|transitionByMtaMessageId)" apps/api/convex`
  → at least one hit in `mail/outbound.ts` and `webhooks/dispatcher.ts`.

### Done when

- All verification greps return the expected counts.
- `npx vitest run` in `apps/api` is green.
- A new postbox dispatch (single-recipient) walks `queued → sent`
  exactly as before, with one new audit-log row.
- A new postbox dispatch (multi-recipient, mixed outcomes) ends
  with aggregate `'partial'` and per-recipient states reflecting
  the actual per-recipient outcomes.
- A per-recipient MTA POST 5xx during dispatch produces an immediate
  per-recipient `bounced` transition (today: silently logged).
- The migration runs cleanly on a fixture corpus of legacy
  `outbound` shapes (single-state, with mtaJobId, without mtaJobId).
