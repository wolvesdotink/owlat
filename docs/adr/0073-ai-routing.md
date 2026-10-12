# ADR-0073: AI routing, admission and the task-policy catalog

## Status

Accepted on 2026-10-11, when the owner accepted all thirteen recommendations of
the AI routing plan (`docs/plans/ai-routing-plan.md`, revision 9). This ADR
records the architecture the plan builds. The contracts it names (schema,
validators, the routing-policy record and the task-policy catalog) ship first;
the behaviour lands in later steps of the same branch, each behind the default
posture in decision 4.

It extends ADR-0060 (the decision plane) and does not reopen it. Decision 8 of
ADR-0060 still holds: a calibrated probability belongs in the host's gates only
through the block-only rule in decision 8 below.

## Context

Every priced model call in Owlat writes one row to `llmUsageEvents`, and the
owner made that ledger the single source of settled spend on 2026-10-06. Three
things around it were missing.

1. Nothing reserved money before a call. `analytics/spendBudget.ts` summed at
   most the newest 12,000 ledger rows of the month and allowed the call when it
   could not compute the total. Concurrent calls overshot the ceiling, and the
   Team Inbox kept drafting past it.
2. Nothing said which model a task may use, within which limits. Each call site
   picked `fast` or `capable` through a seven-value `LLMTask`, with no output
   limit on structured calls and no root deadline.
3. Embeddings carried a constant model stamp whatever model wrote them, and
   retrieval compared vectors from different models after a switch.

The plan also adds cheaper routes (deterministic stops, decision bundles, a
cheap writer first). Each of those changes what a message costs and, if done
carelessly, what happens to it.

## Decision

### 1. The ledger stays the only settled spend

`llmUsageEvents` keeps one row per provider request, failed attempts and the
decision adapter's inner retries included. New optional columns
(`lib/llmUsageTags.ts`, `llmUsageRoutingFields`) say which logical request a
row belongs to (`rootRequestId`, `parentCallId`, `requestId`, `attempt`), which
task and policy version routed it, who answered (`endpoint`), the usage the
three token totals do not break out (cache reads and writes, reasoning), the
latency, the quality result, the price catalog revision, whether the cost is a
conservative estimate, the integer cost in micro-USD, the budget class and the
admission reservation.

`llmSpendPeriods` holds settled totals per UTC day and month, per plane and
budget class. It is derived only from the ledger. The mutation that inserts a
ledger row adds the row's micro-USD to its two buckets in the same transaction,
and a rebuild can recompute every bucket from the ledger alone.
`llmSpendAggregateState` says whether the buckets are complete. Admission reads
these totals, never a truncated scan, and refuses paid dispatch while they are
not `complete`.

### 2. Reservations are holds, not spend

`llmReservations` holds the money a call may still spend. A caller reserves the
whole allowed path (every attempt, any quality escalation) in integer micro-USD
under an idempotent `reservationId`, before the provider is called. Admission
checks settled totals plus outstanding `held` reservations against the ceiling
in one mutation, so concurrent admissions cannot overshoot.

