# ADR-0072: The thread brief, one interpretation of every thread

## Status

Accepted (2026-10-07). Built on `feat/thread-brief`. Amends ADR-0051 (the
item coverage gate) and ADR-0061 (no classifier summary on team Updates).

## Context

Before this change Owlat summarised a thread in five places, each with its
own prompt and its own cache:

- the reader's one-line summary strip (`mailThreads.summaryCache`);
- Answer mode's catch-up card, for Postbox and Team Inbox threads
  (`threadCatchUps`);
- Today's one-sentence lines (`todayThreadSummaries`);
- the Team Inbox classifier's `summary` on Updates;
- the quarantined extraction the agent pipeline ran before drafting.

None of them knew what the others had read. None kept state between two
messages, so "Jonas asked for the signed contract" was rediscovered, in
slightly different words, on every surface and on every new message. And none
could say what was still open: a summary retells a thread, it does not track
the obligations in it. The Reply Queue's needs-reply flag and the commitments
list each had a third and fourth view of the same facts.

## Decision

Every eligible message is interpreted once, when it arrives or is sent, into
structured, grounded claims that are kept per thread. Every surface reads
those claims. Nothing else summarises a thread.

### 1. Two modes

Interpretation runs in `brief` mode for personal Postbox mailboxes and in
`actions` mode for every team surface: Team Inbox threads
(`conversationThreads`) and mailboxes whose scope is `shared`. The mode is
read from its source of truth at read time (`resolveThreadMode`,
`modeOfMailbox`), so a mailbox converted to a team inbox stops showing a
personal overview the moment it flips; `scopeChange.ts` cleans up after it.

- **Brief mode** produces the personal Overview: Latest update, Where things
  stand (facts), For you, Waiting on others, Activity, People and Files.
- **Actions mode** produces items only. It writes no facts, no latest lines
  and no overview, because a team surface shows the customer's own words and
  the team's conversation about them, not a retelling.

### 2. Tables

All of them store the thread as `threadKind` plus `mailThreadId` or
`conversationThreadId` (`lib/validators/threadRef.ts`), and each row inherits
its thread's read rule: mailbox access for a mail thread, the shared-inbox
reader role for a team thread (`mail/interpret/threadAccess.ts`). Every
derived string is sealed like a message body (`lib/messageBody.ts`).

| Table                                      | What it holds                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `messageInterpretations`                   | One extraction per source, content revision, extractor version and mode: status, source manifest, sealed payload, pending transitions     |
| `interpretSources`                         | The eligibility snapshot taken when a source is enqueued, the team reply text as sent, and the claim record per source                    |
| `threadItems`                              | Obligations: intent, facets, parties, responsibility, assignee, status, disposition, completion, due, amount, evidence, `counterpartyKey` |
| `threadFacts`                              | Brief mode only: keyed claims with evidence, supersession and conflict links                                                              |
| `threadActivity`                           | Append-only log per thread, with actor, provenance and visibility                                                                         |
| `threadBriefs`                             | One row per thread: revisions, checkpoint, completeness, deletion epoch, counters                                                         |
| `threadViewerState`                        | Per viewer: view override, what they have seen, team stream position                                                                      |
| `draftResponsePlans`                       | Per draft: stances per item, coverage spans, file claims, bound to the draft hash                                                         |
| `threadItemCorrections`, `noteReactions`   | People's corrections (the eval's feedback) and reactions on internal notes                                                                |
| `threadPurgeJobs`, `interpretBackfillJobs` | The resumable erasure and scope-change jobs, and the 30-day backfill                                                                      |

`mailThreads.needsReply` stays, now projected from the interpretation through
the existing `applyResult` path, and `mailThreads.briefTop` is the list-row
projection (top item, counts, first latest line).

### 3. Interpretation

`mail/interpret/run.ts` (`interpretMessage`) runs one source through these
steps:

1. scope (a clearsigned message is read only inside its signed part);
2. segment (`segmentMessage` in `@owlat/shared/mailSegments`: fresh, quoted,
   forwarded, signature and disclaimer segments with stable ids);
