import type { Doc, Id, TableNames } from '../_generated/dataModel';

/**
 * Batch-loads documents by their IDs, deduplicating requests.
 * Returns a Map of ID → document (or null if not found).
 *
 * The table name `K` is inferred from the ids the caller passes, so the result
 * is a `Map<string, Doc<K> | null>` without an explicit type argument — typing
 * it off `ctx.db.get`'s own signature instead would widen every document to
 * the union of every table.
 */
export async function batchGet<K extends TableNames>(
	ctx: { db: { get: <T extends TableNames>(id: Id<T>) => Promise<Doc<T> | null> } },
	ids: ReadonlyArray<Id<K>>
): Promise<Map<string, Doc<K> | null>> {
	const seen = new Map<string, Id<K>>();
	for (const id of ids) seen.set(id, id);
	const results = await Promise.all(
		[...seen.values()].map(async (id) => {
			const doc = await ctx.db.get(id);
			return [id, doc] as const;
		})
	);
	return new Map(results);
}
