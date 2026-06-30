# Sending reputation module — one scope-discriminated table, one summarizer behind a read-side seam, derive-on-read replacing five copied window loops

**Status:** accepted (implementation deferred — see Execution)

## Context

Sending reputation is the rolling 30-day accumulation of delivery events
(`send | deliver | bounce | hard_bounce | complaint`) into a bounce rate
and a complaint rate, classified into a `low | medium | high | critical`
risk level, which at `high`/`critical` auto-escalates the deployment's
**Abuse status** (warn / suspend). It is the input to the only automated
sending-suspension the product has — and it is owned by no module.

The logic lives across two files (`analytics/sendingReputation.ts`,
`analytics/reputationQueries.ts`) and two tables (`sendingReputation` in
`schema/delivery.ts:38`, `domainReputation` in `schema/domains.ts:91`,
column-identical save for `domain`). It is fed by exactly one producer
and read by three disjoint consumer populations.

### Producer / consumer landscape

| Role | Path | Notes |
|---|---|---|
| Producer (only one) | `delivery/sendLifecycle.ts:816` (`reputation_update` effect → `updateStats`) | one event updates the org window always + the domain window when a domain is present |
| Public read | `analytics/reputationQueries.ts:getSendingOverview` (`:53-80`) | 4 web consumers; **re-sums the window itself** |
| Public read | `analytics/reputationQueries.ts:getDomainReputations` (`:201-256`) | 1 web consumer; **re-sums, grouped by domain** |
| Platform-admin read | `platformAdmin/queries.ts` (`:18-22`, `:70-74`, `:210-214`, `:275-279`, `:391`) | 5 sites; read derived values **stale off "the latest bucket"** |
| Cron | `crons.ts:37` → `recalculateAll` (`:397-450`) | org-only; re-sums the window a third time + prunes >60d |

Five drift signals concentrate.

### 1. The window-sum loop is copied five times; the two writers are verbatim twins

"Sum the day buckets inside the 30-day window → `bounceRate = bounced /
sent` → `complaintRate = complaints / sent` → `calculateRiskLevel(...)`"
appears in:

- `updateStats` (org write) — `sendingReputation.ts:174-197`
- `updateDomainReputation` (domain write) — `sendingReputation.ts:324-345`
- `recalculateAll` (cron) — `sendingReputation.ts:407-438`
- `getSendingOverview` (public read) — `reputationQueries.ts:53-80`
- `getDomainReputations` (public read) — `reputationQueries.ts:201-256`

The org writer (`:155-197`) and the domain writer (`:305-345`) are
near-verbatim copies: identical `switch (eventType)`, identical rolling
loop, identical rate math — the only differences are the table name and
the `domain` filter.

### 2. The writer caches a derived value the reader refuses to trust

`updateStats:200-206` writes `bounceRate` / `complaintRate` / `riskLevel`
onto "today's record." `getSendingOverview:59-69` ignores that cache and
re-sums the window from scratch. The platform-admin reads
(`platformAdmin/queries.ts:18-22, 25, 43-48`) read those cached fields
off whatever the single latest bucket happens to hold — stale whenever no
event landed today — and `getPlatformStats:220-227` computes "platform"
rates from a **single day's** bucket while everyone else uses 30 days. No
one owns the derived number; that is the tell that a module is missing.

### 3. The auto-enforce trigger is duplicated and fires too often

"If risk is `high`/`critical`, schedule `autoEnforceReputation`" appears
in both `updateStats:208-213` and `updateRiskLevel:482-487`, and fires on
*every* qualifying event — so a critical org schedules an enforce
mutation on every single bounce. The **Abuse status (module)** (ADR-0011)
dedupes it idempotently, but the intent ("escalate when we cross a
threshold") is obscured by the per-event firing.

### 4. Org/domain asymmetry is a latent bound violation

`recalculateAll` and the 60-day cleanup it performs are **org-only**.
`domainReputation` has no cron fallback and no cleanup, so its
`.collect()` scans (`sendingReputation.ts:273`, `reputationQueries.ts:189`)
grow unbounded across domains × days — a `CONVENTIONS.md` `.collect()`
bound waiting to be violated as soon as a deployment sends from several
domains for a few months.

### 5. The only reason to store a risk level is dead code

`listByRiskLevel` (`:86-94`) and `listDomainsByRiskLevel` (`:378-388`) —
the sole consumers of the `by_risk_level` indexes on both tables, and the
only readers of the *stored* `riskLevel` — have **zero callers**
(repo-wide grep). The stored derived columns exist to feed an index no
live code reads.

### Shared framing

Per LANGUAGE.md's deletion test: delete `updateDomainReputation` and the
domain accumulation reappears as a verbatim copy of the org accumulation;
delete any one window-sum and the same loop is still standing in four
other callers, two of which (the public reads) disagree with the writer's
cache about who owns the rate. The block concentrates hard — it earns a
module.

The interface is the test surface, and today there is almost none: the
one existing test (`__tests__/sendingReputation.test.ts`) covers only the
pure `calculateRiskLevel`. The accumulation mutations — the dual `switch`,
the rolling window, and the **auto-suspend enforce path**, which is the
single most consequential behavior in this file — are untested, because
they can only be exercised through the scattered mutations, not through a
single owning interface.

Confidence: high on the shape (it reuses the read-side shell-vs-engine
split of ADR-0037 and the lifecycle effects-vs-shell split); the
table-unify is a pre-prod clean break with a reputation-data reset, per
the repo's [[feedback_preprod_atomic_breaking_changes]] posture.

## Decision

Make **Sending reputation** one module at
`apps/api/convex/analytics/sendingReputation.ts`: the only writer of a
single scope-discriminated table, with one summarizer behind a read-side
seam that every reader crosses.

### The table (schema breaking change)

`sendingReputation` and `domainReputation` collapse into one table; the
stored derived columns and their indexes are dropped.

```ts
// schema/delivery.ts — replaces both tables; domainReputation removed from schema/domains.ts
sendingReputation: defineTable({
  scope: v.union(v.literal('org'), v.literal('domain')),
  domain: v.optional(v.string()),     // set iff scope === 'domain'
  periodStart: v.number(),            // UTC start-of-day bucket
  totalSent: v.number(),
  totalDelivered: v.number(),
  totalBounced: v.number(),
  totalHardBounced: v.number(),
  totalComplaints: v.number(),
  lastCalculatedAt: v.number(),
  // DROPPED: bounceRate, complaintRate, riskLevel (derived on read)
}).index('by_scope_domain_period', ['scope', 'domain', 'periodStart']),
  // DROPPED: by_risk_level (dead), by_period_start (subsumed), by_domain (subsumed)
