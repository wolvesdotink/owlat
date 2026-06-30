import type { GenericId } from 'convex/values';

/**
 * Batch-loads documents by their IDs, deduplicating requests.
 * Returns a Map of ID → document (or null if not found).
 *
 * Generic over the table name `K` so the branded `GenericId<K>` flows through
 * to `ctx.db.get` — callers pass `Id<'table'>[]` and `K` is inferred from it.
 */
export async function batchGet<T, K extends string = string>(
	ctx: { db: { get: (id: GenericId<K>) => Promise<T | null> } },
	ids: GenericId<K>[]
): Promise<Map<string, T | null>> {
	const seen = new Map<string, GenericId<K>>();
	for (const id of ids) seen.set(String(id), id);
	const results = await Promise.all(
		[...seen.values()].map(async (id) => {
			const doc = await ctx.db.get(id);
			return [String(id), doc] as const;
		})
	);
	return new Map(results);
}
