/**
 * The commits of the re-embed actions (`embeddingReembed.ts`): each action
 * reads, makes its embedding calls, then writes what it decided in one of
 * these, which re-check the state those calls ran against. Kept apart from
 * `embeddingReembedJobs.ts` for the ~500 LOC ratchet.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { ensureConfiguredSpace } from '../lib/aiRouting/embeddingActivation';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { REEMBED_PAGE_ATTEMPTS, startLocalReembedJob } from './embeddingReembedJobs';
import { commitReembedPage, pauseRunningJob, reembedPageArgs } from './embeddingReembedPage';

/** Wait before retrying a page whose rows did not all land, per attempt. */
const RETRY_DELAY_MS = 30_000;

/**
 * The kickoff's commit: activate the space the local embedder measured (the
 * embedding switch path) and start or resume its local re-embed. `inactive`
 * when the configuration no longer names the measured space: nothing is
 * written.
 */
export const activateLocalSpace = internalMutation({
	args: { space: measuredEmbeddingSpaceValidator, isForced: v.boolean() },
	handler: async (
		ctx,
		args
	): Promise<'inactive' | Awaited<ReturnType<typeof startLocalReembedJob>>> => {
		const active = await ensureConfiguredSpace(ctx, args.space);
		if (!active) return 'inactive';
		return startLocalReembedJob(ctx, { spaceId: active._id, isForced: args.isForced });
	},
});

/**
 * The batch's commit: the page (`commitReembedPage`), then in the same
 * transaction the next batch, a retry of this page after a backoff, or, once
 * `attempt` reached the last one, the pause that keeps the cursor for a resume
 * (the kickoff, or an admin).
 */
export const commitBatch = internalMutation({
	args: { ...reembedPageArgs, attempt: v.number() },
	handler: async (ctx, { attempt, ...page }): Promise<'continue' | 'retry' | 'paused' | 'stop'> => {
		const commit = await commitReembedPage(ctx, page);
		const job = { jobId: page.jobId, generation: page.generation };
		if (commit.outcome === 'continue') {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.runBatch, job);
		} else if (commit.outcome === 'retry') {
			if (attempt >= REEMBED_PAGE_ATTEMPTS) {
				await pauseRunningJob(ctx, {
					...job,
					reason: 'provider_unavailable',
					lastError: `${commit.unresolved} item(s) could not be embedded after ${attempt} attempts.`,
				});
				return 'paused';
			}
			await ctx.scheduler.runAfter(
				RETRY_DELAY_MS * attempt,
				internal.aiRouting.embeddingReembed.runBatch,
				{ ...job, attempt: attempt + 1 }
			);
		}
		return commit.outcome;
	},
});
