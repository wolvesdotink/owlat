/**
 * PR-10 — Convex blockedEmails → MTA Redis suppression mirror.
 *
 * The MTA keeps its own Redis suppression list as the last-hop deliverability
 * backstop, but it is fed only by MTA-internal events. Convex-side
 * suppressions (manual UI blocks, provider-webhook bounce/complaints, and the
 * lifecycle's bounce/complaint/suppress-after-N escalation) were never mirrored
 * to it, so the backstop could not catch the automation/agent outbound paths
 * that bypass the application-level blocklist check.
 *
 * These tests assert that inserting a `blockedEmails` row schedules a mirror
 * action that POSTs the address + (MTA-mapped) reason to the MTA
 * `POST /suppression` endpoint. They fail before the fix (no mirror call) and
 * pass after.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal, api } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from './factories';
import type { Id } from '../_generated/dataModel';
import { toMtaSuppressionReason } from '../delivery/suppressionMirror';

// Pass the org-member floor + the contacts:manage gate so the public
// blockedEmails.add mutation reaches its insert. (Same approach as
// trackingDomains.integration.test.)
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const originalFetch = global.fetch;

// Collect the JSON body of every POST to the MTA /suppression endpoint.
function suppressionCalls(fetchSpy: ReturnType<typeof vi.fn>): Array<{
	emails: string[];
	reason: string;
	source?: string;
}> {
	return fetchSpy.mock.calls
		.filter((call) => String(call[0]).endsWith('/suppression'))
		.map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

describe('toMtaSuppressionReason mapping', () => {
	it('maps a complaint to the MTA permanent complaint reason', () => {
		expect(toMtaSuppressionReason('complained')).toBe('complaint');
	});

	it('maps a hard bounce to the MTA permanent hard_bounce reason', () => {
		expect(toMtaSuppressionReason('bounced', 'hard')).toBe('hard_bounce');
		// A bounced row without an explicit bounceType is treated as hard
		// (provider-webhook addFromEvent carries no bounceType but is a real
		// bounce suppression).
		expect(toMtaSuppressionReason('bounced')).toBe('hard_bounce');
	});

	it('maps a soft-bounce escalation to the expiring manual reason', () => {
		// A suppress-after-N soft escalation is recoverable; it must not pose as a
		// permanent hard bounce on the MTA list.
		expect(toMtaSuppressionReason('bounced', 'soft')).toBe('manual');
	});

	it('maps a manual block to the MTA manual reason', () => {
		expect(toMtaSuppressionReason('manual')).toBe('manual');
	});
});

describe('blockedEmails → MTA /suppression mirror', () => {
	beforeEach(() => {
		// The mirror is scheduled with `runAfter(0, …)`, so a real-timer drain
		// (`finishInProgressScheduledFunctions`) races the still-pending timer.
		// Fake timers + `finishAllScheduledFunctions(vi.runAllTimers)` deterministically
		// fire the timer and await the action to completion.
		vi.useFakeTimers();
		vi.stubEnv('MTA_INTERNAL_URL', 'https://mta.internal');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		// Resolve every POST (suppression mirror + any drained reputation/webhook
		// fanout actions) so draining the scheduler doesn't touch the network.
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		) as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('a hard bounce through the send lifecycle mirrors the recipient to the MTA as hard_bounce', async () => {
		const t = convexTest(schema, modules);

		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'bouncer@example.com' }),
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					contactEmail: 'bouncer@example.com',
					status: 'sent',
				}),
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});

		// The lifecycle inserted the blocklist row.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'bouncer@example.com'))
				.first();
			expect(row?.reason).toBe('bounced');
		});

		// Drain the scheduled mirror action.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.emails).toEqual(['bouncer@example.com']);
		expect(calls[0]!.reason).toBe('hard_bounce');
		expect(calls[0]!.source).toBe('convex-blocklist');
	});

	it('a spam complaint through the send lifecycle mirrors the recipient to the MTA as complaint', async () => {
		const t = convexTest(schema, modules);

		let sendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'complainer@example.com' }),
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					contactEmail: 'complainer@example.com',
					status: 'delivered',
				}),
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'complained', at: Date.now() },
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.emails).toEqual(['complainer@example.com']);
		expect(calls[0]!.reason).toBe('complaint');
	});

	it('a manual blockedEmails.add mirrors the address to the MTA as manual', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.blockedEmails.add, {
			email: 'Manual@Example.com',
			reason: 'manual',
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(1);
		// Normalized (lower-cased) on the way to the MTA.
		expect(calls[0]!.emails).toEqual(['manual@example.com']);
		expect(calls[0]!.reason).toBe('manual');
	});

	it('a provider-webhook bounce (addFromEvent) mirrors the address to the MTA', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'webhook-bounce@example.com',
			reason: 'bounced',
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.emails).toEqual(['webhook-bounce@example.com']);
		expect(calls[0]!.reason).toBe('hard_bounce');
	});

	it('does NOT mirror when the address is already blocked (no duplicate insert)', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'already@example.com',
				reason: 'manual',
				createdAt: Date.now(),
			});
		});

		// addFromEvent short-circuits on the existing row — no new insert, so no
		// mirror should be scheduled.
		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: 'already@example.com',
			reason: 'bounced',
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(0);
	});

	it('does not throw when the MTA is not configured (mirror is best-effort)', async () => {
		vi.unstubAllEnvs();
		// The vitest setup seeds default MTA env; clear it so getMtaConfig() is null.
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
		const t = convexTest(schema, modules);

		// No MTA env → getMtaConfig() returns null; the action logs and returns.
		await expect(
			t.mutation(internal.blockedEmails.addFromEvent, {
				email: 'no-mta@example.com',
				reason: 'complained',
			}),
		).resolves.toBeDefined();

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const calls = suppressionCalls(global.fetch as ReturnType<typeof vi.fn>);
		expect(calls).toHaveLength(0);
	});
});
