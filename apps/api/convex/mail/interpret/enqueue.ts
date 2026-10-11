/**
 * Where interpretation is enqueued (SPEC §5 "Postbox" and "Outbound"), in the
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
 *   - {@link enqueueSentInterpretation}: a send we made reached its recipient
 *     (Postbox transport `sent`, team Send finalized). Once per send: the
 *     caller only enqueues when its `reply_sent` activity was new.
 *
 * The mode is the run's to derive (`resolveThreadMode`: shared-scope
 * mailboxes and Team Inbox threads run in `actions` mode), so none is passed.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { isInterpretationEligible } from './eligibility';
import { markBriefPending } from './briefRow';
import { captureInterpretSource } from './sources';
import { markOutstanding } from './outstanding';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import type { OutboundSource } from './sendFailure';

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
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, { source });
	}
	await markBriefPending(ctx, ref);
	return true;
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
