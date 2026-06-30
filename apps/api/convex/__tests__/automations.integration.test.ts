import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestAutomation, createTestAutomationStep, createTestContact } from './factories';
import type { Id } from '../_generated/dataModel';
import type { DelayStepConfig } from '../automations/automations';
import { bumpAutomationStats, rollupAutomationStatsRow } from '../automations/statShards';

const modules = import.meta.glob('../**/*.*s');

// ============ Automation Data Model Tests ============

describe('automations - status counting pattern', () => {
	it('should correctly count by status via direct DB query', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('automations', createTestAutomation({ status: 'draft' }));
			await ctx.db.insert('automations', createTestAutomation({ status: 'draft' }));
			await ctx.db.insert('automations', createTestAutomation({ status: 'active' }));
			await ctx.db.insert('automations', createTestAutomation({ status: 'paused' }));

			const all = await ctx.db
				.query('automations')
				.collect();

			expect(all).toHaveLength(4);

			const counts = { draft: 0, active: 0, paused: 0 };
			for (const a of all) {
				counts[a.status]++;
			}
			expect(counts.draft).toBe(2);
			expect(counts.active).toBe(1);
			expect(counts.paused).toBe(1);
		});
	});

	it('should filter active automations by trigger type', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'draft', triggerType: 'contact_created' })
			);

			const active = await ctx.db
				.query('automations')
				.filter((q) => q.eq(q.field('status'), 'active'))
				.collect();

			const contactCreated = active.filter((a) => a.triggerType === 'contact_created');
			expect(contactCreated).toHaveLength(1);
		});
	});
});

// ============ Step Management ============

describe('automations - step management', () => {
	it('steps should maintain sequential ordering via index', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());

			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl1' },
				})
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 1,
					stepType: 'delay',
					config: { duration: 1, unit: 'days' },
				})
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 2,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl2' },
				})
			);

			const steps = await ctx.db
				.query('automationSteps')
				.withIndex('by_automation_and_index', (q) => q.eq('automationId', automationId))
				.collect();

			expect(steps).toHaveLength(3);
			expect(steps[0]!.stepIndex).toBe(0);
			expect(steps[0]!.stepType).toBe('email');
			expect(steps[1]!.stepIndex).toBe(1);
			expect(steps[1]!.stepType).toBe('delay');
			expect(steps[2]!.stepIndex).toBe(2);
			expect(steps[2]!.stepType).toBe('email');
		});
	});

	it('step configs should parse correctly as JSON', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 3, unit: 'hours' },
				})
			);

			const step = await ctx.db.get(stepId);
			expect(step).toBeDefined();
			const config = step!.config as DelayStepConfig;
			expect(config.duration).toBe(3);
			expect(config.unit).toBe('hours');
		});
	});

	it('condition step config should have branch targets', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'condition',
					config: {
						condition: {
							kind: 'contact_property',
							field: 'email',
							operator: 'contains',
							value: '@example.com',
						},
						yesBranchStepIndex: 1,
						noBranchStepIndex: 3,
					},
				})
			);

			const step = await ctx.db.get(stepId);
			const config = step!.config as {
				condition: { kind: string };
				yesBranchStepIndex: number;
				noBranchStepIndex: number;
			};
			expect(config.condition.kind).toBe('contact_property');
			expect(config.yesBranchStepIndex).toBe(1);
			expect(config.noBranchStepIndex).toBe(3);
		});
	});
});

// ============ Automation Runs ============

describe('automation runs', () => {
	it('should track automation run status', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active' })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());

			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});

			const run = await ctx.db.get(runId);
			expect(run?.status).toBe('running');
			expect(run?.currentStepIndex).toBe(0);
			expect(run?.triggeredBy).toBe('contact_created');
		});
	});

});

// ============ Automation Step Runs ============

