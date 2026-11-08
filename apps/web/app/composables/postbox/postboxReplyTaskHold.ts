import type { ComposerSentOutcome } from './usePostboxComposerSendGate';
import { isQueuedSendToken } from './usePostboxOfflineOutbox';
import { holdMailReplyOffer } from '~/composables/useReplyTaskOffer';

/**
 * A Postbox reply the composer reports sent: watch it until the server
 * confirms it went out, then offer to finish its conversation's open tasks.
 * A forward starts another conversation, so it is not held.
 */
export function holdPostboxReplyOffer(
	outcome: ComposerSentOutcome,
	reply: {
		kind: string | null;
		draftId: string | null;
		message: { _id: string; threadId?: string | null } | undefined;
	}
): void {
	if (reply.kind === 'forward' || !reply.message) return;
	const queuedOffline = !!outcome.receipt && isQueuedSendToken(outcome.receipt.undoToken);
	holdMailReplyOffer(
		{ scheduled: outcome.scheduled, queuedOffline },
		{
			draftId: reply.draftId,
			threadMessageId: reply.message._id,
			mailThreadId: reply.message.threadId,
		}
	);
}
