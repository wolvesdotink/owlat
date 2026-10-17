/**
 * Unused-draft pause (SPEC §7): draft-on-arrival stops for a sender whose AI
 * drafts keep going unused, until the owner resumes it on the Senders page.
 *
 * **Logical drafts.** One AI draft is either
 *
 *  - an **offer**: the AI reply a thread's needs-reply flag offers for its
 *    owed message (the arrival slot, or the draft written from the owner's
 *    answers), keyed `<threadId>:<owed messageId>` ({@link draftOfferKeyOf});
 *    or
 *  - a saved draft row with an AI baseline (`aiDraftBaseline`), keyed by its
 *    id, unless it is a **copy** of an offer: the composer sends the offer
 *    key with every write that applies the offered reply (body or baseline,
 *    whichever lands first), and the row keeps it (`mailDrafts.offerKey`,
 *    mail/draftProvenance.ts `aiWritePatch`).
 *
 * **Exactly once.** An offer's outcome is a row of `mailDraftOfferUsage`
 * (mail/draftOfferUsage.ts), checked and written in the mutation that
 * counts, kept for as long as the thread and its owed message exist: once it
 * is there, no copy's discard, death, reply or send counts that offer again.
 * A standalone row's outcome is stored on the row
 * (`mailDrafts.isDraftUsageCounted`). Nothing scans for copies.
 *
 * **Unused** (`unusedDraftStreak` + 1 per logical draft):
 *
 *  - a saved AI draft dies unused: the person discards it
 *    (`drafts.discard`), the answered-draft cleanup purges it
 *    (mail/answeredReply.ts), or the person takes the AI draft back out in
 *    the editor ("AI draft · Discard", `markAiDraftDiscarded`). Every one of
 *    them goes through `deleteDraftRow` or that mutation. A copy counts its
 *    offer, whichever copy goes first; a standalone draft counts itself;
 *  - the owner replies in the thread without an AI-based draft (an Owlat
 *    send, or our reply from another client) while the thread offers a reply
 *    that has not counted. A standalone AI draft left behind counts when the
 *    cleanup removes it, not at the reply.
 *
 * A draft that is sent never counts as unused.
 *
 * **Used.** Sending a row with a baseline whose AI draft was not taken back
 * out (`aiDraftDiscardedAt` absent; a later AI write clears it) resets the
 * streak, also while paused: the pause's own undo then fails its guard,
 * which is right. A copy's send settles its offer as used.
 *
 * At {@link UNUSED_DRAFT_PAUSE_AT} the profile gets `autoDraftPausedAt` and
 * draft-on-arrival skips the sender (`isDraftOnArrivalPaused`); the
 * clarification questions still run. While paused nothing counts up; Resume
 * (`senders/status.resumeDrafts`) clears both fields.
 *
 * **Logged.** A pause and a reset are arrival operations (kind `draft_pause`,
 * actor `system`) with one `senderDraftPause` change row, written with the
 * profile's `lastOperationId` in the same mutation, so undo works. A plain
 * increment is not an operation.
 *
 * Personal mailboxes only, checked at write time. On a profile this module
 * writes only `unusedDraftStreak`, `autoDraftPausedAt` and `lastOperationId`.
 */

import type { SenderDraftPauseValue } from '@owlat/shared/arrival';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import { isPersonalMailbox, requireMailboxAccess } from './permissions';
import { arrivalChangeRow } from './arrival/changeRows';
import { addOperationChanges, startSenderOperation } from './senders/operations';
import {
	ensureSenderProfile,
	isPersonalMailboxId,
	loadSenderProfile,
	senderKeyOf,
} from './senders/profiles';
import { visibleThreadClarification, visibleThreadDraftSlot } from './needsReplySlot';
import { claimDraftOffer } from './draftOfferUsage';

/** Unused AI drafts in a row that pause draft-on-arrival for a sender. */
export const UNUSED_DRAFT_PAUSE_AT = 5;

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

/** Whether the thread offers an AI reply for its owed message (slot or clarification draft). */
function isReplyOffered(thread: Doc<'mailThreads'>): boolean {
	const slot = visibleThreadDraftSlot(thread)?.draft;
	const answered = visibleThreadClarification(thread)?.draft;
	return !!slot?.trim() || !!answered?.trim();
}

