/**
 * Automation step execution is bound to the persisted step run, and every
 * committed boundary of an attempt survives a crash (issue #809, finding 6).
 *
 * Before: the walker picked the step from the run's MUTABLE `currentStepIndex`,
 * retries skipped the claim, and one retry block wrapped the side effect, the
 * completion, the index advance and the next step's creation + scheduling. So
 * a retry after "enqueue committed, completion failed" enqueued a second Send,
 * and a retry after "index advanced, next step not created" executed the NEXT
 * step under the old step run — ahead of its delay.
 *
 * Each boundary is reproduced by committing the prefix an attempt would have
 * committed (through the same mutations the walker uses) and then abandoning
 * it, which is exactly what an action that dies at that point leaves behind.
 * The assertions are the invariants: one Send per step run, the step run's own
 * step executed, delays respected, and the run recovered in the end.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { MAX_RETRY_ATTEMPTS } from '../../lib/constants';
import { STEP_LEASE_MS } from '../stepOrchestration';
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

/** Start a run through the real start mutation and return its first step run. */
async function begin(t: T, runId: Parameters<typeof runOf>[1]) {
	const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
		automationRunId: runId,
	});
	if (started.kind !== 'scheduled') throw new Error(`run did not start: ${started.kind}`);
	return started.stepRunId;
}

describe('step identity', () => {
	it('executes the step its step run was created for, not run.currentStepIndex', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ email: 'Second' },
		]);
		const { runId } = await seedRun(t, automationId);
		const firstStepRunId = await begin(t, runId);

		// The state a crash between "advance the index" and "create the next step
		// run" used to leave behind: the run already points at step 1.
		await t.run(async (ctx) => ctx.db.patch(runId, { currentStepIndex: 1 }));

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId: firstStepRunId,
		});

		const [send] = await sends(t);
		expect(await sends(t)).toHaveLength(1);
		expect(send?.subject).toBe('First');
		expect(send?.automationStepRunId).toBe(firstStepRunId);

		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'pending'],
		]);
		expect((await runOf(t, runId)).currentStepIndex).toBe(1);
	});
});

describe('email intake idempotency key', () => {
	it('returns the existing Send when the same step run enqueues twice', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Once' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);

		const enqueue = () =>
			t.mutation(internal.delivery.nonCampaignIntake.intake, {
				kind: 'automation',
				email: 'reader@example.com',
				contactId,
				automationId,
				subject: 'Once',
				html: '<p>Hello</p>',
				from: 'Owlat <noreply@example.com>',
				automationStepRunId: stepRunId,
			});
		const first = await enqueue();
		const second = await enqueue();

		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok) expect(second.sendId).toBe(first.sendId);
		expect(await sends(t)).toHaveLength(1);
	});
});

describe('failure after each committed boundary', () => {
	it('claim committed, action died: recovered after the lease expires, one Send', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);

		const claim = await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId,
			attempt: 0,
		});
		expect(claim.kind).toBe('claimed');

		// While the lease is live, the sweep leaves the attempt alone, and the
		// originally scheduled firing loses the claim.
		await runDueScheduled(t);
		const early = await t.action(internal.automations.stepWalker.processPendingDelays, {});
		expect(early.recoveredCount).toBe(0);
		expect(await sends(t)).toHaveLength(0);

		vi.advanceTimersByTime(STEP_LEASE_MS + 1);
		const late = await t.action(internal.automations.stepWalker.processPendingDelays, {});
		expect(late.recoveredCount).toBe(1);
		await runDueScheduled(t);

		expect(await sends(t)).toHaveLength(1);
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.retryCount).toBe(1);
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it('Send enqueued, completion lost: the recovered attempt reuses the Send', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);

		await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId,
			attempt: 0,
		});
		// The email step's side effect committed ...
		const enqueued = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: stepRunId,
		});
		// ... and the action died before finalize.
		expect(enqueued.ok).toBe(true);

		await advanceAndRun(t, STEP_LEASE_MS + 1);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);

		const rows = await sends(t);
		expect(rows).toHaveLength(1);
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).toBe(rows[0]?._id);
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it('step finalized: stale retries and duplicates of the finished step change nothing', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'First' },
			{ delayDays: 1 },
			{ email: 'Second' },
		]);
		const { runId } = await seedRun(t, automationId);
		const firstStepRunId = await begin(t, runId);
		await runDueScheduled(t);
		expect(await sends(t)).toHaveLength(1);

		// A late duplicate, and the retry chain an older walker would have run.
		for (const retryCount of [0, 1, 2]) {
			await t.action(internal.automations.stepWalker.executeStep, {
				automationRunId: runId,
				stepRunId: firstStepRunId,
				retryCount,
			});
		}

		expect(await sends(t)).toHaveLength(1);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'pending'],
		]);
	});

	it('respects a delay: an early firing of the delayed step is dropped', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [
			{ email: 'First' },
			{ delayDays: 1 },
			{ email: 'Second' },
		]);
		const { runId } = await seedRun(t, automationId);
		await begin(t, runId);
		await runDueScheduled(t);

		const delayRun = (await stepRunsOf(t, runId))[1];
		expect(delayRun?.status).toBe('pending');
		expect(delayRun?.delayUntil).toBe(Date.now() + DAY_MS);

		// Fired ahead of its delay (a stray retry, a duplicate schedule).
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId: delayRun!._id,
		});
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);
		expect(await sends(t)).toHaveLength(1);
		expect((await stepRunsOf(t, runId))[1]?.status).toBe('pending');

		await advanceAndRun(t, DAY_MS);
		expect((await sends(t)).map((s) => s.subject)).toEqual(['First', 'Second']);
		expect((await runOf(t, runId)).status).toBe('completed');
	});
});

