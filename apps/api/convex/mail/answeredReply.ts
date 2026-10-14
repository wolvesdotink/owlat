/**
 * A response completes the reply it answers (#1346).
 *
 * Once we have answered a conversation, an AI reply left behind makes it look
 * unanswered and invites a second response. There are two kinds:
 *
 *   - The generated reply (the Reply Queue's draft slot and clarification
 *     draft) lives on `mailThreads.needsReply` and goes with that flag.
 *   - A saved composer draft (`mailDrafts`) the AI wrote and no person has
 *     touched: `aiAuthored` set, `humanTouchedAt` never (mail/draftProvenance.ts).
 *     Any change a person makes (body, recipients, subject, attachments, a
 *     link) sets `humanTouchedAt`, and such a draft is theirs and always stays.
 *
 * Cleanup is soft: the draft is marked `obsoleted` by the reply and hidden from
 * every draft surface; its uploads stay. If the reply bounces for the person
 * it answers, every draft it obsoleted comes back (`reconcileAnsweredReply`).
 * After `ANSWERED_RETENTION_MS` the draft is deleted for good, uploads and all
 * (`purgeExpired`).
 *
 * Both kinds of response settle: an Owlat reply once its transport accepted it
 * for the correspondent (the answered sender or a To recipient; a Bcc or
 * archive copy does not count), from the Postbox outbound lifecycle; and our
 * own reply detected by mail sync or a client's IMAP APPEND
 * (`settleOwnerReply`). An auto-reply (vacation notice) or a provider draft is
 * not a response. Untouched as well: a draft replying to mail newer than the
 * response, one saved after it, and a pending or scheduled send. A new inbound
 * message reopens the flow: classification flags it afresh and drafts it under
 * the usual rules, with nothing left to restore.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS, normalizeEmail } from '@owlat/shared';
import { isUntouchedAiAnswer } from '@owlat/shared/answerMode';
import { deleteOwnedUpload } from '../storage/uploads';
import { openMailDraftBody } from '../lib/messageBody';
import {
	headerEvidenceFromMap,
	isBulkPrecedenceForReply,
	isMachineGeneratedForReply,
} from '../lib/mailEvidence';
import { deleteAskSessionsForDraft } from './ai/composeDraftStore';
import { clearThreadNeedsReply, isOwnMessage } from './needsReply';
import { mailboxOwnAddresses } from './identities';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an obsoleted draft (or a Team Inbox stash) waits for a bounce
 * before it is purged: the MTA's own retry horizon, plus three days for a
 * remote server's late bounce report.
 */
export const ANSWERED_RETENTION_MS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 3 * DAY_MS;

/**
 * An auto-reply (a vacation notice, a list or bulk mailing) by its headers:
 * Auto-Submitted other than `no`, List-Id, or a bulk / `auto_reply`
 * Precedence. It answers nothing.
 */
export function isAutomatedResponse(headers: Record<string, string> | undefined): boolean {
	const evidence = headerEvidenceFromMap(headers ?? {});
	return isMachineGeneratedForReply(evidence) || isBulkPrecedenceForReply(evidence);
}

/** Delete a draft row with its uploads and Answer mode ask sessions. */
export async function deleteDraftRow(ctx: MutationCtx, draft: Doc<'mailDrafts'>): Promise<void> {
	for (const att of draft.attachments) {
		await deleteOwnedUpload(ctx, att.storageId, `mailDrafts:${draft._id}`);
	}
	await deleteAskSessionsForDraft(ctx, draft._id);
	await ctx.db.delete(draft._id);
}

/** The thread's live drafts still being composed (not pending, scheduled or obsoleted). */
async function composingDrafts(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailDrafts'>[]> {
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one conversation's drafts
	return drafts.filter((d) => d.state === 'draft' && d.obsoleted === undefined);
}

/** Written by the AI and never touched by a person (the text check is a second guard). */
async function isAiOnlyDraft(draft: Doc<'mailDrafts'>): Promise<boolean> {
	if (!draft.aiAuthored || draft.humanTouchedAt !== undefined) return false;
	if (draft.composerMode === 'full') return false;
	const { bodyHtml } = await openMailDraftBody(draft);
	return isUntouchedAiAnswer(bodyHtml, draft.aiAuthored.text);
}

/**
 * Mark obsolete the AI drafts a response answered: AI-only ones replying to a
 * message received at or before `answeredUpTo`, saved at or before
 * `respondedAt`.
 */
