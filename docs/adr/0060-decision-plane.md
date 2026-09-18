# ADR-0060: The decision plane — a third provider plane, and the contract its dispatch keeps

## Status

Accepted. Records the architecture **and** the dispatch contract of the decision
plane as built: the question DSL, the adapter registry, `runDecision`, the
resolver, and the opt-in posture around all four.

It supersedes nothing. It does **not** reopen ADR-0051's restrict-only gate
registry — where a calibrated probability belongs instead is written down in
decision 8 below, precisely so the next person does not reach for the gates. It
extends the seam ADR-0029 describes from one dispatch module to one dispatch
module **per plane**, with the same retry, usage-normalisation and abort shape.

## Context

Owlat runs two provider planes today. **LANGUAGE** is everything that writes —
drafts, replies, summaries, the assistant. **EMBEDDING** is retrieval, local by
default so it resolves under any language choice. Both go through
`lib/llmProvider.ts` and a registry of one-file adapters guarded by a mapped-type
assignment (`lib/llmProviders/index.ts`), the pattern the pluggable-LLM docs page
describes.

There are 40 LLM dispatch calls across 25 files. Fourteen of them are not writing
anything. They ask a text model to pick a label — a category, a priority, an
injection verdict, "does this need a reply" — and then ask it, in the same JSON
object, how sure it is. That second field is the problem. A model's self-reported
confidence is generated text about itself: it is not measured against anything,
it is not comparable between two calls, and every threshold the product reads off
it (`LLM_INJECTION_CONFIDENCE_THRESHOLD`, the auto-approve score, the clarify
short-circuit) is a number placed by eye on a scale that does not exist.

A decision provider answers the same question differently. You send a state and a
map of named questions; you get back one typed answer per question, each carrying
a **probability distribution over the options you sent**, calibrated across
groups of predictions. There is no prose, no token stream and no schema to
validate, because the answer space is the set of options in the request.

Two properties of that make it worth a plane rather than a call site.

- **The distribution is the product.** A number that is calibrated across groups
  is a defensible input to a gate in a way a self-report never was. It is not a
  correctness guarantee — the vendor says so plainly, calibration "does not
  guarantee that an individual answer is correct" — but it is the difference
  between a threshold that can be derived from a measurement and one that can
  only be argued about.
- **Probability is not confidence.** Choice and Score return a distribution plus
  a derived confidence (how peaked that distribution is). A yes/no question
  returns a bare probability and **no** confidence field at all. Any threshold we
  write has to name which one it reads: a yes/no threshold is distance from 0.5,
  a Choice threshold is peakedness. Collapsing the two into one "confidence"
  field is exactly the mistake the self-reports made.

### Why not a fourth adapter behind the existing LLM provider

Because the seam it would have to fit through destroys the thing we came for.
The language plane's contract is the AI SDK's `LanguageModel`, consumed through
`generateObject`. A decision endpoint has no completion to return, and wrapping
it so that it looks like one means throwing the probabilities away at the
boundary and handing the call site back a parsed object indistinguishable from
what it already had. The tier machinery does not fit either: there is one model,
pinned, with no fast/capable split to route between.

The two shipped adapter shapes already differ from each other — the embedding
adapter has no `listModels`, no per-tier models, and carries an extra dimension
guard — so "like its neighbours" was a choice to be made rather than a shape to
be inherited. Made here, once: the decision adapter follows the **language**
shape, minus tiers.

## Decision

### 1. A third plane, built like its neighbours

`lib/decisionProvider.ts` resolves it; `lib/decisionProviders/` holds the
registry, the two adapters (`typesafe`, `llm`) and the wire codec; `lib/decision/`
holds the question DSL, the dispatch and the plane's pricing. The registry is a
`const … as const` object behind the same mapped-type assignment the other two
planes use, so a missing adapter method is a compile error and a third adapter is
one file plus one registry line.

`lib/decisionProviders/types.ts` and `lib/decision/questions.ts` are **pure**, and
that is load-bearing rather than tidy: `schema/instance.ts` imports the
validators, which import the registry's kind tuple. Nothing on that chain may
pull in `node:crypto` or `@ai-sdk/*` without breaking the Convex isolate that
evaluates the schema. Every call site that will eventually use the plane is
already `'use node'`, so the constraint is about the schema chain, not the
callers.

