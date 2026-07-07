import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { PAGE_SIZE_DEFAULT } from '../lib/constants';

// Get automation runs for analytics with contact details.
// Pagination is index-ordered (desc by creation time); the previous shape
// `.collect()`-ed every matching run, JS-sorted, then sliced — which scaled
// linearly with run count per automation. Indexed `.order('desc').take(N)`
// reads at most `offset + limit + 1` rows.
export const getAutomationRuns = authedQuery({
	args: {
		automationId: v.id('automations'),
		status: v.optional(
			v.union(v.literal('running'), v.literal('completed'), v.literal('cancelled'))
		),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? PAGE_SIZE_DEFAULT;
		const offset = args.offset ?? 0;
		const takeCount = offset + limit + 1;

		const runs = args.status
			? await ctx.db
					.query('automationRuns')
					.withIndex('by_automation_and_status', (q) =>
						q.eq('automationId', args.automationId).eq('status', args.status!)
					)
					.order('desc')
					.take(takeCount)
			: await ctx.db
					.query('automationRuns')
					.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
					.order('desc')
					.take(takeCount);

		const paginatedRuns = runs.slice(offset, offset + limit);
		const hasMore = runs.length > offset + limit;

		const enrichedRuns = await Promise.all(
			paginatedRuns.map(async (run) => {
				const contact = await ctx.db.get(run.contactId);
				return {
					...run,
					contact: contact
						? {
								_id: contact._id,
								email: contact.email,
								firstName: contact.firstName,
								lastName: contact.lastName,
							}
						: null,
				};
			})
		);

		return {
			runs: enrichedRuns,
			hasMore,
		};
	},
});

// Get step-by-step analytics for funnel visualization
export const getStepAnalytics = authedQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		// Get all steps for this automation
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: one automation's steps

		// Read the funnel counts off each step's denormalized per-status counters
		// (maintained by the step-run transition mutations) instead of collecting
		// every run and N+1 collecting each run's step-runs.
		return steps
			.sort((a, b) => a.stepIndex - b.stepIndex)
			.map((step) => {
				const completed = step.statCompleted ?? 0;
				const failed = step.statFailed ?? 0;
				const pending = step.statPending ?? 0;
				const executing = step.statExecuting ?? 0;
				const skipped = step.statSkipped ?? 0;
				return {
					stepId: step._id,
					stepIndex: step.stepIndex,
					stepType: step.stepType,
					config: step.config,
					stats: {
						completed,
						failed,
						pending,
						executing,
						skipped,
						total: completed + failed + pending + executing + skipped,
					},
				};
			});
	},
});

// Get summary statistics for automation
export const getAutomationStats = authedQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const automation = await ctx.db.get(args.automationId);
		if (!automation) return null;

		// Run-level counts from the automation's denormalized stats (maintained by
		// fireTrigger / completeAutomationRun / cancelAutomationRun) — no run scan.
		// Every run is running | completed | cancelled, so cancelled is the
		// remainder of the entered total.
		const totalEntered = automation.statsEntered ?? 0;
		const running = automation.statsActive ?? 0;
		const completed = automation.statsCompleted ?? 0;
		const cancelled = Math.max(0, totalEntered - running - completed);

		// Step-level counts summed from each step's denormalized per-status
		// counters (bounded read of the step rows) — no run × step-run scan.
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: steps per automation

		let totalStepRuns = 0;
		let completedStepRuns = 0;
		let failedStepRuns = 0;
		let emailsSent = 0;
		for (const step of steps) {
			const c = step.statCompleted ?? 0;
			const f = step.statFailed ?? 0;
			totalStepRuns +=
				(step.statPending ?? 0) + (step.statExecuting ?? 0) + c + f + (step.statSkipped ?? 0);
			completedStepRuns += c;
			failedStepRuns += f;
			if (step.stepType === 'email') emailsSent += c; // completed email steps
		}

		// Calculate completion rate
		const completionRate =
			totalEntered > 0 ? ((completed / totalEntered) * 100).toFixed(1) : '0.0';

		return {
			totalEntered,
			running,
			completed,
			cancelled,
			totalStepRuns,
			completedStepRuns,
			failedStepRuns,
			emailsSent,
			completionRate: parseFloat(completionRate),
		};
	},
});
