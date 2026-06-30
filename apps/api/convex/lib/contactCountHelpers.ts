import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Value } from 'convex/values';
import { countWithPagination } from './pagination';

/**
 * Increment the contact count for the instance.
 * Creates the instanceSettings document if it doesn't exist.
 */
export async function incrementContactCount(
	ctx: MutationCtx,
	delta: number = 1
): Promise<void> {
	const settings = await ctx.db
		.query('instanceSettings')
		.first();

	if (settings) {
		await ctx.db.patch(settings._id, {
			contactCount: (settings.contactCount ?? 0) + delta,
			updatedAt: Date.now(),
		});
	} else {
		// Create settings document if it doesn't exist
		await ctx.db.insert('instanceSettings', {
			contactCount: delta,
			createdAt: Date.now(),
		});
	}
}

/**
 * Decrement the contact count for the instance.
 * Ensures count never goes below 0.
 */
export async function decrementContactCount(
	ctx: MutationCtx,
	delta: number = 1
): Promise<void> {
	const settings = await ctx.db
		.query('instanceSettings')
		.first();

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
 * Get the cached contact count for the instance.
 * Returns null if no cached count is available (fallback to pagination count needed).
 * Works in both queries and mutations.
 */
export async function getCachedContactCount(
	ctx: QueryCtx | MutationCtx
): Promise<number | null> {
	const settings = await ctx.db
		.query('instanceSettings')
		.first();

	return settings?.contactCount ?? null;
}

/**
 * Reconcile the cached contact count by doing a real count.
 * Corrects drift caused by partial failures or missed updates.
 *
 * Called by a daily cron (`reconcileAllContactCounts` / `reconcileContactCountInternal`).
 * Counts via a paginated stream (summing page lengths) instead of one full-table
 * collect, so the reconcile stays under the Convex per-query document-read limit
 * on large deployments. Counts only LIVE rows (`deletedAt === undefined`) to
 * match the live increment/decrement semantics — softDeleteContact decrements
 * the cached count, so a reconcile that counted soft-deleted rows would inflate
 * it. The cached count is only a hint.
 */
export async function reconcileContactCount(
	ctx: MutationCtx
): Promise<{ previous: number | null; actual: number; corrected: boolean }> {
	const actual = await countWithPagination(
		ctx.db,
		'contacts',
		'by_deleted_at_and_created_at',
		// `deletedAt === undefined` selects live rows. The generic index-range
		// builder types values as `Value` (no `undefined`), so assert through it
		// — Convex resolves an absent optional field to `undefined` at runtime.
		(q) => q.eq('deletedAt', undefined as unknown as Value),
	);

	const settings = await ctx.db
		.query('instanceSettings')
		.first();

	const previous = settings?.contactCount ?? null;
	const corrected = previous !== actual;

	if (settings) {
		if (corrected) {
			await ctx.db.patch(settings._id, {
				contactCount: actual,
				updatedAt: Date.now(),
			});
		}
	} else {
		await ctx.db.insert('instanceSettings', {
			contactCount: actual,
			createdAt: Date.now(),
		});
	}

	return { previous, actual, corrected };
}