describe('automation step runs', () => {
	it('should track step execution status transitions', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active' })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl1' },
				})
			);
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});

			const stepRunId = await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: 0,
				stepType: 'email',
				status: 'pending',
				scheduledAt: Date.now(),
			});

			const stepRun = await ctx.db.get(stepRunId);
			expect(stepRun?.status).toBe('pending');
			expect(stepRun?.stepType).toBe('email');
		});
	});

	it('should support delay step runs with delayUntil', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const delayUntil = now + 86_400_000;

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active' })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 1, unit: 'days' },
				})
			);
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: now,
				nextStepAt: delayUntil,
				triggeredBy: 'contact_created',
			});

			const stepRunId = await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: 0,
				stepType: 'delay',
				status: 'pending',
				scheduledAt: now,
				delayUntil,
			});

			const stepRun = await ctx.db.get(stepRunId);
			expect(stepRun?.delayUntil).toBe(delayUntil);
			expect(stepRun?.stepType).toBe('delay');
		});
	});

	it('markStepExecuting claims a pending step exactly once (dedupe) and bumps stepsExecuted', async () => {
		const t = convexTest(schema, modules);
		let runId: Id<'automationRuns'>;
		let stepRunId: Id<'automationStepRuns'>;

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active' })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl1' },
				})
			);
			runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			stepRunId = await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: 0,
				stepType: 'email',
				status: 'pending',
				scheduledAt: Date.now(),
			});
		});

		// Two schedulers (original runAfter + the processPendingDelays cron) can
		// target the same pending step. Only the first claim must win.
		const first = await t.mutation(
			internal.automations.stepExecutorQueries.markStepExecuting,
			{ stepRunId: stepRunId! }
		);
		const second = await t.mutation(
			internal.automations.stepExecutorQueries.markStepExecuting,
			{ stepRunId: stepRunId! }
		);

		expect(first.claimed).toBe(true);
		expect(first.stepsExecuted).toBe(1);
		expect(second.claimed).toBe(false); // already executing — duplicate dropped
		expect(second.stepsExecuted).toBe(1); // counter not double-bumped

		await t.run(async (ctx) => {
			const run = await ctx.db.get(runId!);
			expect(run?.stepsExecuted).toBe(1);
			const stepRun = await ctx.db.get(stepRunId!);
			expect(stepRun?.status).toBe('executing');
		});
	});
});

