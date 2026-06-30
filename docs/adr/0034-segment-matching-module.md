# Segment matching module — single owner of filter-set evaluation over a Contact population, closing the five-copy combine drift and the preview's soft-delete leak + N×M preload

**Status:** accepted

## Context

"Which **Contact**s match this stored filter set" is answered by five
independent copies of the same algorithm: normalize the filters →
preload the per-**Condition** lookup once → iterate Contacts combining
each Condition with `AND`/`OR`. Two earlier deepenings bracket this layer
without owning it. ADR-0004 lifted the *per-Condition* primitive into the
`conditions/` registry (`parseCondition` / `preloadConditionsLookup` /
`evaluateOne`). ADR-0033 lifted the *eligibility predicate*
(email-present, suppression, DOI) into the **Audience resolution
(module)** and explicitly **parked** the set-matching layer — its
`_Avoid_` note rejects "Segment evaluation" as a name and §"Replaces"
says `evaluateSegmentCount` / `evaluateOne` / `preloadConditionsLookup`
**stay**. The layer *between* the two — match a *set* of Conditions
against a *population* — was never given an owner, so it accreted a copy
per caller.

### Caller landscape — "match a filter set against Contacts"

| Site | File:line | Population | Empty conditions | Corrupt filters | Preload cost |
|---|---|---|---|---|---|
| Segment preview | `segments.ts:154-171` | **raw `.collect()` — soft-deleted leak** | first N (unfiltered) | per-condition swallow → false | **N×M size-one preloads** |
| Segment count | `lib/segmentEvaluation.ts:63-94` | `notSoftDeleted` | match all | whole-set try/catch → `{0,0}` | one preload |
| Multi-segment cron | `lib/segmentEvaluation.ts:101-149` | `notSoftDeleted` | match all | per-segment try/catch → 0 | one combined preload |
| Campaign send (segment branch) | `campaigns/audienceResolution.ts:135-171` | `notSoftDeleted` | match all live | **log** + total 0 | one preload |
| Automation condition step | `conditions/index.ts:113-123` | n/a (one Contact) | returns `true` | caller `parseCondition` throws (uncaught) | one preload |

The automation step routes through `evaluateAgainstContact` — the only
caller that already shared the combine. The other four open-coded it.

Per LANGUAGE.md's deletion test: deleting the (then-absent) matcher does
not move complexity to one sibling — it is *already* deleted, and the
parse + empty-rule + `AND`/`OR` combine + live-Contact scan sit
re-implemented across five sites. The complexity is real, it concentrates
into a predicate plus a scan, and it lived in five places that had to
agree and did not.

### 1. The preview is O(contacts × conditions) in DB round-trips

`getMatchingContactsByTeam` called `evaluateCondition` — which preloads a
*size-one* lookup — inside a per-Contact × per-Condition double loop
(`segments.ts:159-162`). It re-fetched lookup data once per (Contact,
Condition) pair, the exact N×M pattern the batch `evaluateSegmentCount`
was built to avoid. Every segment-preview render paid it.

### 2. The preview leaks soft-deleted Contacts

`getMatchingContactsByTeam` scanned `ctx.db.query('contacts').collect()`
with no `deletedAt` filter (`segments.ts:147-149`), and its
no-conditions branch returned `ctx.db.query('contacts').take(limit)`
equally unfiltered (`:141-143`). CONTEXT.md's **Contact** invariant is
explicit: "All list/lookup queries MUST filter `deletedAt ===
undefined`." The other four copies applied `notSoftDeleted`; the preview
did not, so it showed (and counted) soft-deleted Contacts. This is the
read-side twin of the send-side leak ADR-0033 closed.

### 3. Five divergent corrupt-filter contracts

Filters are storage-validated (`segmentFiltersValidator`), so a parse
failure is corrupt data, not user input — but the five copies disagreed
on what to do about it: the preview swallowed per-condition to `false`,
the count returned `{0,0}`, the cron returned 0 per segment, the send
path *logged* then returned 0, and the automation step let the throw
escape uncaught. For a send, a silent zero means the Campaign reaches
nobody; for a preview, a throw means a broken page.

### 4. Five divergent empty-conditions contracts

"No conditions" meant "first N rows" in the preview, "all live" in the
count / cron / send, and "true" in the single-Contact step. Same intent
("match everything"), four spellings.

### Shared framing

The five copies are shallow individually — each is the same three-line
combine wrapped in slightly different bookkeeping. But the question they
share has a real, load-bearing bundle of decisions: filter
normalization, the empty rule, short-circuit `AND`/`OR` over the registry
primitive, the live-Contact population, and the throw-vs-swallow
posture. Lifting that bundle behind one module produces leverage — the
preview, the count, the cron, the send, and the automation step ask one
question and get one answer — and locality: the next caller cannot invent
a sixth contract, and the preview's two bugs cannot recur.

Confidence: high. The change is a pure code refactor — no schema
migration, no wire-contract change, every public query signature
preserved. It reuses the ADR-0004 registry primitive unchanged and slots
beneath the ADR-0033 eligibility predicate. The only behaviour changes
are the two preview bug-fixes (§1, §2).

## Decision

Introduce a **Segment matching (module)** at
`apps/api/convex/conditions/segmentMatch.ts` that owns the single mapping
from a stored filter set to the Contacts that match. CONTEXT.md's
`## Segments` section (defining the previously-undefined **Segment** term
and this module) landed inline with the grilling.

