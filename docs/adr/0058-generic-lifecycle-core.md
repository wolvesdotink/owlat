# ADR-0058: The generic lifecycle core — factor the dispatcher, keep the reducers

## Status

Accepted. Supersedes the deferral recorded in ADR-0009 follow-up #1, ADR-0010
follow-up #1, ADR-0017 follow-up #4, and ADR-0028's "out of scope for
follow-up" paragraph. It does **not** supersede any decision those ADRs made
about their own machines; only the recurring "defer the `Lifecycle<S, T, E>`
factor" verdict.

## Context

Eleven modules carry the same hand-rolled state-machine skeleton:

| Module                                  | `LEGAL_EDGES` at | Reports `terminal` |
| --------------------------------------- | ---------------- | ------------------ |
| `delivery/sendLifecycle/reducers.ts`    | :61              | yes                |
| `mail/postboxOutboundLifecycle.ts`      | :70              | yes                |
| `mail/draftLifecycle.ts`                | :166             | no                 |
| `contacts/doiLifecycle.ts`              | :110             | yes                |
| `inbox/processingLifecycle/reducers.ts` | :35              | yes                |
| `transactional/lifecycle.ts`            | :111             | no                 |
| `campaigns/lifecycle.ts`                | :131             | yes                |
| `campaigns/abTestLifecycle.ts`          | :83              | no                 |
| `automations/lifecycle.ts`              | :66              | no                 |
| `emailTemplates/lifecycle.ts`           | :87              | no                 |
| `domains/lifecycle.ts`                  | :274             | no                 |

(`inbox/threads/module.ts` is deliberately absent: its header states there is
no `LEGAL_EDGES` graph, and it is untouched by this ADR.)

Nine of the eleven open their `dispatch` with a near-textually-identical
five-line preamble:

```ts
const from = row.status as Status;
const isLegal = LEGAL_EDGES[from].has(input.to);
const isSelfLoop = from === input.to;
if (!isLegal && !isSelfLoop) {
	if (LEGAL_EDGES[from].size === 0) return { ok: false, reason: 'terminal', from, to: input.to };
	return { ok: false, reason: 'illegal_edge', from, to: input.to };
}
```

`illegal_edge` is universal across all eleven. The `terminal` branch exists in
five. Everything after that line diverges, and diverges for real reasons.

### The recorded objection, and why it was right

ADR-0009 held the factor off because "reducers genuinely diverge at the
implementation level — the factor would dedup type signatures only." ADR-0017,
at seven instances, called the duplication "actively binding" and still
deferred, because "the factor lands when the duplication bites at the
_reducer-implementation_ level." ADR-0028, at eleven, concluded "eleven is not
the trigger." CONTEXT.md records the same counter-argument: each instance
differs in external keys, polymorphic identity, override entry points,
cross-machine coordination and per-kind adapter dispatch, and a generic factor
"would be lossy."

That objection is correct about the thing it was aimed at. A
`Lifecycle<S, T, E>` that owned reducers, the effect runner and the outcome
type would have to absorb: the Postbox machine transitioning a _slice_ of a row
and re-deriving an aggregate column; the Draft machine whose terminal is a row
_delete_ and whose target set contains a state (`sent`) that is never a
from-state; the DOI machine's `admin_attest` relaxation of an undeclared edge;
the Transactional machine's `resolvedTargetStatus` indirection between the
input literal and the persisted status; the Sending-domain machine's
per-provider identity write between the patch and the effects; the Campaign/AB
pair's cross-machine effect. Pushing those behind one generic runner means
either a parameter for every one of them or a semantic loss. That is a bad
trade, and four ADRs were right to refuse it.

What the objection never addressed is that it argues against a factor nobody
has to build. The seven-line preamble above is not a reducer. It contains no
row, no effect, no DB read, no module vocabulary. It is a graph lookup and a
three-way classification, copied eleven times, with a five-of-eleven variation
in whether the no-outgoing-edges case gets its own reason.

## Decision

Introduce `apps/api/convex/lib/lifecycle.ts`. Its scope is the **dispatcher
preamble and nothing else**:

- **`defineLifecycle(spec, options)`** — builds a `LifecycleGraph` from a
  declarative edge spec (`{ queued: ['sent', 'bounced', 'failed'], … }`),
  replacing the hand-built `Record<S, ReadonlySet<S>>`. The graph copies the
  spec, so a caller cannot mutate the edges after construction. From-states and
  to-states are separately parameterized (`LifecycleGraph<TFrom, TTo>`) because
  the Draft machine's targets are not all from-states.
- **`graph.classify(from, to, options?)`** — the transition validation and
  dispatch decision. Returns either `{ kind: 'proceed', from, to, isSelfLoop }`
  or `{ kind: 'refused', reason, from, to }`.