### 2. The question DSL is the contract; the wire shape stays in one file

Call sites import `runDecision` and their own question set built from `noul()`,
`choice()` and `score()`. They never import an adapter. The one adapter property a
call site may read is `calibrated`, and it must read it rather than assume it,
because it is the flag that says whether a threshold means anything on this
answer.

Our answer type is deliberately **not** the vendor's response shape.
`decisionProviders/wire.ts` owns that translation in one place — the way
`normalizeUsage` owns the AI SDK's field-name history in `lib/llm/dispatch.ts` —
so a vendor renaming a field is a one-file change and no call site ever spells
`legend` or `input_tokens`.

### 2b. Every question set is registered, and both adapters answer it the same

`lib/decision/catalog.ts` is the one list of what the product asks. It exists for
the promise the plane rests on: any adapter answers any question set, so
reverting the vendor is a dropdown. One vitest suite drives the whole catalog
through **both** adapters — the native one against a synthesized wire body, the
language-backed one against a stubbed `runLlmObject` — and asserts identical
answer keys, identical `kind` per key, identical value domains and identical
probability key spaces, with `calibrated` the only thing allowed to differ.

A set built inline at a call site is a set no conformance run ever put through
the language-backed path, and the day the vendor is unreachable is the day that
is discovered. The Score legend is where that gap first opened: the
language-backed adapter keys a Score's probabilities `'1'..'N'`, so the codec now
refuses a legend keyed any other way rather than accepting the vendor's own
words — which also keeps the out-of-range check alive, since it can only be
stated over numeric keys.

### 3. The dispatch contract

Everything below is `lib/decision/dispatch.ts`. It is written out here because
these are the behaviours a later reader will otherwise assume, and each one was
chosen against a specific failure.

| Behaviour                    | The rule, and why                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deadline**                 | Every request carries one. `fetchGuarded` passes `init` through and adds no timeout of its own, so a plane sold on sub-second answers would otherwise inherit an unbounded socket. The default is per adapter (10 s native, 60 s language-backed): one number cannot be both tight for the native endpoint and generous to a chat model doing the same job. |
| **Retry**                    | Classified by the repo's one classifier, `isRetriableLlmError`, not a fork of it — 429 and every 5xx (529 included) retry, 401/403/404/422 do not. Backoff is exponential, capped, and **jittered**, which the language plane is not: one shared upstream bucket plus our synchronized ingest is the exact shape that turns one 429 into a retry storm.     |
| **Our own limiter refusing** | Terminal, and not a provider failure. A refusal from the `decisionPlaneGlobal` bucket is wrapped in `DecisionRateLimitRefusal`, which is not retried (the bucket a retry would charge is the one that just said no), is not charged to the breaker, and may not hop. Otherwise a busy minute drives the breaker open and then refuses the hop through the five minutes of real failures that follow — and, worse, answers the volume we just declined to serve on a model that costs 24 to 50 times more. |
| **`Retry-After`**            | Authoritative when the vendor sends it — it replaces our curve rather than being added to it, within a ceiling. Past that ceiling the vendor is naming a time no surface can be held open for, and the call fails instead of sleeping. Their rate limits are documented as dynamically adjusting, so nothing hard-codes a request-per-minute number.        |
| **Abort**                    | The caller's signal rides into the adapter and also cancels the backoff between attempts. A cancellation is never retried and never falls back: it is not a failure of the provider. `runLlmObject` took no signal at all before this work, which is why widening `LlmObjectOptions` shipped in the same phase — half the seam was uncancellable.           |
| **Partial or foreign answers** | A missing requested key, an extra key, or a Choice value outside the criteria we sent is a **hard error** (`DecisionWireError`), never a coerced answer and never a retry. It means our question set and the answer disagree; repairing it silently would corrupt the calibration statistics every later phase gates on, and re-asking only pays to disagree again. |
| **Fallback**                 | At most **one** hop, to the language-backed adapter, and only when the caller passed a resolved fallback plane **together with a breaker and a usage recorder** — `runDecision` refuses a `fallbackTo` that arrives without either, because `resolveDecisionFallback` hands out a ready-made plane and one forgotten line would otherwise buy an uncapped, unrecorded hop. No fallback plane, no hop — that is what "off for the high-volume background classifiers" compiles down to. Refused after 401/403/422, after any codec refusal, and while the breaker is open (see 4). |
| **The kill switch**          | An argument, not a convention. `runDecision` requires the answer of `internal.decision.gate.assertDecisionAllowed`, and that mutation is the only thing that produces one, so a call site cannot reach the vendor without having read the `ai.decisionPlane` flag and charged the instance-global bucket **in the same request**. A flag enforced by caller etiquette is a flag that is on wherever somebody forgot. |
| **Idempotency**              | The vendor documents none, and neither do we — what we carry is a handle, not a promise. One client-side request id per **logical** call, stable across every attempt and across the hop (the way `plugins/llmAccounting.ts` carries a `reservationId`), written onto every ledger row, so three rows of one retried decision are identifiable **as** one decision instead of reading as three. Nothing de-duplicates on it yet; a caller may pass an id derived from the work item so that a later de-duplication can also see a re-run of the same work. |
| **Accounting**               | One usage row per **attempt** — failed attempts and the hop included — written before the answer is used, so the enforced dollar ceiling sees spend rather than success. Rows carry the plane, and whether the attempt was a fallback, uncalibrated or throttled.                                                                                           |

