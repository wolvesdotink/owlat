/**
 * Marketing notifications end to end inside Convex: the producers queue one
 * fan-out per occurrence, the fan-out writes one notice per member whose role
 * may act on it and whose switch is on (once, however often it runs), and the
 * app's reader drops notices whose occurrence no longer holds or that the
 * reader's current role, flags or switches no longer allow.
 *
 * Fake timers keep every scheduled job queued, so a test inspects what was
 * scheduled (and when) and runs the fan-out itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { convexTest } from 'convex-test';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestCampaign,
	createTestContact,
	createTestDomain,
	enableFeatures,
} from '../../__tests__/factories';
import { pushHarness } from '../../push/__tests__/pushFixtures';
import { getSingletonOrganizationId } from '../../lib/sessionOrganization';
import { bumpCampaignStats } from '../../campaigns/statShards';
import {
	AUTOMATION_FAILURE_BREAKER_THRESHOLD,
	recordAutomationRunFailure,
} from '../../automations/lifecycle';
import { removeSendingDomain } from '../../domains/lifecycle';
import type { MarketingNoticeEvent } from '../../lib/validators/marketingNotifications';
import { CAMPAIGN_FINISHED_SETTLE_MS, CAMPAIGN_REMINDER_LEAD_MS } from '../noticeEvents';

const session = vi.hoisted(() => ({
	userId: 'admin-1',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const current = () => ({
		userId: session.userId,
		role: session.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => current()),
		getMutationContext: vi.fn(async () => current()),
		getBetterAuthSessionWithRole: vi.fn(async () => current()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

// Sibling `marketing/*` modules glob in as `../foo.ts`; convex-test resolves
// function paths from the convex root, so re-root them.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../marketing/' + key.slice(3), load]
			: [key, load]
	)
);

type T = ReturnType<typeof convexTest>;

const MEMBERS = { 'owner-1': 'owner', 'admin-1': 'admin', 'editor-1': 'editor' } as const;
const NOW = Date.parse('2026-10-22T09:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	session.userId = 'admin-1';
	session.role = 'admin';
});

afterEach(() => {
	vi.useRealTimers();
});

async function harness(
	flags: Array<'campaigns' | 'automations' | 'transactional'> = ['campaigns', 'automations']
): Promise<T> {
	const t = await pushHarness(modules, { ...MEMBERS });
	if (flags.length > 0) await enableFeatures(t, flags);
	return t;
}

async function seedCampaign(
	t: T,
	overrides: Record<string, unknown> = {}
): Promise<Id<'campaigns'>> {
	return t.run((ctx) =>
		ctx.db.insert('campaigns', createTestCampaign({ name: 'Autumn launch', ...overrides }) as never)
	);
}

async function seedAutomation(
	t: T,
	overrides: Record<string, unknown> = {}
): Promise<Id<'automations'>> {
	return t.run((ctx) =>
		ctx.db.insert(
			'automations',
			createTestAutomation({ name: 'Welcome series', ...overrides }) as never
		)
	);
}

/** The fan-outs queued and not yet run: when each fires and for what. */
async function queuedFanOuts(t: T): Promise<Array<{ at: number; event: MarketingNoticeEvent }>> {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('marketing/notifications') && job.state.kind === 'pending')
			.map((job) => ({
				at: job.scheduledTime,
				event: (job.args[0] as { event: MarketingNoticeEvent }).event,
			}))
	);
}

function fanOut(t: T, event: MarketingNoticeEvent) {
	return t.mutation(internal.marketing.notifications.fanOut, { event });
}

async function noticesFor(t: T) {
	return t.run(async (ctx) =>
		(await ctx.db.query('marketingNotices').collect()).map((row) => ({
			userId: row.userId,
			kind: row.kind,
			name: row.name,
			percent: row.percent,
			count: row.count,
		}))
	);
}

function as(userId: keyof typeof MEMBERS) {
	session.userId = userId;
	session.role = MEMBERS[userId];
}

