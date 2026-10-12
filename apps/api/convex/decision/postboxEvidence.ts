/**
 * Which Postbox message a bundle judges, and its header and sender evidence:
 * the thread's latest inbound message, with the signals the category
 * heuristic reads. The body is not read here; the action scopes and segments
 * it through interpretation's helpers (`./bundleActions.ts`). Query only.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import type { DecisionEvidence } from '../lib/decision/evidence';
import { loadSenderContact, senderEvidenceOf } from '../mail/senderEvidence';

/** Newest messages read to find the latest inbound one. */
const LATEST_WINDOW = 25;

export interface PostboxSubject {
	readonly mailMessageId: Id<'mailMessages'>;
	readonly mailboxId: Id<'mailboxes'>;
	/** Everything but the body, which the action adds. */
	readonly evidence: Omit<DecisionEvidence, 'segments' | 'isScopeComplete'>;
}

/**
 * The latest inbound message of `threadId`, or null: the thread or its mailbox
 * is gone or inactive, a newer message arrived since the classifier ran (its
 * own ingest schedules its own judgment), or no inbound message is in reach.
 */
export const postboxSubject = internalQuery({
	args: {
		threadId: v.id('mailThreads'),
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args): Promise<PostboxSubject | null> => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		if (
			args.expectedLatestMessageId !== undefined &&
			thread.latestMessageId !== args.expectedLatestMessageId
		) {
			return null;
		}
		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;
		const own = mailbox.address.toLowerCase();
		const newest = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
			.order('desc')
			.take(LATEST_WINDOW);
		const latest = newest.find(
			(m: Doc<'mailMessages'>) => m.outbound === undefined && m.fromAddress.toLowerCase() !== own
		);
		if (!latest) return null;
		const contact = await loadSenderContact(
			ctx,
			thread.mailboxId,
			latest.fromAddress.toLowerCase()
		);
		return {
			mailMessageId: latest._id,
			mailboxId: thread.mailboxId,
			evidence: {
				surface: 'postbox',
				from: latest.fromAddress,
				to: latest.toAddresses,
				cc: latest.ccAddresses,
				ownAddresses: [own],
				subject: latest.subject,
				bulkHeaders: latest.unsubscribe !== undefined,
				senderKnown: senderEvidenceOf(contact).isInAddressBook,
			},
		};
	},
});