3. load the thread's open and recently closed items and current facts;
4. one model call on the `extract` tier, temperature 0, through the spend
   gate (`gate.ts`), metered as `interpret`;
5. ground every quote (`ground.ts`);
6. verify consequential claims on the `guard` tier (`verify.ts`);
7. apply through the reducer (`reduce.ts applyInterpretation`).

The output is a strict union on the mode. A run never throws: a failure
records a `failed` or `partial` extraction, the brief shows it as incomplete,
and an incomplete brief never says "nothing to do". Retryable failures are
repaired with backoff (`retry.ts`).

**Grounding.** Every claim must quote its source verbatim, after NFKC and
whitespace normalisation, inside the segment it names. One failed quote
rejects the claim and marks coverage incomplete. Items must quote a fresh
segment, or a forwarded one the sender delegated. Every derived string is
screened for injection and credential solicitation; a flag restricts what
automation may do with the claim (`needsReview`), and never deletes a security
or payment obligation.

**Verification.** Payments, signatures, access, disclosures, promises,
concessions, cancellations, deadlines, ownership, closing transitions and fact
supersessions are checked by a second, tool-less model call, three claims per
call. A claim that fails is not applied. One that is still plausible is stored
as a proposal (`verify: 'proposal'`), shown as "Check this", and not tracked
until a person confirms it.

### 4. The reducer is monotone

SPEC §4 asked for an out-of-order message to replay the thread from a
checkpoint. We built that, and every review round found another invariant the
rebuild broke: identity merges, rows a person had protected, guards skipped on
reused rows, failed attempts. It was replaced by monotone incremental
application (`fold.ts`), one code path for a new message, a late one and a
repair:

- Identity resolves in a fixed order: an explicit `matchItemId` of this
  thread, then a stored claim key (`lineageKeys`, the per-source claim
  record), then the content hash. A resolved claim merges its evidence. Nothing
  is retired because a later read no longer mentions it; an item whose only
  source stops showing it is flagged for review.
- Status and disposition are each ordered by the message time that set them
  (`statusSource`, `dispositionSource`). An older message adds its quotes as
  evidence and cannot move the item back.
- A person's correction, a confirmed field and a recorded or asserted
  completion are locked. A different value from the model becomes a pending
  update the person can confirm.
- "Done" from the model needs a recorded operation or a verified grounded
  statement (`completion: 'reported'`).
- A transition that names an item the thread does not have yet is kept on the
  extraction and applied when a later fold creates the item.

Every write happens in one transaction with its activity rows, after the
reducer has rechecked that the source still exists at the same content
revision and deletion epoch.

### 5. Personal surfaces

The reader opens a personal thread on its Overview, with an
`Overview | Conversation (N)` switch. The saved default comes first, then the
viewer's per-thread override; a link to a cited quote opens the Conversation,
scrolls to the quote and marks it, and never writes either preference. Short
single mails and security mail open on the original. List rows, the Answer
queue and the Workbench show the top item and the latest line instead of a
snippet or a generated sentence, and a new "To do, no reply needed" band lists
items that need action without a reply. Answer mode shows the brief with item
checkboxes and a stance per item.

"With this contact elsewhere" (`elsewhere.ts`) lists the open, tracked items
the thread's counterparties have in other threads. The key is the item's
`counterpartyKey`, the other side's exact normalised address. The scan reads
only the viewer's own scopes, one index range each: the mailboxes they own
or are a member of (an admin's reach into a teammate's private mailbox is not
one) and the Team Inbox for its readers. No row from anyone else's mail is
read, so nothing about it (not a count, not a "more", not a position) can
reach the card. "Show more" raises the per-person limit to a bound. Aliases
are not joined: that can hide an item, never show one about someone else.

### 6. Team surfaces: the chat stream

