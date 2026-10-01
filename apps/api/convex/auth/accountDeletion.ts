import { internalMutation } from '../lib/writeFence';
import { deleteAccountForRequest } from './accountManagement';
import { restartStalledMemberErasures } from './erasure/lifecycle';

// Process pending account deletions past their 30-day grace period.
// Starts the full deletion (org tenant data for an owner, BetterAuth
// org/memberships, onboarding, user profile) via the shared helper and hands
// the rest to the persisted member erasure (auth/erasure/), which marks the
// request completed once it has verified the result. Also restarts erasures
// that stopped moving and re-arms failed ones, once a day.
export const processPendingDeletions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();

		// Find all pending deletion requests that are past their scheduled deletion date
		const pendingRequests = await ctx.db
			.query('accountDeletionRequests')
			.withIndex('by_status', (q) => q.eq('status', 'pending'))
			.collect(); // bounded: pending deletion requests (few)

		let processedCount = 0;
		let failedCount = 0;

		for (const request of pendingRequests) {
			if (request.scheduledForDeletion <= now) {
				const outcome = await deleteAccountForRequest(ctx, request);
				if (outcome === 'failed') failedCount++;
				processedCount++;
			}
		}

		// After the starts above, so a job started in this run is never stale.
		const restartedCount = await restartStalledMemberErasures(ctx);

		return { processedCount, failedCount, restartedCount };
	},
});