```

`scope: 'org'` rows carry `domain: undefined`; the one index serves the
org window (`eq scope`), a domain window (`eq scope, eq domain`), the
per-scope cron sweep, and cleanup.

### The summarizer (the read-side seam)

```ts
type ReputationScope = { kind: 'org' } | { kind: 'domain'; domain: string };

interface ReputationSummary {
  totalSent: number; totalDelivered: number;
  totalBounced: number; totalComplaints: number;
  bounceRate: number; complaintRate: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// The ONLY summarizer of the rolling window. Reader-typed — runs in both
// query and mutation ctx. Sums the day buckets, derives via calculateRiskLevel.
function summarize(db: DatabaseReader, scope: ReputationScope): Promise<ReputationSummary>;

// Grouped all-domains view for getDomainReputations (one loop, shared core).
function summarizeDomains(db: DatabaseReader): Promise<Array<ReputationSummary & { domain: string }>>;
```

The engine takes a `DatabaseReader`, never a session — the
session-auth shell (`reputationQueries.*`) and the platform-admin shell
(`platformAdmin/queries.ts`) keep their own auth and call `summarize`,
the same shell-vs-engine split ADR-0037's **Listing engine** uses.
Derived rate/risk is **computed on read, never stored**: the per-bucket
cache, the `by_risk_level` index, and the dead `listByRiskLevel` /
`listDomainsByRiskLevel` queries are deleted together.

### The writer

```ts
// The only writer. Args unchanged from the producer's side (sendLifecycle effect).
export const recordEvent = internalMutation({
  args: { eventType: ..., domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    bumpBucket(ctx, { kind: 'org' }, args.eventType);
    if (args.domain) bumpBucket(ctx, { kind: 'domain', domain: args.domain }, args.eventType);
    const org = await summarize(ctx.db, { kind: 'org' });
    if (org.riskLevel === 'high' || org.riskLevel === 'critical') {
      await ctx.scheduler.runAfter(0, internal.analytics.sendingReputation.autoEnforceReputation, {
        riskLevel: org.riskLevel,
      });
    }
    return { riskLevel: org.riskLevel };
  },
});
```

`recordEvent` is the single place the enforce decision lives.
`autoEnforceReputation` survives unchanged as the enforce *executor* (it
already calls `abuseStatus.transition` per ADR-0011) — only the duplicate
trigger in `updateRiskLevel` is removed. Enforcement fires off the **org**
scope's risk; domain buckets are recorded for the per-domain dashboard
only (Abuse status is a deployment-level state). Behavior is preserved:
it still fires while `high`/`critical` and the Abuse status module dedupes
— this is a refactor, not a new enforce policy.

### The cron

`recalculateAll` shrinks to **cleanup-only**: age out buckets older than
60 days across *both* scopes (closing drift signal #4). Risk no longer
needs periodic recalculation because it is derived on read; the cron's
former risk-recompute + missed-enforce safety net is moot.

### Decisions resolved in the grilling

1. **Unify the two tables** into one scope-discriminated table (vs a
   scope-parametric core over two physical tables). Scope becomes a pure
   parameter — one accumulator, one summarizer, one cron+cleanup — which
   is what dissolves the org/domain asymmetry for free.
2. **Derive on read** through one `summarize` (vs an authoritative cached
   current value). The window is tiny (≤60 org buckets; domain bounded
   once cleanup is added), so re-deriving is cheap and writer/reader can't
   disagree.
3. **Drop the stored risk + `by_risk_level` index** once the dead
   list-by-risk queries that were its only readers are deleted — the
   discovery that collapsed the residual "do we keep an AGGREGATED
   `riskLevel`?" tension.

## Considered options

### Table strategy

1. **One scope-discriminated table** *(chosen)*. One accumulator, one
   summarizer, one cron; the domain-cleanup asymmetry disappears. Costs a
   schema change + pre-prod reputation reset.
2. **Keep two tables, single-source the logic via a scope-parametric
   core.** No schema change; still kills the 5× duplication and lets us
   add the missing domain cron. Rejected during grilling — leaves two
   tables and runs the same routine against each, when the only
   difference is a scope key.
3. **Two adapters behind a shared core.** LANGUAGE.md's "two adapters =
   real seam" — but the divergence here is a table name and one column,
   too thin to be an adapter. Unifying turns it into a parameter and
   dissolves the seam.

### Read model

1. **One summarizer, derive on read** *(chosen)*. The single window-summer
   is the only place the window is summed; every reader crosses it.
2. **Authoritative cached current value** maintained at write time;
   readers never re-sum. Faster reads, but needs a "which record is
   authoritative" answer and freshness handling when no event lands on a
   day. Rejected — the window is too small to justify the cache, and the
   cache is exactly what drifted from the readers today.

### Stored risk for indexed listing

1. **Drop it with the dead list-by-risk queries** *(chosen)*.
   `listByRiskLevel`/`listDomainsByRiskLevel` have zero callers, so the
   `by_risk_level` index has no live reader and the stored `riskLevel` has
   no reason to exist.
2. **Keep an AGGREGATED `riskLevel`** for the `by_risk_level` index. Would
   reintroduce a write-back of a derived value (the thing we're removing)
   to feed an index nothing reads. Rejected.

### Enforce timing

1. **Fire while `high`/`critical` (preserved)** *(chosen)*, from one place.
   Abuse status dedupes; this keeps the change a behavior-preserving
   refactor.
2. **Fire only on the upward edge** (previous risk below threshold, new
   risk at/above). Cleaner, but requires persisting a prior-risk per
   scope — new state that cuts against derive-on-read. Deferred to
   follow-up; out of scope for this refactor.

### Module home

1. **Stay in `analytics/`** *(chosen)*. The public reads
   (`reputationQueries.ts`) already live there as the auth shell, and the
   move would be churn for no depth gain.
2. **Move to `organizations/` next to the Abuse status module** (its
   enforcement target) or **`delivery/`** (its producer). Deferred — the
   `CONTEXT.md` term names the module regardless of folder; revisit if the
   analytics folder accretes other non-report controls.

## Consequences

### Files that collapse / shrink

- `analytics/sendingReputation.ts` — `updateStats` + `updateDomainReputation`
  collapse into one `recordEvent`; the five window-sum loops collapse into
  one `summarize`; `recalculateAll` shrinks to cleanup; `updateRiskLevel`,
  `getByOrganization`, `getByDomain`, `listByRiskLevel`,
  `listDomainsByRiskLevel` are deleted (dead or subsumed).
- `analytics/reputationQueries.ts` — `getSendingOverview` and
  `getDomainReputations` lose their inline window loops and call
  `summarize` / `summarizeDomains`. `getCampaignSendEstimate` is untouched
  (it is IP-warming, not reputation).
- `platformAdmin/queries.ts` — the 5 raw `sendingReputation` reads route
  through `summarize({ kind: 'org' })`, which **fixes the stale-cache reads
  and the `getPlatformStats` single-day bug** as a side effect.

### Files that grow / change

- `schema/delivery.ts` — the unified `sendingReputation` table + the one
  index; `schema/domains.ts` drops `domainReputation`.
- `delivery/sendLifecycle.ts:816` — the `reputation_update` effect calls
  `recordEvent` instead of `updateStats` (args unchanged).
- `organizations/deletion/steps/domainReputation.ts` + `walker.ts:61,143,205`
  + `steps/_common.ts:64,112` — the two cascade steps merge into one
  `sendingReputation` step; `__tests__/organizationDeletionWalker.test.ts:123`
  (the `domainReputation` ordering assertion) re-points to the unified table.
- `devShortcuts/reset.ts:70` — the table list drops `domainReputation`.

### Schema migration (atomic, pre-prod)

Clean break per the repo's posture: the two tables are replaced by one and
the derived columns are dropped in a single PR; reputation data is reset
(it is a rolling 30-day window with no long-term value, and
`autoEnforceReputation` re-derives the abuse state from the first events
after the reset). No two-phase dual-write.

### Test surface — the payoff

- `__tests__/sendingReputation.integration.test.ts` (new) — drives events
  through `recordEvent` and asserts `summarize`'s rolling rate/risk per
  scope; asserts org and domain accumulate independently; asserts that
  crossing `critical` schedules the abuse enforce (**the auto-suspend path
  that is untested today**); asserts the cleanup cron prunes >60-day
  buckets for both scopes.
- The existing pure `calculateRiskLevel` test is retained unchanged.

### Behavior

Caller-visible behavior is preserved, with three bugs fixed
opportunistically: platform-admin reputation reads stop being stale,
`getPlatformStats` reports the 30-day window instead of a single day, and
domain buckets stop growing unbounded. The Abuse status seam (ADR-0011) is
untouched — reputation remains one of its three internal writers.

### Vocabulary

`CONTEXT.md` gained a `## Sending reputation` section (the **Reputation
scope** and **Sending reputation (module)** terms) upstream of `## Abuse`,
and a Relationships entry tying the **Send lifecycle → Sending reputation
→ Abuse status** chain — landed inline with this ADR.