async function obsoleteAnsweredDrafts(
	ctx: MutationCtx,
	drafts: ReadonlyArray<Doc<'mailDrafts'>>,
	response: { byMessageId: Id<'mailMessages'>; answeredUpTo: number; respondedAt: number }
): Promise<void> {
	const at = Date.now();
	for (const draft of drafts) {
		if (!draft.inReplyToMessageId || draft.lastEditedAt > response.respondedAt) continue;
		const repliedTo = await ctx.db.get(draft.inReplyToMessageId);
		if (!repliedTo || repliedTo.receivedAt > response.answeredUpTo) continue;
		if (!(await isAiOnlyDraft(draft))) continue;
		await ctx.db.patch(draft._id, { obsoleted: { byMessageId: response.byMessageId, at } });
	}
}

/** Bring back every draft `messageId` obsoleted (the reply never reached them). */
async function restoreObsoletedBy(ctx: MutationCtx, messageId: Id<'mailMessages'>): Promise<void> {
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_obsoleted_by', (q) => q.eq('obsoleted.byMessageId', messageId))
		.collect(); // bounded: one conversation's drafts
	for (const draft of drafts) await ctx.db.patch(draft._id, { obsoleted: undefined });
}

/** Whom an Owlat reply answers: the sender of the answered mail and the reply's To. */
function correspondentsOf(sent: Doc<'mailMessages'>, answered: Doc<'mailMessages'>): Set<string> {
	return new Set(
		[answered.fromAddress, answered.replyToAddress, ...sent.toAddresses]
			.filter((a): a is string => !!a)
			.map(normalizeEmail)
	);
}

/**
 * Bring an Owlat reply's drafts in line with its delivery to the correspondent,
 * after any recipient transition: accepted for one of them, the conversation's
 * AI drafts are obsoleted; refused for all of them (a bounce, a failure, even
 * after an earlier acceptance), they come back. A Bcc or archive copy never
 * decides either way. Idempotent.
 */
export async function reconcileAnsweredReply(
	ctx: MutationCtx,
	sentId: Id<'mailMessages'>
): Promise<void> {
	const sent = await ctx.db.get(sentId);
	if (!sent?.answeredMessageId || !sent.outbound) return;
	const answered = await ctx.db.get(sent.answeredMessageId);
	if (!answered) return;
	const correspondents = correspondentsOf(sent, answered);
	const states = sent.outbound.recipients
		.filter((r) => correspondents.has(normalizeEmail(r.address)))
		.map((r) => r.state);
	if (states.includes('sent')) {
		const drafts = await composingDrafts(ctx, answered.threadId);
		await obsoleteAnsweredDrafts(ctx, drafts, {
			byMessageId: sent._id,
			answeredUpTo: answered.receivedAt,
			respondedAt: sent.createdAt,
		});
	} else if (states.length > 0 && !states.includes('queued')) {
		await restoreObsoletedBy(ctx, sent._id);
	}
}

/**
 * Settle a conversation when our own reply arrives from OUTSIDE Owlat (the
 * provider's web client, a phone, a desktop client's APPEND). That reply never
 * passes the draft lifecycle, so without this the needs-reply flag, the draft
 * generated for it and the saved AI draft all outlive the reply that settled
 * them. A Sent copy older than the flagged message (out-of-order sync) settles
 * nothing newer than itself. Not a reply at all: a saved draft (the Drafts
 * folder, `\Draft`) and an automatic one (`isAutomated`, see
 * {@link isAutomatedResponse}).
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

	await obsoleteAnsweredDrafts(ctx, drafts, {
		byMessageId: message._id,
		answeredUpTo: message.receivedAt,
		respondedAt: message.receivedAt,
	});
	if (!thread.needsReply) return;
	const trigger = await ctx.db.get(thread.needsReply.messageId);
	if (trigger && trigger.receivedAt > message.receivedAt) return;
	await clearThreadNeedsReply(ctx, thread._id);
}

const PURGE_BATCH = 50;

/**
 * Delete the drafts obsoleted longer ago than the retention window, uploads
 * and all, and have the Team Inbox drop its stashes from as long ago.
 */
export const purgeExpired = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ purged: number }> => {
		await ctx.scheduler.runAfter(0, internal.inbox.answeredThread.purgeAnsweredStashes, {});
		const cutoff = Date.now() - ANSWERED_RETENTION_MS;
		const drafts = await ctx.db
			.query('mailDrafts')
			.withIndex('by_obsoleted_at', (q) => q.gt('obsoleted.at', 0).lt('obsoleted.at', cutoff))
			.take(PURGE_BATCH);
		for (const draft of drafts) await deleteDraftRow(ctx, draft);
		if (drafts.length === PURGE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.mail.answeredReply.purgeExpired, {});
		}
		return { purged: drafts.length };
	},
});
