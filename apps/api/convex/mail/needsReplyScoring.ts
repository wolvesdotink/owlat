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

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { contactFrecencyScore } from './contacts';
import {
	computePriorityScore,
	isScreenedOut,
	type PriorityUrgency,
	type SenderSignal,
} from './priorityScore';

/**
 * Deterministic sender-importance signal for the Reply Queue priority score:
 * the personal address-book row (VIP flag, frecency, accepted) for `email`. A
 * first-time sender with no row scores as a stranger (empty signal).
 */
async function loadSenderSignal(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	email: string,
	now: number
): Promise<SenderSignal> {
	const contact = await ctx.db
		.query('mailContacts')
		.withIndex('by_mailbox_and_email', (q) =>
			q.eq('mailboxId', mailboxId).eq('email', email.trim().toLowerCase())
		)
		.first();
	if (!contact) return {};
	return {
		isVip: contact.isVip === true,
		isKnownContact: true,
		frecency: contactFrecencyScore(contact, now),
		accepted: contact.isScreenerAccepted === true,
	};
}

/** Whether the mailbox owner enabled the HEY-style first-time-sender screener. */
async function isScreenerEnabled(ctx: MutationCtx, userId: string): Promise<boolean> {
	const settings = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	return settings?.isSenderScreenerOn === true;
}

/**
 * Compute the unified priority score for a needs-reply result and apply the
 * first-time-sender screener. Returns the result with `priorityScore` set, or
 * `null` when the screener held an unknown sender out of the queue. Generic in
 * the result shape so `needsReply.applyResult` keeps its exact validator type.
 */
export async function scoreAndScreenResult<
	T extends { messageId: Id<'mailMessages'>; urgency: PriorityUrgency }
>(
	ctx: MutationCtx,
	opts: {
		mailboxId: Id<'mailboxes'>;
		ownerUserId: string;
		message: Doc<'mailMessages'>;
		resolved: T;
	}
): Promise<T | null> {
	const now = Date.now();
	const sender = await loadSenderSignal(ctx, opts.mailboxId, opts.message.fromAddress, now);
	const screenerEnabled = await isScreenerEnabled(ctx, opts.ownerUserId);
	if (isScreenedOut({ screenerEnabled, sender })) {
		// Screener held this first-time sender out of the queue entirely.
		return null;
	}
	return {
		...opts.resolved,
		priorityScore: computePriorityScore({ urgency: opts.resolved.urgency, sender }),
	};
}