## Follow-up work

1. **Enforce on the upward edge.** If the per-event enforce scheduling
   proves noisy in practice, persist a per-scope prior risk and fire only
   on the crossing. Needs new state; deferred deliberately.
2. **`getPlatformStats` window semantics.** The fix changes it from a
   single-day to a 30-day rolling figure. Confirm with product that
   "platform stats" wants the rolling window (it almost certainly does —
   the single-day reading was unintended).
3. **Module home.** Revisit moving the module out of `analytics/` (to
   `organizations/` beside Abuse status, or `delivery/`) if the analytics
   folder accretes more non-report sending controls.
4. **Per-domain enforcement.** Today only org-scope risk enforces. If
   Abuse status ever becomes domain-scoped, `recordEvent` is the natural
   place to enforce the domain scope too.

## Execution

**Implementation is deferred** (decision accepted; build scheduled as a
separate pre-production pass). When executed, it lands as a single atomic
change — pre-launch nothing needs PR-splitting — built test-first so the
auto-suspend path is covered before the schema moves. Change set:

- `apps/api/convex/schema/delivery.ts` — unified `sendingReputation` table.
- `apps/api/convex/schema/domains.ts` — drop `domainReputation`.
- `apps/api/convex/analytics/sendingReputation.ts` — `recordEvent` +
  `summarize` + `summarizeDomains` + cleanup-only cron; delete dead/subsumed
  exports; keep `calculateRiskLevel` and `autoEnforceReputation`.
- `apps/api/convex/analytics/reputationQueries.ts` — route through `summarize`.
- `apps/api/convex/platformAdmin/queries.ts` — 5 reads route through `summarize`.
- `apps/api/convex/delivery/sendLifecycle.ts` — effect calls `recordEvent`.
- `apps/api/convex/organizations/deletion/` — merge the cascade step; update walker + `_common.ts` + the ordering test.
- `apps/api/convex/devShortcuts/reset.ts` — table list.
- `apps/api/convex/__tests__/sendingReputation.integration.test.ts` — new.

`CONTEXT.md` was updated ahead of execution (this ADR's grilling); the
Abuse-section cross-reference to `autoEnforceReputation` stays accurate
because that function survives.
