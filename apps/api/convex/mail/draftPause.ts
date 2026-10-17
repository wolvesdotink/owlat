/**
 * Unused-draft pause (SPEC §7): draft-on-arrival stops for a sender whose AI
 * drafts keep going unused, until the owner resumes it on the Senders page.
 *
 * `mailSenderProfiles.unusedDraftStreak` counts AI drafts for that sender that
 * went unused in a row:
 *
 *  - **Discarded.** A saved draft with an AI baseline (`aiDraftBaseline`) is
 *    discarded while the reply it was written for is still owed (the thread's
 *    needs-reply flag names the message it answers). A copy of the reply the
 *    thread still offers (the arrival slot, or the draft written from the
 *    owner's answers) does not count: that reply stays on offer and is counted
 *    once, when the owner answers without it.
 *  - **Answered without it.** The owner replies in the thread (through Owlat
 *    without an AI baseline, or from another client) while the thread offered
 *    an AI reply for the owed message: the slot, the clarification draft, or
 *    a saved draft with a baseline.
 *
 * Sending a draft with an AI baseline resets the streak. At
 * {@link UNUSED_DRAFT_PAUSE_AT} the profile gets `autoDraftPausedAt` and
 * draft-on-arrival skips the sender (`isDraftOnArrivalPaused`); the
 * clarification questions still run. While paused nothing counts up, but an
 * AI-based send still resets the streak as a new operation (the pause's own
 * undo then fails its guard, which is right). Resume
 * (`senders/status.resumeDrafts`) clears both fields.
 *
 * **Never twice.** Each count consumes what it counted in the same mutation:
 * a discard deletes the draft row, and a reply clears the thread's needs-reply
 * flag (the send's thread patch, `clearThreadNeedsReply`). A discard counts
 * only while that flag still names the message the draft answers, so a draft
 * left behind by a reply that already counted never counts again.
 *
 * **Logged.** A pause and a reset are arrival operations (kind `draft_pause`,
 * actor `system`) with one `senderDraftPause` change row, written with the
 * profile's `lastOperationId` in the same mutation, so undo works. A plain
 * increment is not an operation.
 *
 * Personal mailboxes only, checked at write time. This module writes only
 * `unusedDraftStreak`, `autoDraftPausedAt` and `lastOperationId` on a profile.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { SenderDraftPauseValue } from '@owlat/shared/arrival';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { arrivalChangeRow } from './arrival/changeRows';
import { addOperationChanges, startSenderOperation } from './senders/operations';
import { ensureSenderProfile, loadSenderProfile, senderKeyOf } from './senders/profiles';
import { isPersonalMailbox } from './permissions';
import { visibleThreadClarification, visibleThreadDraftSlot } from './needsReplySlot';

/** Unused AI drafts in a row that pause draft-on-arrival for a sender. */
export const UNUSED_DRAFT_PAUSE_AT = 5;

/** Saved drafts of one conversation the reply check reads at most. */
const THREAD_DRAFT_SCAN = 50;

export type DraftUse = 'unused' | 'used';

/** The pause fields of a profile, as a change row records them. */
export function draftPauseValueOf(
	profile: Pick<Doc<'mailSenderProfiles'>, 'autoDraftPausedAt' | 'unusedDraftStreak'>
): SenderDraftPauseValue {
	return {
		...(profile.autoDraftPausedAt !== undefined
			? { autoDraftPausedAt: profile.autoDraftPausedAt }
			: {}),
		unusedDraftStreak: profile.unusedDraftStreak,
	};
}

/**
 * The next pause state after one draft outcome, or null when nothing changes.
 * `isLogged` marks a pause or a reset (an operation); an increment is not.
 * Pure.
 */
export function nextDraftPause(
	current: SenderDraftPauseValue,
	use: DraftUse,
	now: number
): { after: SenderDraftPauseValue; isLogged: boolean } | null {
	const isPaused = current.autoDraftPausedAt !== undefined;
	if (use === 'used') {
		// A reset, paused or not; the pause itself waits for Resume.
		if (current.unusedDraftStreak === 0) return null;
		const after = isPaused
			? { autoDraftPausedAt: current.autoDraftPausedAt, unusedDraftStreak: 0 }
			: { unusedDraftStreak: 0 };
		return { after, isLogged: true };
	}
	// Already paused: nothing more to count.
	if (isPaused) return null;
	const streak = current.unusedDraftStreak + 1;
	if (streak >= UNUSED_DRAFT_PAUSE_AT) {
		return { after: { autoDraftPausedAt: now, unusedDraftStreak: streak }, isLogged: true };
	}
	return { after: { unusedDraftStreak: streak }, isLogged: false };
}

/**
 * Apply one draft outcome to the profile of the sender at `address`. An unused
 * draft creates a missing profile; a reset never does. The owner's own
 * address and a team inbox are skipped.
 */
