/**
 * Focused per-effect tests for the four sendLifecycle effects introduced
 * by ADR-0006: campaign_stats_failed, email.sent customer_webhook,
 * email_sent contact_activity, attachment_cleanup.
 *
 * The broader state-machine semantics (legal edges, duplicate detection,
 * terminal handling) are covered by `convex/__tests__/sendLifecycle.
 * integration.test.ts`. This file isolates each new effect's behavior.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { summarize } from '../analytics/sendingReputation';

// Fixed clock for deterministic timestamps in the non-campaign Send tests.
const NOW = 1_700_000_000_000;
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTransactionalEmail,
} from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { rollupCampaignStatsRow } from '../campaigns/statShards';

const modules = import.meta.glob('../**/*.*s');

// Campaign send stats are write-sharded; roll the shards into campaigns.stats*
// before reading (the production rollup is async/cron).
async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const c = await ctx.db.get(campaignId);
	if (c) await rollupCampaignStatsRow(ctx, c);
	return ctx.db.get(campaignId);
}

// The lifecycle schedules webhook fanout and reputation updates via
// ctx.scheduler.runAfter(0, …); let those drain before convex-test resets
// global state — otherwise we leak "Write outside of transaction" errors.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

// ============================================================================
// campaign_stats_failed
// ============================================================================

describe('campaign_stats_failed effect', () => {
	it('queued → failed bumps campaigns.statsFailed for campaign sends', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsFailed: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'provider rejected',
				errorCode: 'WORKPOOL_FAILED',
			},
		});

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsFailed).toBe(1);
		});
	});

	it('does not fire for transactional sends', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId,
				email: 'user@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'provider rejected',
				errorCode: 'WORKPOOL_FAILED',
			},
		});

		// No campaign to bump; no error means the kind-guard works.
		await t.run(async (ctx) => {
			const tx = await ctx.db.get(txSendId!);
			expect(tx?.status).toBe('failed');
			expect(tx?.errorCode).toBe('WORKPOOL_FAILED');
		});
	});

	it('accumulates across multiple failures', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		const sendIds: Id<'emailSends'>[] = [];
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsFailed: 0 })
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			for (let i = 0; i < 3; i++) {
				const id = await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId, status: 'queued' })
				);
				sendIds.push(id);
			}
		});

		for (const id of sendIds) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id },
				transition: {
					to: 'failed',
					at: Date.now(),
					errorMessage: 'err',
					errorCode: 'WORKPOOL_FAILED',
				},
			});
		}

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsFailed).toBe(3);
		});
	});
});

// ============================================================================
// email.sent customer_webhook
// ============================================================================

