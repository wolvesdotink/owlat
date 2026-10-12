/**
 * The two cheap checks the Reply Queue classifier asks before it spends
 * (`needsReplyClassify.ts`, split out at the file-size cap): the screener
 * before clarification (L3), and lazy interpretation for a delivered message
 * that is no reply candidate (D10). Both fail open to today's behaviour.
 */

import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import type { LatestInbound } from '../interpret/needsReplyProjection';

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