Settlement writes the ledger row first (reported usage, or a conservative
estimate marked `isEstimated`) and then marks the hold `settled`. A call that
never reached a provider is `released`. A hold whose action died is settled by
the expiry sweep as `expired`, charging the reserved amount minus the rows it
already wrote (found through the ledger's `by_reservation_id` index). No code
ever sums reservations as spend.

The ceiling is deployment-wide, because each deployment hosts one organization.
Language, decision and embedding capacity are separate planes, so a decision
outage cannot use up the writer budget.

### 3. What happens at the ceiling (D1)

A triage allowance (`triageAllowanceFraction`, default 0.1) is held back inside
the daily and monthly ceilings. Paid guard and classify calls (budget class
`triage`) may use it; everything else stops short of it.

Once either ceiling is exhausted the Team Inbox runs the deterministic safety
checks only, marks the judgments it is missing, blocks auto-send and queues the
message for a person with a visible reason (`inboundMessages.budgetHold`).
Paid drafting, clarification and user-triggered features need admission and
return a clear budget error when refused. Background work defers. When the
spend or reservation state cannot be verified, new paid dispatches are refused;
the old gates allowed them.

### 4. Default posture and the routing policy

Everything the plan says needs an evaluation, live data or separate approval
ships off or in shadow behind a switch in the routing policy. The policy is one
stored row (`aiRoutingPolicy`). A missing row and a missing field both mean the
default, and every default is today's behaviour. The switches, their values and
the pure resolver live in `@owlat/shared/aiRouting`, so the settings form and
the backend read one vocabulary. Saving is admin-only, validated, compare-and-set
on `policyVersion` and audited (`ai_routing_policy.updated`). Every save bumps
`policyVersion`, which artifacts and ledger rows record.

Shadow traffic costs money, so it runs inside its own allowance (D4): at most
`shadowMaxMessageFraction` of eligible messages and `shadowMaxCeilingFraction`
of the daily ceiling, at background priority, under budget class `shadow`. A
deployment without a daily ceiling cannot set any switch to `shadow` until it
sets a finite `shadowCapUsd`.

### 5. The routing ladder

Each message climbs the same ladder and stops at the first rung that settles
it: host code, then the decision plane for bounded questions (when
`ai.decisionPlane` is on and a non-language provider is configured), then one
admitted fast-tier call, then the capable tier. A rung runs only for work the
message still needs. Deterministic stops run before the first paid call they
would make pointless. Work whose only consumer is a screen runs when the screen
opens (D10). A stored answer is reused only while its evidence, scope, versions
and expiry still hold, and sender identity alone never settles a new message
(D12).

### 6. The task-policy catalog

`lib/llm/taskPolicy.ts` gives every task a plane, the tiers it may run on, input,
output and reasoning limits, a deadline, an attempt budget, an eligible
fallback, a budget class, a priority, an evaluation version and the ledger
`feature` tags its calls record under. Task names are dotted (`mail.classify`,
`mail.draft`, `assistant.answer`) and shared with the web app.

The first values reproduce the routes of 2026-10-11 exactly; a test pins the
call-site inventory. A limit of `null` means there was none that day. Later
changes go through the catalog, with an evaluation behind them, rather than
through call sites. The catalog is task routing. `lib/llm/requestPolicy.ts`
stays SDK wire compatibility.

### 7. Fallback and degradation (D3)

Missing, malformed, rejected or undecryptable credentials, invalid provider
configuration, consent denial, codec refusal and exhausted caps are terminal.
They never trigger another paid provider, even when fallback is enabled; the
caller keeps its deterministic baseline or goes to human review. An explicitly
configured decision provider that fails this way is not relabelled as the
language-backed `llm` adapter. Only a deliberately configured `llm` kind runs
on the language plane as its primary.

Operational failures (timeouts, 5xx, throttling) may take at most one fallback
hop, through the breaker and admission, and only where the task's catalog entry
allows `language_hop`. No inbound background task does. The mixed-vendor
OpenRouter defaults (D7) do not enable cross-vendor fallback.

### 8. Decisions and auto-send

A decision result may restrict auto-send and never widen it. It counts toward
`resolveAutoApproveScore` only with compatible adapter provenance and a valid
task and language calibration stamp (`decisionArtifacts.calibration`). The
block-only gate for stale or uncalibrated verdicts joins
`CORE_FINAL_AUTO_SEND_GATES`; nothing feeds it a verdict by default, so it
blocks nothing on day one. All existing gates stay.

No decision output drives a destructive action in this work (D9): not Spam
movement, archival, reply suppression or autonomous quality scoring. Reply
disposition is advisory. Decision artifacts store labels and their provenance,
never message text, and only a `complete`, uninvalidated artifact is reused.

### 9. Embedding provenance (D8)

`embeddingSpaces` records each vector space by identity: provider, secret-free
endpoint, model, native dimensions, and the revision (artifact digest and
quantization for local models). Embedding rows stamp the space they were written
in and where that came from: `measured` by the writer, `record` from retained
deployment records, or `attestation` from an operator, kept as what it is in
`embeddingAttestations`. Vector search filters to the active space; rows with
no space are unknown, stay findable through full-text search, and come back
through the re-embed job. Local re-embedding runs without admission; a paid one
is started by an admin and admitted.

Each embedding table has two vector columns. A staged rebuild writes the new
space into the column the active space does not use, activation flips the
active space in one write, and rollback flips it back.

The active space is the configured one. A settings or environment switch is
allowed on a populated corpus: the new space registers and activates with its
first committed vector, in the column the previous space does not use, so the
previous vectors survive for a switch back. A vector committed under a
configuration that has since changed is dropped. Activating a staged rebuild
also switches the stored embedding selection, in the same transaction.

Each column has one owner, the space that claimed it last (`columnClaim`), and
only the owner writes it. A space's stored vectors are reused (a reactivation,
a rollback to the recorded predecessor, a re-stage) only while it still owns
their column; a space that lost its column is superseded and re-embedded.
Vectors are never copied between columns. Every write of a row's embedding
input, eligibility or stamps goes through one writer (`patchCorpusRow`): a
changed input clears every column the write does not fill, and a write that
leaves a row eligible without a staged vector marks the staged rebuild, which
activates only after a pass that started after the last such mark. An
endpoint's identity is its origin plus a digest of the rest of its canonical
base URL, the same URL the client dispatches to, and whether it is paid
follows the ledger's locality rule (an OpenAI-wire endpoint on a private host
is local), decided again from the embedder about to be called. The same
locality decides the revision probe: every local endpoint, whatever its kind
or `LLM_PROVIDER`, is asked for the model's revision before and after each
call, and a server without Ollama's tags API leaves it unknown, which is an
identity of its own.

