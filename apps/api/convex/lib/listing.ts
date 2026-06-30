import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { DatabaseReader } from '../_generated/server';
import type { Doc, TableNames } from '../_generated/dataModel';
import { countWithPagination } from './pagination';

/**
 * Resource listing — one engine, per-entity descriptors (ADR-0037).
 *
 * This is the single read-side seam for "give me a filtered, searched,
 * paginated, counted page of <entity>". The **Listing engine** here is a thin
 * generic dispatcher; each entity owns a **Listing descriptor** (its
 * "entity/listing.ts") declaring its index + cursor + facet policy as data. It
 * is the read-side counterpart to the write-side lifecycle modules, and mirrors
 * the Walker / Block-module split: thin dispatcher over per-type data.
 *
 * The engine is auth-agnostic: it takes a `DatabaseReader`, never a session.
 * The session-auth shell (`contacts.ts:list`) and the API-key shell
 * (the per-entity "organization.ts") keep their own auth posture and call into
 * here — the same effects-vs-shell split the lifecycle modules use.
 *
 * Convex's `withIndex` / `withSearchIndex` want string-literal index names tied
 * to one table, which a function generic over `TableNames` cannot satisfy at
 * compile time. The public surface is typed via the descriptor's `T` (so call
 * sites are pinned to one table), and the query builders are cast internally —
 * the same trade `lib/pagination.ts:countWithPagination` already makes.
 */

/** Equality filter values legal on a search `filterField` or an index `eq`. */
export type FilterValue = string | number | boolean | undefined | null;

interface ListingSearch {
	/** Name of the table's `searchIndex`. */
	index: string;
	/** The `searchField` declared on that index. */
	field: string;
	/**
	 * `filterFields` declared on the search index. `softDelete`'s `deletedAt`
	 * and every entry in the descriptor's `filters` MUST appear here, or the
	 * search-path `eq` is rejected by Convex at runtime.
	 */
	filterFields?: readonly string[];
}

interface ListingBrowse {
	/**
	 * Default browse index (no equality filter active). For a soft-deletable
	 * entity this index MUST lead with `deletedAt` so the engine can fix
	 * `deletedAt === undefined` inside the index range — soft-delete rides the
	 * index, it is never a page-thinning post-filter. The literal
	 * `'by_creation_time'` selects Convex's built-in creation-order index.
	 */
	index: string;
	order: 'asc' | 'desc';
	/**
	 * For a single equality filter the engine can serve index-natively, the
	 * compound index whose PREFIX is that filter field and whose next field is
	 * the browse sort key (e.g. `status` → `by_status_and_updated_at`). A filter
	 * with no entry here falls back to a post-index `.filter()` (the page can
	 * thin, which is fine for an ordinary filter — only `deletedAt` is barred
	 * from that fate).
	 */
	filterIndexes?: Readonly<Record<string, string>>;
	/** Optional `sort` arg → index map (browse path only; see `sortKeys`). */
	sortIndexes?: Readonly<Record<string, string>>;
}

/**
 * A named count declared alongside the page. Exactly three strategies exist in
 * the wild (ADR-0037 decision 5); richer facets are rejected at the interface —
 * write a plain query outside the seam instead.
 */
export type Facet<T extends TableNames> =
	| { kind: 'indexCount'; index?: string }
	| {
			kind: 'groupBy';
			field: keyof Doc<T> & string;
			buckets: readonly string[];
			/** Index keyed on `field`, used to count each bucket without a scan. */
			index: string;
	  }
	| { kind: 'cachedCounter'; table: TableNames; field: string };

export interface ListingDescriptor<
	T extends TableNames,
	E extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Runtime table name. The `T` generic pins every other field to it. */
	table: T;
	/**
	 * Search path (optional): relevance-ordered, multi-page via
	 * `.withSearchIndex().paginate()` — a real, opaque Convex cursor.
	 */
	search?: ListingSearch;
	/** Browse path (required): sortable via a regular index + `.order()`. */
	browse: ListingBrowse;
	/**
	 * Legal `sort` arg values — BROWSE PATH ONLY. Search results are
	 * relevance-ordered, so passing `search` means relevance order, full stop.
	 */
	sortKeys?: readonly string[];
	/** Equality filters; each must be a `filterField` on `search`. */
	filters?: readonly string[];
	/** When true, `deletedAt === undefined` rides the index on both paths. */
	softDelete?: boolean;
	/**
	 * Per-row enrichment run over the page (and reused by the entity's `get`).
	 * The descriptor author owns the cost: an O(1) cached read vs. a per-row
	 * scan — stated here, never hidden by the engine. `E` is the enrichment's
	 * shape, so callers see typed enriched fields (e.g. `contactCount: number`)
	 * rather than `unknown`.
	 */
	enrich?: (db: DatabaseReader, row: Doc<T>) => Promise<E>;
	facets?: Record<string, Facet<T>>;
}

