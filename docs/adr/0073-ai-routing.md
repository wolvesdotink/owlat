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
