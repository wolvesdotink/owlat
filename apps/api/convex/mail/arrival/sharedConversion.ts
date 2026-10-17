/**
 * Read on arrival is personal-only (SPEC §2.1, §2.9): a personal mailbox that
 * becomes a team inbox keeps none of it.
 *
 *  - {@link clearSharedThreadArrival}: per thread, from the scope change's
 *    thread walk (`mail/interpret/scopeChange.ts startScopeChange`): the
 *    projection, Fix override, digest eligibility and consumed boundary, and
 *    the undo guard. The gist goes with the brief's other brief-mode state.
 *  - {@link drainSharedMailbox}: per mailbox, scheduled by
 *    `scheduleScopeInvalidation` in the transaction that changes the scope:
 *    every arrival row of the mailbox (records, sender profiles, the undo log,
 *    rule drafts, delayed actions, digests), a bounded page per transaction.
 *    Each page re-reads the mailbox first and stops once it is no longer a
 *    team inbox, so a conversion reversed while the drain is queued never
 *    deletes what the personal mailbox records afterwards.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { mailboxScope } from '../mailbox/shared';
import { deleteArrivalMailboxPage } from './mailboxRows';

/** Arrival rows one drain transaction deletes. */
const SHARED_DRAIN_PAGE = 200;

/** A thread of a mailbox that became a team inbox: no personal arrival state on the thread row. */
export async function clearSharedThreadArrival(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	if (
		thread.arrival === undefined &&
		thread.placementOverride === undefined &&
		thread.digestPendingSince === undefined &&
		thread.digestConsumedThrough === undefined &&
		thread.lastArrivalOperationId === undefined &&
		thread.briefTop?.gist === undefined
	) {
		return;
	}
	await ctx.db.patch(threadId, {
		arrival: undefined,
		placementOverride: undefined,
		digestPendingSince: undefined,
		digestConsumedThrough: undefined,
		lastArrivalOperationId: undefined,
		...(thread.briefTop?.gist ? { briefTop: { ...thread.briefTop, gist: undefined } } : {}),
	});
}

/** One page of a team inbox's leftover arrival rows; reschedules until none are left. */
export const drainSharedMailbox = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const mailbox = await ctx.db.get(args.mailboxId);
		// Gone (its own deletion takes the rows) or personal again: stop.
		if (!mailbox || mailboxScope(mailbox) !== 'shared') return null;
		if (!(await deleteArrivalMailboxPage(ctx, args.mailboxId, SHARED_DRAIN_PAGE))) {
			await ctx.scheduler.runAfter(
				0,
				internal.mail.arrival.sharedConversion.drainSharedMailbox,
				args
			);
		}
		return null;
	},
});