describe('campaign finished', () => {
	it('is queued a settle period after → sent, once per campaign', async () => {
		const t = await harness();
		const campaignId = await seedCampaign(t, { status: 'sending' });
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId,
			input: { to: 'sent', at: NOW },
			userId: 'system:send_completion',
		});
		expect(await queuedFanOuts(t)).toEqual([
			{ at: NOW + CAMPAIGN_FINISHED_SETTLE_MS, event: { kind: 'campaign_finished', campaignId } },
		]);
	});

	it('reaches every member who may manage campaigns with the fresh delivered share, exactly once', async () => {
		const t = await harness();
		const campaignId = await seedCampaign(t, { status: 'sent', statsSent: 0, statsDelivered: 0 });
		// The shards are fresher than the cached `stats*` columns on the row.
		await t.run((ctx) =>
			bumpCampaignStats(ctx, campaignId, { statsSent: 50, statsDelivered: 49, statsBounced: 1 })
		);

		expect(await fanOut(t, { kind: 'campaign_finished', campaignId })).toEqual({ written: 3 });
		expect(await fanOut(t, { kind: 'campaign_finished', campaignId })).toEqual({ written: 0 });

		const notices = await noticesFor(t);
		expect(notices.map((n) => n.userId).sort()).toEqual(['admin-1', 'editor-1', 'owner-1']);
		expect(notices.every((n) => n.percent === 98 && n.name === 'Autumn launch')).toBe(true);
	});

	it('skips a person whose switch is off, and a deleted campaign entirely', async () => {
		const t = await harness();
		as('editor-1');
		await t.mutation(api.marketing.notifications.setMyPreference, {
			preference: 'campaignFinished',
			enabled: false,
		});
		const campaignId = await seedCampaign(t, { status: 'sent' });
		expect(await fanOut(t, { kind: 'campaign_finished', campaignId })).toEqual({ written: 2 });

		const deletedId = await seedCampaign(t, { status: 'sent', deletedAt: NOW });
		expect(await fanOut(t, { kind: 'campaign_finished', campaignId: deletedId })).toEqual({
			written: 0,
		});
	});

	it('writes nothing while campaigns are switched off', async () => {
		const t = await harness(['automations']);
		// Campaigns default to on; store them off.
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			if (!settings) throw new Error('no settings row');
			await ctx.db.patch(settings._id, {
				featureFlags: { ...settings.featureFlags, campaigns: false },
			});
		});
		const campaignId = await seedCampaign(t, { status: 'sent' });
		expect(await fanOut(t, { kind: 'campaign_finished', campaignId })).toEqual({ written: 0 });
	});
});

describe('scheduled campaign reminder', () => {
	it('is queued the lead before the start, and not for a start closer than the lead', async () => {
		const t = await harness();
		const campaignId = await seedCampaign(t);
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId,
			input: { to: 'scheduled', at: NOW, scheduledAt: NOW + 2 * HOUR },
			userId: 'admin-1',
		});
		expect(await queuedFanOuts(t)).toEqual([
			{
				at: NOW + 2 * HOUR - CAMPAIGN_REMINDER_LEAD_MS,
				event: { kind: 'campaign_reminder', campaignId, scheduledAt: NOW + 2 * HOUR },
			},
		]);

		const soonId = await seedCampaign(t);
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: soonId,
			input: { to: 'scheduled', at: NOW, scheduledAt: NOW + 10 * MINUTE },
			userId: 'admin-1',
		});
		expect((await queuedFanOuts(t)).map((job) => job.event)).not.toContainEqual(
			expect.objectContaining({ campaignId: soonId })
		);
	});

	it('goes stale when the campaign was rescheduled, cancelled, deleted or started', async () => {
		const t = await harness();
		const start = NOW + 15 * MINUTE;
		const event = (campaignId: Id<'campaigns'>) =>
			({ kind: 'campaign_reminder', campaignId, scheduledAt: start }) as const;

		const moved = await seedCampaign(t, { status: 'scheduled', scheduledAt: start + HOUR });
		const cancelled = await seedCampaign(t, { status: 'cancelled', scheduledAt: start });
		const deleted = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: start,
			deletedAt: NOW,
		});
		const started = await seedCampaign(t, { status: 'sending', scheduledAt: start });
		for (const campaignId of [moved, cancelled, deleted, started]) {
			expect(await fanOut(t, event(campaignId))).toEqual({ written: 0 });
		}

		const current = await seedCampaign(t, { status: 'scheduled', scheduledAt: start });
		expect(await fanOut(t, event(current))).toEqual({ written: 3 });
	});

	it('disappears from the reader once its campaign is cancelled, and offers Cancel while current', async () => {
		const t = await harness();
		const start = NOW + 15 * MINUTE;
		const campaignId = await seedCampaign(t, { status: 'scheduled', scheduledAt: start });
		await fanOut(t, { kind: 'campaign_reminder', campaignId, scheduledAt: start });

		as('editor-1');
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([
			expect.objectContaining({
				kind: 'campaign_reminder',
				name: 'Autumn launch',
				scheduledAt: start,
				url: `/dashboard/campaigns/${campaignId}/edit`,
				cancelUrl: `/dashboard/campaigns/${campaignId}/edit?intent=cancel`,
			}),
		]);

		await t.run((ctx) => ctx.db.patch(campaignId, { status: 'cancelled' }));
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});
});

