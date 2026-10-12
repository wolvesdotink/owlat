/**
 * The cheap checks the Reply Queue classifier asks before it spends
 * (`needsReplyClassify.ts`, split out at the file-size cap): the screener
 * before clarification (L3), lazy interpretation for a delivered message that
 * is no reply candidate (D10), and the continuation while a candidate's
 * earlier deferred mail is still being read (D10). The first two fail open to
 * today's behaviour.
 */

import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import type { LatestInbound } from '../interpret/needsReplyProjection';
import { PREDECESSORS_PENDING } from '../interpret/defer';

/**
 * D10: defer a delivered non-candidate's interpretation when the reader
 * display is its only consumer (`mail/interpret/defer.ts`). Fail-open: a
 * failed check interprets as before.
 */
export async function isDeferredUntilOpen(
	ctx: ActionCtx,
	mailMessageId: Id<'mailMessages'>
): Promise<boolean> {
	try {
		return await ctx.runMutation(internal.mail.interpret.defer.deferDeliveredIfDisplayOnly, {
			mailMessageId,
		});
	} catch {
		return false;
	}
}

/**
 * Whether the first-time-sender screener holds the latest inbound sender out
 * of the queue. Fail-open: a failed read clarifies as before.
 */
export async function isHeldOutByScreener(
	ctx: ActionCtx,
	args: { threadId: Id<'mailThreads'>; latestInbound: LatestInbound }
): Promise<boolean> {
	try {
		return await ctx.runQuery(internal.mail.ai.needsReplyScoring.isHeldOutBeforeClarification, {
			threadId: args.threadId,
			messageId: args.latestInbound.messageId,
		});
	} catch {
		return false;
	}
}

/**
 * D10 (Sol r4 F1): the candidate's interpretation did not run yet, because
 * its thread's earlier deferred mail is still being read (`defer.ts`; the run
 * was told the caller continues itself). The CLASSIFICATION continues at the
 * loop's `retryAt`, with the same arguments, so the model's verdict, the
 * clarification and draft-on-arrival still follow; its interpretation reuses
 * the stored result once the loop has drained. The thread stays pending
 * (the baseline just re-stamped it), so the reconcile sweep also covers a
 * continuation that is lost. True when it continues later.
 */
export async function continuesLater(
	ctx: Pick<ActionCtx, 'scheduler'>,
	run: { status: string; errorCode?: string; retryAt?: number },
	args: ClassifyArgs
): Promise<boolean> {
	if (run.status !== 'skipped' || run.errorCode !== PREDECESSORS_PENDING) return false;
	const delayMs = Math.max(0, (run.retryAt ?? Date.now()) - Date.now());
	await ctx.scheduler.runAfter(delayMs, internal.mail.ai.needsReplyClassify.classifyThread, args);
	return true;
}

/** `classifyThread`'s arguments, passed on unchanged. */
type ClassifyArgs = {
	threadId: Id<'mailThreads'>;
	precedence?: string;
	autoSubmitted?: string;
	listId?: string;
	interpretMessageId?: Id<'mailMessages'>;
};