describe('recovering an email step whose Send already exists', () => {
	it('completes the step with that Send even if the contact unsubscribed since', async () => {
		const t = await freshT();
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ delayDays: 1 },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);
		await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId,
			attempt: 0,
		});
		const enqueued = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: stepRunId,
		});
		if (!enqueued.ok) throw new Error('not enqueued');
		// The action died before finalize, and the contact unsubscribed after the
		// mail was already queued (the worker's own gate decides whether it leaves).
		await t.run(async (ctx) => ctx.db.patch(contactId, { unsubscribedAt: Date.now() }));

		vi.advanceTimersByTime(STEP_LEASE_MS + 1);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);

		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'pending'],
		]);
		expect(stepRuns[0]?.emailSendId).toBe(enqueued.sendId);
		expect((await runOf(t, runId)).status).toBe('running');
		const emailStep = await t.run(async (ctx) => ctx.db.get(stepIds[0]!));
		expect(emailStep?.statCompleted).toBe(1);
		expect(emailStep?.statSkipped ?? 0).toBe(0);
		expect(await sends(t)).toHaveLength(1);
	});
});

describe('executing rows claimed before leases existed', () => {
	it('are recovered once they started more than a lease ago', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);
		// The v0.5.5 claim: executing, a start time, no lease, attempt 0.
		await t.run(async (ctx) => {
			const stepRun = await ctx.db.get(stepRunId);
			await ctx.db.patch(stepRunId, { status: 'executing', startedAt: Date.now() });
			await ctx.db.patch(stepRun!.automationStepId, { statPending: 0, statExecuting: 1 });
		});
		// Its own scheduled firing (attempt 0) loses: the row is not pending.
		await runDueScheduled(t);

		const early = await t.action(internal.automations.stepWalker.processPendingDelays, {});
		expect(early.recoveredCount).toBe(0);

		vi.advanceTimersByTime(STEP_LEASE_MS + 1);
		const late = await t.action(internal.automations.stepWalker.processPendingDelays, {});
		expect(late.recoveredCount).toBe(1);
		await runDueScheduled(t);

		expect(await sends(t)).toHaveLength(1);
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.status).toBe('completed');
		expect((await runOf(t, runId)).status).toBe('completed');
	});
});

describe('side-effect retry', () => {
	it('retries a failed side effect with backoff; a racing duplicate of the retry is dropped', async () => {
		const t = convexTest(schema, walkerModules);
		// No settings row yet: the email step fails with "sender not configured".
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);

		const first = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
		});
		expect(first.retrying).toBe(true);
		await seedSettings(t);

		// The scheduled retry (attempt 1) and a duplicate of it race.
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
			retryCount: 1,
		});
		await advanceAndRun(t, 60_000);

		expect(await sends(t)).toHaveLength(1);
		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.retryCount).toBe(1);
	});

	it('an attempt past the shared retry/recovery budget fails the step and cancels the run', async () => {
		const t = await freshT();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await begin(t, runId);
		await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId,
			attempt: 0,
		});
		await t.run(async (ctx) => ctx.db.patch(stepRunId, { retryCount: MAX_RETRY_ATTEMPTS }));

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
			retryCount: MAX_RETRY_ATTEMPTS + 1,
		});

		expect(result.cancelled).toBe(true);
		expect(await sends(t)).toHaveLength(0);
		expect((await stepRunsOf(t, runId))[0]?.status).toBe('failed');
		expect((await runOf(t, runId)).status).toBe('cancelled');
		expect(await runTotals(t, automationId)).toMatchObject({ statsEntered: 1, statsCancelled: 1 });
		const automation = await t.run(async (ctx) => ctx.db.get(automationId));
		expect(automation?.consecutiveRunFailures).toBe(1);
	});
});
