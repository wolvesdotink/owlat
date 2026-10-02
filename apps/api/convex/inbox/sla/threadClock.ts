/**
 * Where the response clock (`./clock.ts`) meets the thread writers outside the
 * thread module (which moves it inside its own transitions):
 *
 *   - `snoozeClockPatch`: snooze, unsnooze and the wake sweep (`inbox/snooze.ts`).
 *   - `settleClockForMessage`: the processing lifecycle, when a message is
 *     answered, turns out to need no reply, or is released from quarantine.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { transition as threadTransition } from '../threads/module';
import type { ProcessingStatus, TransitionInput } from '../processingLifecycle/types';
import { loadSlaPolicy } from './policy';
import { pauseClock, resumeClock, startClock, stopClock, type ClockPatch } from './clock';

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

/** How many of a thread's messages the no-reply check reads. */
const MESSAGE_SCAN_LIMIT = 200;

/**
 * Move the clock for a processing-lifecycle edge of one inbound message:
 *   - `sent`: the reply reached the customer;
 *   - a no-reply state: stop the clock when nothing since it started still
 *     needs an answer;
 *   - released from quarantine: the message needs an answer after all, so a
 *     clock starts from its arrival when none is running.
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
	if (input.to === 'received' && input.source === 'release_quarantine') {
		const thread = await ctx.db.get(threadId);
		if (!thread || thread.status !== 'open') return;
		const patch = startClock(thread, message.receivedAt, await loadSlaPolicy(ctx));
		if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
	}
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
		(m) =>
			m._id !== settledId &&
			m.receivedAt >= startedAt &&
			!NO_REPLY_STATES.has(m.processingStatus) &&
			m.processingStatus !== 'sent'
	);
	if (stillOwed) return;
	const patch = stopClock(thread, Date.now());
	if (Object.keys(patch).length > 0) await ctx.db.patch(threadId, patch);
}