A Team Inbox thread, and a shared mailbox's thread, read as one stream
(`teamStream.ts`): the customer's emails as they were written, the team's
replies from their immutable sent content (queued and failed ones marked),
internal notes labelled "Internal", and activity as system lines. The order is
deterministic, with stable ids and pagination across all four sources. Notes
take @mentions and reactions, and `#` links a note to an item. Pinned above
the stream, "Open for the team" lists the actions with their assignee and a
Claim button; items owed by the customer and unclear ones stay visible below.

Internal notes never enter customer mail, quoted replies, interpretation input
or agent prompts. There is no Overview switch on a team surface, and the
classifier's summary line is gone from the header (D7).

### 7. Drafting and the item coverage gate

Drafting takes the response plan: the open items of ours with a stance each
(answer, accept, decline, defer, clarify, skip). A request is never permission
to accept it; prices, deadlines, concessions and disclosures need policy or
the owner's input. The drafter's self-check returns coverage spans per item,
file claims checked against real attachments, and new promises, written to
`draftResponsePlans` against the draft hash. The label is "Addressed in
draft", never "Done".

For the Team Inbox two core auto-send gates follow the handling rules and
precede the plugin gates (ADR-0051 amendment). `interpretation_incomplete`
always holds when the message or the thread was not interpreted completely
(D3). `item_coverage` objects to an unaddressed item, an unclear owner, a
stale plan, an unauthorised commitment or a missing attachment. It runs in
shadow mode by default: its objection goes to `agentShadowDecisions` and the
send proceeds. `agentConfig.isItemCoverageEnforced` turns it into a hold, and
the check then repeats at dispatch. Shadow mode never relaxes an earlier gate.
The Postbox still never auto-sends.

### 8. One summary, so the others go

The duplicates are deleted, with their web callers: the catch-up
(`mail/ai/catchUp*`, `inbox/catchUp.ts`, `CatchUpCard`), the reader strip's
summary mode (`getOrGenerateThreadSummary`), Today's summariser
(`today/summarize.ts`), the agent's quarantined extraction
(`quarantine.ts`) and the classifier summary on team Updates. Ask about this
thread stays: it answers a question, it does not summarise.

The tables and the field they wrote stay in the schema for one release,
marked retired (CONVENTIONS "Expand, migrate, contract"). Migration
`0067_empty_retired_summaries` empties `threadCatchUps` and
`todayThreadSummaries` and clears `mailThreads.summaryCache`; the next release
drops them. Until then thread deletion and erasure keep deleting their rows
(`mail/legacySummaryRows.ts`).

### 9. Mail from before the brief

`mail/interpret/backfill.ts` walks a mailbox's active threads of the last 30
days (D5): a message in the window, not muted, not archived or trashed. For
each thread it starts reading the thread's whole history
(`backfillSources.ts`), newest first, four messages per page, with a durable
cursor on the brief row. The rest of the pages follow in a chain per thread,
and the brief reads partial ("the rest is still being read") until every page
was admitted. Inbound mail goes through `interpretMessage`. Our own sent mail
is admitted only once its transport recorded it sent, and goes through
`outboundRun.interpretSent`, so a recipient that later failed is reconciled the
same way as for a live send. A Team Inbox thread reads the customer's emails
and every reply and follow-up that went out, from its sent-text snapshot; a
reply sent before snapshots existed cannot be read back, and the brief says so
and stays partial. Each source is snapshotted as admitted, so the run's
`not_live` rule does not refuse it; folder, mute and bulk rules still apply.
The walk is one job row per mailbox, started by the owner from Settings >
Reading ("Prepare overviews for recent mail"), or for every mailbox by an
operator:

    npx convex run mail/interpret/backfill:startAll

It reads ten threads per batch and waits a minute between batches, so the
spend ledger has caught up before the next batch asks the gate. It pauses when
the gate refuses (`ai_off`, `budget`) or after 300 threads in one run, and
resumes from its cursor with the same cutoff. Every batch carries the job's
generation, so a batch of a cancelled run never joins the next one, and a
mailbox that is disconnected or purged ends its job (account teardown deletes
it). It schedules interpretation runs and nothing else: no notification, no
Reply Queue write.