/** The key of the AI reply the thread offers now, or undefined when it offers none. */
export function draftOfferKeyOf(thread: Doc<'mailThreads'>): string | undefined {
	const flag = thread.needsReply;
	return flag && isReplyOffered(thread) ? `${thread._id}:${flag.messageId}` : undefined;
}

function baselineOf(draft: Doc<'mailDrafts'>): string | undefined {
	const text = draft.aiDraftBaseline?.text;
	return text?.trim() ? text : undefined;
}

/** The person who wrote `messageId`, when it is mail of this mailbox. */
async function senderOf(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	messageId: Id<'mailMessages'> | undefined
): Promise<string | null> {
	const message = messageId ? await ctx.db.get(messageId) : null;
	return message && message.mailboxId === mailboxId ? message.fromAddress : null;
}

/**
 * The AI draft of `draft` went unused (discarded, or taken back out in the
 * editor). A copy counts its offer once; any other row counts itself once.
 */
async function countUnusedRow(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	if (!baselineOf(draft) || draft.isDraftUsageCounted) return;
	if (draft.state !== 'draft' || !(await isPersonalMailboxId(ctx, draft.mailboxId))) return;
	await ctx.db.patch(draft._id, { isDraftUsageCounted: true });
	if (draft.offerKey && !(await claimDraftOffer(ctx, draft.mailboxId, draft.offerKey, Date.now())))
		return;
	const sender = await senderOf(ctx, draft.mailboxId, draft.inReplyToMessageId);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: draft.mailboxId,
		address: sender,
		use: 'unused',
		now: Date.now(),
	});
}

/**
 * The owner answered `thread` without an AI-based draft (a send of a draft
 * without one, or a reply from another client). The reply the thread offers
 * counts as unused, once. Call it before the reply clears the flag.
 */
export async function noteReplyWithoutAiDraft(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>
): Promise<void> {
	const flag = thread.needsReply;
	const key = draftOfferKeyOf(thread);
	if (!flag || !key || !(await isPersonalMailboxId(ctx, thread.mailboxId))) return;
	if (!(await claimDraftOffer(ctx, thread.mailboxId, key, Date.now()))) return;
	const sender = await senderOf(ctx, thread.mailboxId, flag.messageId);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: thread.mailboxId,
		address: sender,
		use: 'unused',
		now: Date.now(),
	});
}

/** Whether sending `draft` is an AI-based send: it holds an AI draft nobody took back out. */
function isAiBasedSend(draft: Doc<'mailDrafts'>): boolean {
	return baselineOf(draft) !== undefined && draft.aiDraftDiscardedAt === undefined;
}

/**
 * The lifecycle's `→ sent`, before the send's cascade clears the thread's
 * needs-reply flag: an AI-based send resets its sender's streak (a copy
 * settles its offer as used); any other reply counts the offered reply.
 */
export async function noteDraftSent(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	if (!(await isPersonalMailboxId(ctx, draft.mailboxId))) return;
	if (!isAiBasedSend(draft)) {
		const thread = draft.threadId ? await ctx.db.get(draft.threadId) : null;
		if (thread && thread.mailboxId === draft.mailboxId) await noteReplyWithoutAiDraft(ctx, thread);
		return;
	}
	if (draft.offerKey) await claimDraftOffer(ctx, draft.mailboxId, draft.offerKey, Date.now());
	const sender = await senderOf(ctx, draft.mailboxId, draft.inReplyToMessageId);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: draft.mailboxId,
		address: sender,
		use: 'used',
		now: Date.now(),
	});
}

/**
 * A draft row is deleted unsent (`answeredReply.deleteDraftRow`: a discard,
 * the answered-draft cleanup): its AI draft went unused.
 */
export async function noteDraftDiscarded(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>
): Promise<void> {
	await countUnusedRow(ctx, draft);
}

/**
 * "AI draft · Discard" in the Answer mode editor: the person took the AI
 * draft back out. Counts it as unused once, and a send of this row stops
 * being AI-based until an AI draft goes in again (mail/draftProvenance.ts).
 */
// authz: requireMailboxAccess on the draft's mailbox, like drafts.discard.
export const markAiDraftDiscarded = postboxMutation({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<void> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft || !baselineOf(draft)) return;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return;
		await ctx.db.patch(draft._id, { aiDraftDiscardedAt: Date.now() });
		await countUnusedRow(ctx, draft);
	},
});
