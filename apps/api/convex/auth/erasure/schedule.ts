/**
 * Scheduling a member erasure's next step (`walker.ts` `drive`), shared by the
 * walker's own continuation and by `lifecycle.ts` (start, re-arm, restart).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { randomToken } from '../../lib/randomToken';

/**
 * Hand the job to a new chain: a fresh lease on the row, and a drive holding
 * it. Any chain still holding the previous lease stops at its next step.
 */
export async function scheduleDrive(
	ctx: MutationCtx,
	jobId: Id<'memberErasureJobs'>,
	delayMs = 0
): Promise<void> {
	const lease = randomToken(16);
	await ctx.db.patch(jobId, { lease });
	await ctx.scheduler.runAfter(delayMs, internal.auth.erasure.walker.drive, { jobId, lease });
}