### Module surface

```ts
// apps/api/convex/conditions/segmentMatch.ts

export interface SegmentFilters { logic: 'AND' | 'OR'; conditions: readonly unknown[]; }
export interface ParsedSegmentFilters { logic: 'AND' | 'OR'; conditions: Condition[]; }

// ── Pure core — the test surface. ──
// Throws on corrupt filters (storage-validated → corrupt data, not user input).
export function parseSegmentFilters(input: string | SegmentFilters): ParsedSegmentFilters;

// Empty conditions match every Contact; otherwise short-circuit AND/OR over evaluateOne.
// Synchronous and pure given a preloaded lookup.
export function makeSegmentPredicate(
  filters: ParsedSegmentFilters,
  lookup: ConditionsLookup,
): (contact: Doc<'contacts'>) => boolean;

// ── Lenient async conveniences — preview / count / cron. Bake in the
// notSoftDeleted scan; treat corrupt filters as a zero match. ──
export function countLiveMatches(ctx, input): Promise<number>;
export function matchLiveContacts(ctx, input, opts?: { limit?: number }): Promise<Doc<'contacts'>[]>;
export function countLiveMatchesForSegments(ctx, segments): Promise<Map<string, number>>;

// ── Single-Contact case — the automation `condition` step. ──
export function evaluateAgainstContact(ctx, conditions: Condition[], logic, contact): Promise<boolean>;
```

Re-exported from `conditions/index.ts` so callers keep importing from
`../conditions`.

### The two-layer split is load-bearing

The split between the **pure predicate** and the **async conveniences**
is not stylistic — two callers forbid a scan-owning matcher:

- The **Audience resolution (module)**'s segment branch must *interleave*
  matching with its `selectRecipient` eligibility filter in one walk; it
  needs the predicate, not a materialized list it would re-load.
- The multi-segment cron (`countLiveMatchesForSegments`) shares one
  Contact scan *and* one combined lookup across many Segments; a
  scan-owning matcher would re-scan per Segment.

So the pure core exposes `parseSegmentFilters` + `makeSegmentPredicate`
(callers own iteration), while the simple preview/count callers get the
conveniences that own the canonical `notSoftDeleted` scan.

### Three decisions resolved in the grilling

1. **Corrupt filters: throw; callers decide.** The pure core throws. The
   preview/count/cron conveniences swallow to a zero match (a broken
   filter must not break the page). The send path composes the pure core
   itself so it can **log then resolve zero** — a silent zero means the
   Campaign reaches nobody, so it is logged loudly, not swallowed
   silently.
2. **The conveniences own the live-Contact scan.** `notSoftDeleted` is
   baked into `countLiveMatches` / `matchLiveContacts` /
   `countLiveMatchesForSegments`, so the preview's soft-delete leak
   cannot recur at a future scan site. The send path and cron keep their
   own scans (they need to share/interleave) and apply `notSoftDeleted`
   at that scan.
3. **Home in `conditions/`, named "Segment matching".** It is the
   registry's natural "evaluate a *set* over a population" operation.
   "Segment evaluation" was rejected: ADR-0033 parked that name because
   an **Audience** also covers **Topic membership**; this module is the
   segment/Condition half only, so "matching" names the operation without
   claiming audience resolution.

### Replaces

| File:line | Pre | Post |
|---|---|---|
| `segments.ts:154-171` `getMatchingContactsByTeam` | N×M size-one preloads; raw `.collect()` (soft-delete leak) | `matchLiveContacts` — one preload, `notSoftDeleted` scan |
| `lib/segmentEvaluation.ts:63-94` `evaluateSegmentCount` | own normalize + scan + combine | thin wrapper → `countLiveMatches` (name kept — ADR-0033 depends on it) |
| `lib/segmentEvaluation.ts:101-149` `evaluateMultipleSegments` | own combined-preload + per-segment combine | thin wrapper → `countLiveMatchesForSegments` |
| `campaigns/audienceResolution.ts:135-171` segment branch | inline parse + empty branch + combine | `parseSegmentFilters` + `makeSegmentPredicate`; keeps log-and-zero |
| `conditions/index.ts:113-123` `evaluateAgainstContact` | own combine | moved into `segmentMatch.ts` as the single-Contact case |

