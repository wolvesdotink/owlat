/**
 * Personal-mail delivery pipeline — what an inbound insert sets off.
 *
 * Hosted MX delivery (`mail/delivery.ts::deliverToMailbox`) and external IMAP
 * sync (`mail/external/delivery.ts::ingestExternalMessage`) both land inbound
 * mail through `insertDeliveredMessage` and then have to tell the rest of the
 * mailbox about it. That tail used to be written out at each site and drifted:
 * synced replies never cleared "remind me if no reply" or "snooze until they
 * reply", and MX delivery never settled the Reply Queue on an owner reply. It
 * lives here once.
 *
 * Not called by IMAP APPEND (`mail/imap/append.ts`), which is a client filing a
 * copy rather than mail arriving, or by archive import, which is history.
 */

import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { scheduleNeedsReplyClassify } from '../needsReply';
import { isAutomatedResponse, settleOwnerReply } from '../answeredReply';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox } from '../permissions';
import { enqueueCategoryCheck } from '../categoryArrival';
import { clearThreadFollowUp } from '../followUps';
import { clearSnoozeUntilReplyForThread } from '../snooze';
import { shouldExtractLiveMessage } from '../liveKnowledge';
import { enqueuePush } from '../../push/events';
import { enqueueDeliveredInterpretation } from '../interpret/enqueue';
import { queuesNeedsReplyCheck, type InboundOrigin } from './insert';
import { writeArrivalRecord, type ArrivalRecordSeed } from '../arrival/records';
import { refreshArrivalProjection } from '../arrival/projection';
import { isColdPitchAskable } from '../arrival/coldPitch';

export type { InboundOrigin };

/** Folders whose mail is never "the reply arrived". */
const NOT_A_REPLY_ROLES: ReadonlySet<string> = new Set(['spam', 'trash', 'sent', 'drafts']);

/**
 * Run the side effects of one inbound insert.
 *
 * `folder` is the folder the caller chose. The row's ACTUAL folder can differ:
 * a muted thread's delivery is re-routed to Archive inside the insert
 * (mail/mute.ts), and the classifiers should not spend work on it.
 *
 *   - Reply Queue + smart-inbox category enqueues: inbox mail that stayed in
 *     the inbox, never from a backfill (importing years of history must not
 *     fan out background LLM work). The category heuristic runs right here in
 *     the insert; only ambiguous mail reaches the LLM. The anti-loop headers
 *     ride along because they are not persisted on the row. The Reply Queue's
 *     pending marker was already stamped by the insert's thread patch (same
 *     `origin`, passed as `inboundOrigin`), so only the classify is scheduled
 *     here.
 *   - Follow-up and snooze-until-reply clears: the awaited reply arrived. Only
 *     for mail from someone other than the mailbox owner, outside Spam, Trash,
 *     Sent and Drafts, and never from a backfill (an old message is not a new
 *     reply).
 *   - Knowledge extraction, under the same conditions (`../liveKnowledge`).
 *     A backfill is history, which a mailbox import's indexing sweep covers.
 *   - Read on arrival: the message's arrival record (live inbound mail of a
 *     personal mailbox), written before the category check so the category
 *     lands in it, and the thread's projection once everything is in
 *     (`../arrival/records.ts`, `../arrival/projection.ts`).
 *   - Interpretation (the thread brief, SPEC §5): the classify above
 *     interprets the delivered message; other live mail that could be
 *     eligible is scheduled on its own (`../interpret/enqueue.ts`). Either way
 *     the brief reads "pending" until the run lands.
 *   - The owner's own reply settles the thread's Reply Queue row and removes
 *     the AI drafts it made obsolete (`../answeredReply`); an auto-reply
 *     (Auto-Submitted, a list, a bulk or `auto_reply` Precedence) does not.
 *   - Web Push to the owner of a personal mailbox, for live unread mail from
 *     someone else that stayed in the inbox (`../../push/`). Whether it
 *     actually notifies — scope, mute, quiet hours — is the sender's call.
 */
