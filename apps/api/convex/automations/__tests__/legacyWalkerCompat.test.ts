/**
 * Rows a v0.5.5 step walker left behind, finished by this release's walker.
 *
 * v0.5.5 claimed a step run without a lease, enqueued its email Send without
 * the step-run key, and advanced a run in separate calls from its action. A
 * deployment can still hold rows from such an action that died mid-step: an
 * `executing` row with no lease, an unkeyed Send, or a running run with no
 * active step run. These tests write that state directly and check that the
 * new orchestration finishes it: no second Send, no adopted stray Send, and
 * stalled runs recovered.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { STEP_LEASE_MS } from '../stepOrchestration';
import { STALLED_RUN_GRACE_MS } from '../stalledRuns';
import { LEGACY_ATTEMPT_WINDOW_MS } from '../stepRunSend';
import { insertStepRun, transitionStepRun } from '../stepRunTransitions';
import {
	DAY_MS,
	advanceAndRun,
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

/**
 * The step run v0.5.5's claim left: created for the step, then moved to
 * `executing` with no lease, and the run's executed-step count bumped.
 */
async function legacyClaim(
	t: T,
	runId: Id<'automationRuns'>,
	stepId: Id<'automationSteps'>
): Promise<Id<'automationStepRuns'>> {
	return await t.run(async (ctx) => {
		const step = await ctx.db.get(stepId);
		if (!step) throw new Error('step not found');
		const stepRunId = await insertStepRun(ctx, {
			automationRunId: runId,
			step,
			delayUntil: undefined,
		});
		const stepRun = await ctx.db.get(stepRunId);
		if (!stepRun) throw new Error('step run not written');
		await transitionStepRun(ctx, stepRun, 'executing', { startedAt: Date.now() });
		const run = await ctx.db.get(runId);
		await ctx.db.patch(runId, { stepsExecuted: (run?.stepsExecuted ?? 0) + 1 });
		return stepRunId;
	});
}

/** v0.5.5's step completion: the row completed and its Send stamped with the step-run key. */
async function legacyComplete(
	t: T,
	stepRunId: Id<'automationStepRuns'>,
	sendId: Id<'transactionalSends'>
): Promise<void> {
	await t.run(async (ctx) => {
		const stepRun = await ctx.db.get(stepRunId);
		if (!stepRun) throw new Error('step run not found');
		await ctx.db.patch(sendId, { automationStepRunId: stepRunId });
		await transitionStepRun(ctx, stepRun, 'completed', {
			completedAt: Date.now(),
			emailSendId: sendId,
		});
	});
}

/** v0.5.5's email step: the intake WITHOUT the step-run idempotency key. */
async function legacyEnqueue(
	t: T,
	args: { automationId: Id<'automations'>; contactId: Id<'contacts'>; subject: string }
): Promise<Id<'transactionalSends'>> {
	const outcome = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
		kind: 'automation',
		email: 'reader@example.com',
		contactId: args.contactId,
		automationId: args.automationId,
		subject: args.subject,
		html: '<p>Hello</p>',
		from: 'Owlat <noreply@example.com>',
	});
	if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
	return outcome.sendId;
}

