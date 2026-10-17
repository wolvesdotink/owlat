/**
 * Unused-draft pause (SPEC §7): draft-on-arrival stops for a sender whose AI
 * drafts keep going unused, until the owner resumes it on the Senders page.
 *
 * **Logical drafts.** One AI draft is either a saved draft row with an AI
 * baseline (`aiDraftBaseline`), keyed by its id, or the AI reply a thread's
 * needs-reply flag offers for its owed message (the arrival slot, or the
 * draft written from the owner's answers), keyed by the thread and that
 * flag. A saved row holding the same text as the reply the thread offers is
 * a copy of that reply, not a draft of its own.
 *
 * **Exactly once.** Each logical draft's outcome is counted once, and the
 * fact is stored with it: `mailDrafts.isDraftUsageCounted` on a row,
 * `needsReply.isDraftUsageCounted` on the flag (a reply clears the flag
 * itself). A copy settles its arrival reply too, so no later discard, reply
 * or send counts that reply again.
 *
 * **Unused** (`unusedDraftStreak` + 1 per logical draft):
 *
 *  - the person takes the AI draft back out in the editor ("AI draft ·
 *    Discard", `markAiDraftDiscarded`), or discards the draft row
 *    (`drafts.discard`);
 *  - the owner replies in the thread without an AI-based draft (an Owlat
 *    send, or our reply from another client): every uncounted AI draft for
 *    the owed message counts, the offered reply included.
 *
 * **Used.** Sending a row with a baseline whose AI draft was not taken back
 * out (`aiDraftDiscardedAt` absent; a later AI write clears it) resets the
 * streak, also while paused: the pause's own undo then fails its guard,
 * which is right. Its copies of the offered reply settle with it.
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

function baselineOf(draft: Doc<'mailDrafts'>): string | undefined {
	const text = draft.aiDraftBaseline?.text;
	return text?.trim() ? text : undefined;
}

/** Whether `draft` holds a copy of the AI reply `thread` offers for the message the draft answers. */
function isOfferedCopy(draft: Doc<'mailDrafts'>, thread: Doc<'mailThreads'>): boolean {
	const baseline = baselineOf(draft);
	if (!baseline || thread.needsReply?.messageId !== draft.inReplyToMessageId) return false;
	return offeredReplies(thread).some((text) => sameText(text, baseline));
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

/** Mark the thread's offered AI reply counted. */
async function settleOfferedReply(ctx: MutationCtx, thread: Doc<'mailThreads'>): Promise<void> {
	if (!thread.needsReply || thread.needsReply.isDraftUsageCounted) return;
	await ctx.db.patch(thread._id, {
		needsReply: { ...thread.needsReply, isDraftUsageCounted: true },
	});
}

/**
 * The AI draft of `draft` went unused (discarded, or taken back out in the
 * editor). Counts once for the sender it answers, unless it is a copy of an
 * offered reply that already counted; settles that reply either way.
 */
async function countUnusedRow(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	if (!baselineOf(draft) || draft.isDraftUsageCounted || draft.obsoleted) return;
	if (draft.state !== 'draft' || !(await isPersonalMailboxId(ctx, draft.mailboxId))) return;
	await ctx.db.patch(draft._id, { isDraftUsageCounted: true });
	const thread = draft.threadId ? await ctx.db.get(draft.threadId) : null;
	const sameMailbox = thread !== null && thread.mailboxId === draft.mailboxId;
	if (sameMailbox && isOfferedCopy(draft, thread)) {
		if (thread.needsReply?.isDraftUsageCounted) return;
		await settleOfferedReply(ctx, thread);
	}
	const sender = await senderOf(ctx, draft.mailboxId, draft.inReplyToMessageId);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: draft.mailboxId,
		address: sender,
		use: 'unused',
		now: Date.now(),
	});
}

/** The thread's saved drafts still being composed with an uncounted AI draft for `messageId`. */
async function uncountedAiRows(
	ctx: Pick<QueryCtx, 'db'>,
	thread: Doc<'mailThreads'>,
	messageId: Id<'mailMessages'>,
	exceptDraftId: Id<'mailDrafts'> | undefined
): Promise<Doc<'mailDrafts'>[]> {
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
		.take(THREAD_DRAFT_SCAN);
	return drafts.filter(
		(d) =>
			d._id !== exceptDraftId &&
			d.state === 'draft' &&
			!d.obsoleted &&
			!d.isDraftUsageCounted &&
			d.inReplyToMessageId === messageId &&
			baselineOf(d) !== undefined
	);
}

/**
 * The owner answered `thread` without an AI-based draft (a send of a draft
 * without one, or a reply from another client). Every AI draft for the owed
 * message that has not counted yet counts once: the offered reply, and each
 * saved draft that is not a copy of it. Call it before the reply clears the
 * thread's needs-reply flag; `exceptDraftId` is the draft being sent.
 */
export async function noteReplyWithoutAiDraft(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	exceptDraftId?: Id<'mailDrafts'>
): Promise<void> {
	const flag = thread.needsReply;
	if (!flag || !(await isPersonalMailboxId(ctx, thread.mailboxId))) return;
	let unused = offeredReplies(thread).length > 0 && !flag.isDraftUsageCounted ? 1 : 0;
	for (const row of await uncountedAiRows(ctx, thread, flag.messageId, exceptDraftId)) {
		await ctx.db.patch(row._id, { isDraftUsageCounted: true });
		if (!isOfferedCopy(row, thread)) unused++;
	}
	if (unused === 0) return;
	await settleOfferedReply(ctx, thread);
	const sender = await senderOf(ctx, thread.mailboxId, flag.messageId);
	if (!sender) return;
	for (let i = 0; i < unused; i++) {
		await recordDraftUse(ctx, {
			mailboxId: thread.mailboxId,
			address: sender,
			use: 'unused',
			now: Date.now(),
		});
	}
}

/** Whether sending `draft` is an AI-based send: it holds an AI draft nobody took back out. */
function isAiBasedSend(draft: Doc<'mailDrafts'>): boolean {
	return baselineOf(draft) !== undefined && draft.aiDraftDiscardedAt === undefined;
}

/**
 * The lifecycle's `→ sent`, before the send's cascade clears the thread's
 * needs-reply flag: an AI-based send resets its sender's streak and settles
 * the copies of the reply it used; any other reply counts the thread's
 * unused AI drafts.
 */
export async function noteDraftSent(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	if (!(await isPersonalMailboxId(ctx, draft.mailboxId))) return;
	const thread = draft.threadId ? await ctx.db.get(draft.threadId) : null;
	const ownThread = thread && thread.mailboxId === draft.mailboxId ? thread : null;
	if (!isAiBasedSend(draft)) {
		if (ownThread) await noteReplyWithoutAiDraft(ctx, ownThread, draft._id);
		return;
	}
	if (ownThread && isOfferedCopy(draft, ownThread)) {
		const flag = ownThread.needsReply!;
		for (const row of await uncountedAiRows(ctx, ownThread, flag.messageId, draft._id)) {
			if (isOfferedCopy(row, ownThread)) await ctx.db.patch(row._id, { isDraftUsageCounted: true });
		}
	}
	const sender = await senderOf(ctx, draft.mailboxId, draft.inReplyToMessageId);
	if (!sender) return;
	await recordDraftUse(ctx, {
		mailboxId: draft.mailboxId,
		address: sender,
		use: 'used',
		now: Date.now(),
	});
}

/** `drafts.discard`, before the row is deleted: its AI draft went unused. */
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
