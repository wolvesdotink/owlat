/**
 * A run waiting for the category refinement (PR review PR-4 and its review
 * F1). `settleCategory` (`eligibility.ts`) makes a bulk-stranger candidate's
 * run wait while its thread's category is still provisional; the run then
 * calls {@link deferForCategory} to schedule itself at the settle time.
 *
 * The deferral is recorded on the source's snapshot row
 * (`interpretSources.categoryDeferredUntil`) in the same transaction that
 * schedules the job, so a repeated or concurrent call for the same source and
 * deadline is a no-op: one deferred job per source, never two runs racing
 * past the extraction dedupe. The source stays outstanding meanwhile (no
 * outcome was recorded), which is what it is.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';
import { loadInterpretSource } from './sources';

export const deferForCategory = internalMutation({
	args: { source: interpretationSourceValidator, until: v.number() },
	handler: async (ctx, args): Promise<{ isScheduled: boolean }> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row) return { isScheduled: false };
		// Already waiting for this (or a later) deadline: the scheduled run covers it.
		if (row.categoryDeferredUntil !== undefined && row.categoryDeferredUntil >= args.until) {
			return { isScheduled: false };
		}
		await ctx.db.patch(row._id, { categoryDeferredUntil: args.until, updatedAt: Date.now() });
		await ctx.scheduler.runAt(args.until, internal.mail.interpret.run.interpretMessage, {
			source: args.source,
		});
		return { isScheduled: true };
	},
});
