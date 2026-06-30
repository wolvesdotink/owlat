# Audience resolution module — single definition of campaign recipient eligibility, discriminated `Audience` value, closing count/send drift and the soft-delete leak

**Status:** proposed

## Context

"Who receives this Campaign" is answered by three independent
implementations of the same rules, plus the storage shape that feeds
them and the frontend that builds them. The targeting selection — what
CONTEXT.md now names an **Audience** — is open-coded everywhere it
appears: four flat columns in the schema, three loose refs in the
wizard, and separate eligibility logic in the recipient query and the
count query. The duplication has already drifted, and the drift is
user-visible.

### Caller landscape — "who is an eligible recipient"

| Site | File:line | Audience shape | Eligibility applied | Soft-delete filter |
|---|---|---|---|---|
| Recipient resolver (de-facto) | `emailsQueries.ts:138-267` | flat args (`audienceType` + `topicId`/`segmentId`/`segmentFilters`) | email-present, suppression, DOI-if-topic; segment match via inline `evaluateCondition` loop | ❌ **none** (`:214` scans `contacts`) |
| Wizard count | `campaigns/organization.ts:99-152` | flat args | topic: **DOI only**; segment → `evaluateSegmentCount` | ❌ none |
| Shared segment count | `lib/segmentEvaluation.ts:63-91` | `filters` | raw match only (`total === eligible`) | ❌ none (`:75,:80`) |
| Wizard selection | `AudienceStep.vue:30-113` | three refs (`audienceType` + `selectedTopicId` + `selectedSegmentId`) | re-derives topic-xor-segment at `:59-69`, `:102-110` | n/a |
| Wizard review | `new.vue:47-52, 119-125` | `AudienceStepExpose` | re-derives `audienceDisplayText` | n/a |
| Storage | `schema/campaigns.ts:29-32` | four flat optional columns | — | — |

Two orchestrator consumers of the recipient resolver (`emails.ts:325`
first-phase, `emails.ts:731` winner-remainder); two frontend consumers
each of the count query (`AudienceStep.vue:59`, `useCampaignForm.ts:185`)
and the `updateAudience` mutation (`AudienceStep.vue:120`,
`useCampaignForm.ts:127`).

Per LANGUAGE.md's deletion test: deleting `getCampaignRecipients` does
not move complexity to one sibling — it scatters the eligibility rules
(email-present + suppression + DOI + segment match) across both the
orchestrator's first and second phase *and* re-collides them with the
count query's separate copy. The complexity is real, it concentrates
into a predicate, and it currently lives in three places that must
agree and don't.

### 1. The wizard count over-reports — `eligible` ≠ delivered

`getAudienceCountByOrganization` computes `eligible` by filtering on DOI
*only*:

```ts
// campaigns/organization.ts:124-136 — topic path
let eligible = 0;
for (const membership of memberships) {
  const contact = await ctx.db.get(membership.contactId);
  if (contact) {
    const isDoiEligible =
      contact.doiStatus === 'confirmed' || contact.doiStatus === 'not_required';
    if (isDoiEligible) eligible++;
  }
}
```

It never drops emailless Contacts (phone/SMS/WhatsApp/generic origin) or
`blockedEmails` suppressed Contacts. The segment path is worse — it
delegates to `evaluateSegmentCount`, which returns `total === eligible`
(raw match count, no eligibility at all). But the actual send *does*
drop both:

```ts
// emailsQueries.ts:174 (topic) and :224,:250 (segment)
if (!contact || !contact.email || isEmailBlocked(contact.email)) continue;
```

So the operator is shown "500 eligible recipients" and 450 emails go
out. The gap the wizard renders (`AudienceStep.vue:93-96`,
`total - eligible`) reflects only DOI — it cannot explain the emailless
and suppressed exclusions because the count never saw them.

### 2. Soft-deleted Contacts are reachable on a live send

`getCampaignRecipients`' segment path collects the whole `contacts`
table with no `deletedAt` filter:

```ts
// emailsQueries.ts:214-216
const contacts = await ctx.db
  .query('contacts')
  .collect();
```