async function setupSubscriber(
	t: ReturnType<typeof convexTest>,
	events: Array<'email.sent' | 'email.delivered'>
): Promise<Id<'webhooks'>> {
	let webhookId: Id<'webhooks'>;
	await t.run(async (ctx) => {
		webhookId = await ctx.db.insert('webhooks', {
			name: 'test-webhook',
			url: 'https://example.test/hook',
			events,
			secret: 'shh',
			isActive: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
	return webhookId!;
}

describe('email.sent customer_webhook effect', () => {
	// We assert at the scheduler-queue level rather than the
	// webhookDeliveryLogs row level: the fanout chain
	// (scheduleFanout → fanoutEvent action → createDeliveryLog + scheduler →
	// deliverWebhookInternal) involves a `'use node'` action that does not
	// drain reliably under convex-test's edge runtime. Asserting that the
	// lifecycle scheduled the fanout action with the right payload covers
	// the lifecycle's responsibility; the fanout chain itself is exercised
	// by `webhooks/__tests__/`.
	it('queued → sent schedules an email.sent fanout for campaign sends', async () => {
		const t = convexTest(schema, modules);
		await setupSubscriber(t, ['email.sent']);

		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign()
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					contactEmail: 'alice@example.com',
					status: 'queued',
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'msg-1',
			},
		});

		const fanoutJobs = await t.run(async (ctx) => {
			const jobs = await ctx.db.system
				.query('_scheduled_functions')
				.collect();
			return jobs.filter(
				(j) =>
					j.name.includes('fanout') &&
					j.args[0]?.event === 'email.sent'
			);
		});

		expect(fanoutJobs).toHaveLength(1);
		expect(fanoutJobs[0]!.args[0].data).toMatchObject({
			email: 'alice@example.com',
			campaignId: expect.any(String),
			transactionalEmailId: null,
		});
	});

	it('payload carries transactionalEmailId for transactional sends', async () => {
		const t = convexTest(schema, modules);
		await setupSubscriber(t, ['email.sent']);

		let txSendId: Id<'transactionalSends'>;
		let txEmailId: Id<'transactionalEmails'>;
		await t.run(async (ctx) => {
			txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'bob@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'tx-msg-1',
			},
		});

		const fanoutJobs = await t.run(async (ctx) => {
			const jobs = await ctx.db.system
				.query('_scheduled_functions')
				.collect();
			return jobs.filter(
				(j) =>
					j.name.includes('fanout') &&
					j.args[0]?.event === 'email.sent'
			);
		});

		expect(fanoutJobs).toHaveLength(1);
		expect(fanoutJobs[0]!.args[0].data).toMatchObject({
			email: 'bob@example.com',
			campaignId: null,
			transactionalEmailId: txEmailId!,
		});
	});

	it('schedules an email.sent fanout regardless of subscribers (filtering is the fanout action\'s job)', async () => {
		// The lifecycle is intentionally agnostic of who subscribes — it
		// always emits the customer_webhook effect on `sent`, and the
		// fanout action filters to active matching subscribers when it
		// runs. Asserting the scheduled-job count here documents that
		// contract.
		const t = convexTest(schema, modules);

		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign()
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'msg-no-subs',
			},
		});

		const fanoutJobs = await t.run(async (ctx) => {
			const jobs = await ctx.db.system
				.query('_scheduled_functions')
				.collect();
			return jobs.filter(
				(j) =>
					j.name.includes('fanout') &&
					j.args[0]?.event === 'email.sent'
			);
		});

		expect(fanoutJobs).toHaveLength(1);
	});
});

// ============================================================================
// email_sent contact_activity
// ============================================================================

describe('email_sent contact_activity effect', () => {
	it('queued → sent inserts email_sent activity for campaign sends', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign()
			);
			contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'queued',
					personalizedSubject: 'Hello there',
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'msg-act-1',
			},
		});

		await t.run(async (ctx) => {
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const emailSent = activities.filter((a) => a.activityType === 'email_sent');
			expect(emailSent).toHaveLength(1);
			expect(emailSent[0]!.metadata).toMatchObject({
				emailType: 'campaign',
				emailSubject: 'Hello there',
			});
		});
	});

	it('queued → sent inserts email_sent activity for transactional sends', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		let txEmailId: Id<'transactionalEmails'>;
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'tx@example.com',
				contactId,
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'tx-msg-act',
			},
		});

		await t.run(async (ctx) => {
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			const emailSent = activities.filter((a) => a.activityType === 'email_sent');
			expect(emailSent).toHaveLength(1);
			expect(emailSent[0]!.metadata).toMatchObject({
				emailType: 'transactional',
				transactionalEmailId: txEmailId,
			});
		});
	});

	it('skips the activity when contactId is missing on the send row', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'anon@example.com',
				// no contactId
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'tx-msg-anon',
			},
		});

		await t.run(async (ctx) => {
			const activities = await ctx.db
				.query('contactActivities')
				.collect();
			expect(activities).toHaveLength(0);
		});
	});
});

// ============================================================================
// attachment_cleanup
// ============================================================================