export interface ListResourcesArgs {
	search?: string;
	filters?: Record<string, FilterValue>;
	sort?: string;
	/**
	 * Browse-path order override. When omitted the descriptor's
	 * `browse.order` stands; when given it flips the direction of whichever
	 * index the browse path selected (default or `sort`-swapped). Ignored on
	 * the search path — search results are always relevance-ordered.
	 */
	order?: 'asc' | 'desc';
	paginationOpts: PaginationOptions;
}

/** A page row: the document plus whatever `enrich` merged onto it. */
export type EnrichedDoc<
	T extends TableNames,
	E extends Record<string, unknown> = Record<string, unknown>,
> = Doc<T> & E;

// The descriptor pins the table; internally everything is cast to `any` because
// Convex's per-table index-name literals can't flow through a `TableNames`
// generic. Confined to this module — see the file header.
type AnyQuery = {
	withIndex: (name: string, range?: (q: AnyBuilder) => unknown) => AnyQuery;
	withSearchIndex: (name: string, filter: (q: AnyBuilder) => unknown) => AnyQuery;
	order: (dir: 'asc' | 'desc') => AnyQuery;
	filter: (predicate: (q: AnyBuilder) => unknown) => AnyQuery;
	paginate: (opts: PaginationOptions) => Promise<PaginationResult<Record<string, unknown>>>;
};
interface AnyBuilder {
	search: (field: string, query: string) => AnyBuilder;
	eq: (field: unknown, value: unknown) => AnyBuilder;
	and: (...exprs: unknown[]) => unknown;
	field: (name: string) => unknown;
}

function activeFilters(
	filterFields: readonly string[] | undefined,
	filters: Record<string, FilterValue> | undefined,
): Array<{ field: string; value: FilterValue }> {
	if (!filters) return [];
	const out: Array<{ field: string; value: FilterValue }> = [];
	for (const field of filterFields ?? []) {
		const value = filters[field];
		if (value !== undefined) out.push({ field, value });
	}
	return out;
}

async function searchPage<T extends TableNames, E extends Record<string, unknown>>(
	db: DatabaseReader,
	descriptor: ListingDescriptor<T, E>,
	search: string,
	args: ListResourcesArgs,
): Promise<PaginationResult<Doc<T>>> {
	const cfg = descriptor.search!;
	const query = db.query(descriptor.table as never) as unknown as AnyQuery;
	const result = await query
		.withSearchIndex(cfg.index, (q) => {
			let builder = q.search(cfg.field, search);
			// Soft-delete and equality filters ride the search index's
			// filterFields — never a post-filter that would thin the page.
			if (descriptor.softDelete) builder = builder.eq('deletedAt', undefined);
			for (const { field, value } of activeFilters(descriptor.filters, args.filters)) {
				builder = builder.eq(field, value);
			}
			return builder;
		})
		.paginate(args.paginationOpts);
	return result as unknown as PaginationResult<Doc<T>>;
}