The per-Condition primitive (`evaluateOne` / `preloadConditionsLookup` /
`parseCondition`) **stays** in the registry — the module reuses it, does
not fork it. `evaluateCondition` in `lib/segmentEvaluation.ts` stays as a
single-condition convenience (it is not a copy of the combine).

### Closes drift bugs

1. **Preview N×M preloads** (§1) — the preview routes through
   `matchLiveContacts`, which preloads once.
2. **Preview soft-delete leak** (§2) — `matchLiveContacts` scans
   `notSoftDeleted`; the read-side twin of ADR-0033's send-side fix.
3. **Divergent corrupt handling** (§3) — one contract: pure core throws,
   conveniences swallow, send logs-and-zeros.
4. **Divergent empty handling** (§4) — `makeSegmentPredicate` returns
   `() => true` for empty conditions uniformly.

### Tests

The interface is the test surface.

1. **`makeSegmentPredicate` / `parseSegmentFilters`** at
   `conditions/__tests__/segmentMatch.integration.test.ts` — `AND`
   requires all, `OR` matches any, empty matches every Contact;
   `parseSegmentFilters` *throws* on unknown kind and on invalid JSON
   (the corrupt contract).
2. **Preview regression** — `matchLiveContacts` excludes soft-deleted
   Contacts (the §2 leak), respects `limit`, returns first N for empty
   conditions, and returns `[]` on corrupt filters (lenient posture).
3. **`countLiveMatches`** — returns 0 on corrupt filters; counts only
   matching live Contacts.
4. **Behaviour-preservation** — the existing
   `lib/__tests__/segmentEvaluation.integration.test.ts` (≈50 cases over
   `evaluateCondition` / `evaluateSegmentCount`) **stays green
   unchanged**, proving the wrappers preserve the public contract.

### Out of scope

- **The full-table segment scan's performance.** The conveniences and the
  send path still `notSoftDeleted(contacts.collect())`; no index lands
  here — same deferral as ADR-0033 / ADR-0032's `reconcileMemberCounts`.
  The scan is now localized so a future index lands in one place.
- **The `{ total, eligible }` shape on `evaluateSegmentCount`.** Kept
  (both fields equal) because ADR-0033 relies on the name and shape;
  collapsing it to a bare number is deferred churn, not part of this
  deepening.

## Consequences

**The segment-match algorithm lives once.** The parse, empty-rule,
`AND`/`OR` combine, and live-Contact scan decisions concentrate in one
module; the preview's N+1 and soft-delete leak cannot recur, and a sixth
caller inherits the contract instead of inventing one.

**Two read-path bugs close.** Segment previews stop showing soft-deleted
Contacts and stop paying N×M DB round-trips — the read-side complement of
ADR-0033's send-side eligibility fixes.

**Aligns with the registry pattern.** The module sits beneath ADR-0033's
eligibility predicate and atop ADR-0004's per-Condition primitive — three
layers, each with one owner: per-Condition evaluation (registry),
set-over-population matching (this module), recipient eligibility
(Audience resolution).

**Surface area:**

| Code site | Pre | Post |
|---|---|---|
| `segments.ts` preview block | ~46 LOC | ~3 LOC |
| `lib/segmentEvaluation.ts` | ~150 LOC | ~75 LOC (thin wrappers) |
| `campaigns/audienceResolution.ts` segment branch | ~50 LOC | ~30 LOC |
| `conditions/index.ts` `evaluateAgainstContact` | ~16 LOC | re-export (moved) |
| New `conditions/segmentMatch.ts` | — | ~210 LOC |
| New `conditions/__tests__/segmentMatch.integration.test.ts` | — | ~210 LOC |

**Landed as a single atomic refactor.** No schema migration, no
wire-contract change, every public query signature preserved — so no
phased rollout was needed (contrast ADR-0033's five phases). Verified
green: full `apps/api` vitest suite (2062 passed), `tsc --noEmit`, and
`lint` (the unbounded-`.collect()` ratchet *dropped* 276 → 254 because
the preview's double scan is gone).

**Risk:** low. The only behaviour changes are the two preview bug-fixes —
a preview that previously listed a soft-deleted Contact, or rendered
slowly on a many-condition segment, now behaves correctly. No send-path
behaviour changes (the campaign matcher already filtered soft-deleted;
this routes it through the shared predicate without altering its result).
```
