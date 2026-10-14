/**
 * Where the response clock (`./clock.ts`) meets the thread writers outside the
 * thread module (which moves it inside its own transitions):
 *
 *   - `snoozeClockPatch`: snooze, unsnooze and the wake sweep (`inbox/snooze.ts`).
 *   - `settleClockForMessage`: the processing lifecycle, when a message is
 *     answered, turns out to need no reply, or needs one after all.
 *   - `releaseClockIfNothingOwed`: a message stored already set aside
 *     (quarantined on arrival), which never passes through the lifecycle.
 *   - `isReplyOwed`: the switch-on sweep (`./apply.ts`), which starts clocks
 *     only where the customer still waits on an answer.
 *
 * "Still owed" means a message in a state that needs an answer that arrived
 * after the team last replied. The last reply is read off the unified timeline
 * (`unifiedMessages`), which records every reply channel, including a person's
 * SMS, WhatsApp or chat reply that leaves the inbound message untouched.
 *
 * One exception, and both checks honour it: a message the reply that answered
 * it bounced back to the team (`answerBouncedAt`, inbox/answeredThread.ts) is
 * owed however old it is and whatever newer message was answered before the
 * bounce. That reply never reached the customer, so an earlier `sent` does not
 * speak for it. The marker is live-only and found through its own index, not
 * the recent-message scan:
 *
 *   - it is cleared when the obligation ends: the message moves to a state
 *     that needs no reply (sent, archived, informational, quarantined; here),
 *     or a later sent reply settles the thread (inbox/answeredThread.ts, even
 *     on a message with a person's draft, whose draft stays as it is);
 *   - and the check itself requires the message to still need a reply and no
 *     reply to have reached the customer since the bounce, so a marker some
 *     other path left behind still cannot reopen anything.
 *
 * Either alone would do; together they keep the index down to live rows and
 * the answer right if one path is ever missed.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { transition as threadTransition } from '../threads/module';
import type { ProcessingStatus, TransitionInput } from '../processingLifecycle/types';
import { loadSlaPolicy } from './policy';
import {
	isClockSet,
	pauseClock,
	resumeClock,
	startClockOnThread,
	stopClock,
	type ClockPatch,
} from './clock';

/**
 * The clock patch for a snooze write: pause on snooze, resume on wake. A
 * thread waiting on the customer stays paused when it wakes.
 */
export async function snoozeClockPatch(
	ctx: MutationCtx,
	thread: Doc<'conversationThreads'>,
	edge: 'snooze' | 'wake',
	now: number
): Promise<ClockPatch> {
	if (edge === 'snooze') return pauseClock(thread, now, await loadSlaPolicy(ctx));
	if (thread.status !== 'open') return {};
	return resumeClock(thread, now, await loadSlaPolicy(ctx));
}

/** A message in one of these states needs no reply from the team. */
const NO_REPLY_STATES: ReadonlySet<ProcessingStatus> = new Set([
	'informational',
	'archived',
	'quarantined',
]);

/**
 * A message leaving one of these states for one that still needs a reply was
 * set aside by the scanner or the classifier and a person overruled it
 * (released from quarantine, or asked for a draft of an informational mail).
 * An archived message reopened by hand is a person replying now; it starts
 * nothing.
 */
const OVERRULED_STATES: ReadonlySet<ProcessingStatus> = new Set(['informational', 'quarantined']);

/** Does a message in this state still wait on the team? */
function isAwaitingReply(status: ProcessingStatus): boolean {
	return !NO_REPLY_STATES.has(status) && status !== 'sent';
}

/**
 * How many bounce markers a check reads. Live markers are few by construction:
 * one per message a bounced reply reopened that nobody has dealt with yet, and
 * every path that deals with it clears the marker. Newest bounces first, and
 * one owed match settles the question.
 */
const BOUNCE_SCAN_LIMIT = 16;

/**
 * Is work a bounce reopened still owed on this thread (see the header)? Read
 * through `by_thread_and_answer_bounced`, so the obligation is found however
 * many messages came after it. `exceptId`: the message settling right now.
 */
