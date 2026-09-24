import { describe, it, expect } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from './factories';
import { newHarness } from './testModules';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
import { deleteAutomationRun } from '../automations/runDeletion';
import {
	bumpAutomationStats,
	rollupAutomationStatsRow,
	summarizeAutomationStats,
} from '../automations/statShards';

/**
 * Contact erasure used to delete automation runs directly: their step runs
 * were orphaned and a running run never reached a terminal state, so the
 * automation's derived active total (entered − completed − cancelled) counted
 * the erased contact as active forever. Runs now go through the run-deletion
 * lifecycle.
 */

type Harness = TestConvex<typeof schema>;
type StepRunStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';

async function seedAutomation(t: Harness) {
	return t.run(async (ctx) => {
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active' as const })
		);
		const step0 = await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepIndex: 0, stepType: 'delay' })
		);
		const step1 = await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepIndex: 1, stepType: 'delay' })
		);
		return { automationId, step0, step1 };
	});
}

/**
 * Insert a run with one step run per `[step, status]` pair, keeping the
 * automation's run counters and the steps' status gauges exactly as the step
 * walker would have left them.
 */
async function seedRun(
	t: Harness,
	automationId: Id<'automations'>,
	contactId: Id<'contacts'>,
	status: 'running' | 'completed',
	stepRuns: Array<[Id<'automationSteps'>, StepRunStatus]>
): Promise<Id<'automationRuns'>> {
	return t.run(async (ctx) => {
		const runId = await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: stepRuns.length - 1,
			status,
			startedAt: Date.now(),
			...(status === 'completed' ? { completedAt: Date.now() } : {}),
			triggeredBy: 'contact_created',
		});
		await bumpAutomationStats(ctx, automationId, {
			statsEntered: 1,
			...(status === 'completed' ? { statsCompleted: 1 } : {}),
		});
		for (const [stepId, stepStatus] of stepRuns) {
			const step = (await ctx.db.get(stepId))!;
			await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: step.stepIndex,
				stepType: step.stepType,
				status: stepStatus,
				scheduledAt: Date.now(),
				retryCount: 0,
			});
			const gauge = {
				pending: 'statPending',
				executing: 'statExecuting',
				completed: 'statCompleted',
				failed: 'statFailed',
				skipped: 'statSkipped',
			}[stepStatus] as 'statPending';
			await ctx.db.patch(stepId, { [gauge]: (step[gauge] ?? 0) + 1 });
		}
		return runId;
	});
}

describe('contact erasure — automation runs', () => {
	it('terminates active runs, removes their step runs and keeps active totals right', async () => {
		const t = newHarness();
		const { automationId, step0, step1 } = await seedAutomation(t);
		const { victimId, otherId } = await t.run(async (ctx) => ({
			victimId: await ctx.db.insert('contacts', createTestContact({})),
			otherId: await ctx.db.insert('contacts', createTestContact({})),
		}));

		// The victim has one run in flight and one finished; another contact
		// has a run in flight that must be left exactly as it is.
		await seedRun(t, automationId, victimId, 'running', [
			[step0, 'completed'],
			[step1, 'pending'],
		]);
		await seedRun(t, automationId, victimId, 'completed', [
			[step0, 'completed'],
			[step1, 'completed'],
		]);
		const otherRunId = await seedRun(t, automationId, otherId, 'running', [
			[step0, 'completed'],
			[step1, 'executing'],
		]);

		await t.run(async (ctx) => {
			await permanentlyDeleteContactWithRelations(ctx, victimId);
		});

		await t.run(async (ctx) => {
			const runs = await ctx.db.query('automationRuns').collect();
			expect(runs.map((r) => r._id)).toEqual([otherRunId]);

			// No step run outlives its run.
			const stepRuns = await ctx.db.query('automationStepRuns').collect();
			for (const stepRun of stepRuns) {
				expect(await ctx.db.get(stepRun.automationRunId)).not.toBeNull();
			}
			expect(stepRuns).toHaveLength(2);

			// Active total = runs actually running. Before the lifecycle, the
			// victim's running run was never cancelled and this read 2.
			const automation = (await ctx.db.get(automationId))!;
			await rollupAutomationStatsRow(ctx, automation);
			const rolled = (await ctx.db.get(automationId))!;
			expect(rolled.statsActive).toBe(1);
			expect(rolled.statsEntered).toBe(3);
			expect(rolled.statsCompleted).toBe(1);
			expect((await summarizeAutomationStats(ctx.db, automationId)).statsCancelled).toBe(1);

			// In-flight gauges drop the victim's pending step run; lifetime
			// completion totals keep the work that really happened.
			const s0 = (await ctx.db.get(step0))!;
			const s1 = (await ctx.db.get(step1))!;
			expect(s0.statCompleted).toBe(3);
			expect(s1.statPending ?? 0).toBe(0);
			expect(s1.statExecuting).toBe(1);
			expect(s1.statCompleted).toBe(1);
		});
	});

	it('spreads a large run over several calls, in-flight rows first, counting it once', async () => {
		const t = newHarness();
		const { automationId, step0, step1 } = await seedAutomation(t);
		const contactId = await t.run((ctx) => ctx.db.insert('contacts', createTestContact({})));
		const history: Array<[Id<'automationSteps'>, StepRunStatus]> = [];
		for (let i = 0; i < 9; i++) history.push([step0, 'skipped']);
		history.push([step1, 'pending']);
		const runId = await seedRun(t, automationId, contactId, 'running', history);

		const first = await t.run((ctx) => deleteAutomationRun(ctx, runId, 4));
		expect(first.isDeleted).toBe(false);
		await t.run(async (ctx) => {
			// The pending step run is the newest row and went in the first call.
			expect((await ctx.db.get(step1))?.statPending ?? 0).toBe(0);
			expect((await ctx.db.get(runId))?.status).toBe('cancelled');
		});

		let calls = 1;
		let done = false;
		while (!done) {
			done = (await t.run((ctx) => deleteAutomationRun(ctx, runId, 4))).isDeleted;
			calls += 1;
		}
		expect(calls).toBeGreaterThan(2);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(runId)).toBeNull();
			expect(await ctx.db.query('automationStepRuns').collect()).toHaveLength(0);
			const totals = await summarizeAutomationStats(ctx.db, automationId);
			expect(totals).toEqual({ statsEntered: 1, statsCompleted: 0, statsCancelled: 1 });
		});
	});

	it('inline erasure finishes a run with hundreds of step runs before removing the contact', async () => {
		// A run with ≥255 step runs needs more than one deletion call. The inline
		// erasure used to stop after the first, and still deleted the contact:
		// the run and 45 step runs stayed behind, and the later phases (the
		// send scrub among them) never ran.
		const t = newHarness();
		const { automationId, step0 } = await seedAutomation(t);
		const contactId = await t.run((ctx) => ctx.db.insert('contacts', createTestContact({})));
		const history: Array<[Id<'automationSteps'>, StepRunStatus]> = [];
		for (let i = 0; i < 300; i++) history.push([step0, 'skipped']);
		const runId = await seedRun(t, automationId, contactId, 'completed', history);
		const sendId = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign({}) as never);
			return ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, contactEmail: 'victim@example.com' }) as never
			);
		});

		await t.run((ctx) => permanentlyDeleteContactWithRelations(ctx, contactId));

		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			expect(await ctx.db.get(runId)).toBeNull();
			expect(await ctx.db.query('automationStepRuns').collect()).toHaveLength(0);
			expect((await ctx.db.get(sendId))?.contactEmail).toBe('[erased]');
		});
	});
});
