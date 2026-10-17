/**
 * The counted draft offers (`mailDraftOfferUsage`, SPEC §7): one row per
 * offered AI reply (an arrival slot or a clarification draft, keyed
 * `<threadId>:<owed messageId>`) whose outcome already counted toward its
 * sender's unused-draft streak (mail/draftPause.ts). No expiry: a row goes
 * with its thread and with its owed message (both ranges of the resumable
 * purge jobs, `arrival/purgeRanges.ts`) or with its mailbox
 * (`arrival/mailboxRows.ts`). A row is only ever written for an owed message
 * that still exists in the thread, so a purge's deletion is never undone.
 *
 * A leaf module (database calls only).
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Record `offerKey` as counted, in the caller's mutation. False (nothing
 * written) when it already was, or when the key names no thread of this
 * mailbox or no owed message of that thread (purged since).
 */
export async function claimDraftOffer(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	offerKey: string,
	now: number
): Promise<boolean> {
	const counted = await ctx.db
		.query('mailDraftOfferUsage')
		.withIndex('by_mailbox_offer', (q) => q.eq('mailboxId', mailboxId).eq('offerKey', offerKey))
		.first();
	if (counted) return false;
	const [threadPart, messagePart, ...rest] = offerKey.split(':');
	if (!threadPart || !messagePart || rest.length > 0) return false;
	const threadId = ctx.db.normalizeId('mailThreads', threadPart);
	const thread = threadId ? await ctx.db.get(threadId) : null;
	if (!thread || thread.mailboxId !== mailboxId) return false;
	// The owed message must still be there: a purged message's row stays gone.
	const messageId = ctx.db.normalizeId('mailMessages', messagePart);
	const message = messageId ? await ctx.db.get(messageId) : null;
	if (!message || message.mailboxId !== mailboxId || message.threadId !== thread._id) return false;
	await ctx.db.insert('mailDraftOfferUsage', {
		mailboxId,
		threadId: thread._id,
		offerKey,
		countedAt: now,
	});
	return true;
}
