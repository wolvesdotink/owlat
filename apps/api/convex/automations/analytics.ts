import { v } from 'convex/values';
import { automationsQuery } from './_helpers';
import { PAGE_SIZE_DEFAULT } from '../lib/constants';
import { loadOrderedSteps } from './steps';
import { getLive } from '../lib/softDelete';
import { getLiveContact } from '../lib/contactHelpers';
import {
	automationRunEndReasonValidator,
	type AutomationStepFailureReason,
	type AutomationStepWaitReason,
} from '../lib/validators/automations';
import { healthWindowStart } from './health';
import { newestWaitingStepRuns } from './waitingRuns';
import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

// Runs, steps and counters of a deleted automation stay until the purge, but
// it reads as missing: every query here answers as for an unknown id.

/** Why a run a failed step ended failed: the coded reason and the stored sentence. */
export type AutomationRunFailure = {
	reason: AutomationStepFailureReason;
	detail: string | null;
};

/** What a running run's email step waits for, and when the wait gives up. */
export type AutomationRunWait = {
	reason: AutomationStepWaitReason;
	detail: string | null;
	until: number;
};

const newestStepRunOf = (db: DatabaseReader, run: Doc<'automationRuns'>) =>
	db
		.query('automationStepRuns')
		.withIndex('by_automation_run', (q) => q.eq('automationRunId', run._id))
		.order('desc')
		.first();

/**
 * Why a run is not moving on: `failure` for a run a failed step ended, `waiting`
 * for a running run whose step waits for the sending setup to be fixed, null
 * otherwise. A failed step run without a code (written before codes existed)
 * reads as `unknown`, with its sentence as the detail.
 */
async function runNotesOf(
	db: DatabaseReader,
	run: Doc<'automationRuns'>
): Promise<{ failure: AutomationRunFailure | null; waiting: AutomationRunWait | null }> {
	if (run.endReason === 'step_failed') {
		// The failed step run is the run's newest: failing it cancels the run in
		// the same transaction, so nothing is written after it.
		const newest = await newestStepRunOf(db, run);
		const failed = newest?.status === 'failed' ? newest : null;
		return {
			failure: {
				reason: failed?.failureReason ?? 'unknown',
				detail: failed?.errorMessage ?? null,
			},
			waiting: null,
		};
	}
	if (run.status !== 'running') return { failure: null, waiting: null };
	// A run's only non-terminal step run is its newest.
	const newest = await newestStepRunOf(db, run);
	const waiting =
		newest?.status === 'pending' && newest.waitingFor && newest.waitingUntil !== undefined
			? {
					reason: newest.waitingFor,
					detail: newest.errorMessage ?? null,
					until: newest.waitingUntil,
				}
			: null;
	return { failure: null, waiting };
}

/** The running runs behind the newest `take` waiting step runs, in that order. */
async function waitingRunsOf(
	db: DatabaseReader,
	automationId: Doc<'automations'>['_id'],
	take: number
): Promise<Doc<'automationRuns'>[]> {
	const stepRuns = await newestWaitingStepRuns(db, automationId, take);
	const runs = await Promise.all(stepRuns.map((stepRun) => db.get(stepRun.automationRunId)));
	return runs.filter((run): run is Doc<'automationRuns'> => run?.status === 'running');
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
// `status` (every such run is cancelled). `waiting` narrows to the running runs
// whose email step waits for the sending setup now (automations/waitingRuns.ts),
// newest wait first; it takes precedence over both.
//
// all-members: run history is part of the automation page every member may
// read; the joined contact is the display projection (id, email, name) already
// member-visible on the contact list. Runs outlive a contact's soft delete for
// the retention window, so a missing or soft-deleted contact joins as `null`.
// A run a failed step ended also joins `failure`, the coded reason and the
// stored sentence (null on every other run); the sentence is the walker's own
// text or a plugin's reason, already clamped and stripped at the plugin seam.
// A running run whose email step waits for the sending setup joins `waiting`,
// the same pair plus when the wait gives up (null on every other run).
export const getAutomationRuns = automationsQuery({
	args: {
		automationId: v.id('automations'),
		status: v.optional(
			v.union(v.literal('running'), v.literal('completed'), v.literal('cancelled'))
		),
		endReason: v.optional(automationRunEndReasonValidator),
		waiting: v.optional(v.boolean()),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await getLive(ctx, args.automationId))) return { runs: [], hasMore: false };

		const limit = args.limit ?? PAGE_SIZE_DEFAULT;
		const offset = args.offset ?? 0;
		const takeCount = offset + limit + 1;
		const endReason = args.endReason;

		const runs = args.waiting
			? await waitingRunsOf(ctx.db, args.automationId, takeCount)
			: endReason
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
				const [contact, notes] = await Promise.all([
					getLiveContact(ctx, run.contactId),
					runNotesOf(ctx.db, run),
				]);
				return {
					...run,
					...notes,
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
