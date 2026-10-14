/**
 * Bounce obligations (#1346): Team Inbox work a bounced reply reopened, which
 * owes the customer an answer however old it is (`inboundMessages.answerBouncedAt`,
 * set by inbox/answeredThread.ts, read by ./threadClock.ts).
 *
 * The marker is live-only, and two things keep it so:
 *
 *   - It is cleared when the obligation ends: the message moves to a state
 *     that needs no reply (./threadClock.ts), another sent agent reply settles
 *     it (inbox/answeredThread.ts), or any reply reaches the customer on any
 *     channel, email, SMS, chat or a team follow-up (`endBounceObligations`,
 *     from the thread module's `reply_sent`).
 *   - The check (`hasOpenBounceObligation`) also requires the message to still
 *     need a reply and no reply to have reached the customer since the bounce,
 *     judged by the thread's `lastReplySentAt` (every `reply_sent`, complete)
 *     as well as the timeline, so a marker some path left behind cannot reopen
 *     anything, however much came after that reply.
 *
 * Both reads go through `by_thread_and_answer_bounced`, so an obligation is
 * found however many messages came after it.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ProcessingStatus } from '../processingLifecycle/types';

/**
 * How many markers the check reads. Live markers are few by construction: one
 * per message a bounced reply reopened that nobody has dealt with yet, and
 * every path that deals with one clears it. Newest bounces first, and one owed
 * match settles the question.
 */
const BOUNCE_SCAN_LIMIT = 16;

/** The latest moment a reply reached the customer, from both records. */
export function latestReplyAt(
	thread: Pick<Doc<'conversationThreads'>, 'lastReplySentAt'> | null,
	timelineReplyAt: number | undefined
): number | undefined {
	const sentAt = thread?.lastReplySentAt;
	if (sentAt === undefined) return timelineReplyAt;
	return timelineReplyAt === undefined ? sentAt : Math.max(sentAt, timelineReplyAt);
}

/**
 * Is work a bounce reopened still owed on this thread? `isAwaitingReply`: the
 * clock module's own reading of a status. `exceptId`: the message settling
 * right now.
 */
export async function hasOpenBounceObligation(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	repliedAt: number | undefined,
	isAwaitingReply: (status: ProcessingStatus) => boolean,
	exceptId?: Id<'inboundMessages'>
): Promise<boolean> {
	const marked = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread_and_answer_bounced', (q) =>
			q.eq('threadId', threadId).gt('answerBouncedAt', 0)
		)
		.order('desc')
		.take(BOUNCE_SCAN_LIMIT);
	return marked.some(
		(message) =>
			message._id !== exceptId &&
			isAwaitingReply(message.processingStatus) &&
			(repliedAt === undefined || repliedAt < (message.answerBouncedAt ?? 0))
	);
}

/** A reply reached the customer at `at`: every obligation from before it ends. */
export async function endBounceObligations(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	at: number
): Promise<void> {
	const marked = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread_and_answer_bounced', (q) =>
			q.eq('threadId', threadId).gt('answerBouncedAt', 0).lt('answerBouncedAt', at)
		)
		.collect(); // bounded: a thread's live bounce markers (see the header)
	for (const message of marked) await ctx.db.patch(message._id, { answerBouncedAt: undefined });
}