describe('delivery hold', () => {
	async function applySnapshot(t: T, appliedAt: number, breaker: boolean) {
		const organizationId = await t.run((ctx) => getSingletonOrganizationId(ctx));
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId,
			generatedAt: appliedAt,
			appliedAt,
			signals: breaker
				? [
						{
							provider: 'gmail',
							source: 'breaker_open',
							severity: 'critical',
							observedAt: appliedAt,
						},
					]
				: [],
		});
	}

	it('is queued on the edge only, and reaches admins and owners only', async () => {
		const t = await harness(['transactional']);
		await applySnapshot(t, NOW, true);
		await applySnapshot(t, NOW + MINUTE, true);
		const queued = await queuedFanOuts(t);
		expect(queued).toEqual([
			{ at: NOW, event: { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW } },
		]);

		expect(await fanOut(t, queued[0]!.event)).toEqual({ written: 2 });
		expect((await noticesFor(t)).map((n) => n.userId).sort()).toEqual(['admin-1', 'owner-1']);
	});

	it('does not repeat within the cooldown when the breaker flaps', async () => {
		const t = await harness(['transactional']);
		await applySnapshot(t, NOW, true);
		expect(await fanOut(t, { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW })).toEqual({
			written: 2,
		});
		// A second opening an hour later, while the first notice is fresh.
		expect(
			await fanOut(t, { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW + HOUR })
		).toEqual({ written: 0 });
	});

	it('writes nothing once the breaker has closed again', async () => {
		const t = await harness(['transactional']);
		expect(await fanOut(t, { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW })).toEqual({
			written: 0,
		});
	});

	it('treats a breaker snapshot older than the router trusts as closed', async () => {
		const t = await harness(['transactional']);
		// The MTA last reported the open breaker 11 minutes ago and then went quiet.
		await applySnapshot(t, NOW - 11 * MINUTE, true);
		expect(
			await fanOut(t, { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW - 11 * MINUTE })
		).toEqual({ written: 0 });

		// A notice written while the snapshot was fresh drops out once it ages.
		await applySnapshot(t, NOW, true);
		expect(await fanOut(t, { kind: 'delivery_hold', provider: 'gmail', openedAt: NOW })).toEqual({
			written: 2,
		});
		expect(await t.query(api.marketing.notifications.listRecent, {})).toHaveLength(1);
		vi.setSystemTime(NOW + 11 * MINUTE);
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});
});

describe('automation problems', () => {
	it('tallies the cancelled runs of one sweep across pages into one notice per automation', async () => {
		const t = await harness();
		const automationId = await seedAutomation(t, { status: 'paused' });
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: `c${i}@example.com` }) as never
				);
				await ctx.db.insert('automationRuns', {
					automationId,
					contactId,
					currentStepIndex: 0,
					status: 'running',
					startedAt: NOW - 2 * HOUR,
					triggeredBy: 'contact_created',
				});
			}
		});

		await t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {
			stalled: [{ automationId, count: 2 }],
			startedAt: NOW - MINUTE,
		});
		expect(await queuedFanOuts(t)).toEqual([
			{
				at: NOW,
				event: { kind: 'automation_stalled', automationId, count: 5, sweepStartedAt: NOW - MINUTE },
			},
		]);

		expect(
			await fanOut(t, {
				kind: 'automation_stalled',
				automationId,
				count: 5,
				sweepStartedAt: NOW - MINUTE,
			})
		).toEqual({ written: 2 });
		expect((await noticesFor(t))[0]).toMatchObject({ name: 'Welcome series', count: 5 });
	});

	it('is queued when the failure breaker pauses an automation', async () => {
		const t = await harness();
		const automationId = await seedAutomation(t, { status: 'active' });
		for (let i = 0; i < AUTOMATION_FAILURE_BREAKER_THRESHOLD; i++) {
			await t.run((ctx) => recordAutomationRunFailure(ctx, automationId));
		}
		const queued = (await queuedFanOuts(t)).filter((job) => job.event.kind === 'automation_paused');
		expect(queued).toEqual([
			{ at: NOW, event: { kind: 'automation_paused', automationId, pausedAt: NOW } },
		]);
		expect(await fanOut(t, queued[0]!.event)).toEqual({ written: 2 });

		// Switched back on before anyone looked: the reader drops it.
		await t.run((ctx) => ctx.db.patch(automationId, { status: 'active' }));
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});
});

