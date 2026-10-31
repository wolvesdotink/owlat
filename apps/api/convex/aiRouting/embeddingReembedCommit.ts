/**
 * The commits of the re-embed actions (`embeddingReembed.ts`): each action
 * reads, makes its embedding calls, then writes what it decided in one of
 * these, which re-check the state those calls ran against. Kept apart from
 * `embeddingReembedJobs.ts` for the ~500 LOC ratchet.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import type { Id } from '../_generated/dataModel';
import { throwInvalidState } from '../_utils/errors';
import { ensureConfiguredSpace } from '../lib/aiRouting/embeddingActivation';
import { assertExpectedTarget, readConfiguredTarget } from '../lib/aiRouting/embeddingRegistry';
import { embeddingTargetKey } from '../lib/embeddingSpace';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import {
	REEMBED_PAGE_ATTEMPTS,
	startAdminReembedJob,
	startLocalReembedJob,
} from './embeddingReembedJobs';
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
 * The admin start's commit. With `space` (the bootstrap: no space was
 * searchable, and the action measured the configured one), it first activates
 * that space, only while the configuration still names the confirmed target;
 * then it starts the job. One transaction: a refused start activates nothing.
 */
export const startReembedCommit = internalMutation({
	args: {
		expectedSpaceId: v.optional(v.id('embeddingSpaces')),
		expectedTargetKey: v.optional(v.string()),
		space: v.optional(measuredEmbeddingSpaceValidator),
	},
	handler: async (ctx, { space, ...expected }): Promise<Id<'embeddingReembedJobs'>> => {
		if (space) {
			if (expected.expectedTargetKey !== undefined) {
				const target = await readConfiguredTarget(ctx.db);
				assertExpectedTarget(
					target ? embeddingTargetKey(target) : null,
					expected.expectedTargetKey
				);
			}
			const active = await ensureConfiguredSpace(ctx, space);
			if (!active) throwInvalidState('The embedding configuration changed. Try again.');
		}
		return startAdminReembedJob(ctx, expected);
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
