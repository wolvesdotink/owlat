/**
 * The shadow allowance's message share, enforced: at most
 * `shadowMaxMessageFraction` of a task's eligible messages are shadowed per
 * UTC day, counted, not sampled.
 *
 * Every eligible message of a shadowed task asks {@link claimShadowSlot} once
 * a day. The mutation counts it as eligible and admits it only while
 * admitted + 1 ≤ floor(share × eligible), and only if the hash sample chose it
 * as a candidate (`lib/aiRouting/shadowSampling.ts`, which spreads the share
 * over the day instead of spending it on the first messages). Counting and
 * the answer happen in one mutation, so concurrent messages serialize on the
 * day's row. Asking again for the same message returns its first answer and
 * counts nothing.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { utcDayKey } from '../lib/clock';
import { aiTaskNameValidator } from '../lib/validators/aiRouting';
import { loadRoutingPolicy } from './policy';

export const claimShadowSlot = internalMutation({
	args: {
		task: aiTaskNameValidator,
		/** The message the judgment is about (its id). */
		subjectKey: v.string(),
		/** The hash sample chose this message. */
		isCandidate: v.boolean(),
	},
	returns: v.object({ isAdmitted: v.boolean() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const dayKey = utcDayKey(now);
		const answered = await ctx.db
			.query('shadowQuotaEntries')
			.withIndex('by_task_and_subject', (q) =>
				q.eq('task', args.task).eq('subjectKey', args.subjectKey).eq('dayKey', dayKey)
			)
			.first();
		if (answered) return { isAdmitted: answered.isAdmitted };

		const policy = await loadRoutingPolicy(ctx);
		const day = await ctx.db
			.query('shadowQuotaDays')
			.withIndex('by_task_and_day', (q) => q.eq('task', args.task).eq('dayKey', dayKey))
			.unique();
		const eligibleCount = (day?.eligibleCount ?? 0) + 1;
		const admittedSoFar = day?.admittedCount ?? 0;
		const isAdmitted =
			args.isCandidate &&
			admittedSoFar + 1 <= Math.floor(policy.shadowMaxMessageFraction * eligibleCount);
		const admittedCount = admittedSoFar + (isAdmitted ? 1 : 0);
		if (day) {
			await ctx.db.patch(day._id, { eligibleCount, admittedCount, updatedAt: now });
		} else {
			await ctx.db.insert('shadowQuotaDays', {
				task: args.task,
				dayKey,
				eligibleCount,
				admittedCount,
				updatedAt: now,
			});
		}
		await ctx.db.insert('shadowQuotaEntries', {
			task: args.task,
			dayKey,
			subjectKey: args.subjectKey,
			isAdmitted,
			createdAt: now,
		});
		return { isAdmitted };
	},
});
