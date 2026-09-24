import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

// ============== Internal Queries ==============

// Get email template for step execution
export const getEmailTemplateForStep = internalQuery({
	args: {
		templateId: v.id('emailTemplates'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.templateId);
	},
});

// Get instance settings for sender information
export const getInstanceSettings = internalQuery({
	args: {},
	handler: async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		return settings;
	},
});

/** Per-tick cap for the pending-delay recovery sweep. */
export const PENDING_DELAY_BATCH = 200;

// Get pending delay step runs that are ready to execute. Capped per tick so a
// large coming-due cohort (thousands of contacts on the same "wait N days" step
// all maturing at once while the scheduler is backed up) can't blow the read /
// single-transaction fan-out budget; the walker reschedules itself to drain the
// rest, and the claimStepRun CAS makes the re-fire idempotent.
export const getPendingDelayStepRuns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const pendingRuns = await ctx.db
			.query('automationStepRuns')
			.withIndex('by_status_and_delay_until', (q) =>
				q.eq('status', 'pending').lte('delayUntil', now)
			)
			.take(PENDING_DELAY_BATCH);

		return pendingRuns;
	},
});
