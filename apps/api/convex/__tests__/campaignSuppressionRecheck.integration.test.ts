/**
 * Regression tests — campaign worker re-checks the suppression list before
 * dispatch (2026-07-03 in-depth review finding: honor-suppression gap).
 *
 * Campaigns filter the blocklist ONCE, at audience-resolution time, then
 * enqueue. But the timezone path can schedule a send up to ~24h out and the
 * rate-limited campaign queue can run long, so a recipient who hard-bounces /
 * complains / is manually blocked AFTER resolution but BEFORE the worker runs
 * would still get the already-queued campaign email — a CAN-SPAM §316.5 /
 * Gmail-Yahoo 2024 honor-suppression violation.
 *
 * The fix adds an O(1) `blockedEmails.by_email` point read in
 * `delivery/worker.ts` (`sendSingleEmail`) immediately before dispatch. On a
 * hit the worker returns `{ success: false, suppressed: true }` WITHOUT
 * contacting any provider, and the Send completion handler
 * (`delivery/sendCompletion.ts`) finalizes the Send as a terminal, suppression-
 * labelled non-delivery (status 'failed', code RECIPIENT_SUPPRESSED).
 *
 * These tests assert both halves end-to-end.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');

const BLOCKED = 'blocked@example.com';

const originalFetch = global.fetch;

function decisionResponse(): Response {
	return new Response(JSON.stringify({ decision: 'mta', lease: { token: 'lease-clean' } }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function seedCampaignSend(
	t: ReturnType<typeof convexTest>,
	email: string
): Promise<{ emailSendId: Id<'emailSends'>; contactId: Id<'contacts'> }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
		const emailSendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: email,
				status: 'queued',
			})
		);
		return { emailSendId, contactId };
	});
}

describe('campaign worker — pre-dispatch suppression re-check', () => {
	beforeEach(() => {
		// A provider IS configured, to prove the skip happens because of the
		// blocklist re-check and not because the send would fail to route.
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('skips a recipient blocked after resolution — no provider POST, returns suppressed', async () => {
		const t = convexTest(schema, modules);
		const { emailSendId, contactId } = await seedCampaignSend(t, BLOCKED);

		// Recipient lands on the blocklist AFTER the campaign was resolved +
		// enqueued (e.g. a spam complaint from an earlier send) but BEFORE this
		// worker runs.
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: BLOCKED,
				reason: 'complained',
				createdAt: Date.now(),
			});
		});

		// Any provider POST would be a delivery — assert none happens.
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = (await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: BLOCKED,
				from: 'sender@example.com',
				providerType: 'mta',
				template: { subject: 'Hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: BLOCKED },
				emailSendId: emailSendId as never,
				convexSiteUrl: 'https://convex.example',
			},
		})) as { success: boolean; suppressed?: boolean };

		expect(result.success).toBe(false);
		expect(result.suppressed).toBe(true);
		// The suppressed recipient was NEVER dispatched to the provider.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('completion handler finalizes a suppressed worker result as failed/RECIPIENT_SUPPRESSED (not sent)', async () => {
		const t = convexTest(schema, modules);
		const { emailSendId } = await seedCampaignSend(t, BLOCKED);

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: 'test-work-id' as never,
			result: { kind: 'success', returnValue: { success: false, suppressed: true } },
			context: { sendRef: { kind: 'campaign' as const, id: emailSendId } },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(emailSendId);
			expect(send?.status).toBe('failed');
			expect(send?.status).not.toBe('sent');
			expect(send?.errorCode).toBe('RECIPIENT_SUPPRESSED');
		});
	});

	it('a clean (non-blocked) recipient is NOT short-circuited by the re-check', async () => {
		const t = convexTest(schema, modules);
		const { emailSendId, contactId } = await seedCampaignSend(t, 'clean@example.com');

		// Provider returns success — the worker must proceed past the re-check
		// and actually dispatch (one POST), proving the gate only fires on a hit.
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, id: 'mta-clean-1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = (await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'clean@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'Hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'clean@example.com' },
				emailSendId: emailSendId as never,
				convexSiteUrl: 'https://convex.example',
			},
		})) as { success: boolean; suppressed?: boolean };

		expect(result.success).toBe(true);
		expect(result.suppressed).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalled();
	});
});
