# Resource listing — one engine and per-entity descriptors behind a single read-side seam, replacing four incompatible list contracts

**Status:** accepted

## Context

The backend is 35 deep write-side modules — lifecycles, intake, dispatch,
find-or-create — each owning how one entity *changes*. The read side never got
the same treatment. "List a page of `<entity>`" is open-coded in ~80 `list*`
query endpoints, and the duplication is not the worst of it: no two of them
agree on their own contract.

### The four-contracts landscape — "a filtered, paginated page"

| Query | Return shape | Cursor | Access path |
|---|---|---|---|
| `contacts/contacts.ts:50` (`list`) | `{ page, isDone, continueCursor }` | **real Convex cursor on browse; the literal string `'search'` on search** | `search_contacts` index + `by_created_at` |
| `campaigns/organization.ts:11` (`listByOrganization`) | `{ page, isDone, continueCursor }` | **stringified integer offset** (`paginateArray`) | `by_status`/`by_updated_at`, then in-memory `.filter()` |
| `emailTemplates/organization.ts:8` (`listByOrganization`) | **bare array, no pagination at all** | — | **`.collect()` the whole table**, then in-memory filter + sort |
| `topics/topics.ts:26` (`listByOrganization`) | `{ page, … }` + per-row enrichment | real Convex cursor | `.paginate()`, no filter, **N+1 `contactCount`** |

Four list queries, four return contracts, none canonical. A single piece of
pagination UI physically cannot consume all of them. This sits behind no shared
interface — `lib/queryHelpers.ts` holds only `buildSearchableText` and
`notSoftDeleted`; `lib/pagination.ts` holds the *primitives* (`paginateArray`,
`countWithPagination`) that each call site re-assembles by hand.

### 1. The cursor is a lie on the search path

`contacts/contacts.ts:74` returns `continueCursor: ('search' as unknown as string)`
when `hasMore` is true, and the search handler always `.take(numItems + 1)` from
the top, ignoring any incoming cursor. **Search results are silently
single-page** — asking for page 2 of a search re-serves page 1. The `as unknown
as string` cast is the tell: the code knows the cursor is not a cursor. The bug
exists precisely because no module owns "what a cursor means here."

### 2. The index-vs-collect decision is made per file, often wrongly

The decision tree "do I have a search index? a status index? or do I collect
everything?" is re-derived in each query, and the answers diverge:
`contacts` uses a real `searchIndex` (the right pattern); `campaigns` collects a
whole status-bucket and filters search in memory; `emailTemplates` `.collect()`s
the *entire* table for every list, every filter, every sort
(`organization.ts:17-60`) — a scaling cliff with no index in sight. Across the
backend there are **140 `.collect()` calls in 47 files**, a meaningful fraction
of them load-all-then-filter where an index exists.

### 3. Counts are their own zoo

`countByStatusByOrganization` (`campaigns/organization.ts:66`) and
`countByTypeByOrganization` (`emailTemplates/organization.ts:65`) both
`.collect()` the table and group-by in a hand loop. `contacts.ts:93` (`count`)
reads a denormalized cached counter from `instanceSettings` with a
`countWithPagination` fallback. `getAudienceStats` (`contacts.ts:111`) composes
three counts. Three count strategies, no shared surface — and the dashboards
that render a list need its facet counts *alongside* the page anyway.

### 4. Enrichment is duplicated, and N+1

`topics.ts:26` (`list`) enriches each row with `contactCount`
(`cachedMemberCount ?? countWithPagination(...)`), and `topics.ts:62` (`get`)
inlines the *same* enrichment for the single-row case. The per-row count is a
full pagination scan whenever the cached field is absent.

### Shared framing

Per LANGUAGE.md's deletion test: there is no module to delete — which is the
point. The search→filter→sort→paginate→count block is *currently reappearing*
across ~80 callers, in four mutually-incompatible shapes, with a live cursor bug
and a scaling cliff. It concentrates hard, so the module earns its keep. The
interface is the test surface: none of this logic can be tested without a seeded
deployment per query, so none of it has a test — including the cursor semantics
that are already wrong.

This is the read-side counterpart to the write-side lifecycle campaign, and it
follows the codebase's own resolved precedent: the **Walker** (thin generic
dispatcher) over **Block modules** (per-type data). The novelty over a pure
refactor is a real blast radius — a schema migration (new search indexes) and an
intentional, atomic break to the `emailTemplates` HTTP list shape.

