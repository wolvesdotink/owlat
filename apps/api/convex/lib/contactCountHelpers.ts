import type { DatabaseReader, MutationCtx, QueryCtx } from '../_generated/server';
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
 * The cached contact count for the instance, or `null` when no count is cached
 * yet (a new or restored instance). Works in both queries and mutations.
 *
 * There is deliberately no counting fallback: a missing cache reads as `null`
 * ("pending") and `contacts/countReconcile.ts` recovers it in bounded
 * transactions, so no reader ever scans the contacts table (#917).
 */
export async function getCachedContactCount(ctx: QueryCtx | MutationCtx): Promise<number | null> {
	return await readCachedContactCount(ctx.db);
}

/** `getCachedContactCount` for callers holding only a database reader. */
export async function readCachedContactCount(db: DatabaseReader): Promise<number | null> {
	return (await readInstanceCounter(db, 'contacts')).contactCount ?? null;
}
