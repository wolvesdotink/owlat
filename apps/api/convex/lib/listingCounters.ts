/**
 * Per-status (per-type) counts behind the listing facets (plan 3.1), on the
 * `lib/counters.ts` engine. A `groupBy` facet that names one of these kinds in
 * `counter` reads its buckets instead of walking every row of every bucket
 * through the index (`lib/listing.ts` countFacet), and falls back to that walk
 * until the scope is backfilled.
 *
 * The bucket is the facet field's value, exactly what the index count matched,
 * so a counter and a walk can never disagree about what a row counts as. The
 * backfill walks the table in creation order, so a row's position is its
 * `_creationTime`.
 *
 * Every insert, delete and write of the field on these tables calls
 * {@link recordListingCounter} in the same mutation.
 */

import type { MutationCtx } from '../_generated/server';
import { applyCounterChange, counterScopeKey, creationPosition } from './counters';

/** The facet field each listing counter tallies. */
export const LISTING_COUNTER_FIELDS = {
	campaignStatus: 'status',
	templateType: 'type',
	automationStatus: 'status',
} as const;

export type ListingCounterKind = keyof typeof LISTING_COUNTER_FIELDS;

/** A row of a counted table — any shape carrying the facet field. */
type CountedRow = { _creationTime?: number } & Partial<Record<'status' | 'type', unknown>>;

export function listingCounterBuckets(
	kind: ListingCounterKind,
	row: CountedRow
): readonly string[] {
	const value = row[LISTING_COUNTER_FIELDS[kind]];
	return typeof value === 'string' ? [value] : [];
}

/**
 * Move one row's facet bucket: `before` is the row before the write (null for
 * an insert), `after` the row as written (null for a delete).
 */
export async function recordListingCounter(
	ctx: MutationCtx,
	kind: ListingCounterKind,
	before: CountedRow | null,
	after: CountedRow | null
): Promise<void> {
	const row = before ?? after;
	if (!row) return;
	await applyCounterChange(
		ctx,
		counterScopeKey(kind),
		creationPosition(row),
		before ? listingCounterBuckets(kind, before) : [],
		after ? listingCounterBuckets(kind, after) : []
	);
}
