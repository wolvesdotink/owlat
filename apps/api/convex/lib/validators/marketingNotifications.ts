/**
 * Validators for marketing notifications (`marketing/notifications*`): what a
 * producer reports, what a stored notice is, and the five per-person switches.
 *
 * One home because the producers (campaign lifecycle and scheduling, the
 * delivery snapshot, the automation sweep and breaker, the deliverability
 * evidence writer), the scheduled fan-out, the stored rows and the push sender
 * all speak these shapes, and a scheduled job keeps the arguments it was
 * queued with across a deploy: variants are only ever added.
 */

import { v, type Infer } from 'convex/values';
import { destinationProviderValidator } from './deliverability';

/** What a stored notice is about. */
export const marketingNoticeKindValidator = v.union(
	v.literal('campaign_finished'),
	v.literal('campaign_reminder'),
	v.literal('delivery_hold'),
	v.literal('automation_stalled'),
	v.literal('automation_paused'),
	v.literal('domain_dns')
);
export type MarketingNoticeKind = Infer<typeof marketingNoticeKindValidator>;

/**
 * The five switches in Preferences → This device → Marketing notifications.
 * Both automation kinds share one switch: a stall and a breaker pause are the
 * same question for the person ("is this automation still doing its job?").
 */
export const MARKETING_NOTIFICATION_PREFERENCES = [
	'campaignFinished',
	'campaignReminder',
	'deliveryHold',
	'automationProblems',
	'domainDns',
] as const;
export type MarketingNotificationPreference = (typeof MARKETING_NOTIFICATION_PREFERENCES)[number];

export const marketingNotificationPreferenceValidator = v.union(
	v.literal('campaignFinished'),
	v.literal('campaignReminder'),
	v.literal('deliveryHold'),
	v.literal('automationProblems'),
	v.literal('domainDns')
);

/**
 * One occurrence a producer reports, by reference only: the fan-out re-reads
 * the source rows when it runs, so a campaign deleted, rescheduled or cancelled
 * in the meantime notifies nobody, and the copy is built from current names.
 */
export const marketingNoticeEventValidator = v.union(
	// A campaign reached `sent`. The delivered share is read when the fan-out
	// runs, a few minutes later, from the sharded counters.
	v.object({ kind: v.literal('campaign_finished'), campaignId: v.id('campaigns') }),
	// A scheduled campaign is about to send. `scheduledAt` is the start this
	// reminder was queued for: a reschedule or cancel makes it stale.
	v.object({
		kind: v.literal('campaign_reminder'),
		campaignId: v.id('campaigns'),
		scheduledAt: v.number(),
	}),
	// The MTA's circuit breaker for one destination provider opened (a bounce
	// or complaint spike): sending to it is held. `openedAt` identifies the
	// occurrence.
	v.object({
		kind: v.literal('delivery_hold'),
		provider: destinationProviderValidator,
		openedAt: v.number(),
	}),
	// The stalled-run sweep ended `count` runs of one automation that had no
	// next step. `sweepStartedAt` identifies the sweep.
	v.object({
		kind: v.literal('automation_stalled'),
		automationId: v.id('automations'),
		count: v.number(),
		sweepStartedAt: v.number(),
	}),
	// The failure breaker paused an automation after consecutive failed runs.
	v.object({
		kind: v.literal('automation_paused'),
		automationId: v.id('automations'),
		pausedAt: v.number(),
	}),
	// A DNS-backed check of a sending domain failed after a confirmed pass.
	v.object({
		kind: v.literal('domain_dns'),
		alertId: v.id('deliverabilityRegressionAlerts'),
	})
);
export type MarketingNoticeEvent = Infer<typeof marketingNoticeEventValidator>;
