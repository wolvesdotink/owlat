# Conversation thread module — single writer of `conversationThreads`, unifying channel/email reopen semantics and closing the audit gap

**Status:** proposed

## Context

`conversationThreads` is the grouping unit of the shared inbox — every
inbound email and every inbound non-email channel message (SMS, WhatsApp,
generic) hangs off a thread. The table has a real status dimension
(`open | waiting | resolved | closed`), denormalized counters
(`messageCount`, `lastMessageAt`, `firstMessageAt`), a human-assignment
field (`assignedTo`), and a draft-status projection (`latestDraftStatus`)
the agent pipeline maintains.

Writes to this table are open-coded across five sites with no interface
between them. Each site re-implements its own slice of "find-or-create +
patch metadata + move status," and the slices have drifted.

### Caller landscape — writers to `conversationThreads`

| Writer | File:line | Find-or-create | Metadata patch | Status write | Audit | Notes |
|---|---|---|---|---|---|---|
| Email intake | `inbox/messages.ts:87-152` | 3-strategy cascade (In-Reply-To → References → normalized-subject) | `messageCount+1`, `lastMessageAt` | always `status: 'open'` | none | re-reads thread after insert to compute count |
| Channel intake | `webhooks/channels.ts:98-131` | single strategy (`by_contact` most-recent) | `messageCount+1`, `lastMessageAt` | `status` untouched | none | **forks a new thread when match is `closed`** |
| Assign | `inbox/mutations.ts:131-145` | — | `assignedTo` only | — | none | no audit, no policy |
| Status update | `inbox/mutations.ts:150-169` | — | — | any literal, no edge check | none | no audit |
| Draft status | `inbox/processingLifecycle.ts:626-631` (effect) | — | `latestDraftStatus` | — | — | the one inbox-lifecycle effect that writes a *different* table without delegating to its owner |

Five writers. No shared interface. Per LANGUAGE.md's deletion test:
deleting any one of these does not concentrate complexity — it just
moves the find-or-create or the metadata patch into a sibling. The
duplication is *already* paying the cost it threatens to: the email and
channel paths have diverged on the single most important question a
thread store has to answer.

### 1. Closed-thread reopen is incoherent between channels

`inbox/messages.ts:144-152` patches the matched thread unconditionally and
writes `status: 'open'` — an inbound email on a closed thread reopens it.

```ts
// inbox/messages.ts:145-152
const thread = await ctx.db.get(threadId);
if (thread) {
	await ctx.db.patch(threadId, {
		messageCount: thread.messageCount + 1,
		lastMessageAt: now,
		status: 'open', // Reopen if previously resolved/closed
	});
}
```

`webhooks/channels.ts:108-131` does the opposite — if the most-recent
thread is `closed`, it skips it and *creates a new thread*:

```ts
// webhooks/channels.ts:108-131
if (existingThread && existingThread.status !== 'closed') {
	threadId = existingThread._id;
	await ctx.db.patch(threadId, { lastMessageAt: now, messageCount: ... });
} else {
	// Create new thread
	threadId = await ctx.db.insert('conversationThreads', { ... });
}
```

A customer who emails after a thread is closed continues the same
thread; the same customer who texts after a thread is closed starts a
fresh one. The split is invisible — nothing names "what happens on
inbound to a closed thread" as a decision, so the two intake paths
answered it differently by accident.

### 2. The `messageCount` increment races

`inbox/messages.ts:145-151` reads the thread *after* the message-row
insert, then patches `messageCount: thread.messageCount + 1`. Two inbound
messages on the same thread arriving in overlapping mutations can both
read the same pre-increment count and both write `n+1`, losing one.
Convex serializes conflicting mutations, but the read-then-write split
across the `db.get` at line 145 and the surrounding intake logic leaves
the window wider than it needs to be. The fix is to read and write the
counter inside one tight reducer with no intervening IO.

### 3. `assignThread` and `updateThreadStatus` are auditless and edgeless

