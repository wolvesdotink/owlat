import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestAutomation, createTestAutomationStep, createTestContact } from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { bumpAutomationStats, rollupAutomationStatsRow } from '../automations/statShards';

// Automation run stats are write-sharded; roll the shards into automations.stats*
// (deriving statsActive) before reading, since the production rollup is async/cron.
async function readAutomationWithStats(ctx: MutationCtx, automationId: Id<'automations'>) {
	const a = await ctx.db.get(automationId);
	if (a) await rollupAutomationStatsRow(ctx, a);
	return ctx.db.get(automationId);
}

// Exclude automationStepExecutor from modules so ctx.scheduler.runAfter() calls
// to startAutomationRun produce a harmless "Could not find module" error inside
// convex-test's scheduled-function runner instead of a real executor run that
// would need the full runtime (DB, workpool, etc).
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('automationStepExecutor'))
);

// Let any pending scheduler setTimeouts from this test fire BEFORE the next
// test calls convexTest() and replaces the global state. Without this, the
// setTimeout closure holds a stale DatabaseFake reference that has no active
// transaction, producing "Write outside of transaction" unhandled rejections.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 10));
});

// ============ fireContactCreatedTrigger ============

describe('fireContactCreatedTrigger', () => {
	it('should create runs for all active contact_created automations with steps', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a1 = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a1, stepIndex: 0 }));

			const a2 = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a2, stepIndex: 0 }));

			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(2);

		await t.run(async (ctx) => {
			for (const runId of runIds) {
				const run = await ctx.db.get(runId);
				expect(run).toBeDefined();
				expect(run!.status).toBe('running');
				expect(run!.currentStepIndex).toBe(0);
				expect(run!.triggeredBy).toBe('contact_created');
			}
		});
	});

	it('should skip draft automations', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'draft', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip paused automations', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'paused', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations with no steps', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip if contact already has a running run in that automation', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			// Pre-existing running run
			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should allow re-entry if previous run is completed', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			// Completed run should not block
			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 1,
				status: 'completed',
				startedAt: Date.now() - 100000,
				completedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);
	});

	it('should increment automation statsEntered and statsActive', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' })
			);
			// Seed the initial state into the shards (3 entered, of which 2 completed
			// ⇒ 1 active) so the rollup reproduces statsEntered 3 / statsActive 1.
			await bumpAutomationStats(ctx, automationId, { statsEntered: 3, statsCompleted: 2 });
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const automation = await readAutomationWithStats(ctx, automationId!);
			expect(automation!.statsEntered).toBe(4);
			expect(automation!.statsActive).toBe(2);
		});
	});

	it('should not fire for automations with a different trigger type', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, {
			contactId: contactId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

});

// ============ fireContactUpdatedTrigger ============

describe('fireContactUpdatedTrigger', () => {
	it('should fire for automations where triggerConfig.propertyKey is in changedProperties', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email', 'firstName'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);

		await t.run(async (ctx) => {
			const run = await ctx.db.get(runIds[0]!);
			expect(run!.triggeredBy).toBe('contact_updated');
			expect(run!.triggerData).toEqual({ propertyKey: 'email' });
		});
	});

	it('should not fire when changedProperties does not include the watched property', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['firstName', 'lastName'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations without triggerConfig', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: undefined,
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip if contact already has a running run', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_updated',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations with no steps', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
				})
			);
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should fire for multiple matching automations watching different properties', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a1 = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a1, stepIndex: 0 }));

			const a2 = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'firstName' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a2, stepIndex: 0 }));

			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email', 'firstName'],
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(2);
	});

	it('should increment automation stats', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'email' },
					statsEntered: 0,
					statsActive: 0,
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await t.mutation(internal.automations.triggers.fireContactUpdatedTrigger, {
			contactId: contactId!,
			changedProperties: ['email'],
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const automation = await readAutomationWithStats(ctx, automationId!);
			expect(automation!.statsEntered).toBe(1);
			expect(automation!.statsActive).toBe(1);
		});
	});
});

// ============ fireEventReceivedTrigger ============

describe('fireEventReceivedTrigger', () => {
	it('should fire for automations where triggerConfig.eventName matches', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);
	});

	it('should not fire when eventName does not match', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'signup',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should store eventName and eventProperties in triggerData', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const eventProperties = JSON.stringify({ productId: 'abc', amount: 49.99 });

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
			eventProperties,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);

		await t.run(async (ctx) => {
			const run = await ctx.db.get(runIds[0]!);
			expect(run!.triggerData).toEqual({
				eventName: 'purchase',
				eventProperties,
			});
		});
	});

	it('should store triggerData without eventProperties when not provided', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'login' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'login',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);

		await t.run(async (ctx) => {
			const run = await ctx.db.get(runIds[0]!);
			expect(run!.triggerData).toEqual({
				eventName: 'login',
				eventProperties: undefined,
			});
		});
	});

	it('should skip automations without triggerConfig', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: undefined,
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip if contact already has a running run', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'event_received',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations with no steps', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should increment automation stats', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'event_received',
					triggerConfig: { eventName: 'purchase' },
				})
			);
			// Seed the initial state into the shards (10 entered, 5 completed ⇒ 5
			// active) so the rollup reproduces statsEntered 10 / statsActive 5.
			await bumpAutomationStats(ctx, automationId, { statsEntered: 10, statsCompleted: 5 });
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await t.mutation(internal.automations.triggers.fireEventReceivedTrigger, {
			contactId: contactId!,
			eventName: 'purchase',
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const automation = await readAutomationWithStats(ctx, automationId!);
			expect(automation!.statsEntered).toBe(11);
			expect(automation!.statsActive).toBe(6);
		});
	});
});

