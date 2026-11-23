import { v } from 'convex/values';
import { automationsQuery } from './_helpers';
import { PAGE_SIZE_DEFAULT } from '../lib/constants';
import { loadOrderedSteps } from './steps';
import { getLive } from '../lib/softDelete';
import { getLiveContact } from '../lib/contactHelpers';
import {
	automationRunEndReasonValidator,
	type AutomationStepFailureReason,
} from '../lib/validators/automations';
import { healthWindowStart } from './health';
import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

// Runs, steps and counters of a deleted automation stay until the purge, but
// it reads as missing: every query here answers as for an unknown id.

/** Why a run a failed step ended failed: the coded reason and the stored sentence. */
export type AutomationRunFailure = {
	reason: AutomationStepFailureReason;
	detail: string | null;
};

/**
 * The failure of a run a failed step ended, or null for any other run. A failed
 * step run without a code (written before codes existed) reads as `unknown`,
 * with its sentence as the detail.
 */
async function runFailureOf(
	db: DatabaseReader,
	run: Doc<'automationRuns'>
): Promise<AutomationRunFailure | null> {
	if (run.endReason !== 'step_failed') return null;
	// The failed step run is the run's newest: failing it cancels the run in the
	// same transaction, so nothing is written after it.
	const newest = await db
		.query('automationStepRuns')
		.withIndex('by_automation_run', (q) => q.eq('automationRunId', run._id))
		.order('desc')
		.first();
	const failed = newest?.status === 'failed' ? newest : null;
	return {
		reason: failed?.failureReason ?? 'unknown',
		detail: failed?.errorMessage ?? null,
	};
}

// Get automation runs for analytics with contact details.
// Pagination is index-ordered (desc by creation time); the previous shape
// `.collect()`-ed every matching run, JS-sorted, then sliced — which scaled
// linearly with run count per automation. Indexed `.order('desc').take(N)`
// reads at most `offset + limit + 1` rows.
//
// `endReason` narrows to the runs behind one of the list's health counts: the
// runs that ended for that reason inside the same last-7-days window
// (automations/health.ts), most recently ended first. It takes precedence over
// `status` (every such run is cancelled).
//
// all-members: run history is part of the automation page every member may
// read; the joined contact is the display projection (id, email, name) already
// member-visible on the contact list. Runs outlive a contact's soft delete for
// the retention window, so a missing or soft-deleted contact joins as `null`.
// A run a failed step ended also joins `failure`, the coded reason and the
// stored sentence (null on every other run); the sentence is the walker's own
// text or a plugin's reason, already clamped and stripped at the plugin seam.
export const getAutomationRuns = automationsQuery({
	args: {
		automationId: v.id('automations'),
		status: v.optional(
			v.union(v.literal('running'), v.literal('completed'), v.literal('cancelled'))
		),
		endReason: v.optional(automationRunEndReasonValidator),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await getLive(ctx, args.automationId))) return { runs: [], hasMore: false };

		const limit = args.limit ?? PAGE_SIZE_DEFAULT;
		const offset = args.offset ?? 0;
		const takeCount = offset + limit + 1;
		const endReason = args.endReason;

		const runs = endReason
			? await ctx.db
					.query('automationRuns')
					.withIndex('by_automation_end_reason_completed', (q) =>
						q
							.eq('automationId', args.automationId)
							.eq('endReason', endReason)
							.gte('completedAt', healthWindowStart(Date.now()))
					)
					.order('desc')
					.take(takeCount)
			: args.status
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
				const [contact, failure] = await Promise.all([
					getLiveContact(ctx, run.contactId),
					runFailureOf(ctx.db, run),
				]);
				return {
					...run,
					failure,
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
// all-members: per-step funnel counts and the step config the read-only
// automation page already shows every member.
export const getStepAnalytics = automationsQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		if (!(await getLive(ctx, args.automationId))) return [];
		const steps = await loadOrderedSteps(ctx.db, args.automationId);

		// Read the funnel counts off each step's denormalized per-status counters
		// (maintained by the step-run transition mutations) instead of collecting
		// every run and N+1 collecting each run's step-runs.
		return steps.map((step) => {
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
// all-members: aggregate counts and rates for the automation page every member may read.
export const getAutomationStats = automationsQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const automation = await getLive(ctx, args.automationId);
		if (!automation) return null;

		// Run-level counts from the automation's denormalized stats (maintained by
		// fireTrigger / completeRun / cancelRun) — no run scan.
		// Every run is running | completed | cancelled, so cancelled is the
		// remainder of the entered total.
		const totalEntered = automation.statsEntered ?? 0;
		const running = automation.statsActive ?? 0;
		const completed = automation.statsCompleted ?? 0;
		const cancelled = Math.max(0, totalEntered - running - completed);

		// Step-level counts summed from each step's denormalized per-status
		// counters (bounded read of the step rows) — no run × step-run scan.
		const steps = await loadOrderedSteps(ctx.db, args.automationId);

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
		const completionRate = totalEntered > 0 ? ((completed / totalEntered) * 100).toFixed(1) : '0.0';

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