```ts
// inbox/mutations.ts:139-144
await ctx.db.patch(args.threadId, { assignedTo: args.assignedTo });
return { success: true };
```

```ts
// inbox/mutations.ts:163-168
await ctx.db.patch(args.threadId, { status: args.status });
return { success: true };
```

No audit-log row on either. Every other lifecycle module in this
codebase audits its writes (ADR-0017 campaigns, ADR-0018 sending
domains, ADR-0024 automations, ADR-0028 mail drafts). Thread assignment
and status changes are human actions in a shared inbox — exactly the
kind of write an audit trail exists for — and they leave none.

### 4. The `contactEmail` field is a misnomer the schema can't correct

The thread's identity column is named `contactEmail` but carries an email
for email channels, a phone number for SMS/WhatsApp, and a free-form
handle for generic/chat. `webhooks/channels.ts:116-122` documents the lie:

```ts
// Create new thread. `contactEmail` is the thread-list display
// identifier — it's the email for email/generic channels and the
// raw phone/handle for SMS/WhatsApp/chat. Misnomer kept for now;
// renaming to `contactIdentifier` is its own refactor.
threadId = await ctx.db.insert('conversationThreads', {
	contactId,
	contactEmail: args.from,
	...
```

The field, the index `by_contact_email`, and the compound
`by_normalized_subject_and_contact` all encode the email-centric
assumption the channel work already broke.

### 5. The lifecycle's draft-status effect reaches across a module boundary

`inbox/processingLifecycle.ts:626-631` patches `conversationThreads`
directly from inside the Inbox processing lifecycle's effect runner:

```ts
case 'set_thread_draft_status': {
	await ctx.db.patch(effect.threadId, {
		latestDraftStatus: effect.draftStatus,
	});
	break;
}
```

This is the only inbox-lifecycle effect that writes a table the lifecycle
doesn't own. Every other cross-table write in the codebase's lifecycle
modules delegates to the owning module (DOI lifecycle → Topic
subscription, Email template lifecycle → Saved block). This one patches
in place because there is no owner module for `conversationThreads` to
delegate to.

### Shared framing

The five writers are shallow individually — but the table they share has
a status machine, denormalized counters that must stay consistent, and a
reopen policy that is genuinely a decision. Lifting the writes behind one
module produces real leverage: every intake path declares its channel and
gets the find-or-create + reopen + count maintenance for free, the human
mutations get audit logs for free, and the lifecycle's draft-status
effect gets a module to delegate to. Locality: the reopen policy, the
count-increment, and the audit posture live in one reducer instead of
five hand-rolled patches.

Confidence: high. The scope is "all writes to one table" — a clean,
greppable seam. One intentional behaviour change (channel inbound now
reopens closed threads instead of forking), documented and desired. One
schema rename with a one-pass pre-prod migration.

## Decision

Introduce a **Conversation thread (module)** at
`convex/inbox/threads/module.ts` that owns *all* writes to
`conversationThreads`, migrate the five writers to call into it, and
rename `contactEmail → contactIdentifier`.

The module mirrors the **Mail draft lifecycle (module)** (ADR-0028)
shape — a typed `TransitionInput`, a private reducer per kind returning
`{ patch, effects, applied }`, a `TransitionOutcome`, and an effect
runner — with two differences:

- The discriminator is `kind`, **not** `to`. A thread has heterogeneous
  independent dimensions (`status`, `assignedTo`, `latestDraftStatus`,
  `messageCount`/`lastMessageAt`); there is no single "state" to target.
- There is **no `LEGAL_EDGES` graph**. Manual status changes are fully
  flexible (any literal → any literal). Inbound-driven reopen is its own
  kind, not a status-machine edge.

### Module surface