describe('attachment_cleanup effect', () => {
	it('queued → sent deletes attachmentStorageIds for transactional sends', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		let storageId: Id<'_storage'>;
		await t.run(async (ctx) => {
			const blob = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'application/octet-stream',
			});
			storageId = await ctx.storage.store(blob);
			const txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'attach@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
				attachmentStorageIds: [storageId],
			});
		});

		// Blob exists before the transition.
		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(storageId)).not.toBeNull();
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'tx-cleanup-sent',
			},
		});

		// Blob is gone after.
		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(storageId)).toBeNull();
		});
	});

	it('queued → failed also fires cleanup (terminal worker outcome)', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		let storageId: Id<'_storage'>;
		await t.run(async (ctx) => {
			const blob = new Blob([new Uint8Array([4, 5, 6])], {
				type: 'application/octet-stream',
			});
			storageId = await ctx.storage.store(blob);
			const txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'attach@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
				attachmentStorageIds: [storageId],
			});
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId! },
			transition: {
				to: 'failed',
				at: Date.now(),
				errorMessage: 'provider rejected',
				errorCode: 'WORKPOOL_FAILED',
			},
		});

		await t.run(async (ctx) => {
			expect(await ctx.storage.getUrl(storageId)).toBeNull();
		});
	});

	it('does not fire when no attachments are present', async () => {
		const t = convexTest(schema, modules);
		let txSendId: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const txEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			txSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId: txEmailId,
				email: 'noattach@example.com',
				status: 'queued' as const,
				queuedAt: Date.now(),
				// no attachmentStorageIds
			});
		});

		// The transition simply succeeds without error.
		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transition,
			{
				send: { kind: 'transactional', id: txSendId! },
				transition: {
					to: 'sent',
					at: Date.now(),
					providerMessageId: 'tx-noattach',
				},
			}
		);
		expect(outcome.ok).toBe(true);
	});

	it('does not run for campaign sends (they have no attachmentStorageIds field)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign()
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		// Just verifying the path doesn't error — the field literally doesn't
		// exist on emailSends, so the effect is correctly skipped.
		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transition,
			{
				send: { kind: 'campaign', id: sendId! },
				transition: {
					to: 'sent',
					at: Date.now(),
					providerMessageId: 'campaign-no-attach',
				},
			}
		);
		expect(outcome.ok).toBe(true);
	});

	// ── Non-campaign Send sources (automation + agent_reply) ────────────────
	//
	// Regression coverage for the lifecycle-unification fix: automation-step and
	// agent approved-reply emails now back a `transactionalSends` row (its `kind`
	// discriminates the source) instead of dispatching directly. The SAME
	// lifecycle effects therefore fire — a hard bounce inserts a blocklist row,
	// and the `send` event increments the sendingReputation denominator — which
	// the old direct-dispatch path silently skipped.
	describe('non-campaign Send sources', () => {
		async function seedNonCampaignSend(
			t: TestConvex<typeof schema>,
			kind: 'automation' | 'agent_reply',
			overrideArgs?: Record<string, unknown>,
		) {
			return await t.run(async (ctx) => {
				const sendId = await ctx.db.insert('transactionalSends', {
					kind,
					email: 'recipient@example.com',
					status: 'sent',
					sentAt: NOW,
					providerMessageId: `pm-${kind}-1`,
					...overrideArgs,
				});
				return { sendId };
			});
		}

		it.each(['automation', 'agent_reply'] as const)(
			'%s hard bounce inserts a blocklist row',
			async (kind) => {
				const t = convexTest(schema, modules);
				const { sendId } = await seedNonCampaignSend(t, kind);

				await t.mutation(internal.delivery.sendLifecycle.transition, {
					send: { kind: 'transactional', id: sendId },
					transition: { to: 'bounced', at: NOW, bounceType: 'hard' },
				});

				const blocked = await t.run(async (ctx) =>
					ctx.db
						.query('blockedEmails')
						.withIndex('by_email', (q) =>
							q.eq('email', 'recipient@example.com'),
						)
						.first(),
				);
				expect(blocked).not.toBeNull();
				expect(blocked?.bounceType).toBe('hard');
				expect(blocked?.sourceType).toBe('transactionalSend');
			},
		);

		it.each(['automation', 'agent_reply'] as const)(
			'%s send records a sendingReputation send event (totalSent denominator)',
			async (kind) => {
				const t = convexTest(schema, modules);
				const { sendId } = await seedNonCampaignSend(t, kind, {
					status: 'queued',
				});

				// The `reputation_update` effect schedules recordEvent via
				// runAfter(0); fake timers + finishAllScheduledFunctions is
				// convex-test's supported way to drain a scheduled mutation queue
				// (a plain finishInProgress leaves the scheduled write rolled back).
				vi.useFakeTimers();
				try {
					await t.mutation(internal.delivery.sendLifecycle.transition, {
						send: { kind: 'transactional', id: sendId },
						transition: {
							to: 'sent',
							at: NOW,
							providerMessageId: `pm-${kind}-1`,
						},
					});
					await t.finishAllScheduledFunctions(vi.runAllTimers);
				} finally {
					vi.useRealTimers();
				}

				const org = await t.run(async (ctx) =>
					summarize(ctx.db, { kind: 'org' }),
				);
				expect(org.totalSent).toBeGreaterThanOrEqual(1);
			},
		);
	});
});
