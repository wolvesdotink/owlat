/**
 * Run deletion (contact erasure) racing the step walker. Scheduled
 * `executeStep` jobs are not tracked by id, so deletion cannot cancel them;
 * the orchestration mutations must turn every late firing into a no-op
 * instead. None of these may send, resurrect a row, or move a counter twice.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { deleteAutomationRun } from '../runDeletion';
import { STEP_LEASE_MS } from '../stepOrchestration';
import {
	runDueScheduled,
	runTotals,
	seedAutomation,
	seedRun,
	seedSettings,
	sends,
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

async function started(): Promise<{
	t: T;
	automationId: Id<'automations'>;
	stepId: Id<'automationSteps'>;
	runId: Id<'automationRuns'>;
	stepRunId: Id<'automationStepRuns'>;
}> {
	const t = convexTest(schema, walkerModules);
	await seedSettings(t);
	const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Hello' }]);
	const { runId } = await seedRun(t, automationId);
	const begun = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
		automationRunId: runId,
	});
	if (begun.kind !== 'scheduled') throw new Error(`run did not start: ${begun.kind}`);
	return { t, automationId, stepId: stepIds[0]!, runId, stepRunId: begun.stepRunId };
}

async function deleteRunFully(t: T, runId: Id<'automationRuns'>): Promise<void> {
	await t.run(async (ctx) => {
		const progress = await deleteAutomationRun(ctx, runId, 100);
		expect(progress.isDeleted).toBe(true);
	});
}

async function stepGauges(t: T, stepId: Id<'automationSteps'>) {
	const step = await t.run(async (ctx) => ctx.db.get(stepId));
	return {
		pending: step?.statPending ?? 0,
		executing: step?.statExecuting ?? 0,
		completed: step?.statCompleted ?? 0,
	};
}

async function rowCounts(t: T) {
	return await t.run(async (ctx) => ({
		runs: (await ctx.db.query('automationRuns').collect()).length,
		stepRuns: (await ctx.db.query('automationStepRuns').collect()).length,
	}));
}

describe('run deletion vs. the step walker', () => {
	it('drops a scheduled first step whose run was deleted before it fired', async () => {
		const { t, automationId, stepId, runId } = await started();

		await deleteRunFully(t, runId);
		await runDueScheduled(t);

		expect(await sends(t)).toHaveLength(0);
		expect(await rowCounts(t)).toEqual({ runs: 0, stepRuns: 0 });
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 0,
			statsCancelled: 1,
		});
		expect(await stepGauges(t, stepId)).toEqual({ pending: 0, executing: 0, completed: 0 });
	});

	it('turns an in-flight attempt of a deleted run into a stale no-op', async () => {
		const { t, automationId, stepId, runId, stepRunId } = await started();
		const claim = await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId,
			attempt: 0,
		});
		expect(claim.kind).toBe('claimed');

		// The contact is erased while the attempt is inside its side effect.
		await deleteRunFully(t, runId);

		const finalized = await t.mutation(internal.automations.stepOrchestration.finalizeStepRun, {
			stepRunId,
			attempt: 0,
			outcome: { kind: 'completed' },
		});
		expect(finalized.kind).toBe('stale');
		const retried = await t.mutation(internal.automations.stepOrchestration.retryOrFailStepRun, {
			stepRunId,
			attempt: 0,
			errorMessage: 'provider timeout',
		});
		expect(retried.kind).toBe('stale');

		// The lease of the dead attempt would have expired by now; the recovery
		// sweep must not find (or re-dispatch) the deleted row.
		vi.advanceTimersByTime(STEP_LEASE_MS + 1);
		const swept = await t.action(internal.automations.stepWalker.processPendingDelays, {});
		expect(swept.recoveredCount).toBe(0);
		await runDueScheduled(t);

		expect(await rowCounts(t)).toEqual({ runs: 0, stepRuns: 0 });
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 0,
			statsCancelled: 1,
		});
		expect(await stepGauges(t, stepId)).toEqual({ pending: 0, executing: 0, completed: 0 });
	});

	it('skips the step without a send while a deletion spans several transactions', async () => {
		const { t, automationId, stepId, runId } = await started();

		// A budget of one row only cancels the run; its step runs remain.
		await t.run(async (ctx) => {
			expect((await deleteAutomationRun(ctx, runId, 1)).isDeleted).toBe(false);
		});
		await runDueScheduled(t);

		expect(await sends(t)).toHaveLength(0);
		const [stepRun] = await t.run(async (ctx) => ctx.db.query('automationStepRuns').collect());
		expect(stepRun?.status).toBe('skipped');

		await deleteRunFully(t, runId);
		expect(await rowCounts(t)).toEqual({ runs: 0, stepRuns: 0 });
		// Cancelled once, by the deletion, not again by the skipped claim.
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 0,
			statsCancelled: 1,
		});
		expect(await stepGauges(t, stepId)).toEqual({ pending: 0, executing: 0, completed: 0 });
	});
});
