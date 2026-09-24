/**
 * v0.5.5's step walker, in flight across the deploy of this release.
 *
 * An action that is running when a release deploys finishes on the OLD code,
 * but every ctx.runQuery / ctx.runMutation it makes resolves against the NEW
 * functions. v0.5.5's `executeStep` / `startAutomationRun` drove each step
 * through single-transition functions that this release had removed, so such
 * an action failed mid-step, leaving an `executing` row or a run pointing at
 * nothing. The functions are back as one-release shims
 * (`stepExecutorQueries.ts`, `lifecycle.recordRunFailure`,
 * `blockedEmails.isBlockedInternal`). These tests replay v0.5.5's call
 * sequence against them and check they cooperate with the new orchestration:
 * no second Send, no double advance, and stalled runs recovered.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestBlockedEmail, createTestContact } from '../../__tests__/factories';
import { MAX_RETRY_ATTEMPTS } from '../../lib/constants';
import { STEP_LEASE_MS } from '../stepOrchestration';
import { STALLED_RUN_GRACE_MS } from '../stalledRuns';
import { LEGACY_ATTEMPT_WINDOW_MS } from '../stepRunSend';
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

const legacy = internal.automations.stepExecutorQueries;

async function freshT(): Promise<T> {
	const t = convexTest(schema, walkerModules);
	await seedSettings(t);
	return t;
}

/** v0.5.5's `startAutomationRun` minus its scheduling: create step 0 through the shims. */
async function legacyStart(t: T, runId: Id<'automationRuns'>) {
	const runData = await t.query(legacy.getAutomationRunWithContact, { automationRunId: runId });
	if (!runData) throw new Error('run not found');
	const step = await t.query(legacy.getAutomationStep, {
		automationId: runData.run.automationId,
		stepIndex: 0,
	});
	if (!step) throw new Error('no first step');
	return await t.mutation(legacy.createStepRun, {
		automationRunId: runId,
		automationStepId: step._id,
		stepIndex: 0,
		stepType: step.stepType,
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

/** v0.5.5's advance after a completed step: skipped rows, index, next step run. */
async function legacyAdvance(
	t: T,
	args: { runId: Id<'automationRuns'>; automationId: Id<'automations'>; from: number; to: number }
) {
	const steps = await t.query(legacy.getAutomationSteps, { automationId: args.automationId });
	await t.mutation(legacy.markStepsSkipped, {
		automationRunId: args.runId,
		fromStepIndex: args.from + 1,
		toStepIndex: args.to,
	});
	const next = steps.find((step) => step.stepIndex === args.to);
	if (!next) {
		await t.mutation(legacy.completeAutomationRun, { automationRunId: args.runId });
		return null;
	}
	await t.mutation(legacy.advanceAutomationRun, {
		automationRunId: args.runId,
		nextStepIndex: args.to,
	});
	return await t.mutation(legacy.createStepRun, {
		automationRunId: args.runId,
		automationStepId: next._id,
		stepIndex: args.to,
		stepType: next.stepType,
	});
}

describe('a v0.5.5 step walker action in flight across the deploy', () => {
	it('finishes its step through the shims and the new walker takes the run from there', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ email: 'Second' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyStart(t, runId);

		expect(await t.mutation(legacy.markStepExecuting, { stepRunId })).toEqual({
			claimed: true,
			stepsExecuted: 1,
		});
		const sendId = await legacyEnqueue(t, { automationId, contactId, subject: 'First' });
		await t.mutation(legacy.markStepCompleted, { stepRunId, emailSendId: sendId });
		const nextStepRunId = await legacyAdvance(t, { runId, automationId, from: 0, to: 1 });
		// v0.5.5 then scheduled executeStep, which now runs the new walker.
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId: nextStepRunId!,
		});

		expect((await sends(t)).map((s) => s.subject)).toEqual(['First', 'Second']);
		expect((await stepRunsOf(t, runId)).map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'completed'],
		]);
		expect((await runOf(t, runId)).status).toBe('completed');
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 1,
			statsCancelled: 0,
		});
		const firstStep = await t.run(async (ctx) => ctx.db.get(stepIds[0]!));
		expect(firstStep).toMatchObject({ statCompleted: 1, statPending: 0, statExecuting: 0 });
	});

	it('a legacy attempt that enqueued and then failed is retried without a second Send', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyStart(t, runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId });
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
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId: firstRunId, contactId } = await seedRun(t, automationId);
		const firstStepRunId = await legacyStart(t, firstRunId);
		await t.mutation(legacy.markStepExecuting, { stepRunId: firstStepRunId });
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
		const secondStepRunId = await legacyStart(t, secondRunId);
		await t.mutation(legacy.markStepExecuting, { stepRunId: secondStepRunId });
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
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyStart(t, runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId });
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

	it('cannot move a run the new walker already recovered and advanced', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ delayDays: 1 },
			{ email: 'Second' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyStart(t, runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId });
		const sendId = await legacyEnqueue(t, { automationId, contactId, subject: 'First' });

		// The legacy action stalls; the recovery sweep adopts its row after a lease.
		vi.advanceTimersByTime(STEP_LEASE_MS + 1);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);
		const afterRecovery = await runOf(t, runId);
		expect(afterRecovery.currentStepIndex).toBe(1);

		// The legacy action wakes up and carries on with its own advance.
		await t.mutation(legacy.markStepCompleted, { stepRunId, emailSendId: sendId });
		const handedBack = await legacyAdvance(t, { runId, automationId, from: 0, to: 1 });
		await t.mutation(legacy.cancelAutomationRun, { automationRunId: runId });
		await t.mutation(legacy.completeAutomationRun, { automationRunId: runId });

		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'pending'],
		]);
		expect(handedBack).toBe(stepRuns[1]?._id);
		const run = await runOf(t, runId);
		expect(run.status).toBe('running');
		expect(run.nextStepAt).toBe(afterRecovery.nextStepAt);
		const delayStep = await t.run(async (ctx) => ctx.db.get(stepIds[1]!));
		expect(delayStep?.statPending).toBe(1);

		await advanceAndRun(t, DAY_MS);
		expect((await sends(t)).map((s) => s.subject)).toEqual(['First', 'Second']);
		expect((await runOf(t, runId)).status).toBe('completed');
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 1,
			statsCancelled: 0,
		});
	});

	it('the legacy claim honours contact deletion and unsubscribe like the new claim', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ delayDays: 1 },
		]);

		const unsubscribed = await seedRun(t, automationId, { unsubscribedAt: Date.now() });
		const skippedId = await legacyStart(t, unsubscribed.runId);
		expect(await t.mutation(legacy.markStepExecuting, { stepRunId: skippedId })).toEqual({
			claimed: false,
			stepsExecuted: 0,
		});
		expect(
			(await stepRunsOf(t, unsubscribed.runId)).map((r) => [r.automationStepId, r.status])
		).toEqual([
			[stepIds[0], 'skipped'],
			[stepIds[1], 'pending'],
		]);

		const deleted = await seedRun(t, automationId, { deletedAt: Date.now() });
		const cancelledId = await legacyStart(t, deleted.runId);
		expect((await t.mutation(legacy.markStepExecuting, { stepRunId: cancelledId })).claimed).toBe(
			false
		);
		expect((await runOf(t, deleted.runId)).status).toBe('cancelled');
		expect(await sends(t)).toHaveLength(0);
	});

	it('counts a run failure once, and only when its legacy cancel ended the run', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const failures = async () =>
			(await t.run(async (ctx) => ctx.db.get(automationId)))?.consecutiveRunFailures ?? 0;
		/** v0.5.5's catch block after its last retry. */
		const legacyExhausted = async (
			runId: Id<'automationRuns'>,
			stepRunId: Id<'automationStepRuns'>
		) => {
			await t.mutation(legacy.markStepFailed, {
				stepRunId,
				errorMessage: 'SMTP 451',
				retryCount: MAX_RETRY_ATTEMPTS,
			});
			await t.mutation(legacy.cancelAutomationRun, { automationRunId: runId });
			await t.mutation(internal.automations.lifecycle.recordRunFailure, { automationId });
		};

		const failed = await seedRun(t, automationId);
		const failedStepRunId = await legacyStart(t, failed.runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId: failedStepRunId });
		await legacyExhausted(failed.runId, failedStepRunId);
		expect((await runOf(t, failed.runId)).status).toBe('cancelled');
		expect(await failures()).toBe(1);

		// The recovery took this step over (it carries a lease now), so the
		// legacy failure and cancel change nothing, and neither may the count.
		const recovered = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'second@example.com' }))
		);
		const runId = await t.run(async (ctx) =>
			ctx.db.insert('automationRuns', {
				automationId,
				contactId: recovered,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			})
		);
		const stepRunId = await legacyStart(t, runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId });
		await t.run(async (ctx) =>
			ctx.db.patch(stepRunId, { retryCount: 1, leaseExpiresAt: Date.now() + STEP_LEASE_MS })
		);
		await legacyExhausted(runId, stepRunId);
		expect((await runOf(t, runId)).status).toBe('running');
		expect(await failures()).toBe(1);
	});

	it('keeps the blocklist entry point it called', async () => {
		const t = await freshT();

		await t.run(async (ctx) =>
			ctx.db.insert('blockedEmails', createTestBlockedEmail({ email: 'gone@example.com' }))
		);
		expect(
			await t.query(internal.blockedEmails.isBlockedInternal, { email: 'Gone@Example.com' })
		).toBe(true);
		expect(
			await t.query(internal.blockedEmails.isBlockedInternal, { email: 'here@example.com' })
		).toBe(false);
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
		const { automationId } = await seedAutomation(t, [{ email: 'First' }, { email: 'Second' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await legacyStart(t, runId);
		await t.mutation(legacy.markStepExecuting, { stepRunId });
		const sendId = await legacyEnqueue(t, { automationId, contactId, subject: 'First' });
		await t.mutation(legacy.markStepCompleted, { stepRunId, emailSendId: sendId });
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
