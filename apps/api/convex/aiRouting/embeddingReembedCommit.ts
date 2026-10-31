/**
 * The commits of the re-embed actions (`embeddingReembed.ts`): each action
 * reads, makes its embedding calls, then writes what it decided in one of
 * these, which re-check the state those calls ran against. Kept apart from
 * `embeddingReembedJobs.ts` for the ~500 LOC ratchet.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { ensureConfiguredSpace } from '../lib/aiRouting/embeddingActivation';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { startLocalReembedJob } from './embeddingReembedJobs';

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
