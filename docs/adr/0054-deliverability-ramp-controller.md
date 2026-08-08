# The deliverability ramp controller — one AIMD controller, two actuators, a substitution table instead of a degraded code path

**Status:** accepted (shipped — see Execution)

> Filed as ADR-0043 in issue #485; `0043`–`0053` were already taken when it was
> written, and this repo's rule is one document per number (see the note at the
> top of [ADR-0043](./0043-execution-plan.md)), so it lands at **0054**. The
> content is unchanged.

## Context

The ramp controller decides, once an hour, how much of a deployment's outbound
mail leaves through its **own MTA** rather than through a reference transport,
and — where there is no reference transport — how fast the per-IP warming
schedule is allowed to grow. It is the only automated control in the product
that can make deliverability *worse*, and the only one whose mistakes are not
undoable: a share that ran too hot for a day is corrected by lowering it, but
the mail has already reached the receiver and the reputation damage is already
priced in.

It shipped in PR #461 with **no ADR**, deliberately: the module *shapes* it
uses are all borrowed. The sharded-write / summed-read discipline is
[ADR-0042](./0042-sending-reputation-module.md)'s, the adapter-module shape is
[ADR-0020](./0020-send-provider-adapter-modules.md)'s, and the dispatch-module
shape is [ADR-0007](./0007-mta-dispatch-modules.md)'s. Nothing about the
*layout* of `apps/api/convex/delivery/ramp/` establishes a new pattern.

But the controller's **decision architecture** is not a shape borrowed from
anywhere, and it was recorded only in the plan document and in the PR body —
neither of which is a durable artefact a reader of the repository will find.
Six decisions in particular are load-bearing, are non-obvious, and would each
be individually "improved" away by a well-meaning refactor:

1. There is **one** controller driving **two** actuators, not two controllers.
2. The two actuators compose in a **fixed order**, and never both increase in
   the same window.
3. The AIMD constants are **asymmetric on purpose**; each one is a safety
   property, not a tuning knob.
4. `insufficient_data` **holds** — in both directions. Thin data is not a
   licence to advance and not a reason to retreat.
5. The decision core is **pure**, and the absence of a third-party account is
   **additive-only**: it lowers confidence and slows the ramp, and does nothing
   else.
6. The measurement plane records **what was decided**, before dispatch, and is
   keyed by **arm** and never by provider — the two things about it that are
   *not* borrowed from ADR-0042.

Every one of them is already fixture-pinned. This ADR is the durable write-up
of a decision already made, so that the fixtures have something to point at.

## Decision

### 1. One controller, two actuators, behind one gate interface

The controlled variable is not "transport share". It is **how fast we let
volume grow against measured evidence**. Share is one way to express that;
warming pace is another.

So the gates, the aggregation, the precedence ladder, the AIMD arithmetic and
the freeze ladder are all *one* implementation, and only the actuator changes:

| | equipped (a reference transport exists) | standalone (none) |
|---|---|---|
| Controlled variable | own-MTA **share** `s ∈ [0, 1]` | warming-pace **multiplier** `m` |
| Decision function | `nextShare` (`ramp/controller.ts`) | `nextPaceMultiplier` (`ramp/paceActuator.ts`) |
| Bounds | `RAMP_AIMD` (`ramp/controllerConfig.ts`) | `PACE_AIMD` (`ramp/paceConfig.ts`) |
| Where the value becomes an effect | the mix the router reads | `effectiveDailyCap` (`ramp/paceCeiling.ts`) |

The arithmetic itself is one module, `ramp/aimd.ts`, parameterised by bounds —
`aimdClamp`, `aimdDecrease`, `aimdIncrease` — because two copies of "halve it,
but never below the floor" is exactly how the two actuators come to disagree
about what a retreat costs. The cooldown ladder (`nextCooldownMs`) is likewise
shared, over a `RampCooldownState` interface narrow enough that both the mix
row and the pace row satisfy it structurally.

The two precedence ladders are written **rung for rung in the same order**, and
both carry that order in a comment block at the top of the file, so a reviewer
who has verified one recognises the other:

```
  0. kill switch          — pin, in BOTH directions
  1. unusable clock       — never decide against a broken clock
  2. abuse status         -> 0 (share) / M_MIN (pace)
  3. circuit breaker      -> x0.5, freeze 6h, charged once per incident
  4. critical blocklist   -> 0 / M_MIN, freeze 24h, re-stamped (trailing)
 4b. unreadable stored value -> hold at the clamped value
  5. active freeze        -> hold
 5a. no evaluation at all -> hold; the graduation clock stops
 5b. stale/skewed evidence -> hold; evidence has an expiry, both directions
  6. gate halt / fail     -> max(floor, x0.5), freeze COOLDOWN
  7. insufficient data    -> hold; never up, and never DOWN either
  8. capacity ceiling / per-UTC-day guard
  9. graduation / low utilisation
 10. K_CLEAN              -> hold while building confidence
 11. additive increase    -> the ONLY rung that can raise anything
```

The ladder lives in **one function** in each file rather than being split
across helpers. The *order* is the safety property, and a property a reviewer
has to verify by reading three files is a property nobody verifies.

### 2. The degraded path is a substitution table, not a conditional

`ramp/degradationMatrix.ts` is one table with one row per absent integration —
`reference_transport`, `google_postmaster`, `microsoft_snds`,
`complaint_feedback_loop`, `seed_mailboxes`, `commercial_placement_api`. A row
may change only: which signal sources substitute, K_CLEAN, the step multiplier,
the phase-promotion dwell multiplier, the phase-ceiling delta, the complaint
threshold, the pace actuator's day cap, and the confidence copy.

`ramp/degradation.ts` is the **only** consumer of that table, and its folds are
all commutative and all fail toward caution: strictest K_CLEAN wins, step and
dwell multipliers multiply, ceiling deltas sum and clamp to the ladder's lowest
rung, tightest complaint ceiling wins, lowest pace-day cap wins, weakest
confidence wins. Adding an integration is a table row and nothing else; the
controller never asks "is SNDS connected?".

Which actuator a cell drives is itself read off the table — the
`reference_transport` row lists `pace_actuator` among its substitutes — rather
than off a `hasRelay` boolean, so standalone is the degenerate case of the same
mechanism rather than a second code path. `__tests__/noScatteredConditionals.test.ts`
proves every row is exercised and that no consumer re-derives a substitution
inline.

### 3. The fixed actuator order, and the interlock

`composeActuators` (`ramp/actuatorComposition.ts`) applies both decisions in a
**fixed, non-commutative order**:

- **Share moves first.** It is cheap and instantly reversible — the relay
  absorbs the difference, and a share that went up too far is taken back inside
  one window at no lasting cost.
- **Pace moves second.** It is slow and **reputation-bearing**: a warming cap
  that grew too fast is not undone by lowering it again, because the volume has
  already reached the receiver.

**A cell may never increase both in the same window.** Two reputation-bearing
dials moving together is the experiment whose result nobody can read: if the
next window degrades, which move caused it? When the share increases, the pace
increase is **deferred**, not cancelled — and deliberately does not count the
UTC day, so the tick that finally takes the step is still allowed to take it.

The deferral has to **outlive the tick**, and that is why it appears twice.
`composeActuators` fires the interlock and records `deferredAt`; rung 8b of
`nextPaceMultiplier` re-reads that persisted anchor and holds until a whole
evaluation window has elapsed. Without the second half, the next hourly tick
would find the share holding on `window_open` and take the pace step anyway —
both dials moved inside one window regardless.

**Retreats are not interlocked, in either direction or at any rung.** That is
the asymmetry restated: a rule that made a share retreat delay a pace retreat
would ration the one thing that must never be rationed.

### 4. The AIMD asymmetry — cheap to retreat, expensive to advance

Every constant below exists to keep that asymmetry. Changing one in isolation —
a smaller cooldown, a bigger step — is a change to the **safety property**, not
a tuning tweak.

| Constant | Value | Where |
|---|---|---|
| `decreaseFactor` | **×0.5** on any breached gate, instantly | `RAMP_AIMD` |
| `shareFloor` | **0.01** — a soft failure never reaches zero | `RAMP_AIMD` |
| `increaseStep` | **+5pp** (campaign, automation), **+3pp** (transactional) | `RAMP_STREAM_CONFIGS` |
| `cleanWindowsRequired` (K_CLEAN) | **3** consecutive clean windows | `RAMP_STREAM_CONFIGS` |
| `evaluationWindowMs` | **24h** — the minimum spacing between two *counted* windows | `RAMP_AIMD` |
| `cooldownBaseMs` / `cooldownMaxMs` | **6h**, doubling, capped at **48h** | `RAMP_AIMD` |
| `cooldownRepeatWindowMs` | **24h**, measured from the previous freeze's **expiry** | `RAMP_AIMD` |
| `breakerFreezeMs` / `blocklistFreezeMs` | **6h** / **24h** | `RAMP_AIMD` |
| `capacitySafety` | **0.8** headroom on the projected warming cap | `RAMP_AIMD` |
| `graduationHoldMs` | **14 days** at `s = 1.0`, all gates green | `RAMP_AIMD` |
| `RAMP_PHASE_CEILINGS` | **0.25 / 0.5 / 0.8 / 1.0** | `controllerConfig.ts` |
| `PACE_AIMD` | floor **0.25**, ceiling **1.5**, step **+0.1** per clean UTC day | `paceConfig.ts` |

