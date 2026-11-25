/**
 * An automation email step re-checks its run, its automation and its step in
 * the transaction that writes the Send, not only at the claim.
 *
 * The email step claims its step run in one transaction, then reads the
 * template and the default sender and personalizes the mail in an action, and
 * only then hands the send to the non-campaign intake. A pause, a deletion, a
 * cancelled run or a removed step landing in that window must stop the mail.
 * Each event is injected right after the claim commits, by wrapping the email
 * step's `execute`, and the real walker, step module and intake run around it.
 *
 * A pause after the Send is written is caught by the worker's last gate,
 * which withdraws the queued email; the last block drives that through the
 * gate and the send completion.
 *
 * Contact changes in the same window (deleted, unsubscribed) are pinned in
 * `contactEligibility.test.ts`, and a blocklisted address or a suspension in
 * `emailStepOutcomes.test.ts`: the intake checks those on its own.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { deleteAutomationRun } from '../runDeletion';
import type * as emailStep from '../steps/email';
import { cancelRun } from '../stepRunTransitions';
import { STEP_LEASE_MS } from '../stepOrchestration';
import {
	DAY_MS,
	advanceAndRun,
	runDueScheduled,
	runOf,
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

// Runs after the claim committed and before the email step reads anything.
const afterClaim = vi.hoisted(() => ({ inject: null as null | (() => Promise<void>) }));
vi.mock('../steps/email', async (importOriginal) => {
	const actual = await importOriginal<typeof emailStep>();
	return {
		...actual,
		emailStepModule: {
			...actual.emailStepModule,
			async execute(...args: Parameters<typeof actual.emailStepModule.execute>) {
				await afterClaim.inject?.();
				return actual.emailStepModule.execute(...args);
			},
		},
	};
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-23T09:00:00Z'));
	afterClaim.inject = null;
});
afterEach(() => {
	vi.useRealTimers();
});

async function startEmailRun(t: T) {
	await seedSettings(t);
	const { automationId, stepIds } = await seedAutomation(t, [
		{ email: 'Welcome' },
		{ email: 'Follow-up' },
	]);
	const { runId, contactId } = await seedRun(t, automationId);
	const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
		automationRunId: runId,
	});
	if (started.kind !== 'scheduled') throw new Error('not started');
	return { automationId, stepIds, runId, contactId, stepRunId: started.stepRunId };
}

async function automationOf(t: T, automationId: Id<'automations'>) {
	const automation = await t.run(async (ctx) => ctx.db.get(automationId));
	if (!automation) throw new Error('automation vanished');
	return automation;
}

/** Every way the step could still be fired later: retries, recovery, the sweep. */
async function fireEverythingLater(
	t: T,
	ids: { runId: Id<'automationRuns'>; stepRunId: Id<'automationStepRuns'> }
) {
	for (const retryCount of [0, 1]) {
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: ids.runId,
			stepRunId: ids.stepRunId,
			retryCount,
		});
	}
	await advanceAndRun(t, STEP_LEASE_MS + 60_000);
	await t.action(internal.automations.stepWalker.processPendingDelays, {});
	await runDueScheduled(t);
}

type Started = Awaited<ReturnType<typeof startEmailRun>>;

const automationEvents: Array<{
	name: string;
	inject: (t: T, s: Started) => Promise<void>;
	stepRunStatus: 'failed' | 'skipped';
	errorMessage: string;
}> = [
	{
		name: 'the automation is paused',
		inject: (t, s) => t.run(async (ctx) => ctx.db.patch(s.automationId, { status: 'paused' })),
		stepRunStatus: 'failed',
		errorMessage: 'Automation is no longer active',
	},
	{
		name: 'the automation is paused and deleted',
		inject: (t, s) =>
			t.run(async (ctx) =>
				ctx.db.patch(s.automationId, { status: 'paused', deletedAt: Date.now() })
			),
		stepRunStatus: 'failed',
		errorMessage: 'Automation is no longer active',
	},
	{
		name: 'the step is removed (the automation is active again)',
		inject: (t, s) => t.run(async (ctx) => ctx.db.delete(s.stepIds[0]!)),
		stepRunStatus: 'failed',
		errorMessage: 'Step not found',
	},
	{
		name: 'the run is cancelled',
		inject: (t, s) =>
			t.run(async (ctx) => {
				await cancelRun(ctx, s.runId);
			}),
		stepRunStatus: 'skipped',
		errorMessage: 'Automation run is no longer running',
	},
];

