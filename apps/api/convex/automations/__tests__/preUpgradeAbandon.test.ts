/**
 * Work v0.5.5 left stuck is resumed only while it is young.
 *
 * v0.5.5 never recovered a run whose start was lost or a step run whose action
 * died, so the stalled-run sweep and the lease recovery can meet such rows
 * months after the fact. Past `PRE_UPGRADE_ABANDON_AFTER_MS` they are ended
 * without a side effect (no welcome mail half a year late); younger ones keep
 * the normal recovery, which `legacyWalkerCompat.test.ts` and
 * `stepRunRecovery.test.ts` cover.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { PRE_UPGRADE_ABANDON_AFTER_MS, PRE_UPGRADE_ABANDONED_ERROR } from '../stepRunTransitions';
import {
	DAY_MS,
	runDueScheduled,
	runOf,
	runTotals,
	seedAutomation,
	seedRun,
	seedSettings,
	sends,
	stepRunsOf,
	walkerModules,
	type T,
} from './walkerHarness';

vi.mock('../../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function freshT(): Promise<T> {
	const t = convexTest(schema, walkerModules);
	await seedSettings(t);
	return t;
}

const sweep = (t: T) => t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {});
const recover = (t: T) => t.action(internal.automations.stepWalker.processPendingDelays, {});

describe('a run v0.5.5 never started', () => {
	it('is cancelled, not started, once it is older than the cutoff', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }, { email: 'Day 2' }]);
		const { runId } = await seedRun(t, automationId);

		vi.advanceTimersByTime(180 * DAY_MS);
		expect(await sweep(t)).toMatchObject({ started: 0, cancelled: 1 });
		await runDueScheduled(t);

		expect(await sends(t)).toEqual([]);
		expect(await stepRunsOf(t, runId)).toEqual([]);
		expect((await runOf(t, runId)).status).toBe('cancelled');
		expect(await runTotals(t, automationId)).toMatchObject({
			statsEntered: 1,
			statsCancelled: 1,
		});
	});

	it('is still started just inside the cutoff', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		vi.advanceTimersByTime(PRE_UPGRADE_ABANDON_AFTER_MS);
		expect(await sweep(t)).toMatchObject({ started: 1, cancelled: 0 });
		await runDueScheduled(t);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		expect((await runOf(t, runId)).status).toBe('completed');
	});
});

describe('an executing step run v0.5.5 claimed and never finished', () => {
	/** Step 0 claimed the v0.5.5 way: executing, a start time, no lease. */
	async function legacyClaimedFirstStep(t: T, runId: Id<'automationRuns'>) {
		const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		if (started.kind !== 'scheduled') throw new Error(`not started: ${started.kind}`);
		await t.run(async (ctx) => {
			const stepRun = await ctx.db.get(started.stepRunId);
			await ctx.db.patch(started.stepRunId, { status: 'executing', startedAt: Date.now() });
			await ctx.db.patch(stepRun!.automationStepId, { statPending: 0, statExecuting: 1 });
		});
		// Its own scheduled firing (attempt 0) loses: the row is not pending.
		await runDueScheduled(t);
		return started.stepRunId;
	}

	it('with no Send: is skipped and its run cancelled, sending nothing', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ email: 'Day 2' },
		]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await legacyClaimedFirstStep(t, runId);

		vi.advanceTimersByTime(180 * DAY_MS);
		expect((await recover(t)).recoveredCount).toBe(1);
		await runDueScheduled(t);

		expect(await sends(t)).toEqual([]);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r._id, r.status, r.errorMessage])).toEqual([
			[stepRunId, 'skipped', PRE_UPGRADE_ABANDONED_ERROR],
		]);
		expect((await runOf(t, runId)).status).toBe('cancelled');
		const step = await t.run(async (ctx) => ctx.db.get(stepIds[0]!));
		expect(step).toMatchObject({ statExecuting: 0, statSkipped: 1 });

		// Nothing is left for a later sweep to pick up again.
		expect((await recover(t)).recoveredCount).toBe(0);
	});

	it('with its Send: is completed with it and its run cancelled, never moving on', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }, { email: 'Day 2' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyClaimedFirstStep(t, runId);
		// v0.5.5's email step enqueued its Send without the step-run key.
		const outcome = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
		});
		if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);

		vi.advanceTimersByTime(180 * DAY_MS);
		expect((await recover(t)).recoveredCount).toBe(1);
		await runDueScheduled(t);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r._id, r.status, r.emailSendId])).toEqual([
			[stepRunId, 'completed', outcome.sendId],
		]);
		expect((await runOf(t, runId)).status).toBe('cancelled');
	});
});
