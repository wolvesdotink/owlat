# ADR-0061: Response disposition — classify first, draft only what expects a reply

## Status

Accepted.

## Context

Every non-spam inbound message walked the whole agent chain: classify,
clarify, draft, route. A shipping notice, an order confirmation, a "thanks,
that fixed it" all produced a draft nobody would send and a row in the review
queue somebody had to clear. The classifier already emitted an `information`
intent; nothing read it. The personal Postbox had a real needs-reply verdict
(`mail/needsReply.ts`), the shared inbox had none.

Three smaller gaps sat next to that one. The draft prompt said nothing about
language, so an organisation whose tone guidance is English answered German
customers in English. The clarify step dropped the slot extractor's suggested
answers on the floor and asked its questions in whatever language the model
chose. And when the agent parked a message waiting on a person, nobody was
told; the row sat in the review queue until someone looked.

## Decision

### 1. The classifier decides whether a reply is expected

`agent/steps/classify` returns, in the same structured call it already made:
`needsResponse`, `language` (ISO 639-1), `importance` (0–1) and one
`summary` sentence per interface locale (`APP_LOCALES`). The prompt frames the
context as untrusted data behind `SYSTEM_GUARD`; every free-text field is
bounded and scrubbed before it is persisted, and `language` is allowlisted
(`safeLanguage`) before any later step may place it in a system role.

The verdict is one-sided by design. `resolveResponseDisposition` returns
`informational` only when the model said no response is needed **and** it was
at least 0.6 confident **and** the message is not a complaint, not urgent, not
an escalation, and its intent is `information` or `acknowledgment`. A question
or a request always takes the reply path whatever the boolean says. Missing a
reply the sender was waiting for is the expensive failure; an unneeded draft
costs a review-queue row.

The same call also names the **kind** of mail, orthogonal to the topic
category: `personal`, `update`, `notification`, `receipt`, `newsletter` or
`advertising`. The four bulk kinds never expect a reply whatever intent label
they got, so they are informational under the same safety rails; they are what
splits the dashboard into tabs.

### 2. `informational` is a lifecycle state, not an archive reason

The lifecycle (ADR-0010) gains a thirteenth state. `classifying →
informational` ends the pipeline for that message: no clarify, no draft, no
route, so nothing can auto-send. Knowledge extraction still fires on that
edge; an update the organisation never answers is still something it learned.
Two edges lead out, both human: `informational → archived` (reason
`update_dismissed`) and `informational → drafting`, which re-enters the draft
step through `walker.resumeDraft` exactly as an answered clarification does,
and lands in the review queue like any other draft.

An archive reason would have hidden these messages behind the same label as
spam. A state keeps them queryable on the existing status index, countable in
`inboxStats`, and visible with an honest label.

### 3. The Updates dashboard reads it

`inbox/updates.ts` ranks the informational rows deterministically
(`importance`, then priority, then recency) and the team-inbox page
`/dashboard/inbox/updates` walks them keyboard-first, showing the summary in
the reader's interface language. Four tabs split the rows by kind: Updates (a
human keeping us informed), Promotions (advertising, newsletters),
Notifications (automated mail, receipts) and Spam. Dismiss and "draft a reply"
are the two actions on the first three, both audited
(`inbound.update_dismissed`, `inbound.reply_requested`). The Spam tab lists
what the classifier archived as spam — the lifecycle now persists
`archiveReason` on the message for that — and offers only "block sender",
because `archived` is terminal. No model call sits between the classifier's
verdict and the dashboard, so the page cannot fail-open into hiding something.

The personal Postbox gets the matching split on its own category classifier:
`promotion` (a sale or discount pitch from a sender the owner never wrote to)
and `spam`. A `spam` label moves the thread's inbox messages to the Spam
folder the moment it is applied; recategorizing a spam thread as anything else
brings them back and the per-sender override stops the classifier from filing
that sender as spam again. The owner stays in charge of both directions.

### 4. The reply is written in the sender's language

`runSharedDraft` accepts `replyLanguage`. The system prompt always instructs
the model to write the entire reply, signature included, in the language the
sender wrote in, and names the detected language when known; the alternative
review drafts carry the same instruction. Postbox passes nothing and gets the
generic rule. Along the way the draft step's classification allowlists were
brought back in line with the classifier's enums — they had drifted so far
that `urgent`, `normal`, `feature_request`, `complaint` and `information` were
all rewritten to `unspecified` before reaching the drafter.

### 5. The person is asked in their own language, with suggestions

The clarify step keeps the slot extractor's `options` (bounded, credential
solicitations dropped) and, for the questions it actually asks, runs one
cheap translation call (`inbox/clarificationLocalize.ts`) into every
non-English interface locale. Translations ride on the question as
`translations[]`; the canonical English copy stays what is stored, matched by
answer-memory and quoted in `[CONFIRMED BY OWNER]`. The UI renders the entry
for the current locale and maps a picked chip back to its canonical value on
submit. The Postbox Reply Queue refinement takes the same helper.

The suggestions are answers you click. The shared chip component says so in a
lead-in line, marks the picked chip, and reads the answer back under the row,
so a click visibly "takes". Answer-memory keeps the same scenario handled the
same way: a question the person answered before arrives with that answer
pre-picked and labelled "last time", and a card whose questions memory answered
in full drafts without asking and shows which answers were reused above the
draft. The person stays in charge — any other chip, or typed text, replaces the
pre-pick and the correction becomes the new standing answer.

### 6. The person is told

`classifying → awaiting_clarification` emits a `notify_clarification` effect.
The runner appends one `inboxAssignmentNotices` row of kind `clarification`
per recipient: the message's assignee, else the thread's assignee, else every
shared-inbox reader. The client surfaces it through the existing assignment
notice channel (toast plus desktop notification) with its own copy; a
clarification is never coalesced into an assignment burst.

## Consequences

- Mail that expects no reply produces no draft and no review-queue row. The
  gates of ADR-0051 are untouched: the new state has no edge into `approved`.
- A wrong "no reply" verdict is recoverable from the dashboard in one click
  and shows up in the audit log; a wrong "needs reply" verdict costs what it
  cost before.
- Rows classified before this change have no `needsResponse`; they read as
  "needs a response", which is the old behaviour.
- The classifier call returns more text (two summary sentences), on the fast
  tier. The translation call happens only when a question is actually asked.
- The `informational` counter in `inboxStats` is optional, so existing
  singleton rows need no migration.
- Plugin draft strategies (ADR-0050) do not receive `replyLanguage`; the host
  `default` strategy does. A plugin that ignores the inbound language is a
  plugin defect, not a host one.
