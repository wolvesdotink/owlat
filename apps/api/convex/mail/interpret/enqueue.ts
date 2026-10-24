/**
 * Where interpretation is enqueued ("Outbound"), in the
 * transaction of the event that calls for it, which also marks the thread's
 * brief `pending` until the reducer lands.
 *
 *   - {@link enqueueDeliveredInterpretation}: inbound Postbox delivery
 *     (`deliveryPipeline/afterInsert.ts`). Eligibility is wider than the Reply
 *     Queue's candidates. When delivery scheduled the needs-reply classify for
 *     the message, that run interprets it (`mail/ai/needsReplyClassify.ts`), so
 *     nothing more is scheduled here and the model never reads it twice.
 *     Otherwise live mail that could be eligible is scheduled on its own. The
 *     pre-check is cheap and conservative (folder, mute); the run decides on
 *     the full signals, snapshotted here (`sources.captureInterpretSource`).
 *     A message whose only consumer is the reader display is deferred until
 *     the thread is opened instead (`defer.ts`); the classify run makes
 *     the same call for a delivered message that is no reply candidate.
 *   - {@link enqueueSentInterpretation}: a send we made reached its recipient
 *     (Postbox transport `sent`, team Send finalized). Once per send: the
 *     caller only enqueues when its `reply_sent` activity was new.
 *   - {@link enqueueClientSentInterpretation}: our reply sent from another
 *     client, once its Sent copy is synced or APPENDed.
 *
 * The mode is the run's to derive (`resolveThreadMode`: shared-scope
 * mailboxes and Team Inbox threads run in `actions` mode), so none is passed.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { isInterpretationEligible } from './eligibility';
import { markBriefPending } from './briefRow';
import { captureInterpretSource } from './sources';
import { markOutstanding } from './outstanding';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import type { OutboundSource } from './sendFailure';
import { scheduleArrivalRead } from '../arrival/dispatch';
import { canonicalMessageId } from '../../lib/messageId';

/**
 * The part of eligibility known at delivery: live mail outside spam, trash,
 * drafts and sent, in a thread that is not muted. Bulk mail is left to the run.
 */
async function couldBeEligible(ctx: MutationCtx, message: Doc<'mailMessages'>): Promise<boolean> {
	const [folder, thread] = await Promise.all([
		ctx.db.get(message.folderId),
		ctx.db.get(message.threadId),
	]);
	if (!thread) return false;
	return isInterpretationEligible({
		isLive: true,
		...(folder?.role ? { folder: folder.role } : {}),
		isThreadMuted: thread.mutedAt !== undefined,
		isBulkHeaderPresent: false,
		isSenderKnown: true,
	}).isEligible;
}

/**
 * Interpretation for one delivered Postbox message. Returns whether it was
 * enqueued (here or by the classify run).
 */
export async function enqueueDeliveredInterpretation(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	opts: {
		isLive: boolean;
		/** The needs-reply classify was scheduled with this message to interpret. */
		isInterpretedByClassify: boolean;
		precedence?: string;
		listId?: string;
		/** Delivery queued the category refinement: read on arrival waits for it a little (§2.3.1). */
		isCategoryRefining?: boolean;
	}
): Promise<boolean> {
	if (!opts.isLive) return false;
	const ref: ThreadRef = { kind: 'mail', id: message.threadId };
	const source = { kind: 'mail' as const, id: message._id };
	if (!opts.isInterpretedByClassify && !(await couldBeEligible(ctx, message))) return false;
	// The eligibility snapshot every run and retry decides on (`sources.ts`);
	// the ingest-only headers are known here and nowhere later.
	const captured = await captureInterpretSource(ctx, {
		source,
		isLive: true,
		...(opts.precedence ? { precedence: opts.precedence } : {}),
		...(opts.listId ? { listId: opts.listId } : {}),
	});
	if (!captured) return false;
	if (!opts.isInterpretedByClassify) {
		// No Reply Queue check was queued for it, so the reader display may be
		// its only consumer: it is deferred with read on arrival off, else its run
		// reads it now at the depth it chooses (`mail/arrival/dispatch.ts`).
		if ((await scheduleArrivalRead(ctx, message)) === 'deferred') return true;
	}
	// Read on arrival: the per-message marker the run's depth
	// decision waits on, cleared by this message's category write. Never on a
	// deferred source.
	if (opts.isCategoryRefining) await stampCategoryPending(ctx, captured);
	await markBriefPending(ctx, ref);
	return true;
}