describe('the automation changes between the claim and the send', () => {
	it.each(automationEvents)(
		'$name: no Send, the step run ends, nothing counts as failed',
		async ({ inject, stepRunStatus, errorMessage }) => {
			const t = convexTest(schema, walkerModules);
			const started = await startEmailRun(t);
			afterClaim.inject = () => inject(t, started);

			const result = await t.action(internal.automations.stepWalker.executeStep, {
				automationRunId: started.runId,
				stepRunId: started.stepRunId,
			});
			afterClaim.inject = null;

			expect(result).toMatchObject({ success: false, cancelled: true });
			expect(await sends(t)).toHaveLength(0);
			const [stepRun] = await stepRunsOf(t, started.runId);
			expect(stepRun).toMatchObject({ status: stepRunStatus, errorMessage });
			expect(stepRun?.leaseExpiresAt).toBeUndefined();
			expect(stepRun?.failureReason).toBeUndefined();
			const run = await runOf(t, started.runId);
			expect(run.status).toBe('cancelled');
			expect(run.endReason).toBeUndefined();
			expect((await automationOf(t, started.automationId)).consecutiveRunFailures ?? 0).toBe(0);

			// Resumed, and every later firing of the step: still nothing.
			await t.run(async (ctx) =>
				ctx.db.patch(started.automationId, { status: 'active', deletedAt: undefined })
			);
			await fireEverythingLater(t, started);
			expect(await sends(t)).toHaveLength(0);
			expect(await stepRunsOf(t, started.runId)).toHaveLength(1);
			expect((await runOf(t, started.runId)).status).toBe('cancelled');
		}
	);

	it('the run is deleted (contact erasure, automation purge): no Send', async () => {
		const t = convexTest(schema, walkerModules);
		const started = await startEmailRun(t);
		afterClaim.inject = () =>
			t.run(async (ctx) => {
				await deleteAutomationRun(ctx, started.runId, 100);
			});

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: started.runId,
			stepRunId: started.stepRunId,
		});
		afterClaim.inject = null;

		expect(await sends(t)).toHaveLength(0);
		await fireEverythingLater(t, started);
		expect(await sends(t)).toHaveLength(0);
	});

	it('a retried intake call after the step ended sends nothing and leaves it ended', async () => {
		const t = convexTest(schema, walkerModules);
		const started = await startEmailRun(t);
		afterClaim.inject = () =>
			t.run(async (ctx) => ctx.db.patch(started.automationId, { status: 'paused' }));
		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: started.runId,
			stepRunId: started.stepRunId,
		});
		afterClaim.inject = null;
		await t.run(async (ctx) => ctx.db.patch(started.automationId, { status: 'active' }));
		const before = await stepRunsOf(t, started.runId);

		const retried = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId: started.contactId,
			automationId: started.automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: started.stepRunId,
		});

		expect(retried).toMatchObject({ ok: false, reason: 'automation_step_ended' });
		expect(await sends(t)).toHaveLength(0);
		expect(await stepRunsOf(t, started.runId)).toEqual(before);
	});

	it('nothing changes: the step sends exactly once and the run moves on', async () => {
		const t = convexTest(schema, walkerModules);
		const started = await startEmailRun(t);

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: started.runId,
			stepRunId: started.stepRunId,
		});
		await fireEverythingLater(t, started);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome', 'Follow-up']);
		expect((await stepRunsOf(t, started.runId)).map((r) => r.status)).toEqual([
			'completed',
			'completed',
		]);
		expect((await runOf(t, started.runId)).status).toBe('completed');
	});
});