Four consequences of those numbers are worth stating outright, because each is
a property the code defends and none of them is visible from the constant
alone:

**A clean window is a *day*, not a tick.** The cron ticks hourly against a 24h
outcome window. Without `evaluationWindowMs`, K_CLEAN = 3 would be satisfied by
three overlapping reads of the *same* day taken an hour apart, and a green cell
would walk from 0.02 to its phase ceiling in ~20 steps inside a single day —
the "expensive to advance" half of the asymmetry deleted. A window counts once,
and only a counted window extends the streak or permits an increase. Retreats
are explicitly *not* window-gated.

**The cooldown ladder is anchored on the previous freeze's expiry, not its
start.** A ladder freeze runs exactly its rung and the `frozen` rung refuses to
evaluate while it runs, so the earliest breach following a 24h cooldown is 24h
after that cooldown *started*. Start-anchored, the 24h repeat window was
unreachable from the 24h rung, the ladder cycled 6h/12h/24h/base for ever, and
the 48h cap could not be reached at all. Expiry-anchored it asks the question
the constant is named for: has this cell run clean for a day since we last let
it go?

**The floor is not zero, and hard stops deliberately ignore it.** A cell at
zero sends nothing, a cell that sends nothing can never be re-measured, and a
cell that can never be re-measured can never recover. So a soft failure retreats
to `shareFloor`; abuse status and a critical blocklist listing pass `floor: 0`
into the same `aimdDecrease` — that *is* what makes a hard stop hard.

**Graduation is a pin, and only a real failure revokes it.** `s = 1.0` held 14
days with every gate green pins the cell and drops the relay to
`priority_failover` standby. The pin survives a capacity bound (the warming cap
is not a breach) but never overrides it, and a graduated cell that has to climb
back to its ceiling pays for every step in the same currency as any other
increase — K_CLEAN, one counted window, one step — rather than jumping there.

### 5. `insufficient_data` HOLDS, and the minimum sample is enforced

Gate aggregation ranks `halt > fail > insufficient_data > pass`.
`insufficient_data` outranking `pass` is the whole rule: the controller must
never increase on thin data, **and must never decrease on it either**, which is
why holding is its own verdict rather than a quiet failure.

The minimum sample is a **precondition on returning a verdict at all**, not
advice. `RAMP_GATE_SAMPLE_FLOORS` carries one floor per gate — 200 sends per
arm for hard bounce and deferral, 1000 for complaint, 400 for concurrent
engagement, 2000 for the standalone trailing engagement gate, 20 classified
responses for the SMTP block detector, the seed roll-up's own minimum for
placement — derived from the rule of thumb that a threshold needs ~1/threshold
observations before it means anything. A gate that returns a verdict below its
floor is a defect.

`pass` is never the default. An evaluation in which *nothing* contributed — an
empty gate list, or nothing but optional gates that are all holding — returns
`insufficient_data`. Never increase, and never decrease, on nothing.

Evidence also **expires in both directions**: `maxEvidenceAgeMs` is 48h
(`maxBaselineAgeMs` is 33 days for the one gate whose window is historical by
contract), and future-dated evidence beyond the shipped routing snapshot's skew
allowance is rejected with the same allowance the snapshot validator uses. A
`pass` of any age would otherwise flow straight through K_CLEAN into the
additive-increase branch and buy one step per elapsed window for ever.

One deliberate refinement of "insufficient data holds": an **optional** gate's
`insufficient_data` is ignored by the aggregator entirely (its `fail`/`halt`
still count in full). Optionality is a fixed property of the gate id
(`OPTIONAL_RAMP_GATES`), consulted by the aggregator rather than trusted off a
flag on the result, so a caller-supplied gate result cannot remove itself from
the holding logic by mislabelling itself. That is rule 6 in one line: no absent
external account may hold the ramp.