describe('a step v0.5.5 claimed and never finished', () => {
	it('a legacy attempt that enqueued and then failed is retried without a second Send', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyClaim(t, runId, stepIds[0]!);
		const legacySendId = await legacyEnqueue(t, { automationId, contactId, subject: 'Welcome' });

		// v0.5.5's catch block scheduled the retry, which runs this release's walker.
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
			retryCount: 1,
		});
		await runDueScheduled(t);

		const rows = await sends(t);
		expect(rows.map((s) => s._id)).toEqual([legacySendId]);
		expect(rows[0]?.automationStepRunId).toBe(stepRunId);
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun).toMatchObject({ status: 'completed', emailSendId: legacySendId });
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it("does not adopt a Send the contact's previous run of the automation wrote late", async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId: firstRunId, contactId } = await seedRun(t, automationId);
		await legacyClaim(t, firstRunId, stepIds[0]!);
		// The first run ends while its v0.5.5 action is still sending, and the
		// contact enters the automation again.
		await t.run(async (ctx) =>
			ctx.db.patch(firstRunId, { status: 'cancelled', completedAt: Date.now() })
		);
		vi.advanceTimersByTime(60_000);
		const secondRunId = await t.run(async (ctx) =>
			ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			})
		);
		const secondStepRunId = await legacyClaim(t, secondRunId, stepIds[0]!);
		vi.advanceTimersByTime(60_000);
		// The first run's action finally enqueues its (unkeyed) Send.
		const lateSendId = await legacyEnqueue(t, { automationId, contactId, subject: 'Welcome' });

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: secondRunId,
			stepRunId: secondStepRunId,
			retryCount: 1,
		});
		await runDueScheduled(t);

		const rows = await sends(t);
		expect(rows).toHaveLength(2);
		expect(rows.find((s) => s._id === lateSendId)?.automationStepRunId).toBeUndefined();
		const [stepRun] = await stepRunsOf(t, secondRunId);
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).not.toBe(lateSendId);
	});

	it('does not adopt an unkeyed Send written after a legacy attempt could still run', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyClaim(t, runId, stepIds[0]!);
		vi.advanceTimersByTime(LEGACY_ATTEMPT_WINDOW_MS);
		const strayId = await legacyEnqueue(t, { automationId, contactId, subject: 'Welcome' });

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
			retryCount: 1,
		});
		await runDueScheduled(t);

		expect(await sends(t)).toHaveLength(2);
		expect((await stepRunsOf(t, runId))[0]?.emailSendId).not.toBe(strayId);
	});

	it('is adopted by the recovery sweep after a lease, and the run walks on', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ delayDays: 1 },
			{ email: 'Second' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		await legacyClaim(t, runId, stepIds[0]!);
		const sendId = await legacyEnqueue(t, { automationId, contactId, subject: 'First' });

		vi.advanceTimersByTime(STEP_LEASE_MS - 1);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);
		expect((await runOf(t, runId)).currentStepIndex).toBe(0);

		vi.advanceTimersByTime(2);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);
		expect((await runOf(t, runId)).currentStepIndex).toBe(1);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'pending'],
		]);
		expect(stepRuns[0]?.emailSendId).toBe(sendId);

		await advanceAndRun(t, DAY_MS);
		expect((await sends(t)).map((s) => s.subject)).toEqual(['First', 'Second']);
		expect((await runOf(t, runId)).status).toBe('completed');
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 1,
			statsCancelled: 0,
		});
	});
});

describe('stalled runs: running, with no active step run', () => {
	async function sweep(t: T) {
		return await t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {});
	}

	it('a run whose legacy start died before its first step run is started', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		expect(await sweep(t)).toMatchObject({ started: 0, live: 1 });
		vi.advanceTimersByTime(STALLED_RUN_GRACE_MS + 1);
		expect(await sweep(t)).toMatchObject({ started: 1 });
		await runDueScheduled(t);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it('a run whose legacy walker died between two steps is cancelled, never resumed', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ email: 'Second' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyClaim(t, runId, stepIds[0]!);
		const sendId = await legacyEnqueue(t, { automationId, contactId, subject: 'First' });
		await legacyComplete(t, stepRunId, sendId);
		// ... and the action died before creating the next step run.

		vi.advanceTimersByTime(STALLED_RUN_GRACE_MS - 1);
		expect(await sweep(t)).toMatchObject({ cancelled: 0, live: 1 });
		vi.advanceTimersByTime(2);
		expect(await sweep(t)).toMatchObject({ cancelled: 1 });

		expect((await runOf(t, runId)).status).toBe('cancelled');
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 0,
			statsCancelled: 1,
		});
		expect((await sends(t)).map((s) => s.subject)).toEqual(['First']);
	});

	it('leaves a run with an active step run alone, however old', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }, { delayDays: 30 }]);
		const { runId } = await seedRun(t, automationId);
		await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		await runDueScheduled(t);

		vi.advanceTimersByTime(10 * DAY_MS);
		expect(await sweep(t)).toMatchObject({ live: 1, started: 0, cancelled: 0 });
		expect((await runOf(t, runId)).status).toBe('running');
	});
});
