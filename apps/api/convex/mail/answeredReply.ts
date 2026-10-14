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
 * Cleanup is soft: the draft is marked `obsoleted` by the replies that answered
 * it and hidden from every draft surface; its uploads stay. When a reply
 * bounces for the person it answers it drops out of that set, and a draft no
 * reply answers any more comes back (`reconcileAnsweredReply`).
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

import { v } from 'convex/values';
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
 * How many answering replies a hidden draft or a Team Inbox stash tracks. A
 * Convex array tops out at 8,192 and a document at 1 MiB, so the set cannot
 * grow with the conversation. Past the cap it stops growing and the row is
 * marked untracked: it stays answered and is never restored by a bounce. That
 * fails safe (dozens of accepted replies answered it), and an exact restore
 * past that point would need the full set, which is what the cap gives up.
 */
export const MAX_TRACKED_ANSWERS = 64;

/**
 * Record one more distinct answering reply on a tracked set: it joins the
 * set and renews retention (`at`, the purge clock), so the purge waits for the
 * newest reply's bounce window. Past the cap the set is frozen and marked
 * untracked. The caller has checked the id is not in the set already, so a
 * duplicate acceptance never renews.
 */
export function withAnsweringReply<IdT>(
	ids: readonly IdT[],
	id: IdT,
	at: number
): { ids: IdT[]; at?: number; isUntracked?: true } {
	if (ids.length >= MAX_TRACKED_ANSWERS) return { ids: [...ids], isUntracked: true };
	return { ids: [...ids, id], at };
}

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

/** The thread's drafts still being composed, hidden ones included (not pending or scheduled). */
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

/** Written by the AI and never touched by a person (the text check is a second guard). */
async function isAiOnlyDraft(draft: Doc<'mailDrafts'>): Promise<boolean> {
	if (!draft.aiAuthored || draft.humanTouchedAt !== undefined) return false;
	if (draft.composerMode === 'full') return false;
	const { bodyHtml } = await openMailDraftBody(draft);
	return isUntouchedAiAnswer(bodyHtml, draft.aiAuthored.text);
}

/**
 * Record `byMessageId` as answering the AI drafts it answered: AI-only ones
 * replying to a message received at or before `answeredUpTo`, saved at or
 * before `respondedAt`. A live draft is hidden; one another reply already hid
 * gains this reply too, so it stays hidden while either stands.
 */
async function obsoleteAnsweredDrafts(
	ctx: MutationCtx,
	drafts: ReadonlyArray<Doc<'mailDrafts'>>,
	response: { byMessageId: Id<'mailMessages'>; answeredUpTo: number; respondedAt: number }
): Promise<void> {
	const at = Date.now();
	for (const draft of drafts) {
		const hidden = draft.obsoleted;
		if (hidden?.isUntracked || hidden?.byMessageIds.includes(response.byMessageId)) continue;
		if (!draft.inReplyToMessageId || draft.lastEditedAt > response.respondedAt) continue;
		const repliedTo = await ctx.db.get(draft.inReplyToMessageId);
		if (!repliedTo || repliedTo.receivedAt > response.answeredUpTo) continue;
		if (!(await isAiOnlyDraft(draft))) continue;
		if (!hidden) {
			await ctx.db.patch(draft._id, { obsoleted: { byMessageIds: [response.byMessageId], at } });
			continue;
		}
		const next = withAnsweringReply(hidden.byMessageIds, response.byMessageId, at);
		await ctx.db.patch(draft._id, {
			obsoleted: {
				...hidden,
				byMessageIds: next.ids,
				...(next.at !== undefined ? { at: next.at } : {}),
				...(next.isUntracked ? { isUntracked: true as const } : {}),
			},
		});
	}
}

/**
 * `sent` never reached the correspondent: it no longer answers the drafts it
 * hid. One another reply also answered stays hidden behind that reply; one
 * nothing else answered comes back.
 */
async function restoreObsoletedBy(
	ctx: MutationCtx,
	sent: Doc<'mailMessages'>,
	answered: Doc<'mailMessages'>
): Promise<void> {
	for (const draft of await composingDrafts(ctx, answered.threadId)) {
		const ids = draft.obsoleted?.byMessageIds;
		// An untracked draft stays hidden: its set no longer says who answered it.
		if (!draft.obsoleted || draft.obsoleted.isUntracked || !ids?.includes(sent._id)) continue;
		const rest = ids.filter((id) => id !== sent._id);
		await ctx.db.patch(draft._id, {
			obsoleted: rest.length > 0 ? { ...draft.obsoleted, byMessageIds: rest } : undefined,
		});
	}
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
		await restoreObsoletedBy(ctx, sent, answered);
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

/**
 * Per purge run: few rows and a read budget well under the transaction's
 * 16 MiB, leaving room for each draft's ask sessions, receipts and deletes. The
 * row that crosses the budget is still returned, so every run makes progress.
 */
const PURGE_PAGE = { numItems: 8, maximumBytesRead: 4 * 1024 * 1024 } as const;

/**
 * Delete the drafts obsoleted longer ago than the retention window, uploads
 * and all, and have the Team Inbox drop its stashes from as long ago.
 */
export const purgeExpired = internalMutation({
	args: { isContinuation: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<{ purged: number }> => {
		if (!args.isContinuation) {
			await ctx.scheduler.runAfter(0, internal.inbox.answeredThread.purgeAnsweredStashes, {});
		}
		const cutoff = Date.now() - ANSWERED_RETENTION_MS;
		const page = await ctx.db
			.query('mailDrafts')
			.withIndex('by_obsoleted_at', (q) => q.gt('obsoleted.at', 0).lt('obsoleted.at', cutoff))
			.paginate({ cursor: null, ...PURGE_PAGE });
		for (const draft of page.page) await deleteDraftRow(ctx, draft);
		if (!page.isDone && page.page.length > 0) {
			await ctx.scheduler.runAfter(0, internal.mail.answeredReply.purgeExpired, {
				isContinuation: true,
			});
		}
		return { purged: page.page.length };
	},
});