The stored completeness the auto-send gates read follows the history too:
`briefCompleteness` (the one rule every writer uses) keeps a complete brief
partial while history is unread or unreadable, so D3 holds Team Inbox
auto-send meanwhile. `brief.get` also says whether a pending history is
`running` or `stalled`; the reader asks to resume a stalled one.

Older threads are interpreted on first open. `brief.get` answers
`completeness: 'none'`, the web shows the Conversation and calls
`mail.interpret.lazy.ensure`, which starts or resumes that one thread's
history, behind the gate and a per-user rate limit. The web remembers a thread
only once the server took it, and retries a refusal a few times.

### 10. Erasure

Purging a message, thread, mailbox or account removes or recomputes every
claim, cache, plan, coverage reference, note link and reaction that depends on
it. A surviving claim keeps only surviving evidence, and is reworded from a
surviving claim or redacted to a neutral line when its wording came from the
purged message. Deletion epochs make an in-flight run write nothing. The work
runs as resumable jobs (`purgeRun.ts`, `threadPurgeJobs`).

## Eval gate

`apps/api/convex/mail/interpret/__eval__/` holds a labelled corpus (71
threads across the slices of plan §14: forwards, inline replies, quoted
history, German, injection, amounts and deadlines with time zones, team notes
and more) and a replay harness over the deterministic parts: scope,
segmentation and grounding. The harness does not run the reducer yet; replaying
the corpus through the reducer (identity, transitions, completion) is
outstanding work, covered meanwhile by the reducer's own unit tests. Run it
with:

    bun apps/api/scripts/interpret-eval.ts [corpus-dir] [--out <file>]

With no model configured it replays the labels themselves (the oracle). Those
numbers measure segmentation and grounding alone and must be perfect, so the
run exits non-zero otherwise. With `INTERPRET_EVAL_MODEL` and
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set it sends every message through
the real interpretation prompt and reports recall, precision, ownership,
evidence validity, the unsupported rate and cost, without gating. Either way
it writes the metrics to a report file (`__eval__/reportFile.ts`), by default
`apps/api/.interpret-eval/report.json`, which is git-ignored, so two runs can
be compared. The 1,000-thread corpus the plan asks for is follow-up work.

## Owner decisions

The product owner accepted every recommendation of plan §16 on 2026-10-07:

- **D1.** Users who had auto-summarize off keep Conversation as their default
  view (`resolveThreadDefaultView`).
- **D2.** The Postbox interprets all eligible inbox mail, not only Reply Queue
  candidates.
- **D3.** Incomplete interpretation holds team auto-send from the first phase
  (`interpretation_incomplete`).
- **D4.** Items have their own assignee, defaulting to the thread's assignee
  when the item is created; the UI shows Unassigned until then.
- **D5.** The backfill covers active threads of the last 30 days; older ones
  are interpreted on first open.
- **D6.** "Overview" in the UI, "brief" in code.
- **D7.** The ADR-0061 classifier summary is dropped from team Updates; the
  rows show the subject and the sender's first lines.

## Consequences

- One model call per message replaces up to five summary calls per open, and
  the result is reused by every surface and by the agent pipeline. Opening a
  thread costs nothing once it is interpreted.
- Everything shown is grounded in a quote a reader can open. That costs a
  second, cheaper call for consequential claims, and some true claims end up
  as proposals a person has to confirm.
- The monotone reducer cannot undo a status a later message set when an older
  message arrives late; the late message only adds evidence. We accept that:
  the alternative rebuilt state it could not reconstruct.
- A thread that was never interpreted shows its Conversation until the
  backfill or the first open reaches it. A spent budget leaves briefs
  incomplete and says so.
- Team auto-send now depends on interpretation. While the coverage gate is in
  shadow mode only the incomplete-interpretation hold is new; enforcing
  coverage is a later, per-instance decision based on the shadow log.
- Old browser tabs from the previous release lose the catch-up card and the
  summary strip at deploy: their calls fail and both fail soft. The retired
  functions were not kept as previous-release shims.
- Cross-thread items match exact addresses only. A contact who writes from
  two addresses shows as two people.
