/**
 * The worker's last gate before dispatching a MARKETING envelope checks the
 * contact as well as the blocklist.
 *
 * A re-check that ran for campaign envelopes only and read the blocklist only
 * would let an automation Send go out that was enqueued before the contact
 * unsubscribed from everything (no blocklist row) or was soft-deleted.
 *
 * Covers the after-enqueue half: the automation Send is already queued when
 * the contact changes. The worker returns `suppressed` with the contact reason
 * and never reaches a provider; the completion handler records a terminal
 * non-delivery with its own code. Transactional mail keeps its policy.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestInstanceSettings,
} from './factories';
import { SENDING_HOLD_RECHECK_MS } from '../workspaces/abuseGate';

const modules = import.meta.glob('../**/*.*s');

const originalFetch = global.fetch;

function decisionResponse(): Response {
	return new Response(
		JSON.stringify({
			decision: 'mta',
			lease: { token: 'lease-clean', providerProbe: false, globalProbe: false },
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

function acceptedResponse(id: string): Response {
	return new Response(JSON.stringify({ success: true, id }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function seedQueuedAutomationSend(
	t: ReturnType<typeof convexTest>,
	contactState: Record<string, unknown> = {}
): Promise<{ sendId: Id<'transactionalSends'>; contactId: Id<'contacts'> }> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'reader@example.com', ...contactState })
		);
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'automation',
			email: 'reader@example.com',
			contactId,
			status: 'queued',
			queuedAt: Date.now(),
			subject: 'Follow-up',
		});
		return { sendId, contactId };
	});
}

function automationEnvelope(
	sendId: Id<'transactionalSends'>,
	contactId: Id<'contacts'>,
	emailPurpose: 'marketing' | 'transactional' = 'marketing'
) {
	return {
		kind: 'transactional' as const,
		deliveryDomain: 'production' as const,
		messageType: 'automation' as const,
		emailPurpose,
		to: 'reader@example.com',
		from: 'sender@example.com',
		providerType: 'mta',
		organizationId: 'org-test',
		sendId,
		contactId,
		template: { subject: 'Follow-up', htmlContent: '<p>hi</p>' },
		...(emailPurpose === 'marketing'
			? { listUnsubscribe: true, convexSiteUrl: 'https://convex.example' }
			: {}),
	};
}

