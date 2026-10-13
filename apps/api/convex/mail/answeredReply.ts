/**
 * A response completes the reply it answers (#1346).
 *
 * Once we have answered a conversation, a reply draft left behind makes it look
 * unanswered and invites a second response. There are two kinds of draft:
 *
 *   - The generated reply (the Reply Queue's draft slot and clarification
 *     draft) lives on `mailThreads.needsReply` and goes with that flag.
 *   - Saved composer drafts (`mailDrafts`), shown in Drafts and resumed by the
 *     composer, are removed here.
 *
 * Both kinds of response settle both: an Owlat send through the draft
 * lifecycle's sent-effects (`deleteSentDraft`; the thread patch there clears
 * the flag), and our own reply detected by mail sync or a client's IMAP APPEND
 * (`settleOwnerReply`).
 *
 * Only what the response answered goes. A draft replying to mail newer than
 * that stays, and so does one edited after the response was written (the
 * owner is still working on it). A pending or scheduled send is a send the
 * owner already chose, not a draft, and is never touched. A new inbound
 * message reopens the flow: classification flags it afresh and drafts it under
 * the usual rules, with nothing left to restore.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { deleteOwnedUpload } from '../storage/uploads';
import { deleteAskSessionsForDraft } from './ai/composeDraftStore';
import { clearThreadNeedsReply, isOwnMessage } from './needsReply';
import { mailboxOwnAddresses } from './identities';

/** Delete a draft row with its uploads and Answer mode ask sessions. */
export async function deleteDraftRow(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	for (const att of draft.attachments) {
		await deleteOwnedUpload(ctx, att.storageId, `mailDrafts:${draft._id}`);
	}
	await deleteAskSessionsForDraft(ctx, draft._id);
	await ctx.db.delete(draft._id);
}

/** The thread's saved drafts still being composed (not pending or scheduled). */
async function composingDrafts(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailDrafts'>[]> {
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one conversation's drafts
	return drafts.filter((d) => d.state === 'draft');
}

/**
 * Delete the drafts a response made obsolete: those replying to a message
 * received at or before `answeredUpTo` and last edited at or before
 * `respondedAt`. Returns how many went.
 */
async function removeAnsweredDrafts(
	ctx: MutationCtx,
	drafts: ReadonlyArray<Doc<'mailDrafts'>>,
	response: { answeredUpTo: number; respondedAt: number }
): Promise<number> {
	let removed = 0;
	for (const draft of drafts) {
		if (!draft.inReplyToMessageId || draft.lastEditedAt > response.respondedAt) continue;
		const repliedTo = await ctx.db.get(draft.inReplyToMessageId);
		if (!repliedTo || repliedTo.receivedAt > response.answeredUpTo) continue;
		await deleteDraftRow(ctx, draft);
		removed++;
	}
	return removed;
}

/**
 * The `→ sent` row delete: the dispatched draft goes, and so do the other
 * drafts of the conversation that replied to the same message or an earlier
 * one. The dispatched draft's attachments stay (the sent copy owns them).
 */
export async function deleteSentDraft(
	ctx: MutationCtx,
	draft: Doc<'mailDrafts'>,
	sentAt: number
): Promise<void> {
	const original = draft.inReplyToMessageId ? await ctx.db.get(draft.inReplyToMessageId) : null;
	// Same-mailbox only, as for the flagAnswered patch (cross-mailbox IDOR).
	if (draft.threadId && original && original.mailboxId === draft.mailboxId) {
		const others = (await composingDrafts(ctx, draft.threadId)).filter((d) => d._id !== draft._id);
		await removeAnsweredDrafts(ctx, others, {
			answeredUpTo: original.receivedAt,
			respondedAt: sentAt,
		});
	}
	await deleteAskSessionsForDraft(ctx, draft._id);
	await ctx.db.delete(draft._id);
}

/**
 * Settle a conversation when our own reply arrives from OUTSIDE Owlat (the
 * provider's web client, a phone, a desktop client's APPEND). That reply never
 * passes the draft lifecycle's sent-effects, so without this the needs-reply
 * flag, the draft generated for it and the saved draft all outlive the reply
 * that settled them. A Sent copy older than the flagged message (out-of-order
 * sync) settles nothing newer than itself; a saved draft (the Drafts folder,
 * `\Draft`) is not a reply at all.
 */
export async function settleOwnerReply(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const message = await ctx.db.get(messageId);
	if (!message || message.flagDraft) return;
	const thread = await ctx.db.get(message.threadId);
	if (!thread) return;
	const drafts = await composingDrafts(ctx, thread._id);
	if (!thread.needsReply && drafts.length === 0) return;
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isOwnMessage(message, await mailboxOwnAddresses(ctx, mailbox))) return;
	if ((await ctx.db.get(message.folderId))?.role === 'drafts') return;

	const response = { answeredUpTo: message.receivedAt, respondedAt: message.receivedAt };
	await removeAnsweredDrafts(ctx, drafts, response);
	if (!thread.needsReply) return;
	const trigger = await ctx.db.get(thread.needsReply.messageId);
	if (trigger && trigger.receivedAt > message.receivedAt) return;
	await clearThreadNeedsReply(ctx, thread._id);
}
