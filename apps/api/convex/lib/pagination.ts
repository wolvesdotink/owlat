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
 * total).
 *
 * Streaming keeps memory flat but does NOT reset the transaction's budget:
 * every matching row is a document read against the per-transaction limits
 * (documents scanned and bytes read), so a large range fails the whole query
 * or mutation. Use it only for ranges that are bounded by construction; a set
 * that can grow with the contact book needs a maintained counter, and a
 * recount of one has to be split across transactions (see
 * `contacts/countReconcile.ts`).
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
