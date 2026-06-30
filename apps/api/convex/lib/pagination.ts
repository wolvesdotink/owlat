import type { IndexRange, IndexRangeBuilder, GenericDocument } from 'convex/server';
import type { DatabaseReader } from '../_generated/server';
import type { TableNames } from '../_generated/dataModel';
import { BULK_QUERY_LIMIT } from './constants';

/**
 * Count rows matching a query using pagination to avoid loading all into memory.
 * Replaces the repeated pattern: let count=0; while(!isDone) { paginate... count += page.length }
 */
export async function countWithPagination(
	db: DatabaseReader,
	table: TableNames,
	indexName: string = 'by_creation_time',
	indexPredicate: (q: IndexRangeBuilder<GenericDocument, string[]>) => IndexRange = (q) => q as unknown as IndexRange
): Promise<number> {
	let count = 0;
	let cursor: string | null = null;
	let isDone = false;

	while (!isDone) {
		// Cast required: Convex's withIndex() expects IndexName to be a string
		// literal type from the specific table's index union (IndexNames<TableInfo>).
		// Since this utility is table-agnostic, TypeScript cannot verify the index
		// name belongs to the given table at compile time. Callers provide the
		// correct table + index pairing; this is safe at runtime.
		const result = await db
			.query(table)
			.withIndex(indexName as never, indexPredicate as never)
			.paginate({ cursor, numItems: BULK_QUERY_LIMIT });

		count += result.page.length;
		isDone = result.isDone;
		cursor = result.continueCursor;
	}

	return count;
}

export interface PaginationResult<T> {
	page: T[];
	isDone: boolean;
	continueCursor: string;
}

// `paginateArray` was removed with ADR-0037: its stringified-integer offset was
// not a real Convex cursor. All list pagination now flows through the Listing
// engine (`lib/listing.ts`), which paginates at the database with a real,
// opaque Convex cursor on both the search and browse paths.
