/**
 * The counted draft offers (`mailDraftOfferUsage`, SPEC §7): one row per
 * offered AI reply (an arrival slot or a clarification draft, keyed
 * `<threadId>:<owed messageId>`) whose outcome already counted toward its
 * sender's unused-draft streak (mail/draftPause.ts). No expiry: a row goes
 * with its thread (`deleteThreadOfferUsage`), its owed message
 * (`arrival/purgeRanges.ts`) or its mailbox (`arrival/mailboxRows.ts`).
 *
 * A leaf module (database calls only), so thread deletion can import it.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Rows one thread deletion removes per pass; a thread holds one per owed message at most. */
const THREAD_USAGE_PAGE = 100;

/**
 * Record `offerKey` as counted, in the caller's mutation. False (nothing
 * written) when it already was, or when the key names no thread of this
 * mailbox.
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
	const threadId = ctx.db.normalizeId('mailThreads', offerKey.slice(0, offerKey.indexOf(':')));
	const thread = threadId ? await ctx.db.get(threadId) : null;
	if (!thread || thread.mailboxId !== mailboxId) return false;
	await ctx.db.insert('mailDraftOfferUsage', {
		mailboxId,
		threadId: thread._id,
		offerKey,
		countedAt: now,
	});
	return true;
}

/** A thread is deleted: its counted offers go with it. */
export async function deleteThreadOfferUsage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	for (;;) {
		const rows = await ctx.db
			.query('mailDraftOfferUsage')
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.take(THREAD_USAGE_PAGE);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length < THREAD_USAGE_PAGE) return;
	}
}
