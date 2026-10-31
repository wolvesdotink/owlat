/**
 * Read on arrival: every arrival row of one mailbox, by table, children first
 * (for erasure). One reader per table for the walks that remove a
 * mailbox's arrival state wholesale:
 *
 *  - member erasure (`auth/erasure/mailboxPhases.ts`, the `mailboxRecords`
 *    phase, within its own budget);
 *  - an external mailbox's teardown (`mail/external/accountTeardown.ts`);
 *  - a personal mailbox that becomes a team inbox (`sharedConversion.ts`).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Id, TableNames } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

export type ArrivalRangeReader = (limit: number) => Promise<Array<{ _id: Id<TableNames> }>>;

/** One bounded reader per arrival table, scoped to `mailboxId`. */
export function arrivalMailboxRanges(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): ArrivalRangeReader[] {
	return [
		(n) =>
			ctx.db
				.query('mailDraftOfferUsage')
				.withIndex('by_mailbox_offer', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailArrivalOperationChanges')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailDelayedActions')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailDigests')
				.withIndex('by_mailbox_period', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailRuleDrafts')
				.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailSenderProfiles')
				.withIndex('by_mailbox_sender', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(n) =>
			ctx.db
				.query('mailArrivalOperations')
				.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
	];
}

/**
 * Delete at most `limit` arrival rows of `mailboxId`, tables in order. Returns
 * true when every table is empty for the mailbox, false when the caller has to
 * come back (in a new transaction).
 */
export async function deleteArrivalMailboxPage(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	limit: number
): Promise<boolean> {
	let left = limit;
	for (const read of arrivalMailboxRanges(ctx, mailboxId)) {
		if (left <= 0) return false;
		const asked = left;
		const rows = await read(asked);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length === asked) return false;
		left -= rows.length;
	}
	return true;
}