```ts
// convex/inbox/threads/module.ts

type ConversationThreadStatus = 'open' | 'waiting' | 'resolved' | 'closed';

type ThreadWriteSource =
	| 'inbound' | 'agent' | 'user';

type TransitionInput =
	| { kind: 'inbound_activity'; occurredAt: number }
	| { kind: 'status_change'; to: ConversationThreadStatus; source: ThreadWriteSource }
	| { kind: 'assignment_change'; assignedTo?: string; source: ThreadWriteSource }
	| { kind: 'draft_status_change'; latestDraftStatus: 'pending' | 'approved' | 'rejected' | 'sent' };

type TransitionOutcome =
	| { ok: true; applied: 'transitioned' | 'noop'; threadId: Id<'conversationThreads'> }
	| { ok: false; reason: 'thread_not_found' };

// ── Intake entries (find-or-create + implicit inbound_activity) ──

export async function findOrCreateForEmail(
	ctx: MutationCtx,
	args: {
		contactId?: Id<'contacts'>;
		contactIdentifier: string;
		subject: string;
		normalizedSubject: string;
		inReplyTo?: string;
		references?: string;
		occurredAt: number;
	},
): Promise<{ threadId: Id<'conversationThreads'>; action: 'matched' | 'created' }>;

export async function findOrCreateForChannel(
	ctx: MutationCtx,
	args: {
		contactId?: Id<'contacts'>;
		contactIdentifier: string;
		subject: string;
		normalizedSubject: string;
		occurredAt: number;
	},
): Promise<{ threadId: Id<'conversationThreads'>; action: 'matched' | 'created' }>;

// ── Direct transition entry (non-intake writes) ──

export async function transition(
	ctx: MutationCtx,
	args: { threadId: Id<'conversationThreads'>; input: TransitionInput },
): Promise<TransitionOutcome>;
```

`findOrCreateForEmail` runs the existing three-strategy cascade
(In-Reply-To header → References header → `by_normalized_subject_and_contact`
composite). `findOrCreateForChannel` runs the single-strategy match
(`by_contact`, most-recent, **status-agnostic** — the matcher no longer
skips closed threads). Both, on a hit *or* a fresh create, immediately run
the `inbound_activity` reducer so the count/lastMessageAt patch and the
reopen-if-closed are atomic with discovery — the caller makes one call.

### The `inbound_activity` reducer

```ts
function reduceInboundActivity(
	thread: Doc<'conversationThreads'>,
	occurredAt: number,
): ReducerResult {
	const wasClosed = thread.status === 'closed';
	return {
		patch: {
			messageCount: thread.messageCount + 1,
			lastMessageAt: occurredAt,
			...(wasClosed ? { status: 'open' as const } : {}),
		},
		effects: wasClosed
			? [{ kind: 'audit_log', action: 'thread.reopened_by_inbound', threadId: thread._id }]
			: [],
		applied: 'transitioned',
	};
}
```

The count read (`thread.messageCount`) and the patch happen inside the
reducer with no intervening IO — closing the §2 race. The reopen audit
fires only on the closed→open edge, not on every inbound (avoiding
timeline noise).

### Effects

One effect kind: `audit_log`. Five new audit-action literals land in
`auditActions/catalog.ts`, plus a new `conversation_thread` audit
resource:

- `thread.reopened_by_inbound` — `inbound_activity` on a closed thread.
- `thread.status_changed` — `status_change` (details: `from`, `to`, `source`).
- `thread.assigned` — `assignment_change` with a non-null `assignedTo`
  (details: `userId`, `source`).
- `thread.unassigned` — `assignment_change` with `assignedTo` undefined.
- `thread.draft_status_changed` — `draft_status_change` (details:
  `latestDraftStatus`).

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `inbox/messages.ts:87-152` | inline cascade + insert + re-read + patch | `findOrCreateForEmail(ctx, { ... })` → `threadId` |
| `webhooks/channels.ts:98-131` | inline single-strategy + fork-on-closed + patch | `findOrCreateForChannel(ctx, { ... })` → `threadId` |
| `inbox/mutations.ts:131-145` (`assignThread`) | bare `db.patch(assignedTo)` | `transition(ctx, { threadId, input: { kind: 'assignment_change', assignedTo, source: 'user' } })` |
| `inbox/mutations.ts:150-169` (`updateThreadStatus`) | bare `db.patch(status)` | `transition(ctx, { threadId, input: { kind: 'status_change', to, source: 'user' } })` |
| `inbox/processingLifecycle.ts:626-631` (`set_thread_draft_status`) | inline `db.patch(latestDraftStatus)` | effect-runner calls `transition(ctx, { threadId, input: { kind: 'draft_status_change', latestDraftStatus } })` |

