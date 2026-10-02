/**
 * Bring existing threads in line when response targets are switched on or off.
 *
 * ON: every open thread that is waiting on the team gets a clock that starts
 * NOW, not at its last message. A backlog that predates the policy would
 * otherwise turn overdue at once and flood the team with breach notices; the
 * "Waiting > 24h" view already shows how old it is. A snoozed thread gets a
 * paused clock that starts when it wakes.
 *
 * OFF: every running clock is cleared, unjudged. Paused clocks are left: they
 * clear themselves when they would resume (`clock.ts` `resumeClock`).
 *
 * One page per mutation, chained. `generation` is the policy's `updatedAt` at
 * the save that scheduled the sweep: a later save supersedes the chain, so an
 * off-on-off flurry never leaves two sweeps fighting.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import { readSlaPolicyRow } from './policy';
import { slaPolicyView } from './policyRules';
import { isClockSet, startClock } from './clock';

const PAGE_SIZE = 100;

export const applyPage = internalMutation({
	args: {
		generation: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args): Promise<{ changed: number; isDone: boolean }> => {
		const row = await readSlaPolicyRow(ctx);
		if (!row || row.updatedAt !== args.generation) return { changed: 0, isDone: true };
		const policy = slaPolicyView(row);
		const now = Date.now();
		let changed = 0;

		if (!policy) {
			// Every page re-reads the head of the range it just emptied.
			const running = await ctx.db
				.query('conversationThreads')
				.withIndex('by_response_due_at', (q) => q.gt('responseDueAt', 0))
				.take(PAGE_SIZE);
			for (const thread of running) {
				await ctx.db.patch(thread._id, {
					responseDueAt: undefined,
					responseDueKind: undefined,
					responseClockStartedAt: undefined,
					slaBreachNotifiedAt: undefined,
				});
				changed++;
			}
			const isDone = running.length < PAGE_SIZE;
			if (!isDone) {
				await ctx.scheduler.runAfter(0, internal.inbox.sla.apply.applyPage, args);
			}
			return { changed, isDone };
		}

		const page = await ctx.db
			.query('conversationThreads')
			.withIndex('by_status_and_last_message_at', (q) => q.eq('status', 'open'))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
		for (const thread of page.page) {
			if (isClockSet(thread)) continue;
			const patch = startClock(thread, now, policy);
			if (patch.responseDueAt === undefined) continue;
			const isSnoozed = thread.snoozedUntil !== undefined && thread.snoozedUntil > now;
			await ctx.db.patch(
				thread._id,
				isSnoozed
					? {
							...patch,
							responseDueAt: undefined,
							responsePausedRemainingMs:
								patch.responseDueKind === 'first' ? policy.firstResponseMs : policy.nextResponseMs,
						}
					: patch
			);
			changed++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.inbox.sla.apply.applyPage, {
				generation: args.generation,
				cursor: page.continueCursor,
			});
		}
		return { changed, isDone: page.isDone };
	},
});
