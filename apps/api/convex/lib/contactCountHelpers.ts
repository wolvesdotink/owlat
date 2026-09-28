import type { DatabaseReader, MutationCtx, QueryCtx } from '../_generated/server';
import type { Value } from 'convex/values';
import { countWithPagination } from './pagination';
import { getInstanceSettings, upsertInstanceSettings } from './instanceSettings';

/**
 * Increment the contact count for the instance.
 * Creates the instanceSettings document if it doesn't exist.
 */
export async function incrementContactCount(ctx: MutationCtx, delta: number = 1): Promise<void> {
	const settings = await getInstanceSettings(ctx.db);
	await upsertInstanceSettings(ctx, { contactCount: (settings?.contactCount ?? 0) + delta });
}

/**
 * Decrement the contact count for the instance.
 * Ensures count never goes below 0.
 */
export async function decrementContactCount(ctx: MutationCtx, delta: number = 1): Promise<void> {
	const settings = await getInstanceSettings(ctx.db);

	if (settings) {
		const newCount = Math.max(0, (settings.contactCount ?? 0) - delta);
		await ctx.db.patch(settings._id, {
			contactCount: newCount,
			updatedAt: Date.now(),
		});
	}
	// If no settings document exists, there's nothing to decrement
}

/**
 * Get the cached contact count for the instance, or `null` when no count is
 * cached yet. Works in both queries and mutations.
 *
 * Most callers want `getContactCount`, which falls back to counting live rows.
 * Use this one only when an absent cache has to be told apart from a real count.
 */
export async function getCachedContactCount(ctx: QueryCtx | MutationCtx): Promise<number | null> {
	const settings = await getInstanceSettings(ctx.db);

	return settings?.contactCount ?? null;
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
	return await countWithPagination(
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

	const settings = await getInstanceSettings(ctx.db);

	const previous = settings?.contactCount ?? null;
	const corrected = previous !== actual;

	// No row reads as `previous === null`, so it always counts as corrected.
	if (corrected) {
		await upsertInstanceSettings(ctx, { contactCount: actual });
	}

	return { previous, actual, corrected };
}