The lifecycle's `set_thread_draft_status` effect *kind* stays (it's the
trigger, emitted from the four reducer sites at
`processingLifecycle.ts:470, 523, 533, 542`); only its runner body
changes from a direct patch to a module call. Symmetric to how the DOI
lifecycle's `fire_topic_subscribed_triggers` effect delegates to the
Topic subscription module.

### Closes drift bugs

1. **Channel/email reopen incoherence** (§1) — `findOrCreateForChannel`'s
   matcher is status-agnostic; the shared `inbound_activity` reducer
   reopens any closed thread uniformly. Channels stop forking.
2. **`messageCount` race** (§2) — read + patch inside one reducer, no
   intervening IO.
3. **Auditless human mutations** (§3) — `status_change` and
   `assignment_change` both fire `audit_log`.
4. **`contactEmail` misnomer** (§4) — renamed to `contactIdentifier`;
   the §4 comment is deleted.
5. **Lifecycle cross-table reach** (§5) — the draft-status effect now
   delegates to the owning module.

### Tests

New test surface at `convex/inbox/threads/__tests__/module.test.ts`:

- **Email find-or-create** — matches by In-Reply-To; falls through to
  References; falls through to normalized-subject; creates on full miss.
  Asserts `action` value each time.
- **Channel find-or-create** — matches most-recent regardless of status
  (the behaviour change: a closed most-recent thread is matched, not
  forked); creates on no-contact-history.
- **Inbound reopen** — `inbound_activity` on a closed thread writes
  `status: 'open'` and emits `thread.reopened_by_inbound`; on an open
  thread emits no audit; `messageCount` increments by exactly one in
  both cases.
- **Status change** — any-to-any accepted; audit row carries `from`/`to`.
- **Assignment change** — assign emits `thread.assigned`; clearing emits
  `thread.unassigned`.
- **Draft status** — `draft_status_change` patches `latestDraftStatus`;
  audit row carries the new value.
- **thread_not_found** — `transition` on a deleted id returns
  `{ ok: false, reason: 'thread_not_found' }`.

The existing `__tests__/inboundMutations.integration.test.ts` and
`__tests__/inboundQueries.integration.test.ts` keep their thread-read
assertions; their direct-patch setup helpers (`threadData(...)` factory)
are unaffected — they build rows, they don't exercise the writers.

### Out of scope for this ADR

- **`inbox/mutations.ts:editDraft`** writes `inboundMessages.draftResponse`
  / `draftSubject`, not the thread. It bypasses the Inbox processing
  lifecycle today (a separate gap). Routing it through the lifecycle is a
  follow-up; this ADR does not touch it.
- **`unifiedMessages` and `inboundMessages` row writes** stay in their
  intake callers. The module owns the *thread*, not the message rows that
  hang off it. Lifting message-row writes into a module fails the
  two-adapters test today — each channel's message row is shaped
  differently and written once.
- **A `messageCount` reconciliation cron.** Deferred — same posture as
  `topics.reconcileMemberCounts`. The in-reducer atomic increment closes
  the live race; a reconciliation sweep lands only if drift is observed.
- **Customer-facing `conversation.*` webhook events.** The thread is an
  internal inbox surface today; no customer subscribes to thread events.
  If that lands, it joins as an effect kind, not a rewrite.
- **The chat-side `chatRooms.linkedInboxThreadId` write** stays in
  `chat/emailLink.ts` — that's a chat-table write that *reads* a thread
  to validate the link target; it does not write `conversationThreads`.

## Consequences

**Closes the channel/email reopen split.** The single most load-bearing
thread decision — what happens on inbound to a closed thread — now lives
in one reducer with one answer. This is a behaviour change for channels
(they stop forking) and is the intended fix.

