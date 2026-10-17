/**
 * Member erasure for the read-on-arrival tables (schema/mailArrival.ts,
 * relations in `arrivalRelations.ts`): every row of a personal mailbox, read
 * by mailbox. Spread into the `mailboxRecords` phase (`mailboxPhases.ts`),
 * children first. Most per-message rows are already gone by then: the
 * `mailboxMessages` phase deletes each message through
 * `deleteMessageRowAndBlobs`, which takes its arrival rows along.
 */

import type { Id, TableNames } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

type RangeReader = (limit: number) => Promise<Array<{ _id: Id<TableNames> }>>;

/** One bounded reader per arrival table, scoped to `mailboxId`. */
export function arrivalMailboxRanges(ctx: MutationCtx, mailboxId: Id<'mailboxes'>): RangeReader[] {
	return [
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
