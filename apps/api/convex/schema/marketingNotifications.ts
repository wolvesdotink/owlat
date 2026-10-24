import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { marketingNoticeKindValidator } from '../lib/validators/marketingNotifications';

/**
 * Marketing notifications (marketing/notifications*).
 *
 * `marketingNotices` holds one row per person per occurrence ("Autumn launch
 * finished · 98% delivered"). The fan-out writes it, the foreground app reads
 * the recent ones as toasts and native notifications, and Web Push sends it by
 * id. Display values are captured at write time; the target ids let every
 * reader re-check that the occurrence still holds (a reminder for a campaign
 * that was cancelled meanwhile is never shown). Rows older than the retention
 * are pruned on the next write for the same person.
 *
 * `marketingNotificationSettings` is one row per person with the five switches
 * from Preferences → This device. An absent row or field means on.
 *
 * Lifecycle: deleted by member erasure and by workspace deletion.
 *
 * Spread into `defineSchema()` from schema.ts via `...marketingNotificationTables`.
 */
/** Both tables, in the order the organization wipe deletes them. */
export const MARKETING_NOTIFICATION_TABLES = [
	'marketingNotices',
	'marketingNotificationSettings',
] as const;

export type MarketingNotificationTable = (typeof MARKETING_NOTIFICATION_TABLES)[number];

export const marketingNotificationTables = {
	marketingNotices: defineTable({
		// BetterAuth user id of the person the notice is for.
		userId: v.string(),
		kind: marketingNoticeKindValidator,
		// One occurrence: a producer that fires twice for it (a retried cron, a
		// re-applied snapshot) writes one notice per person.
		eventKey: v.string(),
		// What the occurrence is about (a campaign, a provider, an automation, a
		// domain check), for the per-subject cooldown.
		subjectKey: v.string(),
		campaignId: v.optional(v.id('campaigns')),
		automationId: v.optional(v.id('automations')),
		domainId: v.optional(v.id('domains')),
		alertId: v.optional(v.id('deliverabilityRegressionAlerts')),
		// The campaign, automation or domain name; the destination provider for
		// a delivery hold.
		name: v.optional(v.string()),
		// Campaign finished: delivered share of the messages handed off, 0–100.
		percent: v.optional(v.number()),
		// Automation stalled: runs ended.
		count: v.optional(v.number()),
		// Domain DNS: the failing check's protocol label ("SPF with -all").
		detail: v.optional(v.string()),
		// Campaign reminder: the start the reminder is for.
		scheduledAt: v.optional(v.number()),
		// In-app path the notice opens.
		url: v.string(),
		createdAt: v.number(),
	})
		.index('by_user_created', ['userId', 'createdAt'])
		.index('by_event_user', ['eventKey', 'userId'])
		.index('by_subject_created', ['subjectKey', 'createdAt']),

	marketingNotificationSettings: defineTable({
		userId: v.string(),
		isCampaignFinishedOn: v.optional(v.boolean()),
		isCampaignReminderOn: v.optional(v.boolean()),
		isDeliveryHoldOn: v.optional(v.boolean()),
		isAutomationProblemsOn: v.optional(v.boolean()),
		isDomainDnsOn: v.optional(v.boolean()),
		updatedAt: v.number(),
	}).index('by_user', ['userId']),
};