describe('worker — marketing dispatch gate', () => {
	beforeEach(() => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
		vi.stubEnv('INSTANCE_SECRET', 'test-routing-reentry-secret-32-bytes-minimum');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it.each([
		['contact_unsubscribed', { unsubscribedAt: 1 }],
		['contact_deleted', { deletedAt: 1, deletedBy: 'user-1' }],
	] as const)(
		'an automation Send whose contact became %s after enqueue is never dispatched',
		async (reason, contactState) => {
			const t = convexTest(schema, modules);
			const { sendId, contactId } = await seedQueuedAutomationSend(t);
			await t.run(async (ctx) => ctx.db.patch(contactId, contactState));

			const fetchSpy = vi.fn();
			global.fetch = fetchSpy as unknown as typeof fetch;

			const result = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: automationEnvelope(sendId, contactId),
			});

			expect(result).toEqual({ kind: 'suppressed', reason });
			expect(fetchSpy).not.toHaveBeenCalled();
		}
	);

	it('a Send whose contact row was erased is never dispatched', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId } = await seedQueuedAutomationSend(t);
		await t.run(async (ctx) => ctx.db.delete(contactId));
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: automationEnvelope(sendId, contactId),
		});

		expect(result).toEqual({ kind: 'suppressed', reason: 'contact_deleted' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('an automation Send to a blocklisted address is suppressed (the old campaign-only gap)', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId } = await seedQueuedAutomationSend(t);
		await t.run(async (ctx) =>
			ctx.db.insert('blockedEmails', {
				email: 'reader@example.com',
				reason: 'complained',
				createdAt: Date.now(),
			})
		);
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: automationEnvelope(sendId, contactId),
		});

		expect(result).toEqual({ kind: 'suppressed' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('a campaign envelope for a contact that unsubscribed after resolution is suppressed', async () => {
		const t = convexTest(schema, modules);
		const { emailSendId, contactId } = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'reader@example.com', unsubscribedAt: Date.now() })
			);
			const emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					contactEmail: 'reader@example.com',
					status: 'queued',
				})
			);
			return { emailSendId, contactId };
		});
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'reader@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				template: { subject: 'Hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'reader@example.com' },
				emailSendId,
				convexSiteUrl: 'https://convex.example',
			},
		});

		expect(result).toEqual({ kind: 'suppressed', reason: 'contact_unsubscribed' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('transactional mail to an unsubscribed contact is not gated by the marketing rule', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId } = await seedQueuedAutomationSend(t, { unsubscribedAt: 1 });
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse())
			.mockResolvedValueOnce(acceptedResponse('mta-receipt-1'));
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: automationEnvelope(sendId, contactId, 'transactional'),
		});

		expect(result.kind).toBe('accepted');
		expect(fetchSpy).toHaveBeenCalled();
	});

	it('a held transactional template Send to an address blocked since intake is never dispatched', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId } = await seedQueuedAutomationSend(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(sendId, { kind: 'transactional' });
			await ctx.db.insert('blockedEmails', {
				email: 'reader@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				createdAt: Date.now(),
			});
		});
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: automationEnvelope(sendId, contactId, 'transactional'),
		});
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: 'test-work-id' as never,
			result: { kind: 'success', returnValue: result },
			context: { sendRef: { kind: 'transactional' as const, id: sendId } },
		});

		expect(result).toEqual({ kind: 'suppressed' });
		expect(fetchSpy).not.toHaveBeenCalled();
		const send = await t.run(async (ctx) => ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
		expect(send?.errorCode).toBe('RECIPIENT_SUPPRESSED');
	});

	it('a marketing-only suppression does not stop a transactional Send at dispatch', async () => {
		const t = convexTest(schema, modules);
		const { sendId, contactId } = await seedQueuedAutomationSend(t);
		await t.run(async (ctx) =>
			ctx.db.insert('blockedEmails', {
				email: 'reader@example.com',
				reason: 'unengaged',
				createdAt: Date.now(),
			})
		);
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse())
			.mockResolvedValueOnce(acceptedResponse('mta-receipt-2'));
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: automationEnvelope(sendId, contactId, 'transactional'),
		});

		expect(result.kind).toBe('accepted');
	});

	describe('while sending is suspended', () => {
		async function setAbuseStatus(
			t: ReturnType<typeof convexTest>,
			to: 'clean' | 'warned' | 'suspended'
		) {
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').first();
				if (settings) await ctx.db.patch(settings._id, { abuseStatus: to });
				else
					await ctx.db.insert('instanceSettings', createTestInstanceSettings({ abuseStatus: to }));
			});
		}

		async function seedQueuedCampaignSend(t: ReturnType<typeof convexTest>) {
			return await t.run(async (ctx) => {
				const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'reader@example.com' })
				);
				const emailSendId = await ctx.db.insert(
					'emailSends',
					createTestEmailSend({
						campaignId,
						contactId,
						contactEmail: 'reader@example.com',
						status: 'queued',
					})
				);
				return { emailSendId, contactId };
			});
		}

		function campaignEnvelope(emailSendId: Id<'emailSends'>, contactId: Id<'contacts'>) {
			return {
				kind: 'campaign' as const,
				to: 'reader@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'Hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'reader@example.com' },
				emailSendId,
				convexSiteUrl: 'https://convex.example',
			};
		}

		it('holds a campaign envelope instead of dispatching it, spending no attempt', async () => {
			vi.useFakeTimers();
			const t = convexTest(schema, modules);
			await setAbuseStatus(t, 'suspended');
			const { emailSendId, contactId } = await seedQueuedCampaignSend(t);
			const fetchSpy = vi.fn();
			global.fetch = fetchSpy as unknown as typeof fetch;

			const result = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: campaignEnvelope(emailSendId, contactId),
			});

			expect(result).toMatchObject({
				kind: 'deferred',
				deferralOrigin: 'local',
				hold: 'sending_suspended',
				retryState: { attempt: 1, startedAt: Date.now(), idempotencyKey: `send_${emailSendId}` },
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('holds a marketing automation envelope too', async () => {
			const t = convexTest(schema, modules);
			await setAbuseStatus(t, 'suspended');
			const { sendId, contactId } = await seedQueuedAutomationSend(t);
			const fetchSpy = vi.fn();
			global.fetch = fetchSpy as unknown as typeof fetch;

			const result = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: automationEnvelope(sendId, contactId),
			});

			expect(result).toMatchObject({ kind: 'deferred', hold: 'sending_suspended' });
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('dispatches the held envelope exactly once after the suspension is lifted', async () => {
			const t = convexTest(schema, modules);
			await setAbuseStatus(t, 'suspended');
			const { emailSendId, contactId } = await seedQueuedCampaignSend(t);
			global.fetch = vi.fn() as unknown as typeof fetch;
			const held = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: campaignEnvelope(emailSendId, contactId),
			});
			if (held.kind !== 'deferred') throw new Error(`expected a hold, got ${held.kind}`);

			await setAbuseStatus(t, 'clean');
			const fetchSpy = vi
				.fn()
				.mockResolvedValueOnce(decisionResponse())
				.mockResolvedValueOnce(acceptedResponse(`send_${emailSendId}`));
			global.fetch = fetchSpy as unknown as typeof fetch;
			const resumed = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: held.envelopeInput,
				retryState: held.retryState,
			});

			expect(resumed.kind).toBe('accepted');
			const sendCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/send'));
			expect(sendCalls).toHaveLength(1);
		});

		it('a warned workspace holds nothing', async () => {
			const t = convexTest(schema, modules);
			await setAbuseStatus(t, 'warned');
			const { emailSendId, contactId } = await seedQueuedCampaignSend(t);
			const fetchSpy = vi
				.fn()
				.mockResolvedValueOnce(decisionResponse())
				.mockResolvedValueOnce(acceptedResponse(`send_${emailSendId}`));
			global.fetch = fetchSpy as unknown as typeof fetch;

			const result = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: campaignEnvelope(emailSendId, contactId),
			});

			expect(result.kind).toBe('accepted');
		});

		it('transactional mail is not held by a suspension', async () => {
			const t = convexTest(schema, modules);
			await setAbuseStatus(t, 'suspended');
			const { sendId, contactId } = await seedQueuedAutomationSend(t);
			const fetchSpy = vi
				.fn()
				.mockResolvedValueOnce(decisionResponse())
				.mockResolvedValueOnce(acceptedResponse('mta-receipt-1'));
			global.fetch = fetchSpy as unknown as typeof fetch;

			const result = await t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: automationEnvelope(sendId, contactId, 'transactional'),
			});

			expect(result.kind).toBe('accepted');
		});

		it('completion keeps a held send queued and re-enters it, then fails it by name at the deadline', async () => {
			vi.useFakeTimers();
			const t = convexTest(schema, modules);
			const { sendId, contactId } = await seedQueuedAutomationSend(t);
			const envelopeInput = automationEnvelope(sendId, contactId);
			const heldOutcome = (startedAt: number) => ({
				kind: 'deferred' as const,
				retryAfterMs: SENDING_HOLD_RECHECK_MS,
				deferralOrigin: 'local' as const,
				hold: 'sending_suspended' as const,
				envelopeInput,
				retryState: { attempt: 1, startedAt, idempotencyKey: `send_${sendId}` },
			});

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				workId: 'test-work-id' as never,
				result: { kind: 'success', returnValue: heldOutcome(Date.now()) },
				context: { sendRef: { kind: 'transactional' as const, id: sendId } },
			});
			expect((await t.run(async (ctx) => ctx.db.get(sendId)))?.status).toBe('queued');

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				workId: 'test-work-id' as never,
				result: {
					kind: 'success',
					returnValue: heldOutcome(Date.now() - GOVERNED_MTA_MAX_MESSAGE_AGE_MS),
				},
				context: { sendRef: { kind: 'transactional' as const, id: sendId } },
			});
			const send = await t.run(async (ctx) => ctx.db.get(sendId));
			expect(send?.status).toBe('failed');
			expect(send?.errorCode).toBe('SENDING_SUSPENDED');
			vi.clearAllTimers();
			vi.useRealTimers();
		});
	});

	it.each([
		['contact_unsubscribed', 'RECIPIENT_UNSUBSCRIBED'],
		['contact_deleted', 'CONTACT_DELETED'],
	] as const)(
		'completion records a %s refusal as a terminal non-delivery with code %s',
		async (reason, errorCode) => {
			const t = convexTest(schema, modules);
			const { sendId } = await seedQueuedAutomationSend(t);

			await t.mutation(internal.delivery.sendCompletion.completeSend, {
				workId: 'test-work-id' as never,
				result: { kind: 'success', returnValue: { kind: 'suppressed', reason } },
				context: { sendRef: { kind: 'transactional' as const, id: sendId } },
			});

			const send = await t.run(async (ctx) => ctx.db.get(sendId));
			expect(send?.status).toBe('failed');
			expect(send?.errorCode).toBe(errorCode);
		}
	);
});