CONTEXT.md's **Contact** invariant is explicit: "All list/lookup
queries MUST filter `deletedAt === undefined`." The topic path equally
omits the check — it iterates `contactTopics` memberships (which persist
through the 30-day soft-delete retention window; the cascade hard-delete
runs only at the cron) and patches in `!contact || !contact.email ||
isEmailBlocked` but never `contact.deletedAt`. A soft-deleted Contact
with a surviving membership or a segment match is a campaign recipient.
The same leak lives in the shared `evaluateSegmentCount`
(`segmentEvaluation.ts:75,:80`), so segment-management previews
over-count too.

### 3. Two segment-evaluation paths for the same campaign

The campaign *recipient* path matches segments with an inline
`evaluateCondition` loop (`emailsQueries.ts:238-260`); the campaign
*count* path matches with `evaluateSegmentCount`
(`organization.ts:147`). Both call the same underlying engine
(`evaluateOne` / `preloadConditionsLookup`) but through different
wrappers with different post-filtering — so they can disagree on the
same segment, and bug #1 is exactly that disagreement.

### 4. Illegal Audience states are representable in storage

`schema/campaigns.ts:29-32` stores audience as four independent optional
columns:

```ts
audienceType: v.optional(audienceTypeValidator),
topicId: v.optional(v.id('topics')),
segmentId: v.optional(v.id('segments')),
segmentFilters: v.optional(segmentFiltersValidator), // copied at send time
```

Nothing prevents `audienceType: 'topic'` with a `segmentId` set, or
`'segment'` with neither `segmentId` nor a `segmentFilters` snapshot.
Each reader re-derives the "exactly one, keyed by `audienceType`"
invariant by hand.

### 5. The frontend re-derives the same invariant three times

`AudienceStep.vue` models the Audience as three refs (`:30-34`) and
re-derives topic-xor-segment when building the count args (`:59-69`), in
validation (`:102-110`), and again in `new.vue`'s review text
(`:119-125`) — kept in sync by a `watch` on `props.initialData`
(`:37-46`). The invariant is enforced by convention at each site, so it
can break silently.

### Shared framing

The three eligibility implementations are shallow individually, but the
question they share — campaign recipient eligibility — has a real,
ordered predicate (live → email-present → not-suppressed → DOI-if-topic)
and a load-bearing asymmetry (DOI gates topics, never segments). Lifting
the predicate behind one module produces real leverage: the orchestrator
and the wizard ask one question and get one answer, so the count
*cannot* over-report again. Locality: the predicate, the suppression
gate, the soft-delete filter, and the DOI asymmetry live in one place
instead of three.