describe('sending domain DNS', () => {
	async function record(
		t: T,
		domainId: Id<'domains'>,
		attemptId: string,
		status: 'pass' | 'fail' | 'warn',
		observedAt: number
	) {
		const organizationId = 'org-dns';
		const leaseToken = `lease:${attemptId}`;
		const claim = await t.mutation(internal.delivery.checklistEvidence.claimVerification, {
			organizationId,
			itemId: 'domain.spf',
			domainId,
			attemptId,
			leaseToken,
			now: observedAt,
		});
		if (!claim.claimed) throw new Error('claim failed');
		await t.mutation(internal.delivery.checklistEvidence.recordEvidence, {
			organizationId,
			itemId: 'domain.spf',
			domainId,
			attemptId,
			generation: claim.generation,
			leaseToken,
			validator: 'dns.spf',
			status,
			observedValues: [],
			diagnostic: status,
			observedAt,
		});
	}

	it('is queued for a confirmed failure after a pass, reaches admins, and clears on recovery', async () => {
		const t = await harness(['campaigns']);
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', createTestDomain({ domain: 'mail.example.com' }) as never)
		);
		await record(t, domainId, 'pass', 'pass', NOW - HOUR);
		await record(t, domainId, 'warn', 'warn', NOW - MINUTE);
		expect(await queuedFanOuts(t)).toEqual([]);
		await record(t, domainId, 'fail', 'fail', NOW);

		const queued = await queuedFanOuts(t);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.event.kind).toBe('domain_dns');
		expect(await fanOut(t, queued[0]!.event)).toEqual({ written: 2 });

		as('owner-1');
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([
			expect.objectContaining({
				kind: 'domain_dns',
				name: 'mail.example.com',
				detail: 'SPF with -all',
				url: '/dashboard/admin/delivery/domains?domain=mail.example.com',
			}),
		]);
		// Demoted since: the admin-only notice is no longer theirs to see.
		session.role = 'editor';
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
		session.role = 'owner';

		await record(t, domainId, 'recovered', 'pass', NOW + MINUTE);
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});

	it('drops the notice once its sending domain is removed, though the alert stays open', async () => {
		const t = await harness(['campaigns']);
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', createTestDomain({ domain: 'mail.example.com' }) as never)
		);
		await record(t, domainId, 'pass', 'pass', NOW - HOUR);
		await record(t, domainId, 'fail', 'fail', NOW);
		const [queued] = await queuedFanOuts(t);
		expect(await fanOut(t, queued!.event)).toEqual({ written: 2 });
		expect(await t.query(api.marketing.notifications.listRecent, {})).toHaveLength(1);

		await t.run((ctx) => removeSendingDomain.handler(ctx, { domainId, userId: 'admin-1' }));
		const openAlerts = await t.run(async (ctx) =>
			(await ctx.db.query('deliverabilityRegressionAlerts').collect()).filter(
				(alert) => alert.resolvedAt === undefined
			)
		);
		expect(openAlerts).toHaveLength(1);
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});
});

describe('preferences', () => {
	it('lists only the switches that can fire for the caller, all on until turned off', async () => {
		const t = await harness();
		as('editor-1');
		expect(await t.query(api.marketing.notifications.getMyPreferences, {})).toMatchObject({
			kinds: ['campaignFinished', 'campaignReminder'],
			enabled: { campaignFinished: true, campaignReminder: true },
		});

		as('admin-1');
		await t.mutation(api.marketing.notifications.setMyPreference, {
			preference: 'domainDns',
			enabled: false,
		});
		await t.mutation(api.marketing.notifications.setMyPreference, {
			preference: 'deliveryHold',
			enabled: false,
		});
		expect(await t.query(api.marketing.notifications.getMyPreferences, {})).toEqual({
			kinds: [
				'campaignFinished',
				'campaignReminder',
				'deliveryHold',
				'automationProblems',
				'domainDns',
			],
			enabled: {
				campaignFinished: true,
				campaignReminder: true,
				deliveryHold: false,
				automationProblems: true,
				domainDns: false,
			},
		});
	});

	it('hides notices from the reader once their switch is turned off', async () => {
		const t = await harness();
		const campaignId = await seedCampaign(t, { status: 'sent' });
		await fanOut(t, { kind: 'campaign_finished', campaignId });
		expect(await t.query(api.marketing.notifications.listRecent, {})).toHaveLength(1);
		await t.mutation(api.marketing.notifications.setMyPreference, {
			preference: 'campaignFinished',
			enabled: false,
		});
		expect(await t.query(api.marketing.notifications.listRecent, {})).toEqual([]);
	});
});

describe('retention', () => {
	it('prunes a person’s notices older than a week on their next notice', async () => {
		const t = await harness();
		const oldCampaign = await seedCampaign(t, { status: 'sent' });
		await fanOut(t, { kind: 'campaign_finished', campaignId: oldCampaign });
		vi.setSystemTime(NOW + 8 * 24 * HOUR);
		const newCampaign = await seedCampaign(t, { status: 'sent', name: 'Winter launch' });
		await fanOut(t, { kind: 'campaign_finished', campaignId: newCampaign });
		const notices = await noticesFor(t);
		expect(notices).toHaveLength(3);
		expect(notices.every((n) => n.name === 'Winter launch')).toBe(true);
	});
});