The accounting write, the rate limiter and the breaker are **injected ports**,
not imports; `lib/decision/ports.ts` builds the ctx-bound ones in a single place.
Two of the three are built there today. The rate-limiter port meters per
**attempt**, so retries and the hop each charge; what the gate charges is one
token per **logical call**, at admission, because a bucket needs a mutation ctx
and the gate already is one. No ctx-bound attempt limiter is built yet — it
would put a second internal mutation on the request path, and with no call site
on the plane there is nothing retrying to meter. It lands with the first
migration; until then the gate's per-call charge is the bound.
Each needs a Convex `ctx` this module has no business holding, and keeping them
out is what lets the whole contract be tested against three fakes. The two whose
absence costs money rather than observability — the breaker and the recorder —
are required alongside `fallbackTo` rather than defaulted away.

### 4. The fallback hop is default-off, breakered, and budgeted

Default-on fallback would mean that anything breaking the decision plane — an
expired key, a 429, a vendor outage — silently re-routes every inbound message
onto a model that costs 24 to 50 times more, on the path that is fed by strangers
sending us email. `analytics/spendBudget.ts` exists because of that exact threat.

So the hop is opt-in per caller, and it is guarded by a circuit breaker modelled
on the `llm_failure` breaker beside `agentHealth.ts`: a named failure bucket, the
same three state words, and an operator-visible state. Only the primary plane's
outcomes are reported to it; the hop's own failures are the language plane's
signal, not this plane's. A named `decisionPlaneGlobal` bucket in
`rateLimiter.ts` caps the plane instance-wide beside the other limiters, rather
than an ad-hoc limiter inside the dispatch.

**The bucket's refill is the only way back, and the half-open probe was cut.**
The first build closed the breaker early on a success that followed a quiet
stretch — the classic probe. It was wrong in the one case that matters: the
rate-limiter component writes nothing when a charge is *refused*, so once the
budget is spent the bucket's timestamp freezes and "quiet" accrues in the middle
of the outage. A provider flapping through a 429 storm would have re-armed the
whole failure budget every thirty seconds, which is the opposite of a breaker. A
signal that is only ever observed through the charges it accepts cannot answer
"when did we last see a failure", so the breaker does not ask: recovery is the
refill, and the refill runs on the clock whether or not anything succeeds.

### 5. Spend is admitted, not estimated after the fact

The plane's list price (`lib/decision/pricing.ts`) is explicit about the thing
that would otherwise be wrong twice: output tokens are **returned and nonzero but
billed at zero**, and a `jev-` catch-all keeps an alias off the generic
dollars-per-million default. Admission is separate from pricing and fail-closed —
an endpoint provenance the admission table does not know is refused rather than
guessed at, and the three provenances (`typesafe-native`, `llm-backed`, `custom`)
exist so that an operator-supplied base URL is visibly a different thing from the
vendor's own origin.

### 5b. The model id is configurable, and an unpinned answer is uncalibrated