- **Self-loop classification** is reported as a boolean on the `proceed` arm,
  not as a third kind. A self-loop is orthogonal to legality: some machines
  declare a self-edge legal, some allow an undeclared one so the reducer can
  answer `recorded`, and several read `isSelfLoop` to skip a precondition
  (`automations/lifecycle.ts` skips its `→ active` step-count check on one).
  Modelling it as its own kind would have forced those call sites to re-derive
  `from === to`.
- **Terminal classification is opt-in.** `reportsTerminalRefusals` defaults to
  **false**. Only five modules distinguish "refused because the from-state has
  no outgoing edges" from a plain illegal edge; forcing `terminal` on the other
  six would widen six published outcome unions and change what six sets of
  callers see. `graph.isTerminal(state)` is available to every machine
  regardless — only the _reason_ is withheld.
- **`LifecycleReason<TExtra>`** — the shared outcome-reason base
  (`'illegal_edge' | 'terminal'`) unioned with module-local literals. This is
  the extension point: `mail/postboxOutboundLifecycle.ts` keeps
  `unknown_mta_id_prefix`, `message_not_found`, `message_has_no_outbound` and
  `recipient_not_found`; `mail/draftLifecycle.ts` would keep `already_draft`
  and `no_recipients`. The core never enumerates a module's reasons.
- **`refuse(verdict, context?)`** — folds a refused verdict into the module's
  `ok: false` shape plus whatever context that module carries (row ids, an
  array index). Each module keeps its own differently-named success-id key
  (`campaignId`, `templateId`, `emailId`, `mailMessageId`, …); the core does not
  own the `ok: true` arm at all.
- **`classify(..., { isSanctionedEdge: true })`** — a per-call force-legal
  escape hatch for an edge a module sanctions on grounds the graph cannot
  express. This exists for exactly one known case, DOI's `admin_attest`
  relaxation of `not_required → confirmed`, and it does not mutate the graph.

An undeclared from-state (a cast that outran the schema) now classifies as
`illegal_edge` instead of throwing on `undefined.has(...)`, and never as
`terminal`.

### What stays in the modules — 100%

Per-state reducers, the effect union and its runner, DB-reading preconditions,
external-key parsing, aggregate re-derivation, cross-machine coordination,
row insert/delete bracketing, per-provider adapter dispatch, audit-event
construction, the `ok: true` outcome shape, and every module-local outcome
literal. The core has no `ctx`, no `Doc`, no `Id`, no effects and no
persistence. That is the answer to the "lossy" objection: nothing that could
be lost is inside the boundary.

### Pilot

`mail/postboxOutboundLifecycle.ts` migrates first. It is not the newest
instance (it is the second-oldest, ADR-0012 alongside the Send lifecycle) — it
is the one with two dedicated test files, `postboxOutboundLifecycle.unit.test.ts`
and `postboxOutboundLifecycle.integration.test.ts`, which between them exercise
legal, illegal, terminal, self-loop and `unknown_mta_id_prefix` outcomes. Both
pass **unchanged**. Its `dispatch` loses 22 lines; its outcome union keeps every
literal it published, spelled through `LifecycleReason<…>`.

The remaining ten modules migrate as they are touched, not in a big-bang pass.
A module that never gets touched keeps working; the core is additive.

## Consequences

- The eleven-way copy of the transition classifier becomes one implementation
  with its own unit tests (`__tests__/lifecycleCore.unit.test.ts`), so an edge
  case fixed once is fixed for every migrated machine rather than in one of
  eleven places.
- A new lifecycle module declares an edge spec instead of copying a
  `dispatch` preamble, and gets the self-loop and terminal semantics right by
  construction rather than by imitation.
- The core cannot express a per-input edge relaxation without the
  `isSanctionedEdge` opt-out, which is a per-call flag rather than a graph
  property. If a second and third such case appear, that is the signal to model
  conditional edges properly — not to widen the flag.
- Ten modules remain unmigrated after this ADR, so the repository temporarily
  holds both shapes. This is the intended cost of a pilot-first migration; the
  alternative (one commit touching eleven state machines) is not reviewable.
- `LifecycleGraph` is a value, not a type-only helper, so a machine's edges are
  now introspectable (`states`, `legalTargets`, `isTerminal`). Nothing consumes
  that yet; a state-machine diagram generator or an admin-facing "what can this
  row do next" query is now cheap, but is not built here.

## Non-goals

- A generic reducer, effect runner, or `TransitionOutcome<S, T, E>` type. Four
  ADRs refused those; this ADR does not revisit them.
- Migrating the other ten modules. They move as they are touched.
- `inbox/threads/module.ts`. It has no edges graph and is out of scope.
- Any change to a published outcome literal, mutation signature, or persisted
  status value. The pilot is behaviour-preserving.
