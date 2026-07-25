/**
 * Regression tests for FIX H1 — dispatch is the sole retry authority + a
 * stable, Send-row-derived idempotency key.
 *
 * Two guarantees are asserted end-to-end through the worker action
 * (`internal.delivery.worker.sendSingleEmail`):
 *
 *   (a) A single worker invocation that hits a retryable-then-success MTA
 *       response performs the retry INSIDE the dispatch helper — one worker
 *       run, no workpool re-run. The workpool's `maxAttempts: 1`
 *       de-amplification is asserted alongside, so the only retry authority is
 *       the dispatch helper.
 *
 *   (b) The `messageId` threaded to the MTA is STABLE across the helper's
 *       retries and DERIVED from the Send-row id — not a fresh UUID per
 *       attempt. This is what lets the MTA `/send` SET-NX dedup actually
 *       suppress a duplicate POST.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	EMAIL_WORKPOOL_RETRY_BEHAVIOR,
	transactionalEmailPool,
	campaignEmailPool,
} from '../delivery/workpool';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');

const originalFetch = global.fetch;

function decisionResponse(token: string): Response {
	return new Response(
		JSON.stringify({
			decision: 'mta',
			lease: { token, providerProbe: false, globalProbe: false },
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}
	);
}

describe('FIX H1 — workpool de-amplification', () => {
	it('both email pools share the maxAttempts:1 retry behavior (no pool-level retry)', () => {
		// `maxAttempts` is TOTAL attempts including the first (the workpool
		// component retries only while `attempts < maxAttempts`), so 1 = exactly
		// one worker run. This makes the Send dispatch helper the sole retry
		// authority.
		expect(EMAIL_WORKPOOL_RETRY_BEHAVIOR.maxAttempts).toBe(1);
	});

	it('the pools are constructed (smoke — wiring intact)', () => {
		expect(transactionalEmailPool).toBeDefined();
		expect(campaignEmailPool).toBeDefined();
	});
});

describe('FIX H1 — stable idempotency key through the worker (MTA path)', () => {
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

	it('retryable-then-success: ONE worker run, dispatch retries internally, messageId is STABLE and derived from the send-row id', async () => {
		const t = convexTest(schema, modules);

		// Seed a transactionalSends row; its id is the idempotency-key seed.
		let sendId: string;
		await t.run(async (ctx) => {
			sendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				email: 'rcpt@example.com',
				status: 'queued',
				queuedAt: Date.now(),
				subject: 'hi',
			});
		});

		// First POST: retryable 500. Second POST: success. The dispatch helper
		// owns this retry; the worker is invoked exactly once.
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse('lease-transactional'))
			.mockResolvedValueOnce(new Response('500 Internal Server Error', { status: 500 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, id: 'mta-msg-1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
				emailPurpose: 'transactional' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				sendId: sendId! as never,
				template: { subject: 'hi', htmlContent: '<p>hi</p>' },
			},
		});

		// (a) The worker returns success after the dispatch helper's internal
		//     retry. Exactly two provider POSTs (1 fail + 1 success) — the
		//     dispatch retry, NOT a workpool re-run (which would re-enter the
		//     whole worker and re-POST from scratch).
		expect(result.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(3);

		// (b) Both POSTs carry the SAME messageId, derived from the send-row id —
		//     not a fresh UUID per attempt. This is what the MTA SET-NX dedups on.
		const body0 = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
		const body1 = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
		expect(body0.messageId).toBe(body1.messageId);
		expect(body0.messageId).toBe(`send_${sendId!}`);
	});

	it('campaign path derives the key from emailSendId', async () => {
		const t = convexTest(schema, modules);

		let emailSendId: string;
		let contactId: string;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert('contacts', createTestContact());
			emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'queued' })
			);
		});

		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse('lease-campaign'))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, id: 'mta-msg-2' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const result = await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'campaign' as const,
				to: 'rcpt@example.com',
				from: 'sender@example.com',
				providerType: 'mta',
				organizationId: 'org-test',
				template: { subject: 'hi', htmlContent: '<p>hi</p>' },
				contactInfo: { contactId: contactId! as never, email: 'rcpt@example.com' },
				emailSendId: emailSendId! as never,
				convexSiteUrl: 'https://convex.example',
			},
		});

		expect(result.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
		expect(body.messageId).toBe(`send_${emailSendId!}`);
	});

	it('refuses a marketing automation envelope before provider dispatch when RFC 8058 headers are absent', async () => {
		const t = convexTest(schema, modules);
		const fetchSpy = vi.fn();
		global.fetch = fetchSpy as unknown as typeof fetch;

		await expect(
			t.action(internal.delivery.worker.sendSingleEmail, {
				envelopeInput: {
					kind: 'transactional' as const,
					emailPurpose: 'marketing' as const,
					to: 'rcpt@example.com',
					from: 'sender@example.com',
					providerType: 'mta',
					template: { subject: 'drip', htmlContent: '<p>drip</p>' },
				},
			})
		).rejects.toThrow('list-unsubscribe');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('dispatches automation marketing mail with both RFC 8058 headers', async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await t.run(async (ctx) => ({
			contactId: await ctx.db.insert('contacts', createTestContact()),
			sendId: await ctx.db.insert('transactionalSends', {
				kind: 'automation',
				email: 'rcpt@example.com',
				status: 'queued',
			}),
		}));
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(decisionResponse('lease-automation'))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, id: 'mta-automation-1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		await t.action(internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
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
			},
		});

		const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string) as {
			headers: Record<string, string>;
		};
		expect(body.headers['List-Unsubscribe']).toMatch(/^<https:\/\/convex\.example\/unsub\//);
		expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
	});
});
