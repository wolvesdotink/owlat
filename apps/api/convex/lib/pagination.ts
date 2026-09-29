import type { IndexRange, IndexRangeBuilder, GenericDocument } from 'convex/server';
import type { DatabaseReader } from '../_generated/server';
import type { TableNames } from '../_generated/dataModel';

/**
 * Count the rows of one index range by streaming them.
 *
 * This is a counter, not a paginator: it never calls `.paginate()`. Convex
 * permits only ONE `.paginate()` call per function execution (a second throws
 * at runtime in a deployed backend), and a count frequently runs alongside a
 * real paginated list in the same execution (e.g. the Listing engine's page +
 * total). Async-iterating the query reads rows incrementally under the normal
 * per-execution read limit.
 *
 * It reads every matching row, so callers that must count very large sets
 * should keep a denormalized counter and only fall back here when one is
 * absent.
 */
export async function countIndexRange(
	db: DatabaseReader,
	table: TableNames,
	indexName: string = 'by_creation_time',
	indexPredicate: (q: IndexRangeBuilder<GenericDocument, string[]>) => IndexRange = (q) =>
		q as unknown as IndexRange
): Promise<number> {
	let count = 0;
	// Cast required: Convex's withIndex() expects IndexName to be a string literal
	// from the specific table's index union (IndexNames<TableInfo>). This utility
	// is table-agnostic, so TS cannot verify the index belongs to the table at
	// compile time; callers provide the correct table + index pairing.
	for await (const row of db.query(table).withIndex(indexName as never, indexPredicate as never)) {
		void row;
		count += 1;
	}

	return count;
}

// `paginateArray` was removed with ADR-0037: its stringified-integer offset was
// not a real Convex cursor. All list pagination now flows through the Listing
// engine (`lib/listing.ts`), which paginates at the database with a real,
// opaque Convex cursor on both the search and browse paths.
