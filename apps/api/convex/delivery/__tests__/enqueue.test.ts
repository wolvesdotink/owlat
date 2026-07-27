/**
 * `delivery/enqueue` — the Send enqueue chokepoints, covering the two concerns
 * that live in this module: the SUPPRESSION GATE on the shared non-campaign
 * chokepoint (PR-08) and what the producers put ON THE DURABLE ENVELOPE (G-02).
 *
 * ── PR-08: suppression-list enforcement ─────────────────────────────────────
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
 *
 * ── G-02: `engagementScore` on the envelope (`:~470` onwards) ───────────────
 *
 * The producer half of the engagement-score threading. `MtaExtras.engagementScore`
 * was declared, forwarded and consumed but never SET; the producers here are
 * what now set it. Coverage:
 *   - the non-campaign chokepoint's single indexed point read puts the contact
 *     score on the automation envelope;
 *   - an unscored contact, and a send with NO contact at all (with a scored
 *     contact seeded at the same address as a negative control, proving no
 *     lookup happens), OMIT the field — `0` is the "cold" band and would be a
 *     different, wrong claim;
 *   - the campaign chokepoint forwards the per-recipient score onto each
 *     envelope independently;
 *   - a DEGENERATE stored/passed score is normalised away at the WRITE
 *     boundary so it can never enter a durable envelope.
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
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestEmailTemplate,
	createTestInstanceSettings,
} from '../../__tests__/factories';
import { TEST_SEND_RETENTION_MS } from '../enqueue';

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

describe('delivery.enqueue.enqueueTestSend — durable governed preview', () => {
	it('creates an explicit test Send and queues the normal worker/completion contract', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const previous = {
			provider: process.env['EMAIL_PROVIDER'],
			url: process.env['MTA_API_URL'],
			key: process.env['MTA_API_KEY'],
		};
		process.env['EMAIL_PROVIDER'] = 'mta';
		process.env['MTA_API_URL'] = 'https://mta.test';
		process.env['MTA_API_KEY'] = 'test-key';
		try {
			const { sendId } = await t.mutation(internal.delivery.enqueue.enqueueTestSend, {
				email: 'member@example.com',
				organizationId: 'org-1',
				from: 'Owlat <sender@example.org>',
				subject: '[TEST] Hello',
				html: '<p>Hello</p>',
			});

			const send = await t.run(async (ctx) => ctx.db.get(sendId));
			expect(send).toMatchObject({
				kind: 'test',
				email: 'member@example.com',
				status: 'queued',
			});
			const call = enqueueAction.mock.calls[0];
			expect(call?.[2]).toMatchObject({
				envelopeInput: {
					kind: 'transactional',
					messageType: 'transactional',
					emailPurpose: 'transactional',
					organizationId: 'org-1',
					sendId,
				},
			});
			expect(call?.[3]).toMatchObject({
				context: { sendRef: { kind: 'transactional', id: sendId } },
			});
		} finally {
			if (previous.provider === undefined) delete process.env['EMAIL_PROVIDER'];
			else process.env['EMAIL_PROVIDER'] = previous.provider;
			if (previous.url === undefined) delete process.env['MTA_API_URL'];
			else process.env['MTA_API_URL'] = previous.url;
			if (previous.key === undefined) delete process.env['MTA_API_KEY'];
			else process.env['MTA_API_KEY'] = previous.key;
		}
	});

	it('deletes only an expired test row and leaves ordinary Sends untouched', async () => {
		const t = convexTest(schema, modules);
		const queuedAt = Date.now() - TEST_SEND_RETENTION_MS - 1;
		const { testId, ordinaryId } = await t.run(async (ctx) => ({
			testId: await ctx.db.insert('transactionalSends', {
				kind: 'test',
				email: 'member@example.com',
				status: 'sent',
				queuedAt,
			}),
			ordinaryId: await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'customer@example.com',
				status: 'sent',
				queuedAt,
			}),
		}));

		await expect(
			t.mutation(internal.delivery.enqueue.deleteExpiredTestSend, {
				sendId: testId,
				queuedAt,
			})
		).resolves.toBe(true);
		await expect(
			t.mutation(internal.delivery.enqueue.deleteExpiredTestSend, {
				sendId: ordinaryId,
				queuedAt,
			})
		).resolves.toBe(false);
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows.map((row) => row._id)).toEqual([ordinaryId]);
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

// ─── G-02: the engagement score is put ON THE ENVELOPE by the producers ──────
//
// The score is read from the contact row the producer already holds (campaign
// audience resolution) or with ONE indexed point read in the enqueue
// transaction (non-campaign) — never per-recipient inside the dispatch action.
// An unscored contact, and a send with no contact at all, OMIT the field: `0`
// is the "cold" band and would be a different, wrong claim.

describe('delivery.enqueue — engagementScore on the send envelope', () => {
	it('puts the contact score on the automation envelope', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'scored@example.com', engagementScore: 64 })
				)
		);

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'scored@example.com',
			contactId,
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput?.['engagementScore']).toBe(64);
	});

	it('omits the field for an unscored contact', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert('contacts', createTestContact({ email: 'unscored@example.com' }))
		);

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'unscored@example.com',
			contactId,
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput).toBeDefined();
		expect('engagementScore' in envelopeInput!).toBe(false);
	});

	it('does not look up a contact — and carries no score — when the send has none', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		// A scored contact exists for the SAME address; with no contactId on the
		// send there is no lookup, so the score must not leak onto the envelope.
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'orphan@example.com', engagementScore: 91 })
			);
		});

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'agent_reply',
			email: 'orphan@example.com',
			subject: 'Re: Hi',
			html: '<p>Re: Hi</p>',
			from: 'Owlat <support@example.com>',
		});

		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput).toBeDefined();
		expect('engagementScore' in envelopeInput!).toBe(false);
	});

	it('forwards the per-recipient score onto each campaign envelope', async () => {
		const t = convexTest(schema, modules);
		const { campaignEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(campaignEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const { campaignId, scored, unscored } = await t.run(async (ctx) => {
			const campaign = await ctx.db.insert('campaigns', createTestCampaign());
			const scoredContact = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'a@example.com', engagementScore: 77 })
			);
			const unscoredContact = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'b@example.com' })
			);
			return {
				campaignId: campaign,
				scored: {
					contactId: scoredContact,
					emailSendId: await ctx.db.insert(
						'emailSends',
						createTestEmailSend({
							campaignId: campaign,
							contactId: scoredContact,
							status: 'queued',
						})
					),
				},
				unscored: {
					contactId: unscoredContact,
					emailSendId: await ctx.db.insert(
						'emailSends',
						createTestEmailSend({
							campaignId: campaign,
							contactId: unscoredContact,
							status: 'queued',
						})
					),
				},
			};
		});

		await t.mutation(internal.delivery.enqueue.enqueueCampaignEmails, {
			campaignId,
			emails: [
				{
					emailSendId: scored.emailSendId,
					contactId: scored.contactId,
					email: 'a@example.com',
					engagementScore: 77,
				},
				{
					emailSendId: unscored.emailSendId,
					contactId: unscored.contactId,
					email: 'b@example.com',
				},
			],
			from: 'Owlat <noreply@example.com>',
			subject: 'Hi',
			htmlContent: '<p>Hi</p>',
		});

		expect(enqueueAction).toHaveBeenCalledTimes(2);
		const first = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		const second = enqueueAction.mock.calls[1]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(first?.['engagementScore']).toBe(77);
		expect(second).toBeDefined();
		expect('engagementScore' in second!).toBe(false);
	});

	// ── Adversarial: normalise at the WRITE boundary, not only on read ────────
	//
	// A degenerate stored score (an upstream scorer defect) must never enter the
	// DURABLE envelope. It would be persisted into `routingReentry.envelopeInput`,
	// handed to the MTA, and echoed back through the re-entry webhook — where a
	// NaN returns as `null`, `envelopeInputValidator` (`v.optional(v.number())`)
	// rejects it, and the deferred send's callback is silently dropped.

	it('drops a degenerate STORED score at the non-campaign write boundary', async () => {
		const t = convexTest(schema, modules);
		const { transactionalEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(transactionalEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'degenerate@example.com', engagementScore: -1 })
				)
		);

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'degenerate@example.com',
			contactId,
			subject: 'Hi',
			html: '<p>Hi</p>',
			from: 'Owlat <noreply@example.com>',
		});

		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput).toBeDefined();
		// Unknown, NOT clamped to 0 — clamping would invent the "cold" band for a
		// value that carries no information.
		expect('engagementScore' in envelopeInput!).toBe(false);
	});

	it('drops a degenerate PASSED score at the campaign write boundary', async () => {
		const t = convexTest(schema, modules);
		const { campaignEmailPool } = await import('../workpool');
		const enqueueAction = vi.mocked(campaignEmailPool.enqueueAction);
		enqueueAction.mockClear();
		const { campaignId, contactId, emailSendId } = await t.run(async (ctx) => {
			const campaign = await ctx.db.insert('campaigns', createTestCampaign());
			const contact = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'c@example.com' })
			);
			return {
				campaignId: campaign,
				contactId: contact,
				emailSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId: campaign, contactId: contact, status: 'queued' })
				),
			};
		});

		await t.mutation(internal.delivery.enqueue.enqueueCampaignEmails, {
			campaignId,
			emails: [{ emailSendId, contactId, email: 'c@example.com', engagementScore: 1_000 }],
			from: 'Owlat <noreply@example.com>',
			subject: 'Hi',
			htmlContent: '<p>Hi</p>',
		});

		const envelopeInput = enqueueAction.mock.calls[0]?.[2]?.['envelopeInput'] as
			| Record<string, unknown>
			| undefined;
		expect(envelopeInput).toBeDefined();
		expect('engagementScore' in envelopeInput!).toBe(false);
	});
});
