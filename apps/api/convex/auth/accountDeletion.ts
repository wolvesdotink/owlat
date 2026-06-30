import { internalMutation } from '../_generated/server';
import { deleteAccountForRequest } from './accountManagement';

// Process pending account deletions past their 30-day grace period.
// Runs the full deletion cascade (org tenant data, BetterAuth org/memberships,
// onboarding, user profile) via the shared helper — previously this only
// deleted the user profile and orphaned every other tenant row.
export const processPendingDeletions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();

		// Find all pending deletion requests that are past their scheduled deletion date
		const pendingRequests = await ctx.db
			.query('accountDeletionRequests')
			.withIndex('by_status', (q) => q.eq('status', 'pending'))
			.collect();

		let processedCount = 0;

		for (const request of pendingRequests) {
			if (request.scheduledForDeletion <= now) {
				await deleteAccountForRequest(ctx, request);
				processedCount++;
			}
		}

		return { processedCount };
	},
});