export async function recordDraftUse(
	ctx: MutationCtx,
	args: { mailboxId: Id<'mailboxes'>; address: string; use: DraftUse; now: number }
): Promise<void> {
	const mailbox = await ctx.db.get(args.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	const key = senderKeyOf(args.address);
	if (!key.address || key.address === mailbox.address.toLowerCase()) return;
	const existing = await loadSenderProfile(ctx, mailbox._id, key.senderDigest);
	if (!existing && args.use === 'used') return;
	const profile =
		existing ??
		(await ensureSenderProfile(ctx, {
			mailboxId: mailbox._id,
			address: key.address,
			now: args.now,
		}));
	const before = draftPauseValueOf(profile);
	const step = nextDraftPause(before, args.use, args.now);
	if (!step) return;
	if (!step.isLogged) {
		await ctx.db.patch(profile._id, {
			unusedDraftStreak: step.after.unusedDraftStreak,
			updatedAt: args.now,
		});
		return;
	}
	const operationId = await startSenderOperation(ctx, {
		mailboxId: mailbox._id,
		kind: 'draft_pause',
		actor: 'system',
		senderDigest: profile.senderDigest,
		now: args.now,
	});
	await ctx.db.patch(profile._id, {
		autoDraftPausedAt: step.after.autoDraftPausedAt,
		unusedDraftStreak: step.after.unusedDraftStreak,
		lastOperationId: operationId,
		updatedAt: args.now,
	});
	await ctx.db.insert(
		'mailArrivalOperationChanges',
		arrivalChangeRow({
			operationId,
			mailboxId: mailbox._id,
			change: {
				kind: 'senderDraftPause',
				senderDigest: profile.senderDigest,
				before,
				after: step.after,
			},
			now: args.now,
		})
	);
	await addOperationChanges(ctx, operationId, 1);
}

/** Whether draft-on-arrival is paused for mail from `fromAddress` in this mailbox. */
export async function isDraftOnArrivalPaused(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	fromAddress: string
): Promise<boolean> {
	const profile = await loadSenderProfile(ctx, mailboxId, senderKeyOf(fromAddress).senderDigest);
	return profile?.autoDraftPausedAt !== undefined;
}

function sameText(a: string, b: string): boolean {
	const words = (text: string) => text.replace(/\s+/g, ' ').trim();
	return words(a) === words(b);
}

/** The AI replies the thread itself offers for its owed message (slot, clarification draft). */
function offeredReplies(thread: Doc<'mailThreads'>): string[] {
	const slot = visibleThreadDraftSlot(thread)?.draft;
	const answered = visibleThreadClarification(thread)?.draft;
	return [slot, answered].filter((text): text is string => !!text?.trim());
}

/** A saved draft with an AI baseline, still being composed, answering `messageId`. */
function isAiDraftFor(draft: Doc<'mailDrafts'>, messageId: Id<'mailMessages'>): boolean {
	return (
		draft.state === 'draft' &&
		!draft.obsoleted &&
		draft.inReplyToMessageId === messageId &&
		!!draft.aiDraftBaseline?.text.trim()
	);
}

/** The sender whose reply the thread owes, when the flag's message still exists. */
async function owedSender(
	ctx: Pick<QueryCtx, 'db'>,
	thread: Doc<'mailThreads'>
): Promise<string | null> {
	const flag = thread.needsReply;
	if (!flag) return null;
	const trigger = await ctx.db.get(flag.messageId);
	return trigger && trigger.mailboxId === thread.mailboxId ? trigger.fromAddress : null;
}

/**
 * The owner answered `thread` without an AI reply (a send without a baseline,
 * or a reply from another client). Counts one unused draft for the owed
 * sender when the thread offered one. Call it before the reply clears the
 * thread's needs-reply flag; `exceptDraftId` is the draft being sent.
 */
export async function noteReplyWithoutAiDraft(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	exceptDraftId?: Id<'mailDrafts'>
): Promise<void> {
	const flag = thread.needsReply;
	if (!flag) return;
	let isOffered = offeredReplies(thread).length > 0;
	if (!isOffered) {
		const drafts = await ctx.db
			.query('mailDrafts')
			.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
			.take(THREAD_DRAFT_SCAN);
		isOffered = drafts.some((d) => d._id !== exceptDraftId && isAiDraftFor(d, flag.messageId));
	}
	if (!isOffered) return;
	const sender = await owedSender(ctx, thread);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: thread.mailboxId,
		address: sender,
		use: 'unused',
		now: Date.now(),
	});
}

/**
 * The lifecycle's `→ sent`, before the send's cascade clears the thread's
 * needs-reply flag: a draft with an AI baseline resets its sender's streak,
 * any other reply counts the thread's unused AI reply.
 */
export async function noteDraftSent(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	if (draft.aiDraftBaseline?.text.trim()) {
		const answered = draft.inReplyToMessageId ? await ctx.db.get(draft.inReplyToMessageId) : null;
		if (!answered || answered.mailboxId !== draft.mailboxId) return;
		await recordDraftUse(ctx, {
			mailboxId: draft.mailboxId,
			address: answered.fromAddress,
			use: 'used',
			now: Date.now(),
		});
		return;
	}
	const thread = draft.threadId ? await ctx.db.get(draft.threadId) : null;
	if (thread && thread.mailboxId === draft.mailboxId) {
		await noteReplyWithoutAiDraft(ctx, thread, draft._id);
	}
}

/**
 * `drafts.discard`, before the row is deleted: an AI draft discarded while
 * its reply is still owed counts as unused, unless it is a copy of the reply
 * the thread still offers (see the module header).
 */
export async function noteDraftDiscarded(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>
): Promise<void> {
	const baseline = draft.aiDraftBaseline?.text;
	if (!draft.threadId || !draft.inReplyToMessageId || !baseline?.trim()) return;
	if (draft.state !== 'draft' || draft.obsoleted) return;
	const thread = await ctx.db.get(draft.threadId);
	if (!thread || thread.mailboxId !== draft.mailboxId) return;
	if (thread.needsReply?.messageId !== draft.inReplyToMessageId) return;
	if (offeredReplies(thread).some((text) => sameText(text, baseline))) return;
	const sender = await owedSender(ctx, thread);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: draft.mailboxId,
		address: sender,
		use: 'unused',
		now: Date.now(),
	});
}
