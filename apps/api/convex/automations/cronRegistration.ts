import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';

type Crons = ReturnType<typeof cronJobs>;

/**
 * Automation crons, beside the functions they schedule. The first three moved
 * here unchanged from `convex/crons.ts` (same names, cadences and arguments)
 * when the health-bucket prune would have pushed that file past the 500-LOC cap.
 */
export function registerAutomationCrons(crons: Crons): void {
	// Roll sharded automation run counters (automationStatShards) into
	// automations.stats* (deriving statsActive) so the read cache stays fresh as
	// contacts enter and runs complete.
	crons.interval(
		'rollup automation stats',
		{ minutes: 1 },
		internal.automations.statShards.rollupAutomationStats,
		{}
	);

	// Process pending automation delays every 5 minutes
	// Catches delay steps that may have been missed due to system issues
	crons.interval(
		'process pending delays',
		{ minutes: 5 },
		internal.automations.stepWalker.processPendingDelays
	);

	// Recover automation runs left `running` with no active step run (a step walker
	// action that died between two of its calls). Pages through every running run,
	// so it runs a few times a day rather than every few minutes; see
	// automations/stalledRuns.ts.
	crons.interval(
		'recover stalled automation runs',
		{ hours: 6 },
		internal.automations.stalledRuns.sweepStalledRuns,
		{}
	);

	// Drop automation health buckets past the list's 7-day window (a page per
	// run, continuing itself); see automations/health.ts.
	crons.interval(
		'prune automation health buckets',
		{ hours: 24 },
		internal.automations.health.pruneHealthDays,
		{}
	);
}