Confidence: high on the shape (it mirrors an already-accepted pattern), medium
on the schema scope (the exact `filterFields` per entity get pinned as each
descriptor lands).

## Decision

Make **Resource listing** one seam: a generic **Listing engine** dispatching
over per-entity **Listing descriptors**, returning one Convex-native contract.

### The contract

```ts
// convex/lib/listing.ts — one source of truth
interface ListingDescriptor<T extends TableNames> {
  // Search path (optional): relevance-ordered, multi-page via .withSearchIndex().paginate().
  search?: { index: string; field: string; filterFields?: string[] };
  // Browse path (required): sortable via a regular index + .order().
  browse:  { index: string; order: 'asc' | 'desc' };
  sortKeys?: string[];          // legal sorts — BROWSE PATH ONLY
  filters?:  string[];          // equality filters (must be filterFields on search)
  softDelete?: boolean;         // deletedAt rides the index, never a page-thinning post-filter
  enrich?: (db: DatabaseReader, row: Doc<T>) => Promise<Record<string, unknown>>;
  facets?: Record<string, Facet<T>>;
}

type Facet<T extends TableNames> =
  | { kind: 'indexCount'; index?: string }
  | { kind: 'groupBy'; field: string; buckets: readonly string[] }   // closed bucket set
  | { kind: 'cachedCounter'; table: TableNames; field: string };     // denormalized counter

async function listResources<T extends TableNames>(
  db: DatabaseReader,
  descriptor: ListingDescriptor<T>,
  args: { search?: string; filters?: Record<string, unknown>; sort?: string; paginationOpts: PaginationOpts },
): Promise<PaginationResult<Doc<T> & Record<string, unknown>>>;     // reuses the existing shape
```

The cursor is **Convex-native everywhere** — search uses
`.withSearchIndex(...).paginate()` (a real, opaque cursor; the `'search'`
sentinel dies), browse uses `.withIndex(...).order().paginate()`. **Search
results are relevance-ordered**, so `sortKeys` apply to the browse path only;
passing `search` means relevance order, full stop. This is part of the
interface, not a hidden detail — every caller must know it.

The engine is **auth-agnostic**: it takes a `DatabaseReader`, never a session.
The session-auth shell (`contacts.ts:list`) and the API-key shell
(`*/organization.ts`) keep their own auth posture and call `listResources` —
the same effects-vs-shell split the lifecycle modules already use.

### What the descriptors look like

```ts
// contacts: search index already exists — the cleanest case
export const contactListing: ListingDescriptor<'contacts'> = {
  search: { index: 'search_contacts', field: 'searchableText', filterFields: ['deletedAt'] },
  browse: { index: 'by_created_at', order: 'desc' },
  softDelete: true,
  facets: { total: { kind: 'cachedCounter', table: 'instanceSettings', field: 'contactCount' } },
};

// campaigns: a new search_campaigns index is the Convex-native bill
export const campaignListing: ListingDescriptor<'campaigns'> = {
  search: { index: 'search_campaigns', field: 'searchableText', filterFields: ['status'] },
  browse: { index: 'by_updated_at', order: 'desc' },
  sortKeys: ['updatedAt'], filters: ['status'],
  facets: { total: { kind: 'indexCount' },
            byStatus: { kind: 'groupBy', field: 'status', buckets: CAMPAIGN_STATUSES } },
};

// topics: browse-only, enrichment shared with topics.get
export const topicListing: ListingDescriptor<'topics'> = {
  browse: { index: 'by_creation_time', order: 'desc' },
  enrich: async (db, t) => ({
    contactCount: t.cachedMemberCount
      ?? await countWithPagination(db, 'contactTopics', 'by_topic', q => q.eq('topicId', t._id)),
  }),
};
```

`getRecent` collapses to `listResources(db, d, { paginationOpts: { numItems: 5 } })`;
`getAudienceStats` composes three descriptors' `total` facets.

### Decisions resolved in the grilling

1. **Walker + descriptors hybrid**, not a generic config-bag and not a per-entity
   module family. A single generic engine over thin per-type data — the accepted
   Walker/Block-module shape. A generic engine alone risked a config-bag and
   fights Convex's per-table typed index names; a per-entity family would let the
   cursor/index policy drift again across ~80 implementations.
2. **Convex-native cursor only**, accepting the schema bill: search routes
   through a `searchIndex`, so `campaigns`/`emailTemplates` gain
   `search_*` indexes and `filterFields`; `deletedAt` joins the relevant index so
   soft-delete is never a page-thinning post-filter. An in-memory `paginateArray`
   fallback was rejected — it is the source of the offset cursor and the
   table-scan-on-search.