The version is pinned (`jev-1.13.0`), and the schema column, the `DECISION_MODEL`
variable and the settings picker are still real: the resolver's id is what goes
on the wire, because an id that is stored, echoed back to an operator and then
quietly dropped is worse than not offering the field. What keeps the pin honest
is the answer rather than the request. The adapter reads the model the provider
reports back and stamps `calibrated: false` on anything that is not the pinned
version or one of its aliases, so a deliberate bump and a vendor-side reroute are
handled by one rule: the answers still arrive, and every threshold downstream
goes inert until the calibration harness has been re-run. The settings page's
test button reports the same thing in words rather than a plain success.

That test button is a real round trip — one registered probe question, a handful
of input tokens, output free. A local credential check answers the wrong
question: a well-formed revoked key passes it and then fails every decision
afterwards on the inbound path, where nobody is watching a button. The probe runs
through the same gate, resolver, dispatch and ledger a call site would, because a
test that took a different path would eventually answer for a configuration that
never runs.

### 6. Nothing about an existing install changes

The plane is reachable only through stored configuration an admin enters, behind
a feature flag (`ai.decisionPlane`) that is **off by default, requires `ai`, and
is deliberately not a member of the `ai` feature pack** — one click on a pack
must not start sending message content to a provider nobody chose.

`DEFAULT_DECISION_KIND` is `'llm'`. An install with no decision key resolves to
the language-backed adapter, which answers the same question sets through the
model the operator already configured and stamps the result `calibrated: false`.
That path is not a stub and not a placeholder: it is what every install without a
key runs, it must reproduce today's labels, and it is why reverting this plane is
a dropdown rather than a deploy.

The corollary, stated because it is the whole risk posture: **an install that
enters no key behaves exactly as it did before**, and that is asserted by test
rather than by intention.

### 7. The wizard asks once, pre-fills the recommendation, and skips in one keystroke

Two defaults, deliberately different, and collapsing them into one name would
turn a recommendation into a migration. `SETUP_DEFAULT_DECISION_KIND` is
`'typesafe'`: what a **brand-new** install's wizard and settings card pre-fill,
which is the same thing as saying it is what we would choose.
`DEFAULT_DECISION_KIND` is `'llm'`: what any install that never opted in
**resolves** to, which is today's behaviour.

The prompt sits beside the existing AI-provider questions, names what the plane
does in one line, and keeps "skip" as the first option in the list — the answer
that changes nothing is always the one on top, and taking it leaves the
language-backed adapter, which is where an operator who never sees the prompt
ends up. Pre-filling the recommendation is not the same as choosing for them: the
plane cannot be enabled without a key of their own, and enabling it anywhere
shows the consent screen in 9 first. Each surface names the pre-fill as a
constant rather than a literal — `SETUP_DEFAULT_DECISION_KIND` in the wizard and
in the web card — so neither reads as a stray string. They are two declarations,
not one shared export: the wizard runs in the setup CLI and the card in the web
app, and neither may import the other's. Lifting both into `packages/shared`
beside `featureFlags` is the right home and is not done here.

### 8. No decision answer may widen auto-send

This is the rule that outranks every threshold in the plan, and it is written
here because the first draft of that plan broke it.

The vendor's own jaggedness page states that the model does not treat state as
hostile and that instructions injected into the state can move answers. That is
our threat model exactly — the state is an email a stranger wrote. So a decision
answer may **restrict** an outcome and may never widen one:

- The autonomy gate registry stays restrict-only, per ADR-0051. A three-way
  router that unlocks auto-send above a probability cannot live there, and a
  probability does not become a gate.
- Where a calibrated probability belongs is where a score already decides: it
  improves the input to `resolveAutoApproveScore` and the tier comparisons, which
  is a strictly smaller change than touching the gate structure.
- The only new gate the plane is entitled to is a **block-only** one: a verdict
  answered by an uncalibrated adapter, or by a different provider than the one
  now configured, must not auto-send.
- The deterministic detectors stay, and stay ORed. The injection regexes are not
  replaced by a probability; the probability is a second opinion, never the only
  one.

Two smaller rules of the same family, from the same page: no arithmetic reaches
the plane (every number we act on is computed in TypeScript; a Score is an
ordered label, never a magnitude to interpolate), and the state type admits
budget-capped text or plain data only — attachments and images are not text and
do not migrate.