### 10. Guard placement (D13)

The deterministic injection, smuggling and URL checks run on every Team
message, and the model guard runs before interpretation and knowledge
extraction. The guard is skipped only for mail archived on its spam score and
mail that arrives while the agent is off. The skip is recorded
(`securityFlags.guardNotRun`), and `lib/aiRouting/guardRecord.ts` requires the
guard before any later autonomous processing of that message.

### 11. Task routing, the cheap-first writer and the auto-send contract (Phase 4)

**Task routing.** Every resolver call names its catalog task. The resolver
takes the tier from the task's `tiers` (`lib/llm/taskRouting.ts`) and refuses
a tier the catalog does not list for it. The resolver stamps the tier on the
model, and the dispatch refuses a model whose tier the call's task does not
allow, before any request. A test pins every resolver call in the backend
against the tier it resolved before the catalog existed, so no route moved.

**Cheap-first writer (D2).** It applies only to a reviewed draft. Today that
means a Team Inbox draft written while shadow mode ("Draft only") is on,
because then the route step sends nothing. The routing policy's
`cheapFirstWriter` switch is off by default. With it at `reviewed`, a message
the corrected intent allowlist (`TRIVIAL_INTENTS`) finds formulaic, with the
existing certainty and priority guards, starts on the fast writer, without
tools. The host's quality check scores the draft. When the draft is unusable
(tool-call markup, or cut off at its ceiling) or the check returns a verdict
below the bar (complete, grounded, 0.8 or above), the capable writer drafts
exactly once from the same messages, and that draft is checked and kept
whatever its score. An unknown verdict keeps the fast draft. A provider or
configuration failure of the fast pass ends the writer with that error, as it
ends today's single pass, and buys no escalation. A person reviews every
draft this path writes. With a plugin strategy selected, the single pass runs.

The plan's rule is to reserve the whole allowed path first, so the writer
holds the worst case of all four calls (both drafts, both checks) before the
first one. Each request is bounded before it exists: a draft's prompt is the
draft's own messages, and a check's prompt is the context, the plan and a
draft of at most 64 KiB (a longer draft is not checked). Every call runs under
that one hold, so none can be refused after paid work. The writer settles the
hold once against the requests the path made. A refused hold refuses the draft
before any paid call. Each call writes one ledger row per request, with its
quality result (`passed` or `escalated` for the fast draft; `passed`, `failed`
or `abstained` for the escalation, whose parent call is the fast draft).