3. **Scope is page + enrichment + facet counts.** The descriptor owns the
   entity's whole read surface; `countByStatus`/`countByType`/`count`/the topic
   enrichment all collapse in. A page-only seam was rejected for leaving the count
   zoo and the N+1 standing.
4. **The descriptor owns enrichment cost.** The engine runs `enrich` over the
   page and does not hide whether each call is O(1) cached or a scan; the cost is
   stated on the descriptor. Refusing non-O(1) enrichment at the interface was
   rejected as forcing premature denormalization.
5. **Facets are closed to three strategies** (`indexCount`, `groupBy` over a
   closed bucket set, `cachedCounter`) — exactly what exists in the wild. Richer
   (computed, multi-dimensional) facets are rejected *at the interface*; anyone
   needing one writes a plain query outside the seam, keeping the engine honest.
6. **Auth stays in the shells.** The engine reads; it does not authenticate or
   scope.

### Enforcement

A `lint:listing` guard (sibling to the existing `lint:env` and ADR-0036's
`lint:errors`, run as part of `bun run lint`) bans open-coded
`.collect()`-then-filter-then-paginate and bespoke `paginateArray` pagination in
query files outside `lib/listing.ts` and the `*/listing.ts` descriptors. This is
the locality guarantee made permanent — what stops the ~80 sites from regrowing
and a fifth list contract from appearing.

### Tests

The interface is the test surface — all unit-level against a small seeded
`DatabaseReader`, no deployment per query:

1. **Cursor regression (impossible today):** search returns `numItems`, page 2
   uses the real `continueCursor` and returns the *next* set, not page 1 again —
   the `'search'`-sentinel bug pinned shut.
2. **Index selection:** `search` present ⇒ search index; absent ⇒ browse index +
   `.order()`.
3. **Soft-delete:** deleted rows never appear and never thin a page below
   `numItems`.
4. **Facets:** each strategy returns the right count; `cachedCounter` reads the
   singleton; `groupBy` sums to `total`.
5. **Descriptors** stay near-trivial: type-level + one smoke test each.

## Consequences

**One read contract.** Every list endpoint returns the same
`{ page, isDone, continueCursor }` with a real Convex cursor plus its facets;
one pagination UI works against all of them. Today four shapes, one of them a
non-functional cursor.

**The cursor bug dies with the cutover.** Contact search becomes genuinely
multi-page the moment it routes through the engine.

**The index-vs-collect decision is made once.** The policy that `emailTemplates`
gets wrong (scan the whole table per list) lives in one tested place; a new
listable entity is a ~6-line declaration, not 60 lines of re-derived query.

**The count zoo and the N+1 collapse.** `countByStatus`/`countByType`/`count`
become `facets`; the topic enrichment is declared once and shared by `list` and
`get`.

**Migration** (atomic, pre-prod; no two-phase, per the repo's clean-break
posture):
1. Add the schema: `search_campaigns`, `search_templates` (with `filterFields`
   `status` / `type`+`status`), and fold `deletedAt` into the soft-deletable
   entities' indexes.
2. Land `lib/listing.ts` (engine + `ListingDescriptor`/`Facet` types) reusing
   `PaginationResult<T>`.
3. Port **contacts first** as the tracer — its `search_contacts` index already
   exists (least schema work) and it exercises real search pagination,
   soft-delete, and the `cachedCounter` facet at once.
4. Port the remaining entities (Campaign, Email template, Topic, Segment,
   Automation) entity-by-entity; each shell becomes a one-liner over its
   descriptor.
5. Delete `paginateArray`, the open-coded list/count queries, and the bespoke
   enrichment. The `emailTemplates` HTTP list **changes shape from a bare array
   to `{ page, … }`** — a deliberate, atomic break in the spirit of ADR-0036's
   SDK break.
6. Add the `lint:listing` guard.
7. `CONTEXT.md` `## Resource listing` section (the **Listing engine**, **Listing
   descriptor**, and **Facet** terms + a Relationships bullet) landed inline with
   this ADR.

**Risk:** medium. The port is mechanical but broad (~80 endpoints); the schema
additions are additive and safe; the one hard cutover is external consumers of
the `emailTemplates` HTTP list, which is intentional and atomic. Behaviour at
each call site is preserved or improved — a bare array becomes a paginated page,
a broken search cursor becomes a working one.