### 9. The operator is the data controller; we document, we do not sign

Owlat is self-hosted infrastructure. We do not run a hosted platform, we do not
broker keys, and there are no plan tiers. In a self-hosted deployment the
**operator** is the data controller, and a decision vendor would be **their**
processor, not ours. We cannot sign anything on their behalf and this repo has no
privacy policy or subprocessor list to add a line to.

The artefact that is actually useful is therefore an operator-facing data-flow
note in the providers reference, in both languages: what leaves the deployment,
to which host, under whose key, how to turn it off, and how to exclude a mailbox.
Alongside it: a redaction policy that is a design rather than a sentence — strip
quoted history and signatures, reduce HTML to visible text with the same helper
the injection scan uses, drop attachments, cap the state with head and tail kept,
and honour a per-mailbox opt-out so one mailbox can be excluded from third-party
decisions without disabling AI for the deployment. Accuracy and privacy happen to
want the same thing here.

## Consequences

- There are now three planes to resolve, three sets of envelope columns to
  decrypt, and one more place a misconfiguration can hide. The resolver caches
  keyed on the config row's own version rather than on a bare TTL, so an admin
  who corrects a key sees the correction immediately instead of waiting a window
  out — which the language plane's cache still does not do.
- Every decision call site that migrates gains a **hard** failure mode it did not
  have: a disagreement between our question set and the answer throws instead of
  degrading. That is intended, and it is why the migrations are separately
  shippable and separately revertible, one call site at a time.
- Two call sites that will migrate (`agent/steps/classify`, `mail/handlingRulesCompile`)
  have no `try` around their model call today, so the claim that every call site
  fails soft is already false. Adding a provider without adding a fail-soft path
  there would widen an existing hole, so each migration carries that fix.
- The plane writes one usage row per attempt. The budget scan is bounded, so the
  ceiling would begin under-reporting on a busy day without the scan's own
  headroom moving with this work; it did, and a truncated scan now also reports
  what the rate it saw extrapolates to. That projection is **advisory**: it
  raises `warn` and it is shown, and it never withholds auto-send or cuts
  advisory AI off. Rows do not arrive evenly — a bulk re-index emits a whole
  scan's worth in half an hour — so a rate read off a burst window would have
  blocked mail over money nobody spent, on installs that never entered a decision
  key. The enforced figure stays the counted one.
- The pinned model version (`jev-1.13.0`) is a maintenance cost we accept: a bump
  is manual and re-runs the calibration harness first. A model changing underneath
  a threshold that decides whether mail is sent unattended is the failure the pin
  exists to prevent.
- An operator who never touches the AI-provider page, never sets the env vars and
  never enables the flag carries three unused modules and nothing else. No
  migration runs, no banner appears, no vendor is named in their configuration.

## Non-goals

- **Replacing the language plane.** This provider cannot write. Every draft,
  reply variant, translation, summary and assistant turn stays where it is. The
  adapter has no text method, deliberately, so nobody can reach for it to save
  money on drafting.
- **Migrating a call site.** The plane ships with no caller. Which decision moves,
  and on what evidence, is a per-call-site decision gated on a measured agreement
  report, not on this record.
- **Deciding jurisdiction for the operator.** We document the host, the payload
  and the vendor's own privacy contact, and we ship the opt-out. We do not choose
  a region for them and we do not ship a key.
- **A plugin-facing decision capability.** That needs the DSL lifted into a shared
  package and must satisfy the hosted-seam check; it is a later, separate record.
- **Per-plane budget splitting.** The plane is counted against the existing
  ceiling, and the `plane` tag the ledger now carries is what a share would be
  evaluated off. The plan names a decision-plane share of `AI_SPEND_*` as P1b
  work and this build does not ship it: the honest reason is that the only place
  to enforce it is the per-call gate, where it would mean a bounded ledger scan
  on the inbound path for every decision, and nothing is spending on this plane
  yet to bound. What bounds the hop today is the failure breaker plus the
  instance-global bucket. **This deferral wants sign-off against the plan rather
  than a record written by the implementation it excuses**, and it is a
  prerequisite of the first call-site migration, not of this phase.