export async function runPostInsertInboundEffects(
	ctx: MutationCtx,
	params: {
		messageId: Id<'mailMessages'>;
		folder: Doc<'mailFolders'>;
		origin: InboundOrigin;
		antiLoopHeaders?: Record<string, string>;
		/** What the live-ingest rules pass decided for the record (lane rules, SPEC §6.2). */
		arrival?: ArrivalRecordSeed;
	}
): Promise<void> {
	const { messageId, folder, origin, antiLoopHeaders } = params;
	const delivered = await ctx.db.get(messageId);
	if (!delivered) return;
	const isLive = origin !== 'backfill';

	const precedence = antiLoopHeaders?.['precedence'];
	const listId = antiLoopHeaders?.['list-id'];
	// Read on arrival (SPEC §2.8): the arrival record, before the category
	// check below writes its category into it.
	const record = await writeArrivalRecord(ctx, delivered, { isLive, ...params.arrival });
	const isClassifyQueued = queuesNeedsReplyCheck(origin, folder, delivered.folderId);
	let isCategoryRefining = false;
	if (isClassifyQueued) {
		await scheduleNeedsReplyClassify(ctx, delivered.threadId, {
			precedence,
			// RFC 3834 / list traffic: the strongest "a machine sent this" signal
			// the Reply Queue can get, and like Precedence it lives only on the
			// wire.
			autoSubmitted: antiLoopHeaders?.['auto-submitted'],
			listId,
			// The classify run interprets this message too (one model read).
			interpretMessageId: messageId,
		});
		isCategoryRefining = await enqueueCategoryCheck(ctx, delivered.threadId, {
			precedence,
			messageId,
		});
	}
	// R2 also answers this message's pending rule questions (SPEC §6.2) and
	// the cold-pitch question (#1381): per message, also when the heuristic
	// settled the category without the model (a heuristic label does not keep
	// a pitch out of Needs you).
	const isColdPitchAsked =
		isClassifyQueued &&
		record !== null &&
		!isCategoryRefining &&
		(await isColdPitchAskable(ctx, messageId, precedence));
	if ((record?.pendingAiFilters?.length || isColdPitchAsked) && !isCategoryRefining) {
		await ctx.scheduler.runAfter(0, internal.mail.ai.categoryClassify.classifyThread, {
			threadId: delivered.threadId,
			messageId,
			baselineApplied: true,
			...(precedence !== undefined ? { precedence } : {}),
		});
	}
	// Depth-decision work still out (read on arrival, final review F4): the
	// category refinement, or this message's rule questions (a `sendToDigest`
	// answer is a count hint). Display-only reads wait for it, bounded.
	const isDepthPending = isCategoryRefining || !!record?.pendingAiFilters?.length;
	await enqueueDeliveredInterpretation(ctx, delivered, {
		isLive,
		isInterpretedByClassify: isClassifyQueued,
		precedence,
		listId,
		isCategoryRefining: isDepthPending && record !== null,
	});
	if (record) await refreshArrivalProjection(ctx, delivered.threadId);

	if (isLive && !(folder.role !== undefined && NOT_A_REPLY_ROLES.has(folder.role))) {
		const mailbox = await ctx.db.get(delivered.mailboxId);
		if (mailbox && !isFromMailboxOwner(delivered, mailbox.address)) {
			if (
				folder.role === 'inbox' &&
				delivered.folderId === folder._id &&
				!delivered.flagSeen &&
				isPersonalMailbox(mailbox)
			) {
				await enqueuePush(ctx, mailbox.userId, { kind: 'mail', messageId });
			}
			await clearThreadFollowUp(ctx, delivered.threadId);
			await clearSnoozeUntilReplyForThread(ctx, delivered.threadId, Date.now());
			if (
				await shouldExtractLiveMessage(ctx, { spamVerdict: delivered.spamVerdict, antiLoopHeaders })
			) {
				await ctx.scheduler.runAfter(0, internal.mail.liveKnowledge.extractLiveMessage, {
					mailMessageId: messageId,
				});
			}
		}
	}

	// A vacation notice or other auto-reply from the owner answers nothing.
	await settleOwnerReply(ctx, messageId, { isAutomated: isAutomatedResponse(antiLoopHeaders) });
}