Relatedly, a `fail` from a **tripwire** gate (`CORROBORATION_REQUIRED_RAMP_GATES`
— seed placement, which is 5–10 mailboxes) is flagged `requiresCorroboration`
when it is alone at the winning rank, and both actuators answer it with an
`awaiting_corroboration` **hold** rather than a decrease. Holding still forbids
an increase; it just does not halve a cell on one thin signal.

### 6. A pure decision core, and a cron that only loads, calls and writes

Everything under `apps/api/convex/delivery/ramp/` is pure and total:
`evaluateGates` and the per-gate evaluators, `nextShare`, `nextPaceMultiplier`,
`composeActuators`, the degradation fold, the phase-promotion routes. No
`Date.now()`, no database handle, no `process.env`, no randomness. The clock is
a parameter.

This is enforced two ways, not documented one way.
`__tests__/gates.purity.test.ts` **enumerates the directory** — it does not
hand-list modules, so a file added tomorrow is covered the day it lands — strips
comments (so the prose may talk freely about clocks) and greps the remaining
source for a clock, randomness, an environment read, a database handle or a
Convex function wrapper. It also checks behaviourally that identical inputs give
identical outputs, that arguments are not mutated, and that moving the injected
clock and nothing else is what changes the verdict.

The shell (`delivery/rampControllerCron.ts`) needs all three forbidden things,
so it lives **outside** `ramp/` — that is why the directory boundary is exactly
where it is, and why "is `delivery/ramp/` pure?" stays a question with a yes/no
answer. The shell loads inputs, calls the pure functions, writes the result and
the audit row. A conditional there that changes an outcome is a defect, because
it would be a rule with no fixture. It is bounded (5 of the 15 stream ×
destination-provider cells per tick, self-scheduling) and isolated (each cell in
its own try/catch, so one bad row cannot roll back the slice and starve the
grid).

Convex owns the decision outright and reads MTA state through the existing
`/ip-reputation` sync rather than running a second controller MTA-side: one
owner, no split brain.

### 7. Third-party integrations are additive only

**Absence of an external account lowers measurement confidence and slows the
ramp. It does nothing else.** It never blocks a send, never blocks a phase
promotion outright, never surfaces an error, and never renders a "setup
incomplete" nag.

This is encoded rather than asserted. Every row of the degradation matrix
carries `isBlocking: false` as a **field** so a fixture can assert it, and an
`improvement` sentence phrased as an offer ("connect X — it buys Y") rather than
a warning. `rampCellConfidence` has a single tone, `info`, made unrepresentable
otherwise by its type.

The zero-third-party deployment (`RAMP_FULLY_STANDALONE`) is a **first-class
configuration**, not a gap. It pays for that in speed, not in reach: K_CLEAN
3 → 5 and the step halved (the `reference_transport` row, applied in exactly one
place), and the phase-promotion rule past the 0.5 rung gains a standalone
**route** — doubled dwell, a recent passing seed probe, a 14-day DNSBL-clean
streak across every pool IP, and a deferral rate under threshold in every cell —
so that a deployment with no third-party credentials can still reach 1.0, slower
and on corroborated self-hosted evidence. Promotion routes are named lists of
conditions, not chained `if`s, for the same reason the substitution table is a
table.

Two rows are worth calling out as boundary cases of "additive only":

- `seed_mailboxes` is **the one true gap** — nothing else in the system observes
  the spam folder, so its `substitutes` list is legitimately empty and the ramp
  pays for it in *capacity*: `paceCeilingDay: 14` bounds the pace actuator at
  the day-14 step of the published schedule, and the UI says why. That is still
  a slower ramp, not a block.
- `commercial_placement_api` changes **nothing**: self-hosted seeds are the
  expected configuration, its confidence is `high`, and it carries
  `offersImprovement: false` because Owlat integrates no such service — so it
  contributes neither a note nor an offer. An affordance nobody can act on
  would be a permanent, unactionable nag on every cell for ever, which is the
  exact thing this rule forbids.

### 8. The measurement plane records the DECISION, and is keyed by arm

The Context above says the plane's *shape* is borrowed — sharded writes, summed
reads, ADR-0042. Two things about it are not, and both are the kind a tidying
refactor removes because the cheaper-looking alternative appears equivalent.

**`sendAssignments` is written inside the enqueue transaction, before dispatch.**
The obvious simplification is to derive the same table after the fact from
`sends.providerType`, which every send already carries: one fewer write, one
fewer table, no new retention sweep. It is not equivalent, for three reasons.

