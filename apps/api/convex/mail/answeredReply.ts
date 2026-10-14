/**
 * A response completes the reply it answers (#1346).
 *
 * Once we have answered a conversation, an AI reply left behind makes it look
 * unanswered and invites a second response. There are two kinds:
 *
 *   - The generated reply (the Reply Queue's draft slot and clarification
 *     draft) lives on `mailThreads.needsReply` and goes with that flag.
 *   - A saved composer draft (`mailDrafts`) that still holds an AI reply
 *     word for word goes here.
 *
 * A saved draft a person wrote, or an AI draft a person edited, is theirs and
 * always stays: only one whose recorded AI baseline still equals its text
 * (`isUntouchedAiAnswer`) is removed. So does any draft replying to mail newer
 * than the response, one saved after the response was written, and a pending
 * or scheduled send (a send the owner already chose).
 *
 * Both kinds of response settle: an Owlat reply once its transport accepted it
 * (`settleAcceptedReply`, from the Postbox outbound lifecycle; a send that
 * fails leaves every draft), and our own reply detected by mail sync or a
 * client's IMAP APPEND (`settleOwnerReply`). An auto-reply (vacation notice)
 * or a provider draft is not a response. A new inbound message reopens the
 * flow: classification flags it afresh and drafts it under the usual rules,
 * with nothing left to restore.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { isUntouchedAiAnswer } from '@owlat/shared/answerMode';
import { deleteOwnedUpload } from '../storage/uploads';
import { openMailDraftBody } from '../lib/messageBody';
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

/** A saved draft that is still the AI's reply, untouched by a person. */
async function isUntouchedAiDraft(draft: Doc<'mailDrafts'>): Promise<boolean> {
	const baseline = draft.aiDraftBaseline?.text;
	if (!baseline || draft.composerMode === 'full') return false;
	const { bodyHtml } = await openMailDraftBody(draft);
	return isUntouchedAiAnswer(bodyHtml, baseline);
}

/**
 * Delete the AI drafts a response made obsolete: untouched ones replying to a
 * message received at or before `answeredUpTo`, saved at or before
 * `respondedAt`.
 */
async function removeAnsweredDrafts(
	ctx: MutationCtx,
	drafts: ReadonlyArray<Doc<'mailDrafts'>>,
	response: { answeredUpTo: number; respondedAt: number }
): Promise<void> {
	for (const draft of drafts) {
		if (!draft.inReplyToMessageId || draft.lastEditedAt > response.respondedAt) continue;
		const repliedTo = await ctx.db.get(draft.inReplyToMessageId);
		if (!repliedTo || repliedTo.receivedAt > response.answeredUpTo) continue;
		if (!(await isUntouchedAiDraft(draft))) continue;
		await deleteDraftRow(ctx, draft);
	}
}

/**
 * An Owlat reply's transport accepted it (a recipient reached `sent`): the
 * conversation's AI drafts for the message it answered, or an earlier one, go.
 * The sent draft itself was deleted at `→ sent`. Idempotent, so every accepted
 * recipient may call it.
 */
export async function settleAcceptedReply(
	ctx: MutationCtx,
	sent: Doc<'mailMessages'>
): Promise<void> {
	if (!sent.answeredMessageId) return;
	const answered = await ctx.db.get(sent.answeredMessageId);
	if (!answered) return;
	const drafts = await composingDrafts(ctx, answered.threadId);
	await removeAnsweredDrafts(ctx, drafts, {
		answeredUpTo: answered.receivedAt,
		respondedAt: sent.createdAt,
	});
}

/**
 * Settle a conversation when our own reply arrives from OUTSIDE Owlat (the
 * provider's web client, a phone, a desktop client's APPEND). That reply never
 * passes the draft lifecycle, so without this the needs-reply flag, the draft
 * generated for it and the saved AI draft all outlive the reply that settled
 * them. A Sent copy older than the flagged message (out-of-order sync) settles
 * nothing newer than itself. Not a reply at all: a saved draft (the Drafts
 * folder, `\Draft`) and an automatic one (`isAutomated`: Auto-Submitted, a
 * vacation Precedence).
 */
export async function settleOwnerReply(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	opts: { isAutomated?: boolean } = {}
): Promise<void> {
	if (opts.isAutomated) return;
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
