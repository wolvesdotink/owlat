/**
 * `delivery/enqueue` — the CAMPAIGN Send enqueue chokepoint, plus the
 * member-only test preview in the sibling `delivery/enqueueTestSend.ts`.
 *
 * The two NON-campaign producers moved out of this module in PIECE C2: the
 * automation email step and the agent approved-reply now go through the
 * **Non-campaign send intake (module)** at `delivery/nonCampaignIntake.ts`,
 * whose gate sequence and typed outcome union are covered by the sibling
 * `nonCampaignIntake.test.ts` (and, per producer, by
 * `automations/__tests__/emailStepOutcomes.test.ts` and
 * `agent/__tests__/sendApprovedReply.suppression.test.ts`).
 *
 * ── G-02: `engagementScore` on the envelope ─────────────────────────────────
 *
 * The campaign producer half of the engagement-score threading.
 * `MtaExtras.engagementScore` was declared, forwarded and consumed but never
 * SET; the producer here is what now sets it. Coverage:
 *   - the campaign chokepoint forwards the per-recipient score onto each
 *     envelope independently, and an unscored recipient OMITS the field — `0`
 *     is the "cold" band and would be a different, wrong claim;
 *   - a DEGENERATE passed score is normalised away at the WRITE boundary so it
 *     can never enter a durable envelope.
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
import { TEST_SEND_RETENTION_MS } from '../enqueueTestSend';

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

describe('delivery.enqueueTestSend — durable governed preview', () => {
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
			const { sendId } = await t.mutation(internal.delivery.enqueueTestSend.enqueueTestSend, {
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
			t.mutation(internal.delivery.enqueueTestSend.deleteExpiredTestSend, {
				sendId: testId,
				queuedAt,
			})
		).resolves.toBe(true);
		await expect(
			t.mutation(internal.delivery.enqueueTestSend.deleteExpiredTestSend, {
				sendId: ordinaryId,
				queuedAt,
			})
		).resolves.toBe(false);
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows.map((row) => row._id)).toEqual([ordinaryId]);
	});
});

// ─── G-02: the engagement score is put ON THE ENVELOPE by the producer ───────
//
// The score is read from the contact row the campaign producer already holds
// (audience resolution) — never per-recipient inside the dispatch action. An
// unscored recipient OMITS the field: `0` is the "cold" band and would be a
// different, wrong claim.

describe('delivery.enqueue — engagementScore on the campaign envelope', () => {
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