async function stampCategoryPending(ctx: MutationCtx, id: Id<'interpretSources'>): Promise<void> {
	const row = await ctx.db.get(id);
	if (!row || row.isDeferred === true || row.readOutcome !== undefined) return;
	if (row.categoryPendingAt !== undefined) return;
	await ctx.db.patch(id, { categoryPendingAt: Date.now() });
}

/** Interpretation of a message we sent, once it went out (see the module doc). */
export async function enqueueSentInterpretation(
	ctx: MutationCtx,
	source: OutboundSource,
	ref: ThreadRef
): Promise<void> {
	// A team reply's snapshot (its text as queued) was taken at intake
	// (`inbox/replyAttachments.intakeAgentReply`); a Postbox sent message is
	// snapshotted here, as live.
	if (source.kind === 'outboundMail') {
		await captureInterpretSource(ctx, { source, isLive: true });
	} else {
		// The team reply's snapshot exists already; it is outstanding from now on.
		await markOutstanding(ctx, interpretationSourceKey(source));
	}
	await ctx.scheduler.runAfter(0, internal.mail.interpret.outboundRun.interpretSent, { source });
	await markBriefPending(ctx, ref);
}

/**
 * A client files its Sent copy right after sending, or once an offline outbox
 * drains. A copy dated further back is history (a migration, a folder dragged
 * in, an import into the provider's Sent folder that sync sees as new mail),
 * which is never read into the brief message by message.
 */
export const CLIENT_SENT_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Interpretation of our own mail sent from another client, once its Sent copy
 * lands: synced from the provider's Sent folder, or filed by a desktop client
 * through IMAP APPEND. It is read like an Owlat send, so what the reply
 * answered closes on the brief and leaves the Workbench's To do. Without it
 * those items stay open until someone ticks them off by hand.
 *
 * The Sent folder is what makes it ours, as for history
 * (`backfillSources.mailSourceOf`). Skipped:
 *   - an Owlat send (`outbound` set): its transport lifecycle enqueues it once
 *     it went out;
 *   - a copy older than {@link CLIENT_SENT_COPY_MAX_AGE_MS};
 *   - a message the mailbox already holds under the same Message-ID (a client
 *     re-APPENDing, the Sent copy of an Owlat send, our own copy delivered to
 *     the inbox). Interpretation is keyed by row, so a second row would be
 *     read again; the first row was read, or deliberately not.
 * Callers pass live copies only, never an auto-reply. Returns whether it was
 * enqueued.
 */
export async function enqueueClientSentInterpretation(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<boolean> {
	const message = await ctx.db.get(messageId);
	if (!message || message.flagDraft || message.outbound !== undefined) return false;
	if (Date.now() - message.receivedAt > CLIENT_SENT_COPY_MAX_AGE_MS) return false;
	const [folder, thread] = await Promise.all([
		ctx.db.get(message.folderId),
		ctx.db.get(message.threadId),
	]);
	if (folder?.role !== 'sent' || !thread) return false;
	if (thread.mutedAt !== undefined || thread.isSelfDeliveredBrief) return false;
	if (await isHeldElsewhere(ctx, message)) return false;
	await enqueueSentInterpretation(
		ctx,
		{ kind: 'outboundMail', id: message._id },
		{ kind: 'mail', id: thread._id }
	);
	return true;
}

/**
 * Rows sharing one Message-ID read before giving up. Clients re-APPEND a draft
 * on every autosave, and a draft may keep the Message-ID the sent copy gets.
 */
const SAME_MESSAGE_ID_SCAN = 100;

/**
 * Another non-draft row of the mailbox carries the same Message-ID. Drafts are
 * skipped while reading, so retained autosaves cannot hide an earlier copy.
 * Past {@link SAME_MESSAGE_ID_SCAN} rows it answers yes: not reading a copy
 * costs one brief update, reading it twice costs a model call.
 */
async function isHeldElsewhere(ctx: MutationCtx, message: Doc<'mailMessages'>): Promise<boolean> {
	const rfc822MessageId = canonicalMessageId(message.rfc822MessageId);
	let read = 0;
	for await (const row of ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_rfc822_message_id', (q) =>
			q.eq('mailboxId', message.mailboxId).eq('rfc822MessageId', rfc822MessageId)
		)) {
		if (++read > SAME_MESSAGE_ID_SCAN) return true;
		if (row._id !== message._id && !row.flagDraft) return true;
	}
	return false;
}
