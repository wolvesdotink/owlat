/**
 * Automation marketing honours contact-level unsubscribe and deletion.
 *
 * Before: the step walker only checked that the contact row EXISTED, and the
 * non-campaign intake gated on abuse / provider / blocklist. A global
 * unsubscribe stamps `contacts.unsubscribedAt` without a blocklist row, and a
 * soft-deleted contact stays readable for 30 days, so both kept receiving the
 * rest of an automation after a delay.
 *
 * Now a deleted or erased contact ends the run at the step claim (the waiting
 * step becomes `skipped`, the run `cancelled`, the cancelled counter bumped).
 * An unsubscribed contact only loses the mail: each email step is skipped and
 * the run moves on, so its other steps still run. The intake refuses the send
 * if the contact changes between the claim and the enqueue, with the same
 * split. The worker's last-gate half (after enqueue) is covered in
 * `__tests__/marketingDispatchGate.integration.test.ts`.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { emailStepModule } from '../steps/email';
import { createTestTopic } from '../../__tests__/factories';
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

async function startDrip(t: T) {
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
	expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
	return { automationId, stepIds, runId, contactId };
}

describe('contact changes while the automation waits on a delay', () => {
	const cases: Array<[string, (t: T, contactId: Id<'contacts'>) => Promise<void>]> = [
		[
			'soft deletion',
			(t, id) =>
				t.run(async (ctx) => ctx.db.patch(id, { deletedAt: Date.now(), deletedBy: 'user-1' })),
		],
		['permanent erasure', (t, id) => t.run(async (ctx) => ctx.db.delete(id))],
	];

	it.each(cases)('%s: no further marketing send, run cancelled', async (_label, change) => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { automationId, stepIds, runId, contactId } = await startDrip(t);

		await change(t, contactId);
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'skipped'],
		]);
		expect((await runOf(t, runId)).status).toBe('cancelled');
		// entered − completed − cancelled = 0 active: the counters stay right.
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 0,
			statsCancelled: 1,
		});
		const delayStep = await t.run(async (ctx) => ctx.db.get(stepIds[1]!));
		expect(delayStep?.statPending ?? 0).toBe(0);
		expect(delayStep?.statSkipped).toBe(1);
	});

	it('global unsubscribe: email steps are skipped, every other step still runs', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ delayDays: 2 },
			{ email: 'Follow-up' },
			{ delayDays: 1 },
			{ email: 'Last call' },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		await runDueScheduled(t);

		await t.run(async (ctx) => ctx.db.patch(contactId, { unsubscribedAt: Date.now() }));
		await advanceAndRun(t, 2 * DAY_MS);
		await advanceAndRun(t, DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'completed'],
			[stepIds[2], 'skipped'],
			[stepIds[3], 'completed'],
			[stepIds[4], 'skipped'],
		]);
		expect((await runOf(t, runId)).status).toBe('completed');
		expect(await runTotals(t, automationId)).toEqual({
			statsEntered: 1,
			statsCompleted: 1,
			statsCancelled: 0,
		});
		const skippedEmail = await t.run(async (ctx) => ctx.db.get(stepIds[2]!));
		expect(skippedEmail?.statSkipped).toBe(1);
		expect(skippedEmail?.statPending ?? 0).toBe(0);
		expect(skippedEmail?.statExecuting ?? 0).toBe(0);
	});

	it('an eligible contact still gets the follow-up (control)', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { runId } = await startDrip(t);

		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome', 'Follow-up']);
		expect((await runOf(t, runId)).status).toBe('completed');
	});
});

describe('contact changes between the claim and the enqueue', () => {
	it('unsubscribe: the intake refuses the send, the step is skipped and the run moves on', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { automationId, stepIds } = await seedAutomation(t, [
			{ email: 'Welcome' },
			{ delayDays: 1 },
		]);
		const { runId, contactId } = await seedRun(t, automationId);
		const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		if (started.kind !== 'scheduled') throw new Error('not started');

		const claim = await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
		});
		expect(claim.kind).toBe('claimed');
		await t.run(async (ctx) => ctx.db.patch(contactId, { unsubscribedAt: Date.now() }));

		const intake = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: started.stepRunId,
		});
		expect(intake).toEqual({
			ok: false,
			reason: 'recipient_ineligible',
			detail: 'contact_unsubscribed',
		});

		// What the walker does with the step's `contact_ineligible` outcome.
		const finalized = await t.mutation(internal.automations.stepOrchestration.finalizeStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
			outcome: { kind: 'contact_ineligible', reason: 'contact_unsubscribed' },
		});
		expect(finalized.kind).toBe('scheduled');
		expect(await sends(t)).toHaveLength(0);
		expect((await stepRunsOf(t, runId)).map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'skipped'],
			[stepIds[1], 'pending'],
		]);
		expect((await runOf(t, runId)).status).toBe('running');
	});

	it('deletion: the intake refuses the send and the run ends cancelled', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }, { delayDays: 1 }]);
		const { runId, contactId } = await seedRun(t, automationId);
		const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		if (started.kind !== 'scheduled') throw new Error('not started');
		await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
		});
		await t.run(async (ctx) => ctx.db.patch(contactId, { deletedAt: Date.now() }));

		const intake = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: started.stepRunId,
		});
		expect(intake).toMatchObject({ ok: false, detail: 'contact_deleted' });
		const finalized = await t.mutation(internal.automations.stepOrchestration.finalizeStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
			outcome: { kind: 'contact_ineligible', reason: 'contact_deleted' },
		});
		expect(finalized.kind).toBe('cancelled');
		expect((await stepRunsOf(t, runId)).map((r) => r.status)).toEqual(['skipped']);
		expect((await runOf(t, runId)).status).toBe('cancelled');
	});

	it('the email step maps the intake refusal to an ineligibility outcome, not a retry', async () => {
		const runMutation = vi.fn().mockResolvedValue({
			ok: false,
			reason: 'recipient_ineligible',
			detail: 'contact_deleted',
		});
		const runQuery = vi
			.fn()
			.mockResolvedValueOnce({ subject: 'Hi', htmlContent: '<p>Hi</p>' })
			.mockResolvedValueOnce({ defaultFromEmail: 'noreply@example.com' });

		const outcome = await emailStepModule.execute({ runQuery, runMutation } as never, {
			config: { emailTemplateId: 'template-1' },
			contact: { _id: 'contact-1', email: 'reader@example.com' } as never,
			automation: { _id: 'automation-1' } as never,
			stepRunId: 'step-run-1' as never,
		});

		expect(outcome).toEqual({ status: 'contact_ineligible', reason: 'contact_deleted' });
		expect(runMutation.mock.calls[0]?.[1]).toMatchObject({ automationStepRunId: 'step-run-1' });
	});

	it('the email step hands the intake both URLs the unsubscribe footer is built from', async () => {
		vi.stubEnv('SITE_URL', 'https://app.example');
		vi.stubEnv('CONVEX_SITE_URL', 'https://convex.example');
		try {
			const runMutation = vi.fn().mockResolvedValue({ ok: true, sendId: 'send-1', queued: true });
			const runQuery = vi
				.fn()
				.mockResolvedValueOnce({ subject: 'Hi', htmlContent: '<p>Hi</p>' })
				.mockResolvedValueOnce({ defaultFromEmail: 'noreply@example.com' });

			await emailStepModule.execute({ runQuery, runMutation } as never, {
				config: { emailTemplateId: 'template-1' },
				contact: { _id: 'contact-1', email: 'reader@example.com' } as never,
				automation: { _id: 'automation-1' } as never,
				stepRunId: 'step-run-1' as never,
			});

			expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
				listUnsubscribe: true,
				convexSiteUrl: 'https://convex.example',
				siteUrl: 'https://app.example',
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('the topic an automation belongs to', () => {
	type TopicSetup = { topicId: Id<'topics'>; otherTopicId: Id<'topics'> };

	async function seedTopics(t: T): Promise<TopicSetup> {
		return await t.run(async (ctx) => ({
			topicId: await ctx.db.insert('topics', createTestTopic({ name: 'Product updates' })),
			otherTopicId: await ctx.db.insert('topics', createTestTopic({ name: 'Promotions' })),
		}));
	}

	async function subscribe(t: T, contactId: Id<'contacts'>, topicId: Id<'topics'>) {
		await t.run(async (ctx) =>
			ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() })
		);
	}

	async function leave(t: T, contactId: Id<'contacts'>, topicId: Id<'topics'>) {
		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact_and_topic', (q) =>
					q.eq('contactId', contactId).eq('topicId', topicId)
				)
				.first();
			if (membership) await ctx.db.delete(membership._id);
		});
	}

	/** A three-step drip whose first email has gone out to a member of `memberOf`. */
	async function startTopicDrip(
		t: T,
		automation: Record<string, unknown>,
		memberOf: Id<'topics'>[]
	) {
		const { automationId, stepIds } = await seedAutomation(
			t,
			[{ email: 'Welcome' }, { delayDays: 2 }, { email: 'Follow-up' }],
			automation
		);
		const { runId, contactId } = await seedRun(t, automationId, { doiStatus: 'confirmed' });
		for (const topicId of memberOf) await subscribe(t, contactId, topicId);
		await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		await runDueScheduled(t);
		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		return { automationId, stepIds, runId, contactId };
	}

	it("leaving the trigger's topic mid-series skips the remaining emails and records why", async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { stepIds, runId, contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId } },
			[topicId]
		);

		await leave(t, contactId, topicId);
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		const stepRuns = await stepRunsOf(t, runId);
		expect(stepRuns.map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'completed'],
			[stepIds[1], 'completed'],
			[stepIds[2], 'skipped'],
		]);
		expect(stepRuns[2]?.errorMessage).toMatch(/not subscribed to the automation's topic/);
		const run = await runOf(t, runId);
		expect(run.status).toBe('completed');
		expect(run.emailSkip).toEqual({ reason: 'topic_unsubscribed', topicId });
	});

	it('an explicit topic gates an automation whose trigger has none', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId, otherTopicId } = await seedTopics(t);
		const { runId, contactId } = await startTopicDrip(t, { topicId: otherTopicId }, [
			topicId,
			otherTopicId,
		]);

		await leave(t, contactId, otherTopicId);
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		expect((await runOf(t, runId)).emailSkip).toEqual({
			reason: 'topic_unsubscribed',
			topicId: otherTopicId,
		});
	});

	it('an explicit topic replaces the trigger topic', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId, otherTopicId } = await seedTopics(t);
		const { contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId }, topicId: otherTopicId },
			[topicId, otherTopicId]
		);

		await leave(t, contactId, topicId);
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome', 'Follow-up']);
	});

	it('an automation set to no topic keeps mailing a contact who left the trigger topic', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { runId, contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId }, topicId: null },
			[topicId]
		);

		await leave(t, contactId, topicId);
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome', 'Follow-up']);
		expect((await runOf(t, runId)).emailSkip).toBeUndefined();
	});

	it('a deleted topic stops the mail, as a campaign to it reaches nobody', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId } },
			[topicId]
		);

		// `topics.remove` deletes the memberships with the topic.
		await leave(t, contactId, topicId);
		await t.run(async (ctx) => ctx.db.delete(topicId));
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
	});

	it('a membership awaiting double opt-in is not subscribed, as for a campaign', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId } },
			[topicId]
		);

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact_and_topic', (q) =>
					q.eq('contactId', contactId).eq('topicId', topicId)
				)
				.first();
			await ctx.db.patch(membership!._id, { pendingDoiConfirmation: true });
		});
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
	});

	it('the global unsubscribe wins over leaving the topic', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { runId, contactId } = await startTopicDrip(
			t,
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId } },
			[topicId]
		);

		await leave(t, contactId, topicId);
		await t.run(async (ctx) => ctx.db.patch(contactId, { unsubscribedAt: Date.now() }));
		await advanceAndRun(t, 2 * DAY_MS);

		expect((await sends(t)).map((s) => s.subject)).toEqual(['Welcome']);
		expect((await runOf(t, runId)).emailSkip).toEqual({ reason: 'contact_unsubscribed' });
	});

	it('leaving between the claim and the Send write: the intake refuses, the step is skipped', async () => {
		const t = convexTest(schema, walkerModules);
		await seedSettings(t);
		const { topicId } = await seedTopics(t);
		const { automationId, stepIds } = await seedAutomation(
			t,
			[{ email: 'Welcome' }, { delayDays: 1 }],
			{ triggerType: 'topic_subscribed', triggerConfig: { topicId } }
		);
		const { runId, contactId } = await seedRun(t, automationId, { doiStatus: 'confirmed' });
		await subscribe(t, contactId, topicId);
		const started = await t.mutation(internal.automations.stepOrchestration.beginAutomationRun, {
			automationRunId: runId,
		});
		if (started.kind !== 'scheduled') throw new Error('not started');
		const claim = await t.mutation(internal.automations.stepOrchestration.claimStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
		});
		expect(claim.kind).toBe('claimed');

		await leave(t, contactId, topicId);

		const intake = await t.mutation(internal.delivery.nonCampaignIntake.intake, {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			automationId,
			subject: 'Welcome',
			html: '<p>Hello</p>',
			from: 'Owlat <noreply@example.com>',
			automationStepRunId: started.stepRunId,
		});
		expect(intake).toEqual({
			ok: false,
			reason: 'recipient_ineligible',
			detail: 'topic_unsubscribed',
		});

		const finalized = await t.mutation(internal.automations.stepOrchestration.finalizeStepRun, {
			stepRunId: started.stepRunId,
			attempt: 0,
			outcome: { kind: 'contact_ineligible', reason: 'topic_unsubscribed' },
		});
		expect(finalized.kind).toBe('scheduled');
		expect(await sends(t)).toHaveLength(0);
		expect((await stepRunsOf(t, runId)).map((r) => [r.automationStepId, r.status])).toEqual([
			[stepIds[0], 'skipped'],
			[stepIds[1], 'pending'],
		]);
		expect((await runOf(t, runId)).emailSkip).toEqual({ reason: 'topic_unsubscribed', topicId });
	});

	it('the email step maps a topic refusal to a skip, not a deletion', async () => {
		const runMutation = vi.fn().mockResolvedValue({
			ok: false,
			reason: 'recipient_ineligible',
			detail: 'topic_unsubscribed',
		});
		const runQuery = vi
			.fn()
			.mockResolvedValueOnce({ subject: 'Hi', htmlContent: '<p>Hi</p>' })
			.mockResolvedValueOnce({ defaultFromEmail: 'noreply@example.com' });

		const outcome = await emailStepModule.execute({ runQuery, runMutation } as never, {
			config: { emailTemplateId: 'template-1' },
			contact: { _id: 'contact-1', email: 'reader@example.com' } as never,
			automation: { _id: 'automation-1' } as never,
			stepRunId: 'step-run-1' as never,
		});

		expect(outcome).toEqual({ status: 'contact_ineligible', reason: 'topic_unsubscribed' });
	});
});