A cheap-first draft never auto-sends. The draft step stores
`inboundMessages.isCheapFirstDraft` in the same mutation as the draft, the next
draft clears it, and the `cheap_first_draft` gate in
`CORE_FINAL_AUTO_SEND_GATES` refuses it. Turning shadow mode off between the
draft and the route step therefore cannot send it. Postbox and Answer mode
drafts are reviewed too, but they have no trusted classifier signals to judge
eligibility from, so they keep today's writer.

**Answer mode.** `mail/ai/composeDraftWrite.ts` now runs on `runSharedDraft`,
streamed into the owner's buffer and without a self-check. It keeps its
injection refusal, its markup retry, its handling of a draft cut off at the
output limit, and its budget error. Ledger writes follow the shared service:
it writes every request on every exit, and a failed ledger write no longer
fails a finished draft.

**The auto-send contract.** A decision verdict may enter
`resolveAutoApproveScore` only as an admitted score
(`lib/decision/autoSendContract.ts`), and only to lower it: the route compares
the minimum of the draft's score and every admitted verdict. A verdict is
admitted only when all four hold:

1. its task is listed in `AUTO_SEND_VERDICT_TASKS`;
2. item coverage is enforced (`agentConfig.isItemCoverageEnforced`);
3. it passes the block-only rule of decision 8: a complete, current advisory
   answer from the decision plane configured now, from a calibrated adapter,
   with the checked-in calibration revision for its task and the message's
   language;
4. its score is a probability.

Item coverage is the plan's prerequisite for any decision-driven autonomous
input. While any task feeds auto-send and coverage is not enforced, the
`decision_verdict` gate holds every send, and the agent settings refuse to
switch coverage off. `AUTO_SEND_VERDICT_TASKS` and `CALIBRATION_REVISIONS` are
empty in this release, so no verdict reaches the score and the route passes
none. Draft quality (`mail.draft_quality`) is registered in the question-set
catalog so the eval and the conformance suite use the production wording.
Production does not ask it (D9). Feeding it later takes a calibration report,
a revision per language, the task in `AUTO_SEND_VERDICT_TASKS`, enforced item
coverage, and the route step passing admitted scores.

### 12. The assistant, nested tools and provider batches (Phase 5)