describe('denormalized step-run status counters (getStepAnalytics source)', () => {
	it('createStepRun → markStepExecuting → markStepCompleted maintains the step counters', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl1' },
				}),
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			return { stepId, runId };
		});

		const stepRunId = await t.mutation(internal.automations.stepExecutorQueries.createStepRun, {
			automationRunId: ids.runId,
			automationStepId: ids.stepId,
			stepIndex: 0,
			stepType: 'email',
		});
		expect((await t.run(async (ctx) => ctx.db.get(ids.stepId)))?.statPending).toBe(1);

		await t.mutation(internal.automations.stepExecutorQueries.markStepExecuting, { stepRunId });
		let step = await t.run(async (ctx) => ctx.db.get(ids.stepId));
		expect(step?.statPending).toBe(0);
		expect(step?.statExecuting).toBe(1);

		await t.mutation(internal.automations.stepExecutorQueries.markStepCompleted, { stepRunId });
		step = await t.run(async (ctx) => ctx.db.get(ids.stepId));
		expect(step?.statExecuting).toBe(0);
		expect(step?.statCompleted).toBe(1);

		// Idempotent: a duplicate completion does not double-count.
		await t.mutation(internal.automations.stepExecutorQueries.markStepCompleted, { stepRunId });
		expect((await t.run(async (ctx) => ctx.db.get(ids.stepId)))?.statCompleted).toBe(1);
	});

	it('a duplicate terminal firing does not flip completed→failed or re-count', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			const stepId = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: 'tmpl1' },
				}),
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			return { stepId, runId };
		});

		const stepRunId = await t.mutation(internal.automations.stepExecutorQueries.createStepRun, {
			automationRunId: ids.runId,
			automationStepId: ids.stepId,
			stepIndex: 0,
			stepType: 'email',
		});
		await t.mutation(internal.automations.stepExecutorQueries.markStepExecuting, { stepRunId });
		await t.mutation(internal.automations.stepExecutorQueries.markStepCompleted, { stepRunId });

		// Duplicate firing tries to fail the already-completed step run — must be a no-op.
		await t.mutation(internal.automations.stepExecutorQueries.markStepFailed, {
			stepRunId,
			errorMessage: 'late failure',
			retryCount: 0,
		});

		const step = await t.run(async (ctx) => ctx.db.get(ids.stepId));
		expect(step?.statCompleted).toBe(1);
		expect(step?.statFailed ?? 0).toBe(0); // never incremented — no flip
		expect((await t.run(async (ctx) => ctx.db.get(stepRunId)))?.status).toBe('completed');
	});

	it('a duplicate cancel does not double-decrement statsActive', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation({}));
			// Seed 2 entered (⇒ 2 active) into the shards.
			await bumpAutomationStats(ctx, automationId, { statsEntered: 2 });
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			return { automationId, runId };
		});

		await t.mutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
			automationRunId: ids.runId,
		});
		// Duplicate firing — the run is already cancelled, so stats must not move again.
		await t.mutation(internal.automations.stepExecutorQueries.cancelAutomationRun, {
			automationRunId: ids.runId,
		});

		// Roll the shards into stats* (deriving statsActive = entered − completed −
		// cancelled). Only ONE cancel counted ⇒ 2 − 1 = 1, not 2 − 2 = 0.
		const automation = await t.run(async (ctx) => {
			const a = await ctx.db.get(ids.automationId);
			if (a) await rollupAutomationStatsRow(ctx, a);
			return ctx.db.get(ids.automationId);
		});
		expect(automation?.statsActive).toBe(1); // 2 → 1, not 2 → 0
	});

	it('markStepsSkipped writes skipped step runs and bumps statSkipped for bypassed steps', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			// 4 steps: a condition at 0 branching forward to step 3 skips 1 and 2.
			const step0 = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 0, stepType: 'condition' }),
			);
			const step1 = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 1, stepType: 'email' }),
			);
			const step2 = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 2, stepType: 'delay' }),
			);
			const step3 = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 3, stepType: 'email' }),
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			return { step0, step1, step2, step3, runId };
		});

		// Condition at index 0 branches forward to index 3 — steps 1 and 2 skipped.
		await t.mutation(internal.automations.stepExecutorQueries.markStepsSkipped, {
			automationRunId: ids.runId,
			fromStepIndex: 1,
			toStepIndex: 3,
		});

		const [s1, s2, s3] = await t.run(async (ctx) => [
			await ctx.db.get(ids.step1),
			await ctx.db.get(ids.step2),
			await ctx.db.get(ids.step3),
		]);
		expect(s1?.statSkipped).toBe(1);
		expect(s2?.statSkipped).toBe(1);
		expect(s3?.statSkipped ?? 0).toBe(0); // the branch target is not skipped

		// One skipped step-run row exists per bypassed step.
		const skippedRuns = await t.run(async (ctx) =>
			ctx.db
				.query('automationStepRuns')
				.withIndex('by_automation_run', (q) => q.eq('automationRunId', ids.runId))
				.collect(),
		);
		expect(skippedRuns).toHaveLength(2);
		expect(skippedRuns.every((r) => r.status === 'skipped')).toBe(true);
		expect(skippedRuns.map((r) => r.stepIndex).sort()).toEqual([1, 2]);
	});

	it('markStepsSkipped is a no-op for a sequential or backward advance', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			const step1 = await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 1, stepType: 'email' }),
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
			return { step1, runId };
		});

		// Sequential advance (from 1, to 1) skips nothing.
		await t.mutation(internal.automations.stepExecutorQueries.markStepsSkipped, {
			automationRunId: ids.runId,
			fromStepIndex: 1,
			toStepIndex: 1,
		});

		const step1 = await t.run(async (ctx) => ctx.db.get(ids.step1));
		expect(step1?.statSkipped ?? 0).toBe(0);
		const runs = await t.run(async (ctx) =>
			ctx.db
				.query('automationStepRuns')
				.withIndex('by_automation_run', (q) => q.eq('automationRunId', ids.runId))
				.collect(),
		);
		expect(runs).toHaveLength(0);
	});
});