Confidence: high. Mirrors the **Contact resolution (module)** (ADR-0008)
single-entry, discriminated-input shape, and reuses the existing
segment-matching engine (`evaluateOne` / `preloadConditionsLookup`)
unchanged. One schema migration (pre-prod, single org per deployment,
atomic backfill — same posture as ADR-0032's `contactEmail` rename) and
one intended behaviour change (the count stops over-reporting; soft-
deleted Contacts stop receiving).

## Decision

Introduce a discriminated **Audience** value in `packages/shared`,
migrate `campaigns` from four flat columns to one `audience` field, and
introduce an **Audience resolution (module)** at
`convex/campaigns/audienceResolution.ts` that owns the single mapping
from an **Audience** to its eligible recipients. CONTEXT.md's `## Audience`
section landed inline with the grilling.

### The `Audience` value

```ts
// packages/shared/src/types/audience.ts
// The targeting *selection* — snapshot-free. What the wizard picks and
// what `updateAudience` writes. Ids are strings at this layer; the
// Convex edge narrows them to Id<...>.
export type Audience =
  | { kind: 'topic'; topicId: string }
  | { kind: 'segment'; segmentId: string };
```

```ts
// convex/campaigns/audience.ts — the Convex validator + stored shape.
// The stored segment case additionally carries the send-time snapshot;
// `Infer` keeps it in lockstep with the shared TS type's selection subset.
export const audienceValidator = v.union(
  v.object({ kind: v.literal('topic'), topicId: v.id('topics') }),
  v.object({
    kind: v.literal('segment'),
    segmentId: v.id('segments'),
    frozenFilters: v.optional(segmentFiltersValidator), // copied at send time
  }),
);
export type StoredAudience = Infer<typeof audienceValidator>;
```

Illegal states (`kind: 'topic'` carrying a `segmentId`; `kind: 'segment'`
carrying neither id nor snapshot) become unrepresentable. The wizard and
`updateAudience` speak the snapshot-free `Audience`; the **Campaign send
orchestrator (module)** / preflight populates `frozenFilters` at send
time so an already-sent Campaign reproduces the exact Segment definition
even after the Segment is later edited.

### Module surface

```ts
// convex/campaigns/audienceResolution.ts

export interface CampaignRecipient {
  _id: Id<'contacts'>;
  email: string;
  firstName?: string;
  lastName?: string;
  timezone?: string;
  language?: string;
}

// ── The pure core: the eligibility decision for one loaded Contact. ──
// null = excluded. The ONLY definition of "eligible recipient".
export function selectRecipient(
  contact: Doc<'contacts'>,
  gate: { requiresDoi: boolean; blockedEmails: ReadonlySet<string> },
): CampaignRecipient | null {
  if (contact.deletedAt !== undefined) return null;          // live-contact
  if (!contact.email) return null;                            // email-present
  if (gate.blockedEmails.has(contact.email.toLowerCase())) return null; // suppression
  if (gate.requiresDoi
      && contact.doiStatus !== 'confirmed'
      && contact.doiStatus !== 'not_required') return null;   // DOI (topic only)
  return projectRecipient(contact);
}

// ── The shared async iteration: the single walk over an Audience's
// candidates. `requiresDoi` is true ONLY for a topic Audience whose
// Topic requires DOI — false for every segment Audience (the named
// asymmetry). Segment matching reuses evaluateOne/preloadConditionsLookup
// over the soft-delete-filtered contact scan. ──
async function forEachCandidate(
  ctx: QueryCtx,
  audience: StoredAudience,
  visit: (recipient: CampaignRecipient) => void,
): Promise<{ total: number }>;   // total = candidates examined (members / matches)

// ── Entry 1: materialize rows. The orchestrator's resolution step. ──
export const resolveRecipients = internalQuery({
  args: { audience: audienceValidator },
  handler: async (ctx, { audience }): Promise<CampaignRecipient[]> => { /* push */ },
});

// ── Entry 2: accumulate integers. The wizard's audience-size readout.
// Runs the IDENTICAL predicate, so `eligible` equals the delivered count. ──
export const countRecipients = query({
  args: { audience: v.optional(audienceValidator) },
  handler: async (ctx, { audience }): Promise<{ total: number; eligible: number }> => {
    /* drives forEachCandidate, counts visits; total from the walk */
  },
});
```

Both entries drive `forEachCandidate` + `selectRecipient`;
`resolveRecipients` pushes, `countRecipients` increments. That shared
walk is the structural guarantee that count and send cannot diverge.

### Invariants

- **DOI asymmetry, by design.** `requiresDoi` is set from
  `topic.requireDoubleOptIn` for a topic Audience and is *always false*
  for a segment Audience. Segments are explicit operator targeting, not
  consent-derived membership. Encoded once, in `forEachCandidate`'s gate
  construction. Do not "fix" the segment path to gate on DOI without
  revisiting this invariant.
- **`eligible === resolveRecipients(audience).length`** for any Audience
  — the two entries share one predicate.
- **`total`** is the raw membership count (topic) or segment-match count
  (segment); `total - eligible` is the meaningful excluded gap
  (soft-deleted + emailless + suppressed + DOI-pending), which the wizard
  can now itemise honestly.
- **Live contacts only.** `selectRecipient` rejects `deletedAt !==
  undefined`; the segment scan applies the soft-delete filter at the
  shared `contacts` read. Closes drift #2.

### Replaces

| File:line | Pre | Post |
|---|---|---|
| `emailsQueries.ts:138-267` `getCampaignRecipients` | inline topic + segment eligibility, no soft-delete filter | Deleted; orchestrator calls `resolveRecipients` |
| `campaigns/organization.ts:99-152` `getAudienceCountByOrganization` | DOI-only eligible; segment → raw `evaluateSegmentCount` | Deleted; wizard calls `countRecipients` |
| `emails.ts:325` (first-phase) | `runQuery(getCampaignRecipients, {audienceType,...})` | `runQuery(resolveRecipients, { audience })` |
| `emails.ts:731` (winner-remainder) | same, then orchestrator-side already-sent exclusion | `runQuery(resolveRecipients, { audience })`, then unchanged exclusion |
| `campaigns/campaigns.ts:126` `updateAudience` | three optional args (`audienceType`/`topicId`/`segmentId`) | one `audience: audienceValidator` arg |
| `schema/campaigns.ts:29-32` | four flat optional columns | one `audience: v.optional(audienceValidator)` field |
| `AudienceStep.vue:30-113` | three refs + re-derivation | one `audience` ref of the shared `Audience` type |
| `new.vue:47-52,119-125` | `AudienceStepExpose` re-derivation | reads the shared `Audience` |
| `useCampaignForm.ts:127,185` | flat-arg `updateAudience` + count | `audience`-shaped `updateAudience` + `countRecipients` |

`evaluateSegmentCount`, `evaluateCondition`, `evaluateOne`,
`preloadConditionsLookup` in `lib/segmentEvaluation.ts` **stay** — they
are the shared segment-matching engine used by segment management
(`segments.ts:123,240,312`). The module reuses `evaluateOne` /
`preloadConditionsLookup`; it does not fork them.

### Closes drift bugs

1. **Count over-reporting** (§1) — `countRecipients` runs the same
   `selectRecipient` predicate as `resolveRecipients`; `eligible` now
   subtracts emailless + suppressed + DOI-pending, matching delivery.
2. **Soft-delete leak** (§2) — `selectRecipient` rejects soft-deleted
   Contacts; the shared `contacts` scan gains the `deletedAt` filter, so
   the campaign paths *and* `evaluateSegmentCount`'s preview counts are
   fixed in one place.
3. **Two segment-evaluation paths** (§3) — campaign matching runs once,
   through `forEachCandidate`, for both count and send.
4. **Illegal Audience states** (§4) — the discriminated `audience` field
   makes them unrepresentable in storage.
5. **Frontend re-derivation** (§5) — one `Audience` ref replaces three;
   the topic-xor-segment invariant lives in the type.

### Tests

The interface is the test surface.

1. **`selectRecipient` unit tests** (pure, no harness) at
   `campaigns/__tests__/audienceResolution.test.ts` — table-driven over
   `(contact fixture × gate) → CampaignRecipient | null`: soft-deleted →
   null; emailless → null; suppressed → null; DOI-pending with
   `requiresDoi` → null; DOI-pending with `!requiresDoi` (segment) →
   recipient; confirmed/not_required → recipient. This is the deep core.
2. **Anti-drift integration test** — for a seeded topic and segment,
   assert `countRecipients(a).eligible === resolveRecipients(a).length`.
   The property that bug #1 violated.
3. **Soft-delete regression** — a soft-deleted Contact with a surviving
   topic membership and a segment match appears in neither entry.
4. **DOI asymmetry** — a DOI-pending Contact is excluded from a
   DOI-required topic Audience but included in a segment Audience that
   matches it.
5. **Migrating existing tests:**
   - `__tests__/sendFlow.integration.test.ts:321-...` (the
     `getCampaignRecipients` describe block, call sites `:326,:351,:371,
     :596`) → `resolveRecipients` with `{ audience }`.
   - `__tests__/campaignsRoleEnforcement.integration.test.ts:91-107`
     (`updateAudience` role enforcement) → the `audience`-shaped arg.
   - `lib/__tests__/segmentEvaluation.integration.test.ts:684-...`
     (`evaluateSegmentCount`) **stays** — the engine is unchanged except
     the soft-delete filter, which gains one assertion.

### Out of scope for this ADR

- **The full-table segment scan's performance.** `forEachCandidate`
  localises the `contacts.collect()` scan into one place so a future
  index lands once; this ADR adds no index. Same posture as
  `topics.reconcileMemberCounts` deferral in ADR-0032.
- **The `frozenFilters` snapshot write.** The **Campaign send
  orchestrator (module)** / preflight copies the live Segment's filters
  at send time; the resolver only *reads* a snapshot when handed one.
- **The A/B already-sent exclusion.** `listSentContactIdsForCampaign`
  dedup in `sendCampaignWinnerToRemainder` stays in the orchestrator —
  that is send-state, not Audience membership.
- **A suppression re-check at enqueue.** `blockedEmails` is the only
  suppression gate today and lives inside resolution; this ADR does not
  add a second downstream gate.

## Consequences

**The count cannot over-report again.** The single most user-visible
drift — "you promised 500, you sent 450" — closes structurally, because
the number the wizard shows and the list the send materialises come from
one predicate driven by one walk.

**Soft-deleted Contacts stop receiving campaigns.** A correctness and
compliance fix that also corrects segment-management preview counts via
the shared scan.

**Illegal Audience states become unrepresentable.** Primitive-obsessed
flat columns collapse to a discriminated value the frontend and backend
both speak — the FE's three-ref re-derivation disappears.

**Aligns with the resolution-module pattern.** Single entry surface,
discriminated input, one owner of a cross-cutting question — the same
shape as the **Contact resolution (module)** (ADR-0008).

**Surface area:**

| Code site | Pre | Post |
|---|---|---|
| `emailsQueries.ts` (recipient block) | ~130 LOC | 0 (deleted) |
| `campaigns/organization.ts` (count block) | ~54 LOC | 0 (deleted) |
| `AudienceStep.vue` (audience state) | ~85 LOC | ~30 LOC (one ref) |
| `new.vue` / `useCampaignForm.ts` re-derivation | ~40 LOC | ~10 LOC |
| New `packages/shared/.../audience.ts` | — | ~15 LOC |
| New `convex/campaigns/audience.ts` (validator) | — | ~15 LOC |
| New `convex/campaigns/audienceResolution.ts` | — | ~140 LOC |
| New `campaigns/__tests__/audienceResolution.test.ts` | — | ~220 LOC (≈mostly pure) |
| Net | ~309 LOC | ~430 LOC (≈220 of it new tests) |

### Migration

Five phases, each independently shippable.

#### Phase 1 — `Audience` value + Convex validator

`packages/shared/src/types/audience.ts` and `convex/campaigns/audience.ts`
land with the `Infer` lockstep check. No caller uses them yet. Additive.

#### Phase 2 — Schema migration `campaigns` flat columns → `audience`

1. Migration `convex/migrations/0033_campaign_audience.ts`: one-pass
   backfill mapping `(audienceType, topicId, segmentId, segmentFilters)`
   → the discriminated `audience` (segment case folds `segmentFilters`
   into `frozenFilters`).
2. `schema/campaigns.ts`: add `audience: v.optional(audienceValidator)`;
   drop the four flat columns.
3. Update the current readers/writers to the new field in the same
   commit so the tree compiles (they are rewritten in phases 3–4).

Pre-prod, single org per deployment — bounded backfill, atomic breaking
change. Mirrors ADR-0032 phase 1.

#### Phase 3 — Land the module + tests, migrate backend consumers

1. `convex/campaigns/audienceResolution.ts` with `selectRecipient`,
   `forEachCandidate`, `resolveRecipients`, `countRecipients`.
2. Add the soft-delete filter to the shared `contacts` scan in
   `lib/segmentEvaluation.ts`.
3. `emails.ts:325` and `:731` → `resolveRecipients`. Delete
   `getCampaignRecipients`. `_generated/api.d.ts` regenerates.
4. New pure + anti-drift tests; migrate the `sendFlow` call sites.

#### Phase 4 — Migrate the wizard + write mutation

1. `campaigns/campaigns.ts:126` `updateAudience` → one `audience` arg.
   Delete `getAudienceCountByOrganization`.
2. `AudienceStep.vue` / `new.vue` / `useCampaignForm.ts` → one `Audience`
   ref; the count call switches to `countRecipients`. The wizard's
   excluded-gap readout becomes honest.

#### Phase 5 — Verification sweep

Grep gate: no `audienceType`/`topicId`/`segmentId` flat reads on
`campaigns` outside the migration; no `ctx.db.query('contacts')` without
a soft-delete filter in the campaign send path; `getCampaignRecipients`
and `getAudienceCountByOrganization` gone.

**Risk:** two intended behaviour changes. The wizard's `eligible` count
drops for any Audience containing emailless or suppressed Contacts (now
honest). Soft-deleted Contacts with surviving memberships/matches stop
receiving (correctness). No risk to in-flight scheduled campaigns —
resolution runs fresh at send time; a scheduled campaign stores only the
`audience` selection, resolved when the orchestrator fires.
