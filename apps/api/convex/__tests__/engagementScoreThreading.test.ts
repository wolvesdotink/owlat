/**
 * G-02 — the engagement score reaches the MTA.
 *
 * `MtaExtras.engagementScore` was declared, forwarded by the MTA adapter and
 * consumed by the MTA's priority bands (`mapToPriority` → GroupMQ `orderMs`),
 * but NOTHING in Convex ever set it: every governed send left Convex unscored
 * and the MTA fell back to `PRIORITY_BANDS.DEFAULT` for all mail. The score now
 * rides the durable send ENVELOPE (written by the producers at enqueue time,
 * from the contact row they already hold) and is stamped onto `MtaExtras` at
 * the dispatch boundary — no per-recipient contact read on the hot path.
 *
 * These are END-TO-END assertions through the real worker action against a
 * stubbed MTA HTTP surface: whatever the assertions below see in the POST body
 * is exactly what the adapter put on the wire.
 *
 * Absence semantics are the load-bearing part: an unscored recipient OMITS the
 * field entirely. `0` is a real score meaning "cold" (the lowest priority
 * band); sending `0` for "we don't know" would order genuinely unknown mail
 * behind every cold contact.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');

const originalFetch = global.fetch;

function decisionResponse(token: string): Response {
	return new Response(
		JSON.stringify({
			decision: 'mta',
			lease: { token, providerProbe: false, globalProbe: false },
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

/** The `/send` POST body — call index 1; index 0 is the routing decision. */
function sentBody(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
	const call = fetchSpy.mock.calls[1];
	expect(call).toBeDefined();
	return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

function mtaFetchSpy(id: string, lease: string): ReturnType<typeof vi.fn> {
	const spy = vi
		.fn()
		.mockResolvedValueOnce(decisionResponse(lease))
		.mockResolvedValueOnce(acceptedResponse(id));
	global.fetch = spy as unknown as typeof fetch;
	return spy;
}

describe('engagementScore threading — envelope → MtaExtras → MTA intake', () => {
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

	it('a CAMPAIGN send carries the envelope score to the MTA', async () => {
		const t = convexTest(schema, modules);
		const { contactId, emailSendId } = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contact = await ctx.db.insert('contacts', createTestContact({ engagementScore: 87 }));
			return {
				contactId: contact,
				emailSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId: contact, status: 'queued' })
				),
			};
		});
		const fetchSpy = mtaFetchSpy('mta-campaign-scored', 'lease-campaign');

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'rcpt@example.com' },
				emailSendId,
				convexSiteUrl: 'https://convex.example',
				engagementScore: 87,
			},
		});

		expect(result.success).toBe(true);
		expect(sentBody(fetchSpy)['engagementScore']).toBe(87);
	});

	it('an AUTOMATION send carries the envelope score to the MTA', async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await t.run(async (ctx) => ({
			contactId: await ctx.db.insert('contacts', createTestContact({ engagementScore: 42 })),
			sendId: await ctx.db.insert('transactionalSends', {
				kind: 'automation' as const,
				email: 'rcpt@example.com',
				status: 'queued' as const,
			}),
		}));
		const fetchSpy = mtaFetchSpy('mta-automation-scored', 'lease-automation');

		await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
				messageType: 'automation' as const,
				emailPurpose: 'marketing' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				sendId,
				template: { subject: 'drip', htmlContent: '<p>drip</p>' },
				contactId,
				listUnsubscribe: true,
				convexSiteUrl: 'https://convex.example',
				engagementScore: 42,
			},
		});

		expect(sentBody(fetchSpy)['engagementScore']).toBe(42);
	});

	it('a score of 0 ("cold") is a real score and is transmitted, not dropped', async () => {
		const t = convexTest(schema, modules);
		const { contactId, emailSendId } = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contact = await ctx.db.insert('contacts', createTestContact({ engagementScore: 0 }));
			return {
				contactId: contact,
				emailSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId: contact, status: 'queued' })
				),
			};
		});
		const fetchSpy = mtaFetchSpy('mta-campaign-cold', 'lease-cold');

		await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'rcpt@example.com' },
				emailSendId,
				convexSiteUrl: 'https://convex.example',
				engagementScore: 0,
			},
		});

		const body = sentBody(fetchSpy);
		expect(body['engagementScore']).toBe(0);
		expect('engagementScore' in body).toBe(true);
	});

	it('an UNSCORED recipient omits the field entirely and still dispatches', async () => {
		const t = convexTest(schema, modules);
		const { contactId, emailSendId } = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			// No engagementScore on the contact — the scorer has not reached it.
			const contact = await ctx.db.insert('contacts', createTestContact());
			return {
				contactId: contact,
				emailSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId: contact, status: 'queued' })
				),
			};
		});
		const fetchSpy = mtaFetchSpy('mta-campaign-unscored', 'lease-unscored');

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId, email: 'rcpt@example.com' },
				emailSendId,
				convexSiteUrl: 'https://convex.example',
			},
		});

		expect(result.success).toBe(true);
		const body = sentBody(fetchSpy);
		// Omitted — NOT 0 (which means cold) and NOT null. The MTA reads the
		// missing field as "unknown" and applies PRIORITY_BANDS.DEFAULT.
		expect('engagementScore' in body).toBe(false);
	});

	it('a TRANSACTIONAL send with no contact record dispatches unscored and does not throw', async () => {
		const t = convexTest(schema, modules);
		const sendId = await t.run(
			async (ctx) =>
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional' as const,
					email: 'rcpt@example.com',
					status: 'queued' as const,
					queuedAt: Date.now(),
					subject: 'receipt',
				})
		);
		const fetchSpy = mtaFetchSpy('mta-transactional-1', 'lease-transactional');

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
				emailPurpose: 'transactional' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				sendId,
				template: { subject: 'receipt', htmlContent: '<p>receipt</p>' },
			},
		});

		expect(result.success).toBe(true);
		expect('engagementScore' in sentBody(fetchSpy)).toBe(false);
	});

	it('a hostile out-of-band envelope score is treated as unknown, not clamped', async () => {
		const t = convexTest(schema, modules);
		const sendId = await t.run(
			async (ctx) =>
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional' as const,
					email: 'rcpt@example.com',
					status: 'queued' as const,
					queuedAt: Date.now(),
					subject: 'receipt',
				})
		);
		const fetchSpy = mtaFetchSpy('mta-transactional-2', 'lease-transactional-2');

		await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
				emailPurpose: 'transactional' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				sendId,
				template: { subject: 'receipt', htmlContent: '<p>receipt</p>' },
				engagementScore: 1_000,
			},
		});

		expect('engagementScore' in sentBody(fetchSpy)).toBe(false);
	});
});
