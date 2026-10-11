/**
 * The scheduled side of the thread brief purge jobs (`purgeRun.ts`):
 *
 *  - `continueJob`: one slice of a purge or scope-change job, then itself
 *    again until every range of the job is exhausted;
 *  - `invalidateMailboxThreads`: a mailbox scope change, a page of threads
 *    at a time.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { interpretModeValidator } from '../../lib/validators/threadBrief';
import { unitBudget } from './purgeDrain';
import {
	CONTINUATION_BYTES,
	CONTINUATION_UNITS,
	invalidateMailboxThreadsPage,
	runPurgeJob,
} from './purgeRun';

export const continueJob = internalMutation({
	args: { jobId: v.id('threadPurgeJobs') },
	handler: async (ctx, args): Promise<{ isDone: boolean }> => {
		const isDone = await runPurgeJob(
			ctx,
			args.jobId,
			unitBudget(CONTINUATION_UNITS, CONTINUATION_BYTES)
		);
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.continueJob, args);
		}
		return { isDone };
	},
});

export const invalidateMailboxThreads = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		mode: interpretModeValidator,
		cursor: v.union(v.string(), v.null()),
	},
	handler: (ctx, args): Promise<{ isDone: boolean; threads: number }> =>
		invalidateMailboxThreadsPage(ctx, args),
});