- `providerType` records **what happened**, and the controller's question is
  **what we decided, and for whom**. Health-driven failover is re-resolved at
  dispatch, so a recipient the mix assigned to the own arm whose send then went
  out through the reference relay is a *reference* row in the post-hoc reading
  and stays an *own* row here. That is deliberate and it is the analysis the
  controller needs: the ramp is scored on the effect of its own decision,
  failovers included, because the alternative quietly moves every bad own-arm
  outcome out of the own arm and lets a cell advance on evidence it did not
  produce.
- The mix version and the cell are inputs to a decision that no longer exists
  once the send has left. Reconstructing the cell post-hoc means re-deriving the
  recipient's destination provider from an address that may since have been
  suppressed, and re-deriving the mix version from a config that may since have
  moved. Both are lossy in the direction that flatters the ramp.
- Assignment is a random draw against `s`. A draw that is not durably recorded
  at the moment it is made is not a measurement — nothing later can distinguish
  "we assigned 20% and 20% arrived" from "we assigned 50% and half failed over".

Writing it in the enqueue transaction is what makes the row and the decision the
same event. Denormalising `organizationId` onto the row is part of the same
decision rather than a convenience: a cell-keyed table readable across tenants
is a security defect, so every read is org-leading.

**The plane is keyed by ARM, never by provider kind or instance.** Both tables
carry `own | reference` and stop there — `sendAssignments` also records the
transport kind, for auditing, but nothing in the controller reads it. Two
configured SES instances are one arm; a deployment that swaps SES for Mandrill
mid-ramp does not partition its own history.

This is what keeps adding a provider a **rows** change and never a **columns**
change. A plane keyed by kind would need a schema decision, a migration and a
controller change per provider, and the "which of these am I comparing against"
question would have no answer once a deployment ran two relays. It also keeps
the controller from ever learning a provider's name, which is the same rule
ADR-0055 enforces on the send path — one identity question exists in this
system, `own` vs. not-own, and this is where it is asked.

The cost is real and accepted: the plane cannot answer "how did Resend do versus
SES". That is a reporting question, and the table that answers it is a different
table from the one that drives an actuator.

## Considered options

### Two controllers, or one controller with two actuators

1. **One controller, two actuators** *(chosen)*. One precedence ladder, one
   AIMD module, one freeze ladder, one gate aggregation. Standalone is the
   degenerate case of the equipped path rather than a parallel implementation.
2. **A separate standalone controller.** Rejected: it is the "two code paths for
   every gate means the degraded path rots" failure by construction. The
   standalone path is the one *fewer* people run and therefore the one that rots
   first, and it is also the path with the least measurement to catch the rot.

### The degraded path: a table, or conditionals

1. **One substitution table folded in one place** *(chosen)*. Adding an
   integration is a row. A fixture proves every row is exercised and that no
   consumer re-derives a substitution inline.
2. **An `if` per integration in the controller.** Rejected — it is what the
   table exists to prevent, and it puts the safety-critical precedence ladder
   and the integration matrix in the same function.

### Actuator composition

1. **Fixed order, share first, with a window-long interlock on double
   increases** *(chosen)*. The order follows from reversibility, and the
   interlock keeps every window a readable experiment.
2. **Move both freely.** Rejected: when the next window degrades, nothing can
   attribute it.
3. **Interlock inside the tick only.** Rejected during implementation — it was
   the shape that *looked* right and does not work. The next hourly tick finds
   the share holding and takes the pace step anyway, so both dials still move
   inside one window. Hence the persisted `deferredAt` and rung 8b.

### Thin data

1. **`insufficient_data` is its own verdict and holds both ways** *(chosen)*.
   Holding is honest about what was measured, and a hold has an exit.
2. **Treat thin data as a soft failure and decrease.** Rejected: it punishes a
   quiet week and would walk a healthy low-volume cell to the floor.
3. **Treat thin data as a pass.** Rejected outright — `pass` is the one verdict
   that can raise a share.

### Where the decision lives

1. **Pure core under `ramp/`, effects in a shell outside it, guarded by an
   enumerating source-level purity test** *(chosen)*. The directory boundary is
   the guard's scope, so the guard cannot be diluted by a file added later.
2. **Inject a clock/db interface and mock it.** Rejected as the primary defence:
   a mock only proves the paths a test happened to walk, whereas the source grep
   holds for every path including the ones nobody wrote a test for.

### The measurement plane's grain

1. **A pre-dispatch assignment row, keyed by arm** *(chosen)*. The decision and
   the record are one transaction, and a provider is rows rather than columns.