describe('the automation is paused after the Send is queued', () => {
	/** A two-email series with a delay between, its first email queued, not yet dispatched. */
	async function queueFirstEmail(t: T) {
		await seedSettings(t);
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ delayDays: 2 },
			{ email: 'Follow-up' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		await runDueScheduled(t);
		const [send] = await sends(t);
		if (!send) throw new Error('no Send queued');
		expect(send.status).toBe('queued');
		return { automationId, stepIds, runId, contactId, sendId: send._id };
	}

	/** The worker's last gate for the queued Send, then the completion of its answer. */
	async function dispatch(t: T, queued: Awaited<ReturnType<typeof queueFirstEmail>>) {
		const verdict = await t.query(internal.delivery.marketingDispatchGate.checkMarketingDispatch, {
			email: 'reader@example.com',
			contactId: queued.contactId,
			sendId: queued.sendId,
		});
		if (verdict === null) return verdict;
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: 'test-work-id' as never,
			result: { kind: 'success', returnValue: verdict },
			context: { sendRef: { kind: 'transactional' as const, id: queued.sendId } },
		});
		return verdict;
	}

	const pause = (t: T, automationId: Id<'automations'>) =>
		t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'paused', at: Date.now() },
			userId: 'user-1',
		});

	it('the queued email is withdrawn, the step run and the run say so, nothing counts as failed', async () => {
		const t = convexTest(schema, walkerModules);
		const queued = await queueFirstEmail(t);
		await pause(t, queued.automationId);

		expect(await dispatch(t, queued)).toEqual({ kind: 'suppressed', reason: 'automation_paused' });

		const [send] = await sends(t);
		expect(send).toMatchObject({ status: 'failed', errorCode: 'AUTOMATION_PAUSED' });
		const [emailStepRun] = await stepRunsOf(t, queued.runId);
		expect(emailStepRun).toMatchObject({
			status: 'skipped',
			emailSendId: queued.sendId,
			errorMessage: 'Automation was paused before the queued email went out; email withdrawn',
		});
		expect(emailStepRun?.failureReason).toBeUndefined();
		const run = await runOf(t, queued.runId);
		expect(run).toMatchObject({ status: 'cancelled', emailSkip: { reason: 'automation_paused' } });
		expect(run.endReason).toBeUndefined();
		const automation = await automationOf(t, queued.automationId);
		expect(automation.consecutiveRunFailures ?? 0).toBe(0);
		const step = await t.run(async (ctx) => ctx.db.get(queued.stepIds[0]!));
		expect(step).toMatchObject({ statCompleted: 0, statSkipped: 1 });
		expect(await t.run(async (ctx) => ctx.db.query('automationHealthDays').collect())).toEqual([]);
	});

	it('resuming does not bring the email back, and the ended run sends nothing more', async () => {
		const t = convexTest(schema, walkerModules);
		const queued = await queueFirstEmail(t);
		await pause(t, queued.automationId);
		vi.advanceTimersByTime(60_000);
		await t.run(async (ctx) =>
			ctx.db.patch(queued.automationId, { status: 'active', statusChangedAt: Date.now() })
		);

		// The worker reaches the Send only after the resume.
		expect(await dispatch(t, queued)).toEqual({ kind: 'suppressed', reason: 'automation_paused' });
		await advanceAndRun(t, 3 * DAY_MS);
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await runDueScheduled(t);

		expect((await sends(t)).map((s) => [s.subject, s.status])).toEqual([['Welcome', 'failed']]);
		expect((await runOf(t, queued.runId)).status).toBe('cancelled');
	});

	it('an automation that stayed active sends the queued email, and the run goes on', async () => {
		const t = convexTest(schema, walkerModules);
		const queued = await queueFirstEmail(t);

		expect(await dispatch(t, queued)).toBeNull();

		const [emailStepRun] = await stepRunsOf(t, queued.runId);
		expect(emailStepRun?.status).toBe('completed');
		expect((await runOf(t, queued.runId)).status).toBe('running');
	});
});
