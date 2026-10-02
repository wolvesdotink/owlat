/**
 * Where the response clock (`./clock.ts`) meets the thread writers outside the
 * thread module (which moves it inside its own transitions):
 *
 *   - `snoozeClockPatch`: snooze, unsnooze and the wake sweep (`inbox/snooze.ts`).
 *   - `settleClockForMessage`: the processing lifecycle, when a message is
 *     answered, turns out to need no reply, or needs one after all.
 *   - `isReplyOwed`: the switch-on sweep (`./apply.ts`), which starts clocks
 *     only where the customer still waits on an answer.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { transition as threadTransition } from '../threads/module';
import type { ProcessingStatus, TransitionInput } from '../processingLifecycle/types';
import { loadSlaPolicy } from './policy';
import { pauseClock, resumeClock, startClockOnThread, stopClock, type ClockPatch } from './clock';

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

/** How many of a thread's messages the no-reply check reads. */
const MESSAGE_SCAN_LIMIT = 200;

/**
 * Move the clock for a processing-lifecycle edge of one inbound message:
 *   - `sent`: the reply reached the customer;
 *   - a no-reply state: stop the clock when nothing since it started still
 *     needs an answer;
 *   - released from quarantine, or an informational mail a person wants a
 *     draft for: the message needs an answer after all, so a clock starts from
 *     its arrival when none is running.
 */
export async function settleClockForMessage(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	input: TransitionInput
): Promise<void> {
	const threadId = message.threadId;
	if (!threadId) return;
	if (input.to === 'sent') {
		await threadTransition(ctx, { threadId, input: { kind: 'reply_sent', at: input.at } });
		return;
	}
	if (NO_REPLY_STATES.has(input.to)) {
		await stopIfNothingOwed(ctx, threadId, message._id);
		return;
	}
	if (OVERRULED_STATES.has(message.processingStatus) && isAwaitingReply(input.to)) {
		const thread = await ctx.db.get(threadId);
		if (!thread || thread.status !== 'open') return;
		const policy = await loadSlaPolicy(ctx);
		const patch = startClockOnThread(thread, message.receivedAt, Date.now(), policy);
		if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
	}
}

/**
 * Does the customer still wait on an answer? Read off the thread's newest
 * inbound message: answered, or set aside as needing none, means no. A thread
 * without inbound messages (a channel conversation while the agent is off)
 * has nothing to tell, so it counts as waiting, as an open thread does for
 * the list's waiting time (inbox/threadSort.ts).
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
	return newest === null || isAwaitingReply(newest.processingStatus);
}

async function stopIfNothingOwed(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	settledId: Id<'inboundMessages'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	const startedAt = thread?.responseClockStartedAt;
	if (!thread || startedAt === undefined) return;
	const messages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(MESSAGE_SCAN_LIMIT);
	const stillOwed = messages.some(
		(m) => m._id !== settledId && m.receivedAt >= startedAt && isAwaitingReply(m.processingStatus)
	);
	if (stillOwed) return;
	const patch = stopClock(thread, Date.now());
	if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
}
