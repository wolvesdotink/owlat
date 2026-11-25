/**
 * Seed loader: automation runs in the states the runs panel and the
 * automations list report — a run whose email step failed and a run whose
 * email step is waiting for the sending setup.
 *
 * A run is entered the way the trigger fanout enters one (`automations/triggers.ts`:
 * the run row, the `entered` stat shard and health bucket), and its first step
 * is moved by the walker's own transitions: `insertStepRun`, the claim's move
 * to `executing`, then `waitForConfiguration` or `failStepAndCancelRun`. So the
 * step counters, the run's `endReason`, the cancelled stat and the `failed`
 * health bucket agree with the rows exactly as they would after a real run.
 * What is skipped is the step action itself (the intake), which would try to
 * send.
 *
 * A waiting step is live: the re-check cron runs it again every few minutes,
 * and on a stack with no delivery provider it waits again, which is the state
 * the fixture claims. Its wait gives up a day after seeding, like any other.
 *
 * DEV ONLY (not in `SAMPLE_DATA_MODULES`): a waiting step on a real install
 * would send a demo email the moment the operator's sending setup works.
 * Runs carry no `seedTag`; `?reset=true` removes them with their seeded
 * automation (`seedDemo/index.ts`).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type {
	AutomationStepFailureReason,
	AutomationStepWaitReason,
} from '../../lib/validators/automations';
import { bumpAutomationStats, rollupAutomationStatsRow } from '../../automations/statShards';
import { recordAutomationHealth } from '../../automations/health';
import {
	failStepAndCancelRun,
	insertStepRun,
	transitionStepRun,
} from '../../automations/stepRunTransitions';
import { waitForConfiguration } from '../../automations/configurationWait';
import { STEP_LEASE_MS } from '../../automations/stepOrchestration';
import type { LoadResult, Loader, LoaderOptions, SeedRefs } from './types';

type AutomationRunFixture = {
	slug: string;
	automation: string;
	contact: string;
	/** How long before seeding the contact entered the automation. */
	startedMinutesAgo: number;
	errorMessage: string;
} & (
	| { outcome: 'failed'; failureReason: AutomationStepFailureReason }
	| { outcome: 'waiting'; waitingFor: AutomationStepWaitReason }
);

const MINUTE_MS = 60_000;

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
	refs: SeedRefs,
	options: LoaderOptions
): Promise<LoadResult> {
	const records = rawRecords as AutomationRunFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'automationRuns'>> = {};
	if (options.inert) return { inserted, skipped: records.length, ids };

	const now = Date.now();
	const touched = new Set<Id<'automations'>>();

	for (const rec of records) {
		const automationId = refs['automations']?.[rec.automation] as Id<'automations'> | undefined;
		const contactId = refs['contacts']?.[rec.contact] as Id<'contacts'> | undefined;
		const automation = automationId ? await ctx.db.get(automationId) : null;
		if (!automation || !contactId) {
			skipped++;
			continue;
		}

		// One seeded run per (automation, contact): any run of the pair, in any
		// state, means this fixture is already loaded.
		const existing = await ctx.db
			.query('automationRuns')
			.withIndex('by_automation_and_contact', (q) =>
				q.eq('automationId', automation._id).eq('contactId', contactId)
			)
			.first();
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}

		const firstStep = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation_and_index', (q) =>
				q.eq('automationId', automation._id).eq('stepIndex', 0)
			)
			.first();
		if (!firstStep) {
			skipped++;
			continue;
		}

		const startedAt = now - rec.startedMinutesAgo * MINUTE_MS;
		const runId = await ctx.db.insert('automationRuns', {
			automationId: automation._id,
			contactId,
			currentStepIndex: 0,
			stepsExecuted: 1,
			status: 'running',
			startedAt,
			triggeredBy: automation.triggerType,
		});
		await bumpAutomationStats(ctx, automation._id, { statsEntered: 1 });
		await recordAutomationHealth(ctx, automation._id, 'entered', startedAt);

		const stepRunId = await insertStepRun(ctx, {
			automationRunId: runId,
			step: firstStep,
			delayUntil: undefined,
		});
		await transitionStepRun(ctx, (await ctx.db.get(stepRunId))!, 'executing', {
			startedAt,
			retryCount: 0,
			leaseExpiresAt: now + STEP_LEASE_MS,
		});
		const executing = (await ctx.db.get(stepRunId))!;

		if (rec.outcome === 'waiting') {
			await waitForConfiguration(ctx, executing, rec.waitingFor, rec.errorMessage);
		} else {
			await failStepAndCancelRun(ctx, executing, rec.errorMessage, {
				countRunFailure: true,
				stepFault: true,
				failureReason: rec.failureReason,
			});
		}

		touched.add(automation._id);
		ids[rec.slug] = runId;
		inserted++;
	}

	// The rollup cron would fold the new shards into the list's totals within a
	// minute; doing it here lets the first page load show them.
	for (const automationId of touched) {
		const automation = await ctx.db.get(automationId);
		if (automation) await rollupAutomationStatsRow(ctx, automation);
	}

	return { inserted, skipped, ids };
}

export const automationRunsLoader: Loader = {
	module: 'automationRuns',
	dependencies: ['automations', 'contacts'],
	load,
};
