import type { DatabaseReader, MutationCtx, QueryCtx } from '../_generated/server';
import type { Value } from 'convex/values';
import { countIndexRange } from './pagination';
import { readInstanceCounter, writeInstanceCounter } from './instanceCounters';
import { getInstanceSettings } from './instanceSettings';

/**
 * Increment the contact count for the instance, on its own `instanceCounters`
 * row (plan 2.4) so contact writes never touch the row feature gates read.
 */
export async function incrementContactCount(ctx: MutationCtx, delta: number = 1): Promise<void> {
	const { contactCount } = await readInstanceCounter(ctx.db, 'contacts');
	await writeInstanceCounter(ctx, 'contacts', { contactCount: (contactCount ?? 0) + delta });
}

/**
 * Decrement the contact count for the instance.
 * Ensures count never goes below 0.
 */
export async function decrementContactCount(ctx: MutationCtx, delta: number = 1): Promise<void> {
	const { contactCount } = await readInstanceCounter(ctx.db, 'contacts');
	// Before the instance exists there is nothing to decrement.
	if (contactCount === undefined && !(await getInstanceSettings(ctx.db))) return;
	await writeInstanceCounter(ctx, 'contacts', {
		contactCount: Math.max(0, (contactCount ?? 0) - delta),
	});
}

/**
 * Get the cached contact count for the instance, or `null` when no count is
 * cached yet. Works in both queries and mutations.
 *
 * Most callers want `getContactCount`, which falls back to counting live rows.
 * Use this one only when an absent cache has to be told apart from a real count.
 */
export async function getCachedContactCount(ctx: QueryCtx | MutationCtx): Promise<number | null> {
	return await readCachedContactCount(ctx.db);
}

/** `getCachedContactCount` for callers holding only a database reader. */
export async function readCachedContactCount(db: DatabaseReader): Promise<number | null> {
	return (await readInstanceCounter(db, 'contacts')).contactCount ?? null;
}

/**
 * Count the LIVE contacts (`deletedAt === undefined`), the number the cached
 * `contactCount` stands for.
 *
 * Counts via a paginated stream (summing page lengths) instead of one full-table
 * collect, so it stays under the Convex per-query document-read limit on large
 * deployments. Soft-deleted rows are excluded to match the live
 * increment/decrement semantics: softDeleteContact decrements the cached count.
 */
export async function countLiveContacts(db: DatabaseReader): Promise<number> {
	return await countIndexRange(
		db,
		'contacts',
		'by_deleted_at_and_created_at',
		// `deletedAt === undefined` selects live rows. The generic index-range
		// builder types values as `Value` (no `undefined`), so assert through it
		// — Convex resolves an absent optional field to `undefined` at runtime.
		(q) => q.eq('deletedAt', undefined as unknown as Value)
	);
}

/**
 * The instance's contact count: the cached value, or a live count when no
 * cache exists yet (a new or restored instance before the daily reconcile).
 */
export async function getContactCount(ctx: QueryCtx | MutationCtx): Promise<number> {
	return (await getCachedContactCount(ctx)) ?? (await countLiveContacts(ctx.db));
}

/**
 * Reconcile the cached contact count by doing a real count.
 * Corrects drift caused by partial failures or missed updates.
 *
 * Called by the daily `reconcileAllContactCounts` cron. The count is
 * `countLiveContacts`, so a reconcile never re-inflates the cached count with
 * soft-deleted rows. The cached count is only a hint.
 */
export async function reconcileContactCount(
	ctx: MutationCtx
): Promise<{ previous: number | null; actual: number; corrected: boolean }> {
	const actual = await countLiveContacts(ctx.db);

	const previous = await readCachedContactCount(ctx.db);
	const corrected = previous !== actual;

	// No row reads as `previous === null`, so it always counts as corrected.
	if (corrected) {
		await writeInstanceCounter(ctx, 'contacts', { contactCount: actual });
	}

	return { previous, actual, corrected };
}