**Per-turn caps.** The catalog entry carries `maxToolRounds` and
`maxRetrievalCalls`. Both are null for every task except `assistant.answer`,
where both are 8, the step limit every turn already ran with. The dispatch
stops a tool loop or a tool-calling stream at the tighter of the caller's step
limit and the task's rounds (`lib/llm/taskLimits.ts` `toolRoundLimit`). The
tool host gives each turn one retrieval allowance, shared by the knowledge
and file searches (each one a paid query embedding). The count is taken when
a call starts, so parallel calls in one round cannot overshoot it. A call
past the allowance is refused before it searches, and the model reads the
refusal as the tool's result. The knowledge search is offered only while
`ai.knowledge` is on, as Quick Query refuses it otherwise (#1335).

**The root's priority.** A root may carry an admission priority
(`LlmRootContext.priority`), and every call under it is admitted at that
priority unless its own target names one. The assistant turn and Quick Query
roots are `interactive`. Without this, a nested retrieval embedding was
admitted at its catalog priority, `pipeline`, which may spend past the
advisory reserve that stops the turn itself: a user could buy through a tool
what the turn could not buy. Roots that set no priority (Team, files, Postbox)
keep each call's own priority.

**Holds are per request.** Each request of the turn and of its nested tools
is reserved before it leaves, under the turn's root, with the turn's request
as the parent (§2). One hold for the whole turn would need a bound on the
whole tool loop. That bound does not exist: tool results are unbounded, so the
input of each later round is too. A Stop, noticed on the next row write or by
a once-a-second check while no stream event comes, aborts the stream and every
nested draft still running. Their requests are written anyway, so billed usage
is kept, and unknown usage is settled at the request's own bound.

**Budget refusals are codes.** An assistant answer, an @assistant reply or a
visualization refused for budget stores
`budgetRefusal: { code: 'AI_BUDGET_EXHAUSTED', reason }`, never the English
sentence. The web says it in the reader's language.

**Provider batch APIs (L14, `batchApi`, default `off`).**

- _Scope._ Non-interactive structured calls: knowledge extraction from a Team
  message, a file and a Postbox message (which the backfills and the mailbox
  import run), and file summaries (attachments are semantic files).
- _Providers._ Only adapters with a batch API Owlat speaks: the native OpenAI
  endpoint (Batch API) and the native Anthropic endpoint (Message Batches).
  Azure, Google, OpenRouter, compatible and local servers, and any explicit
  base URL stay real-time.
- _One request per provider batch._ The provider holds the prompt; Owlat stores
  ids and states only (`llmBatchItems`). The batch request is captured from the
  real-time structured call on the adapter's own model with an in-process
  `fetch`, and the result is read back through the same call. The wire body
  and the parse are therefore the real-time call's.
- _Reserve at full price, settle once._ The item and its hold are written in
  one mutation. The item stores the request's bound at the full real-time
  price (`requestBoundMicrousd`), and the hold, when a ceiling is configured,
  is that bound and lives for the 24-hour completion window plus a grace.
  Every terminal transition writes the request's one ledger row and settles
  the hold, if there is one, in the same mutation:
  - a result: its reported usage;
  - zero, only when the request's own result record says it was not billed
    (an error response, or a per-request expired or cancelled record), or the
    provider refused the submission outright;
  - the full bound whenever billing is unknown: an ambiguous submission, no
    result by expiry, or an ended batch whose output has no usable line for
    the request (a batch's own `expired` or `cancelled` status is not
    evidence about one request).

  The bound is on the item, so this holds with no ceiling configured, when
  nothing is reserved.

- _Price._ OpenAI's Batch API and Anthropic's Message Batches API each bill at
  50% of the standard price (confirmed for both). A batch row's endpoint is
  marked `+batch` and priced at half the list rate (`BATCH_PRICE_FACTOR`).
  Holds stay at the full price, so they always cover the row.
- _Not batched._ Assistant and other interactive calls, Team pipeline steps,
  interpretation and its history backfill (one run hold covers the extraction
  and its verifier), and embeddings.
- _Fallback._ With the switch off, or an adapter without a batch API, the
  call is the real-time one. One batch attempt is made per source. A
  definite refusal of the submission sends the call real-time at once. A
  result that is unbilled, unparseable or cut off hands the source back to the
  real-time path once. A usable result continues through the existing paths:
  the extraction's resume marker, or file processing re-run with the summary.
- _Guards at resume._ A result is kept only if the live path would still read
  its source now: `ai.knowledge` on, a Team message not held back by the guard
  since, Postbox mail not moved to Spam, Trash, Sent or Drafts. The check runs
  in the transaction that would keep the result, and the mail resume runs it
  again. A refusal drops the result; the item still writes its row and
  settles, because the batch was billed. Only mail in an extractable folder is
  batched, so imported Sent or Trash mail stays real-time.

## Consequences

- Upgrading changes no route. The new columns are optional, the policy defaults
  are today's paths, and the catalog repeats today's tiers. The spend aggregate
  starts `unreconciled` and needs a rebuild before admission can admit paid
  calls against a configured ceiling.
- Decision artifacts and sender memory are content-derived. They are erased
  with their message, mailbox or Team contact, and every row carries an
  `expiresAt` the daily retention sweep enforces.
- The ledger gains one index (`by_reservation_id`); every other new column is
  read from a bounded slice, like the existing tags.
- The calibration and agreement reports, thresholds from real data, canaries
  and provider-backed smoke tests are out of scope here. They need keys, money
  and live traffic; this work ships the tooling for them.