2. **Derive the plane from `sends.providerType` after the fact.** Rejected: it
   answers "what happened", not "what we decided", and it re-derives the cell
   and the mix version from state that has since moved. Cheaper, and measuring
   something else.
3. **Key the plane by provider kind (or by transport instance).** Rejected: it
   makes every added provider a schema change, splits a deployment's history
   when it swaps relays, and gives the controller a provider's name — which is
   the identity coupling ADR-0055 removes from the send path. Per-provider
   reporting is a separate table for a separate question.

## Consequences

- **The constants are a safety surface, not a config surface.** Anyone changing
  `RAMP_AIMD`, `PACE_AIMD` or `RAMP_STREAM_CONFIGS` is changing the asymmetry.
  The doc comments on those modules say so; this ADR is what they point at.
- **Rung order is reviewable in one sitting.** Both ladders are single functions
  with the order stated at the top of the file, and an increase is reachable
  from exactly one branch at the very bottom of each.
- **Degenerate input fails closed everywhere.** A NaN share resolves to the
  floor; an unreadable capacity projection *holds* rather than becoming "no
  limit"; an out-of-ladder phase ceiling snaps *down* to the lowest rung; a
  corrupt cooldown position restarts at the base; a freeze further out than any
  rung could stamp is treated as unreadable and holds. In every case the
  degenerate path is the one that cannot increase. `aimdIncrease` is the single
  documented exception — it has no floor to fail to, returns an unreadable value
  untouched, and both callers clamp through `aimdClamp` before storing.
- **Adding a destination provider or a stream does not touch the controller.**
  The grid is enumerated (`allDeliverabilityCells`) and substitution scopes use
  `'all'` rather than a hand-typed provider list.
- **Adding an integration is a table row**, plus a presence reader. No rung
  changes.
- **Adding a send provider does not touch the measurement plane either.** Both
  tables are arm-keyed, so a new transport is rows, not a column, a migration or
  a controller change. The price is that the plane cannot rank providers against
  each other; that is a reporting question and belongs to a different table.
- **The assignment write is on the enqueue path**, so it is bounded and
  defensive by obligation: O(N) narrow writes for N recipients, no unbounded
  read, and every failure to classify degrades to "no row" rather than to a
  failed send.
- **The dashboard and the controller cannot disagree.** Gates return the numbers
  that produced the verdict, not booleans, and the confidence copy is derived
  from the same table entries the controller folded.

## Follow-up work

Tracked as issues rather than restated here: the duplicate seed-tripwire rule
with two routes to one verdict (#504), the SMTP block classifier whose
per-category counts never leave the MTA so its gate clause has a reader and no
producer (#501), and seed probes being campaign-only so the transactional and
automation Microsoft cells have no placement evidence (#500).

## Execution

**Already shipped**, in PR #461, on the `integration/deliverability` branch.
This ADR is the durable record of a decision already made and already
fixture-pinned; it introduces no change to behaviour. The decision core is
`apps/api/convex/delivery/ramp/` (`aimd.ts`, `controller.ts`, `paceActuator.ts`,
`actuatorComposition.ts`, `controllerConfig.ts`, `paceConfig.ts`,
`gateConfig.ts`, `gates.ts`, `gateEvaluation.ts`, `degradationMatrix.ts`,
`degradation.ts`, `phasePromotion.ts`, `measurementConfidence.ts` and
siblings); the shell is `apps/api/convex/delivery/rampControllerCron.ts` and its
input/write siblings.

The claims above are pinned by fixtures in
`apps/api/convex/delivery/ramp/__tests__/` — in particular
`gates.purity.test.ts` and `rampControllerPurity.test.ts` (rule 6),
`gates.precedence.test.ts` and `gates.insufficient.test.ts` (rule 5),
`rampControllerAimd.test.ts`, `rampControllerCooldown.test.ts` and
`rampControllerGraduation.test.ts` (rule 4), `actuatorComposition.test.ts` and
`paceIdempotency.test.ts` (rule 3), `degradationMatrix.test.ts` and
`noScatteredConditionals.test.ts` (rules 2 and 7), `gateMatrix.standalone.test.ts`
and `standaloneAsymmetry.test.ts` (rule 1), and the adversarial suites
(`gates.adversarial.test.ts`, `rampControllerAdversarial.test.ts`,
`standaloneAdversarial.test.ts`) for the invariant that no input — crafted,
stale, degenerate or hostile — can raise a value past a hard stop or on thin
data.
