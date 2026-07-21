/**
 * Suppression-list enforcement on the shared non-campaign Send chokepoint.
 *
 * `delivery/enqueue.enqueueNonCampaignSend` is the single writer for both
 * non-campaign producers — automation email steps and agent approved-replies.
 * Before PR-08 it performed NO `blockedEmails` check, so a hard-bounced /
 * complained / manually-blocked address still received automation + agent mail
 * (Gmail/Yahoo 2024 honor-suppress; CAN-SPAM §316.5). The fix adds a blocklist
 * lookup in the chokepoint that throws `recipient_blocked` and writes no row.
 *
 * Coverage here:
 *   (2) unit on enqueueNonCampaignSend — throws `recipient_blocked` and inserts
 *       no `transactionalSends` row when the recipient is suppressed; the
 *       non-blocked positive control inserts a queued row.
 *   (1) automation — a real `executeStep` run for a contact on the blocklist
 *       produces NO transactionalSends row and a skip outcome; the non-blocked
 *       positive control IS enqueued.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestBlockedEmail,
	createTestContact,
	createTestEmailTemplate,
	createTestInstanceSettings,
} from '../../__tests__/factories';

// Stub the workpool so enqueue's `enqueueAction` is a no-op (the Workpool
// component isn't registered in convexTest, and the worker action would need
// provider credentials we don't seed). We assert pre-dispatch DB state.
vi.mock('../workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `delivery/__tests__` file
// omits the sibling `delivery/*` modules (including `delivery/enqueue.ts`, the
// unit under test). Merge a second glob rooted at `delivery/` (`'../**'`) to
// recover them, re-prefixing its keys to the same `../../`-relative form so
// convex-test's single module-root prefix resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...deliveryGlob };
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

// Silence "Could not find module" rejections from the excluded workpool/worker
// modules — enqueue schedules an action whose target module is filtered out of
// this harness. The enqueue itself completes; the scheduled task can't find its
// target.
const suppressed: Error[] = [];
const onRejection = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressed.push(err);
	} else {
		throw err;
	}
};
beforeEach(() => {
	suppressed.length = 0;
	process.on('unhandledRejection', onRejection);
});
afterEach(() => {
	process.removeListener('unhandledRejection', onRejection);
});

async function seedSettings(t: TestConvex<typeof schema>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
			})
		);
	});
}

// ─── (2) Unit: the shared chokepoint ─────────────────────────────────────────

describe('delivery.enqueue.enqueueNonCampaignSend — suppression gate', () => {
	it('throws recipient_blocked and inserts no row when the recipient is blocked', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});

		await expect(
			t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
				kind: 'automation',
				email: 'blocked@example.com',
				subject: 'Hi',
				html: '<p>Hi</p>',
				from: 'Owlat <noreply@example.com>',
			})
		).rejects.toThrow('recipient_blocked');

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});

	it('throws no_delivery_provider and inserts no row when no provider is configured', async () => {
		const t = convexTest(schema, modules);
		const saved = {
			p: process.env['EMAIL_PROVIDER'],
			u: process.env['MTA_API_URL'],
			k: process.env['MTA_API_KEY'],
		};
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
		try {
			await expect(
				t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
					kind: 'automation',
					email: 'allowed@example.com',
					subject: 'Hi',
					html: '<p>Hi</p>',
					from: 'Owlat <noreply@example.com>',
				})
			).rejects.toThrow('no_delivery_provider');

			const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
			expect(rows).toHaveLength(0);
		} finally {
			if (saved.p !== undefined) process.env['EMAIL_PROVIDER'] = saved.p;
			if (saved.u !== undefined) process.env['MTA_API_URL'] = saved.u;
			if (saved.k !== undefined) process.env['MTA_API_KEY'] = saved.k;
		}
	});

	it('normalizes the lookup so a mixed-case recipient is still blocked', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'bounced' })
			);
		});

		await expect(
			t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
				kind: 'agent_reply',
				email: '  Blocked@Example.com  ',
				subject: 'Re: Hi',
				html: '<p>Re: Hi</p>',
				from: 'Owlat <noreply@example.com>',
			})
		).rejects.toThrow('recipient_blocked');

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});

	it('inserts a queued row for a non-blocked recipient (positive control)', async () => {
		const t = convexTest(schema, modules);

		const { sendId } = await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'allowed@example.com',
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		const send = await t.run(async (ctx) => ctx.db.get(sendId));
		expect(send?.status).toBe('queued');
		expect(send?.kind).toBe('automation');
		expect(send?.email).toBe('allowed@example.com');
	});

	// CL-01: the agent 1:1 reply path collapses onto the transactional envelope.
	// `enqueueNonCampaignSend` must thread `autoSubmittedType: 'auto-replied'`
	// (RFC 3834 §2 — an automatic reply to a specific message) onto the worker
	// envelope for the agent_reply kind, and must NOT set it (composer defaults to
	// `auto-generated`) nor any List-Unsubscribe wiring for a 1:1 reply.
	it('threads autoSubmittedType: auto-replied (and no List-Unsubscribe) on the agent_reply envelope', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'agent_reply',
			email: 'customer@example.com',
			subject: 'Re: your message',
			html: '<p>Thanks for reaching out.</p>',
			from: 'Owlat <support@example.com>',
		});

		expect(enqueueAction).toHaveBeenCalledTimes(1);
		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['kind']).toBe('transactional');
		expect(envelopeInput?.['emailPurpose']).toBe('transactional');
		expect(envelopeInput?.['autoSubmittedType']).toBe('auto-replied');
		expect(envelopeInput?.['listUnsubscribe']).toBeUndefined();
	});

	it('does NOT set autoSubmittedType on the automation envelope (composer defaults to auto-generated)', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'allowed@example.com',
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		expect(enqueueAction).toHaveBeenCalledTimes(1);
		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['kind']).toBe('transactional');
		expect(envelopeInput?.['emailPurpose']).toBe('marketing');
		expect(envelopeInput?.['autoSubmittedType']).toBeUndefined();
	});
});

// ─── (1) Automation: a full executeStep run ──────────────────────────────────

async function seedActiveEmailAutomation(
	t: TestConvex<typeof schema>,
	contactEmail: string
): Promise<{ automationRunId: Id<'automationRuns'>; stepRunId: Id<'automationStepRuns'> }> {
	return await t.run(async (ctx) => {
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				subject: 'Welcome {{firstName}}',
				htmlContent: '<p>Hello {{firstName}}</p>',
			})
		);
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active' })
		);
		const stepId = await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({
				automationId,
				stepIndex: 0,
				stepType: 'email',
				config: { emailTemplateId: templateId },
			})
		);
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: contactEmail, firstName: 'Pat' })
		);
		const now = Date.now();
		const automationRunId = await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: 0,
			stepsExecuted: 0,
			status: 'running' as const,
			startedAt: now,
			triggeredBy: 'manual',
		});
		const stepRunId = await ctx.db.insert('automationStepRuns', {
			automationRunId,
			automationStepId: stepId,
			stepIndex: 0,
			stepType: 'email' as const,
			status: 'pending' as const,
			scheduledAt: now,
		});
		return { automationRunId, stepRunId };
	});
}

describe('automation email step — suppression enforcement', () => {
	it('skips (no transactionalSends row) when the contact is on the blocklist', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'blocked@example.com'
		);

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});

		// The run advances/completes — the blocked recipient is a clean skip, not
		// a retryable failure.
		expect(result.success).toBe(true);

		// No Send row was produced for the suppressed recipient.
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);

		// The step run completed with no emailSendId (a no-op skip).
		const stepRun = await t.run(async (ctx) => ctx.db.get(stepRunId));
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).toBeUndefined();
	});

	it('enqueues a Send row for a non-blocked contact (positive control)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'allowed@example.com'
		);

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});
		expect(result.success).toBe(true);

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe('automation');
		expect(rows[0]?.email).toBe('allowed@example.com');
		expect(rows[0]?.status).toBe('queued');

		const stepRun = await t.run(async (ctx) => ctx.db.get(stepRunId));
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).toBe(rows[0]?._id);
	});
});
