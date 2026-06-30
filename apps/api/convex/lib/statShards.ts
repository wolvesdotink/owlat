/**
 * Sharded-counter core (module).
 *
 * The contention fix shared by every per-entity stat counter: instead of
 * read-modify-writing one hot row on each event, bump a RANDOM shard so
 * concurrent writes spread across SHARD_COUNT rows, then sum the shards on the
 * read side. campaigns/statShards.ts and automations/statShards.ts (and, in
 * spirit, the sendingReputation shards of ADR-0042) all want this exact idiom;
 * only the table, index, id field and counter set differ.
 *
 * This module owns the idiom — random-shard selection, the patch-or-insert on
 * first event, and the bounded sum. Each entity supplies its typed table
 * plumbing through `ShardWriter` closures, so Convex's table/index types stay
 * checked at the call site rather than erased behind a string. The per-event
 * rollup into the cached row stays in the entity module, because what it
 * derives (campaigns mirror the sum; automations derive statsActive) genuinely
 * differs.
 */

export const STAT_SHARD_COUNT = 8;

/**
 * The typed table plumbing for one entity's shards. `Field` is the counter-name
 * union; `Shard` is the shard `Doc` (which carries those counters as optional
 * numbers, hence the `extends`).
 */
export interface ShardWriter<Field extends string, Shard extends Partial<Record<Field, number>>> {
	readonly fields: readonly Field[];
	/** The shard row for this shardKey, or null on its first event. */
	findShard(shardKey: number): Promise<Shard | null>;
	/** Add the field deltas onto an existing shard row. */
	patchShard(shard: Shard, patch: Partial<Record<Field, number>>): Promise<void>;
	/** Create the shard row with its initial deltas. (Returns the new id; the
	 * idiom ignores it.) */
	insertShard(shardKey: number, deltas: Partial<Record<Field, number>>): Promise<unknown>;
}

/**
 * Increment counter(s) on a random shard, creating the shard row on its first
 * event. (Mutations may use randomness; only the workflow runtime forbids it.)
 */
export async function bumpStatShard<Field extends string, Shard extends Partial<Record<Field, number>>>(
	writer: ShardWriter<Field, Shard>,
	deltas: Partial<Record<Field, number>>,
): Promise<void> {
	const shardKey = Math.floor(Math.random() * STAT_SHARD_COUNT);
	const existing = await writer.findShard(shardKey);

	if (existing) {
		const patch: Partial<Record<Field, number>> = {};
		for (const f of writer.fields) {
			const d = deltas[f];
			if (d) patch[f] = (existing[f] ?? 0) + d;
		}
		await writer.patchShard(existing, patch);
		return;
	}

	await writer.insertShard(shardKey, deltas);
}

/** Sum a collected set of shard rows over the field list. Bounded by the caller
 * collecting ≤ STAT_SHARD_COUNT rows. */
export function sumStatShards<Field extends string>(
	fields: readonly Field[],
	shards: ReadonlyArray<Partial<Record<Field, number>>>,
): Record<Field, number> {
	const sum = Object.fromEntries(fields.map((f) => [f, 0])) as Record<Field, number>;
	for (const s of shards) {
		for (const f of fields) sum[f] += s[f] ?? 0;
	}
	return sum;
}
