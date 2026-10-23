/**
 * The pure halves of marketing notifications: who may hear about which kind,
 * which switches a person sees, the delivered share, and the push copy.
 */

import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	applicablePreferences,
	isNoticeFeatureOn,
	isNoticeRoleAllowed,
	isPreferenceOn,
	type ResolvedFlags,
} from '../noticePolicy';
import { deliveredPercent } from '../noticeResolvers';
import { campaignReminderDelayMs, CAMPAIGN_REMINDER_LEAD_MS } from '../noticeEvents';
import { marketingPayload } from '../../push/marketingCopy';

function flags(on: string[]): ResolvedFlags {
	return new Proxy({} as ResolvedFlags, { get: (_target, key) => on.includes(String(key)) });
}

function notice(overrides: Partial<Doc<'marketingNotices'>>): Doc<'marketingNotices'> {
	return {
		_id: 'n1' as Id<'marketingNotices'>,
		_creationTime: 0,
		userId: 'user-a',
		kind: 'campaign_finished',
		eventKey: 'k',
		subjectKey: 'campaign:c1',
		url: '/dashboard/campaigns/c1/report',
		createdAt: 0,
		...overrides,
	};
}

describe('marketing notice policy', () => {
	it('sends campaign notices to every member, delivery and DNS notices to admins only', () => {
		expect(isNoticeRoleAllowed('campaign_finished', 'editor')).toBe(true);
		expect(isNoticeRoleAllowed('campaign_reminder', 'editor')).toBe(true);
		expect(isNoticeRoleAllowed('delivery_hold', 'editor')).toBe(false);
		expect(isNoticeRoleAllowed('domain_dns', 'editor')).toBe(false);
		expect(isNoticeRoleAllowed('automation_stalled', 'editor')).toBe(false);
		expect(isNoticeRoleAllowed('domain_dns', 'admin')).toBe(true);
		expect(isNoticeRoleAllowed('campaign_finished', null)).toBe(false);
	});

	it('needs the feature a notice is about', () => {
		expect(isNoticeFeatureOn('campaign_finished', flags(['automations']))).toBe(false);
		expect(isNoticeFeatureOn('delivery_hold', flags(['transactional']))).toBe(true);
		expect(isNoticeFeatureOn('automation_paused', flags(['automations']))).toBe(true);
	});

	it('lists only the switches that can fire for the role and instance, in display order', () => {
		const all = flags(['campaigns', 'automations']);
		expect(applicablePreferences('editor', all)).toEqual(['campaignFinished', 'campaignReminder']);
		expect(applicablePreferences('owner', all)).toEqual([
			'campaignFinished',
			'campaignReminder',
			'deliveryHold',
			'automationProblems',
			'domainDns',
		]);
		expect(applicablePreferences('admin', flags(['transactional']))).toEqual([
			'deliveryHold',
			'domainDns',
		]);
		expect(applicablePreferences('editor', flags([]))).toEqual([]);
	});

	it('treats a missing row or field as on', () => {
		expect(isPreferenceOn(null, 'domainDns')).toBe(true);
		expect(isPreferenceOn({ isDomainDnsOn: undefined }, 'domainDns')).toBe(true);
		expect(isPreferenceOn({ isDomainDnsOn: false }, 'domainDns')).toBe(false);
		expect(isPreferenceOn({ isDomainDnsOn: false }, 'campaignFinished')).toBe(true);
	});
});

describe('deliveredPercent', () => {
	it('rounds down so one bounce never reads as 100%', () => {
		expect(deliveredPercent({ statsSent: 50, statsDelivered: 49, statsBounced: 1 })).toBe(98);
		expect(deliveredPercent({ statsSent: 1000, statsDelivered: 999, statsBounced: 1 })).toBe(99);
	});

	it('says nothing before any receiver reported back or when nothing was handed off', () => {
		expect(deliveredPercent({ statsSent: 50, statsDelivered: 0, statsBounced: 0 })).toBeUndefined();
		expect(deliveredPercent({ statsSent: 0, statsDelivered: 0, statsBounced: 0 })).toBeUndefined();
	});

	it('stays within 0–100 when counters disagree', () => {
		expect(deliveredPercent({ statsSent: 10, statsDelivered: 12, statsBounced: 0 })).toBe(100);
	});
});

describe('campaignReminderDelayMs', () => {
	it('fires the lead ahead of the start, and not at all when the start is closer', () => {
		expect(campaignReminderDelayMs(10 * 3_600_000, 0)).toBe(
			10 * 3_600_000 - CAMPAIGN_REMINDER_LEAD_MS
		);
		expect(campaignReminderDelayMs(CAMPAIGN_REMINDER_LEAD_MS, 0)).toBeNull();
		expect(campaignReminderDelayMs(10 * 60_000, 0)).toBeNull();
	});
});

describe('marketing push copy', () => {
	it('says how much of a finished campaign was delivered', () => {
		const payload = marketingPayload(
			notice({ name: 'Autumn launch', percent: 98 }),
			'en',
			false,
			0
		);
		expect(payload).toEqual({
			title: 'Campaign finished',
			body: 'Autumn launch · 98% delivered',
			tag: 'marketing:campaign:c1',
			url: '/dashboard/campaigns/c1/report',
		});
		expect(marketingPayload(notice({ name: 'Herbst', percent: 98 }), 'de', false, 0).body).toBe(
			'Herbst · 98 % zugestellt'
		);
	});

	it('offers Open and Cancel on a reminder, with minutes left and a cancel that asks first', () => {
		const payload = marketingPayload(
			notice({
				kind: 'campaign_reminder',
				name: 'Webinar',
				campaignId: 'c1' as Id<'campaigns'>,
				scheduledAt: 15 * 60_000,
				url: '/dashboard/campaigns/c1/edit',
			}),
			'en',
			false,
			0
		);
		expect(payload.title).toBe('Scheduled campaign sends in 15 min');
		expect(payload.body).toBe('Webinar');
		expect(payload.actions).toEqual([
			{ action: 'open', title: 'Open', url: '/dashboard/campaigns/c1/edit' },
			{ action: 'cancel', title: 'Cancel send', url: '/dashboard/campaigns/c1/edit?intent=cancel' },
		]);
	});

	it('names the provider of a delivery hold and falls back for an unknown one', () => {
		expect(
			marketingPayload(notice({ kind: 'delivery_hold', name: 'gmail' }), 'en', false, 0).body
		).toBe('Owlat paused sending to Gmail after a spike in bounces or complaints');
		expect(
			marketingPayload(notice({ kind: 'delivery_hold', name: 'nope' }), 'de', false, 0).body
		).toBe(
			'Owlat hat den Versand an andere Anbieter nach vielen Bounces oder Beschwerden pausiert'
		);
	});

	it('keeps names off the lock screen when notifications are private', () => {
		const payload = marketingPayload(
			notice({ kind: 'automation_stalled', name: 'Secret launch', count: 12 }),
			'en',
			true,
			0
		);
		expect(JSON.stringify(payload)).not.toContain('Secret launch');
		expect(
			marketingPayload(
				notice({ kind: 'automation_stalled', name: 'Welcome', count: 12 }),
				'en',
				false,
				0
			).body
		).toBe('Welcome: 12 stalled contacts');
		expect(
			marketingPayload(
				notice({ kind: 'domain_dns', name: 'mail.example.com', detail: 'SPF with -all' }),
				'en',
				false,
				0
			).body
		).toBe('mail.example.com: SPF with -all check failed');
	});
});