async function browsePage<T extends TableNames, E extends Record<string, unknown>>(
	db: DatabaseReader,
	descriptor: ListingDescriptor<T, E>,
	args: ListResourcesArgs,
): Promise<PaginationResult<Doc<T>>> {
	// An explicit `order` arg flips the direction of the chosen browse index;
	// otherwise the descriptor's default order stands.
	const order = args.order ?? descriptor.browse.order;
	const active = activeFilters(descriptor.filters, args.filters);

	// A single equality filter with a dedicated compound index → index-native,
	// ordered, no page-thinning.
	if (active.length === 1) {
		const only = active[0]!;
		const idx = descriptor.browse.filterIndexes?.[only.field];
		if (idx) {
			const q = db.query(descriptor.table as never) as unknown as AnyQuery;
			const result = await q
				.withIndex(idx, (b) => b.eq(only.field, only.value))
				.order(order)
				.paginate(args.paginationOpts);
			return result as unknown as PaginationResult<Doc<T>>;
		}
	}

	// Default browse index: soft-delete rides it; remaining equality filters are
	// applied post-index (ordinary filters may thin a page; only `deletedAt` is
	// barred from that). An explicit `sort` may swap in an alternate index.
	let indexName = descriptor.browse.index;
	if (active.length === 0 && args.sort) {
		indexName = descriptor.browse.sortIndexes?.[args.sort] ?? indexName;
	}

	const base = db.query(descriptor.table as never) as unknown as AnyQuery;
	let q: AnyQuery;
	if (indexName === 'by_creation_time') {
		// Built-in creation-order index — no soft-delete entity uses it.
		q = base.order(order);
	} else {
		q = base
			.withIndex(indexName, (b) => (descriptor.softDelete ? b.eq('deletedAt', undefined) : b))
			.order(order);
	}
	if (active.length > 0) {
		q = q.filter((f) => {
			const exprs = active.map((a) => f.eq(f.field(a.field), a.value));
			return exprs.length === 1 ? exprs[0] : f.and(...exprs);
		});
	}
	const result = await q.paginate(args.paginationOpts);
	return result as unknown as PaginationResult<Doc<T>>;
}

async function enrichPage<T extends TableNames, E extends Record<string, unknown>>(
	db: DatabaseReader,
	descriptor: ListingDescriptor<T, E>,
	page: Doc<T>[],
): Promise<EnrichedDoc<T, E>[]> {
	if (!descriptor.enrich) return page as EnrichedDoc<T, E>[];
	const enrich = descriptor.enrich;
	return Promise.all(
		page.map(async (row) => ({ ...row, ...(await enrich(db, row)) }) as EnrichedDoc<T, E>),
	);
}

/**
 * One page of a listable entity behind one Convex-native contract.
 *
 * Routing is part of the interface, not a hidden detail: a non-empty `search`
 * (when the descriptor has a search index) takes the search path — relevance
 * order, `sort` ignored; otherwise the browse path — `descriptor.browse.order`,
 * optionally an alternate `sort` index. The cursor is a real Convex cursor on
 * both paths (the `'search'` sentinel is gone).
 */
export async function listResources<T extends TableNames, E extends Record<string, unknown>>(
	db: DatabaseReader,
	descriptor: ListingDescriptor<T, E>,
	args: ListResourcesArgs,
): Promise<PaginationResult<EnrichedDoc<T, E>>> {
	const search = args.search?.trim();
	const result =
		search && search.length > 0 && descriptor.search
			? await searchPage(db, descriptor, search, args)
			: await browsePage(db, descriptor, args);

	return { ...result, page: await enrichPage(db, descriptor, result.page) };
}

/** A `groupBy` facet's per-bucket counts plus their sum. */
export type GroupedCount = Record<string, number> & { total: number };

/**
 * One declared facet's count. The descriptor owns which of the three strategies
 * applies; the count zoo (`countByStatus` / `countByType` / `count`) collapses
 * into these. `groupBy` returns per-bucket counts whose `total` is their sum.
 */
export async function countFacet<T extends TableNames, E extends Record<string, unknown>>(
	db: DatabaseReader,
	descriptor: ListingDescriptor<T, E>,
	facetName: string,
): Promise<number | GroupedCount> {
	const facet = descriptor.facets?.[facetName];
	if (!facet) {
		throw new Error(`Unknown facet '${facetName}' on listing for table '${descriptor.table}'`);
	}

	if (facet.kind === 'cachedCounter') {
		const row = (await db.query(facet.table as never).first()) as Record<string, unknown> | null;
		const value = row?.[facet.field];
		if (typeof value === 'number') return value;
		// No denormalized counter yet — fall back to a bounded scan, the same
		// hint-with-fallback contract the contacts cached count already uses.
		return countWithPagination(db, descriptor.table);
	}

	if (facet.kind === 'indexCount') {
		return countWithPagination(db, descriptor.table, facet.index ?? 'by_creation_time');
	}

	// groupBy: one bounded index count per bucket, summed — never a whole-table
	// `.collect()` then group in memory.
	const counts: GroupedCount = { total: 0 } as GroupedCount;
	for (const bucket of facet.buckets) {
		const c = await countWithPagination(
			db,
			descriptor.table,
			facet.index,
			(q) => (q as unknown as AnyBuilder).eq(facet.field, bucket) as never,
		);
		counts[bucket] = c;
		counts.total += c;
	}
	return counts;
}