**Closes the audit gap on human thread actions.** Assignment and status
changes in the shared inbox become auditable for the first time, matching
every other lifecycle module.

**Gives the inbox lifecycle a module to delegate to.** The
`set_thread_draft_status` effect stops being the one cross-table patch
that bypasses an owner module.

**Aligns with the module-family pattern.** Mail draft lifecycle, Topic
subscription, Saved block, and now Conversation thread — same shape:
typed reducer, effect list, single owner of one table's writes.

**Surface area:** roughly net-neutral on production LOC; net-positive
including the new test file.

| Code site | Pre | Post |
|---|---|---|
| `inbox/messages.ts` (thread block) | ~65 LOC inline | ~3 LOC call |
| `webhooks/channels.ts` (thread block) | ~35 LOC inline | ~3 LOC call |
| `inbox/mutations.ts` (assign + status) | ~38 LOC | ~12 LOC (two `transition` calls) |
| `inbox/processingLifecycle.ts` (effect body) | ~5 LOC patch | ~5 LOC delegate |
| New `inbox/threads/module.ts` | — | ~220 LOC |
| New `inbox/threads/__tests__/module.test.ts` | — | ~260 LOC |
| Net | ~143 LOC | ~503 LOC (≈260 of it new tests) |

### Migration

Four phases, each independently shippable.

#### Phase 1 — Schema rename `contactEmail → contactIdentifier`

1. Migration `convex/migrations/0032_thread_contact_identifier.ts`:
   one-pass backfill copying `contactEmail → contactIdentifier` on every
   `conversationThreads` row.
2. `schema/inbox.ts`: rename the field; rename index `by_contact_email →
   by_contact_identifier`; rename the second key column in
   `by_normalized_subject_and_contact` (the index name is unchanged —
   it already says "contact", not "contactEmail").
3. Update the five current readers/writers to the new field name in the
   same commit (the writers are rewritten in phase 3 anyway; this phase
   keeps them compiling). The chat reader at `chat/emailLink.ts:50`
   (`contactEmail === 'internal-chat'`) updates to `contactIdentifier`.

Pre-prod, single org per deployment — the backfill is bounded and the
rename is a breaking schema change landed atomically.

#### Phase 2 — Land the module + audit catalog

1. New `convex/inbox/threads/module.ts` with the three entry points, the
   per-kind reducer, and the effect runner.
2. New audit literals + `conversation_thread` resource in
   `auditActions/catalog.ts`.
3. New tests at `convex/inbox/threads/__tests__/module.test.ts`.

No caller migrated yet — the module is dead code until phase 3. Shippable
(the catalog additions are additive).

#### Phase 3 — Migrate the five writers

1. `inbox/messages.ts:receiveMessage` → `findOrCreateForEmail`.
2. `webhooks/channels.ts:processInboundChannel` → `findOrCreateForChannel`
   (this is where the channel reopen behaviour changes).
3. `inbox/mutations.ts:assignThread` / `updateThreadStatus` → `transition`.
4. `inbox/processingLifecycle.ts` `set_thread_draft_status` runner →
   `transition`.

The channel behaviour change (§1) lands in this phase. Everything else is
behaviour-preserving consolidation.

#### Phase 4 — Remove the dead direct-patch paths

Confirm no `ctx.db.patch('conversationThreads', ...)` or
`ctx.db.insert('conversationThreads', ...)` remains outside the module
(grep gate). The `webhooks/channels.ts:116-122` misnomer comment is
deleted with phase 3; phase 4 is the verification sweep.

**Risk:** one intentional behaviour change (channel inbound reopens closed
threads instead of forking). If a deployment relied on the fork behaviour
for SMS/WhatsApp conversation segmentation, the change is visible as
"fewer, longer threads." The reopen policy lives in one reducer; reverting
for channels would be a per-kind branch there. No risk to email intake
(behaviour-identical), to reads (untouched), or to the agent pipeline (the
draft-status effect produces the same `latestDraftStatus` writes).