// ============ fireTopicSubscribedTrigger ============

describe('fireTopicSubscribedTrigger', () => {
	it('should fire for automations where triggerConfig.topicId matches', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);

		await t.run(async (ctx) => {
			const run = await ctx.db.get(runIds[0]!);
			expect(run!.triggeredBy).toBe('topic_subscribed');
			expect(run!.triggerData).toEqual({ topicId: topicId! });
		});
	});

	it('should not fire when topicId does not match', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId1: Id<'topics'>;
		let topicId2: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId1 = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			topicId2 = await ctx.db.insert('topics', {
				name: 'Updates',
				createdAt: Date.now(),
			});
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId: topicId1 },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId2!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations without triggerConfig', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: undefined,
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip if contact already has a running run', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'topic_subscribed',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should skip automations with no steps', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
				})
			);
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(0);
	});

	it('should increment automation stats', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
					statsEntered: 0,
					statsActive: 0,
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const automation = await readAutomationWithStats(ctx, automationId!);
			expect(automation!.statsEntered).toBe(1);
			expect(automation!.statsActive).toBe(1);
		});
	});

	it('should allow re-entry after previous run completed', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'topic_subscribed',
					triggerConfig: { topicId },
				})
			);
			await ctx.db.insert('automationSteps', createTestAutomationStep({ automationId: a, stepIndex: 0 }));
			contactId = await ctx.db.insert('contacts', createTestContact());

			await ctx.db.insert('automationRuns', {
				automationId: a,
				contactId,
				currentStepIndex: 1,
				status: 'completed',
				startedAt: Date.now() - 100000,
				completedAt: Date.now(),
				triggeredBy: 'topic_subscribed',
			});
		});

		const runIds = await t.mutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: contactId!,
			topicId: topicId!,
		});
		await t.finishInProgressScheduledFunctions();

		expect(runIds).toHaveLength(1);
	});
});

// ============ contact_updated fires from non-dashboard write paths ============

// The contact_updated trigger must fire regardless of HOW a built-in field
// changes — not just the dashboard edit. These cover the two write paths that
// patch built-in fields on an EXISTING contact: CSV/integration import (merge
// mode via the resolution module) and the v1 HTTP API PUT (updateForTeam).
describe('contact_updated fires from import + v1 API write paths', () => {
	async function seedContactUpdatedAutomation(
		t: ReturnType<typeof convexTest>,
		propertyKey: string,
	): Promise<Id<'automations'>> {
		return await t.run(async (ctx) => {
			const a = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey },
				}),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId: a, stepIndex: 0 }),
			);
			return a;
		});
	}

	async function countRunsFor(
		t: ReturnType<typeof convexTest>,
		automationId: Id<'automations'>,
	): Promise<number> {
		return await t.run(async (ctx) => {
			const runs = await ctx.db.query('automationRuns').collect();
			return runs.filter((r) => r.automationId === automationId).length;
		});
	}

	it('fires when a CSV import merge changes firstName', async () => {
		const t = convexTest(schema, modules);
		const automationId = await seedContactUpdatedAutomation(t, 'firstName');

		// First import creates the contact (contact_updated must NOT fire).
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'importtrigger@example.com', firstName: 'Old' }],
			source: 'csv',
			handleDuplicates: 'update',
		});
		await t.finishInProgressScheduledFunctions();
		expect(await countRunsFor(t, automationId)).toBe(0);

		// Second import merges a new firstName — the trigger must fire.
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'importtrigger@example.com', firstName: 'New' }],
			source: 'csv',
			handleDuplicates: 'update',
		});
		await t.finishInProgressScheduledFunctions();

		expect(result.updated).toBe(1);
		expect(await countRunsFor(t, automationId)).toBe(1);
	});

	it('does NOT fire when the import merge touches an unwatched property', async () => {
		const t = convexTest(schema, modules);
		// Automation watches `language`, but only firstName changes.
		const automationId = await seedContactUpdatedAutomation(t, 'language');

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'unwatched@example.com', firstName: 'Old', language: 'en' }],
			source: 'csv',
			handleDuplicates: 'update',
		});
		await t.finishInProgressScheduledFunctions();

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'unwatched@example.com', firstName: 'New', language: 'en' }],
			source: 'csv',
			handleDuplicates: 'update',
		});
		await t.finishInProgressScheduledFunctions();

		expect(await countRunsFor(t, automationId)).toBe(0);
	});

	it('fires when the v1 API updateForTeam changes firstName', async () => {
		const t = convexTest(schema, modules);
		const automationId = await seedContactUpdatedAutomation(t, 'firstName');

		const contactId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'apiupdate@example.com', firstName: 'Old' }),
			);
		});

		await t.mutation(internal.contacts.contacts.updateForTeam, {
			contactId,
			firstName: 'New',
		});
		await t.finishInProgressScheduledFunctions();

		expect(await countRunsFor(t, automationId)).toBe(1);
	});

	it('does NOT fire when updateForTeam writes an identical value', async () => {
		const t = convexTest(schema, modules);
		const automationId = await seedContactUpdatedAutomation(t, 'firstName');

		const contactId = await t.run(async (ctx) => {
			return await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'apinoop@example.com', firstName: 'Same' }),
			);
		});

		await t.mutation(internal.contacts.contacts.updateForTeam, {
			contactId,
			firstName: 'Same',
		});
		await t.finishInProgressScheduledFunctions();

		expect(await countRunsFor(t, automationId)).toBe(0);
	});
});
