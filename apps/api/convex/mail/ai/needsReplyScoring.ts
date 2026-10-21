/**
 * Reply Queue priority scoring + first-time-sender screener, split out of
 * mail/needsReply.ts to keep that file under the domain-file size gate
 * (CONVENTIONS.md → "Split only above ~500 LOC").
 *
 * The deterministic sender-importance signal (VIP flag, frecency, screener-
 * accepted) is read from the personal address book and blended with the LLM
 * urgency by `computePriorityScore`. The HEY-style screener, when the owner
 * enabled it, holds an unknown first-time sender OUT of the queue entirely.
 * Fail-soft: callers only invoke this once the message + mailbox rows are
 * known; a first-time sender with no address-book row scores as a stranger.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import {
	computePriorityScore,
	senderSignalFromContact,
	type PriorityUrgency,
} from './priorityScore';
import { isHeldOutByScreener, loadSenderContact, senderEvidenceOf } from '../senderEvidence';
import { isHeldOutAsColdPitch } from '../arrival/coldPitch';

/**
 * The personal address-book row of the sender, the one lookup both the
 * priority score (VIP flag, frecency, accepted) and the screener read. A
 * first-time sender has no row and scores as a stranger.
 */
function loadSenderRow(ctx: QueryCtx, mailboxId: Id<'mailboxes'>, email: string) {
	return loadSenderContact(ctx, mailboxId, normalizeEmail(email));
}

/**
 * Whether the HEY-style first-time-sender screener applies to `mailbox`: the
 * single source of that answer for the Reply Queue gate and the reader's
 * `senderState` (mail/contacts.ts).
 *
 * - A SHARED team inbox has no single user whose preference may speak for the
 *   team (`mailbox.userId` is only the connecting admin), so the screener is
 *   off and nobody is held out.
 * - A personal mailbox follows its owner's `isSenderScreenerOn` preference.
 */
export async function resolveScreenerEnabled(
	ctx: QueryCtx,
	mailbox: Doc<'mailboxes'>
): Promise<boolean> {
	if (mailbox.scope === 'shared') return false;
	const settings = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', mailbox.userId))
		.first();
	return settings?.isSenderScreenerOn === true;
}

/**
 * Compute the unified priority score for a needs-reply result and apply the
 * first-time-sender screener. Returns the result with `priorityScore` set, or
 * `null` when the screener held an unknown sender out of the queue, or the
 * message carries a cold-pitch verdict (#1381, `mail/arrival/coldPitch.ts`).
 * Generic in the result shape so `needsReply.applyResult` keeps its exact
 * validator type.
 */
export async function scoreAndScreenResult<
	T extends { messageId: Id<'mailMessages'>; urgency: PriorityUrgency },
>(
	ctx: MutationCtx,
	opts: {
		/** The thread's mailbox: its scope and owner decide the screener. */
		mailbox: Doc<'mailboxes'>;
		message: Doc<'mailMessages'>;
		resolved: T;
	}
): Promise<T | null> {
	const now = Date.now();
	// A cold pitch is held out like a screened sender, whatever the classifier says.
	if (await isHeldOutAsColdPitch(ctx, opts.message)) return null;
	const contact = await loadSenderRow(ctx, opts.mailbox._id, opts.message.fromAddress);
	const screenerEnabled = await resolveScreenerEnabled(ctx, opts.mailbox);
	if (isHeldOutByScreener({ screenerEnabled, sender: senderEvidenceOf(contact) })) {
		// Screener held this first-time sender out of the queue entirely.
		return null;
	}
	const sender = senderSignalFromContact(contact, now);
	return {
		...opts.resolved,
		priorityScore: computePriorityScore({ urgency: opts.resolved.urgency, sender }),
	};
}

/**
 * L3: would the screener hold this message's sender out of the Reply Queue?
 * The classifier asks before the Postbox clarification passes, so a thread
 * `applyResult` is going to drop anyway never pays for them. The same rule
 * as {@link scoreAndScreenResult}; false when the thread, its mailbox or the
 * message is gone (the clarification then runs as before).
 */
export const isHeldOutBeforeClarification = internalQuery({
	args: { threadId: v.id('mailThreads'), messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<boolean> => {
		const thread = await ctx.db.get(args.threadId);
		const message = await ctx.db.get(args.messageId);
		const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
		if (!thread || !message || !mailbox) return false;
		const screenerEnabled = await resolveScreenerEnabled(ctx, mailbox);
		if (!screenerEnabled) return false;
		const contact = await loadSenderRow(ctx, mailbox._id, message.fromAddress);
		return isHeldOutByScreener({ screenerEnabled, sender: senderEvidenceOf(contact) });
	},
});
