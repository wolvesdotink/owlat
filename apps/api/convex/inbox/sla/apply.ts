/**
 * Bring existing threads in line when response targets are switched on or off.
 *
 * ON: every open thread whose customer still waits on an answer (its newest
 * message neither answered nor set aside, `./threadClock.ts` `isReplyOwed`)
 * gets a clock that starts NOW, not at its last message. A backlog that
 * predates the policy would otherwise turn overdue at once and flood the team
 * with breach notices; the "Waiting > 24h" view already shows how old it is.
 * A thread the team already answered gets none: nothing is owed until the
 * customer writes again. A snoozed thread gets a paused clock that starts when
 * it wakes. Re-running ON is harmless: a thread with a clock is skipped.
 *
 * OFF: every running clock is cleared, unjudged. Paused clocks are left: they
 * clear themselves when they would resume (`clock.ts` `resumeClock`).
 *
 * One page per mutation, chained. `generation` is the policy's `updatedAt` at
 * the save that scheduled the sweep. Every save schedules a sweep and
 * supersedes the chain before it, so an off-on-off flurry never leaves two
 * sweeps fighting, and a second save while an ON sweep is still walking does
 * not leave the rest of the inbox without clocks.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import { readSlaPolicyRow } from './policy';
import { slaPolicyView } from './policyRules';
import { isClockSet, startClockOnThread } from './clock';
import { isReplyOwed } from './threadClock';

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
			if (isClockSet(thread) || !(await isReplyOwed(ctx, thread._id))) continue;
			const patch = startClockOnThread(thread, now, now, policy);
			if (patch.responseDueKind === undefined) continue;
			await ctx.db.patch(thread._id, patch);
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