async function hasOpenBounceObligation(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	repliedAt: number | undefined,
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

/** How many of a thread's messages the no-reply check reads. */
const MESSAGE_SCAN_LIMIT = 200;
/** How many of a thread's newest timeline rows the last-reply lookup reads. */
const TIMELINE_SCAN_LIMIT = 50;

/** Timeline states of an outbound row that reached the customer. */
const DELIVERED_STATES: ReadonlySet<Doc<'unifiedMessages'>['status']> = new Set([
	'sent',
	'delivered',
	'read',
]);

/**
 * Move the clock for a processing-lifecycle edge of one inbound message:
 *   - `sent`: the reply reached the customer;
 *   - a no-reply state: stop the clock when nothing since it started still
 *     needs an answer;
 *   - released from quarantine, or an informational mail a person wants a
 *     draft for: the message needs an answer after all, so a clock starts from
 *     its arrival when none is running;
 *   - reopened because the reply that answered it bounced (`reopenAnswered`,
 *     inbox/answeredThread.ts): a reply is owed again, so a clock starts from
 *     the bounce when none is running. Not from the message's arrival: that
 *     wait was already judged when the reply went out (`reply_sent` counted
 *     it met or missed), and the bounce can come days later (the MTA retries
 *     for up to four), so restarting from arrival would open an overdue clock
 *     and breach the team for time it could not know about. The bounce is new
 *     information that a reply is owed, like a new customer message, and gets
 *     the same next-response target from the moment it arrives.
 */
export async function settleClockForMessage(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	input: TransitionInput
): Promise<void> {
	const threadId = message.threadId;
	if (!threadId) return;
	// The message needs no reply any more: a bounce obligation on it ends here.
	if (!isAwaitingReply(input.to) && message.answerBouncedAt !== undefined) {
		await ctx.db.patch(message._id, { answerBouncedAt: undefined });
	}
	if (input.to === 'sent') {
		await threadTransition(ctx, { threadId, input: { kind: 'reply_sent', at: input.at } });
		return;
	}
	if (NO_REPLY_STATES.has(input.to)) {
		await releaseClockIfNothingOwed(ctx, threadId, message._id);
		return;
	}
	const isReopenedAnswer =
		(input.to === 'draft_ready' || input.to === 'awaiting_clarification') &&
		input.reopenAnswered === true;
	const isOverruled = OVERRULED_STATES.has(message.processingStatus);
	if ((isOverruled || isReopenedAnswer) && isAwaitingReply(input.to)) {
		const thread = await ctx.db.get(threadId);
		if (!thread || thread.status !== 'open') return;
		const policy = await loadSlaPolicy(ctx);
		// A running or paused clock is never reset (`startClock` keeps it).
		const startAt = isReopenedAnswer ? input.at : message.receivedAt;
		const patch = startClockOnThread(thread, startAt, Date.now(), policy);
		if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
	}
}

/**
 * When the team last replied on this thread: the newest outbound timeline row
 * that reached the customer, or undefined when none is on record.
 */
async function lastReplyAt(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>
): Promise<number | undefined> {
	const rows = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(TIMELINE_SCAN_LIMIT);
	return rows.find((row) => row.direction === 'outbound' && DELIVERED_STATES.has(row.status))
		?.createdAt;
}

/**
 * Does the customer still wait on an answer? Read off the thread's newest
 * inbound message: answered, set aside as needing none, or older than the
 * team's last reply means no, unless a bounce reopened earlier work that still
 * needs a reply (see the header). A thread without inbound messages (a channel
 * conversation while the agent is off) is read off its timeline instead: it
 * waits when the customer wrote last, or when nothing is on record, as an open
 * thread does for the list's waiting time (inbox/threadSort.ts).
 */
export async function isReplyOwed(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>
): Promise<boolean> {
	const newest = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
	if (newest) {
		const repliedAt = await lastReplyAt(ctx, threadId);
		if (isAwaitingReply(newest.processingStatus)) {
			if (repliedAt === undefined || newest.receivedAt > repliedAt) return true;
		}
		return await hasOpenBounceObligation(ctx, threadId, repliedAt);
	}
	const latest = await ctx.db
		.query('unifiedMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
	return latest === null || latest.direction === 'inbound';
}

/**
 * Stop the clock when nothing on the thread still needs an answer, now that
 * `settledId` turned out to need none. Newest first: a message already
 * answered (`sent`) means everything before it was answered too, and a message
 * from before the team's last reply is not owed whatever its state says,
 * except work a bounce reopened (see the header), which is owed wherever it is.
 */
export async function releaseClockIfNothingOwed(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	settledId: Id<'inboundMessages'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread || !isClockSet(thread)) return;
	const repliedAt = await lastReplyAt(ctx, threadId);
	if (await hasOpenBounceObligation(ctx, threadId, repliedAt, settledId)) return;
	const messages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(MESSAGE_SCAN_LIMIT);
	for (const message of messages) {
		if (message._id === settledId) continue;
		if (message.processingStatus === 'sent') break;
		if (repliedAt !== undefined && message.receivedAt <= repliedAt) continue;
		if (isAwaitingReply(message.processingStatus)) return;
	}
	const patch = stopClock(thread, Date.now(), await loadSlaPolicy(ctx));
	if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
}
