import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	abTestConfigValidator,
	linkClickValidator,
	campaignStatusValidator,
} from '../lib/convexValidators';
import { audienceValidator } from '../campaigns/audience';

/**
 * Campaign send job — the checkpoint row for one large-audience send walk
 * (ADR-mirrored on the **Integration import walker**: opaque cursor + batch
 * mutation + self-reschedule). The Campaign send orchestrator inserts one row
 * (`phase: 'resolving'`, `cursor: ''`), then drives `resolveCampaignPage`
 * page-by-page until the audience is exhausted (`phase: 'done'`), so no single
 * query ever resolves the whole audience. ALL send modes — plain, A/B test
 * cohort, and A/B winner remainder — stream through this one walker.
 *
 * `cursor` is the opaque Convex pagination cursor for the next page
 * (`''` = start). `audience` is the frozen Audience snapshot captured once at
 * job creation, so every hop resolves against the same selection even if the
 * Segment is later edited. The completion guard in `campaigns/lifecycle.ts`
 * refuses to flip a campaign to `sent` while a row here is still `'resolving'`.
 *
 * `variantMode` discriminates how each page is classified:
 *   - `plain`      — non-A/B send; every eligible recipient is enqueued (no
 *                    variant tag).
 *   - `ab_test`    — first-phase A/B; per page, each eligible contact is bucketed
 *                    by `hashFraction(campaignId, contactId)`: `h < testFraction`
 *                    is the TEST cohort (variant A/B sub-bucketed by hash), the
 *                    rest is the remainder and is SKIPPED this phase.
 *   - `ab_winner`  — second-phase A/B; the SAME row is reset to a fresh walk after
 *                    winner declaration and re-driven over the audience, enqueuing
 *                    ONLY the remainder (`h >= testFraction`) with `winningVariant`.
 * `testFraction` / `splitPercentage` are stored at job creation for the A/B
 * modes so every hop buckets identically; `winningVariant` is set when the row
 * is reset for the `ab_winner` phase.
 */
const campaignSendJobs = defineTable({
	campaignId: v.id('campaigns'),
	// The walk is either still streaming pages (`resolving`) or has enqueued
	// every page (`done`). Phase 2 (`ab_winner`) reuses the SAME two literals so
	// the lifecycle completion guard (`phase === 'resolving'`) holds across both
	// A/B phases unchanged.
	phase: v.union(v.literal('resolving'), v.literal('done')),
	// How each page is classified into emailSends rows (see table comment).
	// Optional for forward-compat with rows written before this field existed;
	// absent ⇒ treated as `plain`.
	variantMode: v.optional(
		v.union(v.literal('plain'), v.literal('ab_test'), v.literal('ab_winner'))
	),
	// Fraction of the audience that forms the A/B test cohort (`2 × split / 100`).
	// Set for the `ab_test` / `ab_winner` modes; the cohort/remainder partition
	// is `h < testFraction` vs `h >= testFraction`.
	testFraction: v.optional(v.number()),
	// Per-variant split percentage (10–50) — kept for diagnostics / clarity.
	splitPercentage: v.optional(v.number()),
	// The declared winner, set when the row is reset for the `ab_winner` phase.
	winningVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
	// Opaque Convex pagination cursor for the NEXT page. `''` = start.
	cursor: v.string(),
	// Frozen Audience snapshot — captured once, never re-read from the campaign.
	audience: audienceValidator,
	// Running total of emailSends rows enqueued across committed pages.
	enqueuedCount: v.number(),
	// Running total of raw candidates examined (the count denominator).
	totalCandidates: v.number(),
	startedAt: v.number(),
	updatedAt: v.number(),
})
	.index('by_campaign', ['campaignId'])
	// Watchdog lookup: find walks still `resolving` ordered by staleness, so the
	// re-drive cron can resume a walk whose hop threw before rescheduling itself.
	.index('by_phase_updatedAt', ['phase', 'updatedAt']);

/**
 * Campaign tables — one-time marketing email blasts + per-recipient send tracking.
 *
 * Spread into `defineSchema()` from schema.ts via `...campaignTables`.
 */
export const campaignTables = {
	// Campaigns - one-time email sends to a group of contacts
	campaigns: defineTable({
		name: v.string(),
		emailTemplateId: v.optional(v.id('emailTemplates')), // Optional until content is selected
		status: campaignStatusValidator,
		// Sender information
		fromName: v.optional(v.string()),
		fromEmail: v.optional(v.string()),
		replyTo: v.optional(v.string()),
		// Subject line (can override template subject)
		subject: v.optional(v.string()),
		// Audience targeting — one discriminated value (ADR-0033). The stored
		// segment case carries the send-time `frozenFilters` snapshot; illegal
		// states (topic with a segmentId, segment with neither id nor snapshot)
		// are unrepresentable. See CONTEXT.md "Audience".
		audience: v.optional(audienceValidator),
		// Scheduling
		scheduledAt: v.optional(v.number()),
		sentAt: v.optional(v.number()),
		// Timezone-based scheduling: send at specified time in recipient's timezone
		// When true, scheduledAt represents the local time to send (e.g., 9:00 AM)
		// and emails are staggered by timezone
		useRecipientTimezone: v.optional(v.boolean()),
		// Hour and minute for timezone-based sending (0-23 for hour, 0-59 for minute)
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
		// AGGREGATED from emailSends — updated by sendLifecycle's effect list
		// (`campaign_stats_sent` / `campaign_stats_failed` / `campaign_stats_*`
		// in `delivery/sendLifecycle.ts`). statsUpdatedAt below tracks
		// freshness; never write these from a user-facing mutation.
		statsSent: v.optional(v.number()),
		statsFailed: v.optional(v.number()),
		statsDelivered: v.optional(v.number()),
		statsOpened: v.optional(v.number()),
		statsClicked: v.optional(v.number()),
		statsBounced: v.optional(v.number()),
		statsHardBounced: v.optional(v.number()),
		statsSoftBounced: v.optional(v.number()),
		statsUnsubscribed: v.optional(v.number()),
		// A/B Testing fields
		isABTest: v.optional(v.boolean()), // Whether this campaign is an A/B test
		// A/B test configuration (JSON string):
		// { testType: "subject" | "content", variantBSubject?: string, variantBTemplateId?: Id<"emailTemplates">,
		//   splitPercentage: number (10-50), winnerCriteria: "open_rate" | "click_rate" | "manual",
		//   testDuration: number (hours before auto-selecting winner) }
		abTestConfig: v.optional(abTestConfigValidator),
		// A/B test status. Lifecycle owned by `campaigns/abTestLifecycle.ts`
		// (ADR-0017). The pre-deepening `'completed'` literal was dropped —
		// no writer ever set it, and the follow-up "send winning variant to
		// the rest of audience" workflow lands as a new transition kind
		// when it ships rather than as a placeholder literal.
		abTestStatus: v.optional(
			v.union(
				v.literal('pending'), // Test enabled, not started yet
				v.literal('testing'), // Test in progress (campaign sending split)
				v.literal('winner_selected') // Winner has been chosen
			)
		),
		// Variant B stats (Variant A stats use main stats fields)
		abVariantBSent: v.optional(v.number()),
		abVariantBOpened: v.optional(v.number()),
		abVariantBClicked: v.optional(v.number()),
		// Winner information
		abWinner: v.optional(v.union(v.literal('A'), v.literal('B'))),
		abWinnerSelectedAt: v.optional(v.number()),
		// Campaign archive fields (public "View in browser" link)
		archiveEnabled: v.optional(v.boolean()),
		archiveToken: v.optional(v.string()),
		archiveHtmlContent: v.optional(v.string()),
		archiveSubject: v.optional(v.string()),
		// Content scanning: reason if content was blocked by scanner
		contentBlockReason: v.optional(v.string()),
		// Denormalized search field: "name subject" for full-text search
		searchableText: v.optional(v.string()),
		// Aggregated stats freshness (stats* fields are updated only by the Send
		// lifecycle effects in `delivery/sendLifecycle.ts`).
		statsUpdatedAt: v.optional(v.number()),
		// Set when status transitions to 'cancelled' (see campaigns/scheduling.ts).
		cancelledAt: v.optional(v.number()),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_status', ['status'])
		.index('by_updated_at', ['updatedAt'])
		// Status-filtered browse for the Listing engine (ADR-0037): status leads,
		// updatedAt orders within it — index-native filtered listing, no scan.
		.index('by_status_and_updated_at', ['status', 'updatedAt'])
		.index('by_status_and_scheduled_at', ['status', 'scheduledAt'])
		.index('by_status_sent_at', ['status', 'sentAt'])
		.index('by_archive_token', ['archiveToken'])
		// SEALED-AT-REST NOTE (Sealed Mail E8b): `searchableText` indexes campaign
		// METADATA (name, subject), not a sealed 1:1 message body — campaigns are the
		// plaintext broadcast plane (D5) and are out of E8b's at-rest sealing scope.
		// See lib/atRestBodies.ts and apps/docs/content/3.developer/21.sealed-mail-at-rest.md.
		.searchIndex('search_campaigns', {
			searchField: 'searchableText',
			filterFields: ['status'],
		}),

	// Email Sends - tracks individual email sends for campaigns
	// Granular tracking per recipient for opens, clicks, bounces, etc.
	emailSends: defineTable({
		campaignId: v.id('campaigns'),
		contactId: v.id('contacts'),
		// SNAPSHOT — captured at send time, never updated. Updating these would
		// corrupt the historical record (the audit trail must reflect what was
		// actually sent, not the contact's current state).
		contactEmail: v.string(),
		contactFirstName: v.optional(v.string()),
		contactLastName: v.optional(v.string()),
		// Current status of this email send. `failed` is a terminal state set
		// when the workpool reports the action errored — distinct from `bounced`
		// (provider accepted then receiver rejected). See CONTEXT.md "Send status".
		status: v.union(
			v.literal('queued'),
			v.literal('sent'),
			v.literal('failed'),
			v.literal('delivered'),
			v.literal('opened'),
			v.literal('clicked'),
			v.literal('bounced'),
			v.literal('complained')
		),
		// Email provider message ID for tracking
		providerMessageId: v.optional(v.string()),
		// Personalized content for this recipient (to preserve exactly what was sent)
		personalizedSubject: v.optional(v.string()),
		// A/B test variant tracking - "A" or "B" for test recipients
		abVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
		// Timestamps for status changes
		queuedAt: v.number(),
		sentAt: v.optional(v.number()),
		deliveredAt: v.optional(v.number()),
		failedAt: v.optional(v.number()),
		openedAt: v.optional(v.number()),
		clickedAt: v.optional(v.number()),
		bouncedAt: v.optional(v.number()),
		// Bounce classification; required-via-runtime-guard when status='bounced'.
		bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
		complainedAt: v.optional(v.number()),
		// Link tracking for click attribution
		clickedLinks: v.optional(v.array(linkClickValidator)),
		// Open tracking count (may open multiple times)
		openCount: v.optional(v.number()),
		// Error information for failures
		errorMessage: v.optional(v.string()),
		errorCode: v.optional(v.string()),
		// Provider routing metadata (multi-tenant sending platform)
		providerType: v.optional(v.string()), // Which provider sent this email (mta, ses, resend)
		// Correlation ID for end-to-end traceability (API request → send → webhook)
		correlationId: v.optional(v.string()),
		// Soft-delete fields: set on cascade from a soft-deleted contact, so the historical
		// send record remains for audit but stops appearing in normal queries.
		deletedAt: v.optional(v.number()),
		deletedBy: v.optional(v.string()),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
	})
		.index('by_campaign', ['campaignId'])
		.index('by_contact', ['contactId'])
		.index('by_campaign_and_contact', ['campaignId', 'contactId'])
		.index('by_campaign_and_status', ['campaignId', 'status'])
		.index('by_provider_message_id', ['providerMessageId'])
		.index('by_campaign_and_variant', ['campaignId', 'abVariant'])
		// Global status index: lets systemHealth probe the queue depth (count of
		// 'queued' sends) with a bounded .take() instead of scanning every send.
		.index('by_status', ['status']),

	// Checkpoint rows for large-audience campaign sends (see the table comment
	// above). One row per send walk (plain, A/B test cohort, or A/B winner
	// remainder); the orchestrator drives it page-by-page so no single query
	// resolves the whole audience.
	campaignSendJobs,

	// Write-sharded per-campaign send counters. Each send/delivered/opened/clicked/
	// bounced event bumps a RANDOM shard of (campaignId, shardKey) instead of the
	// single campaigns row, so a blast's per-recipient counter writes spread across
	// SHARD_COUNT rows instead of contending on one document (Convex OCC hotspot —
	// the send-lifecycle transition no longer retries on the campaign counter).
	// A rollup cron sums shards into campaigns.stats* (the read interface) — see
	// campaigns/statShards.ts. statsUnsubscribed is NOT sharded (low frequency, off
	// the hot path) and stays a direct counter on the campaign row.
	campaignStatShards: defineTable({
		campaignId: v.id('campaigns'),
		shardKey: v.number(),
		statsSent: v.optional(v.number()),
		statsFailed: v.optional(v.number()),
		statsDelivered: v.optional(v.number()),
		statsOpened: v.optional(v.number()),
		statsClicked: v.optional(v.number()),
		statsBounced: v.optional(v.number()),
		statsHardBounced: v.optional(v.number()),
		statsSoftBounced: v.optional(v.number()),
	}).index('by_campaign_and_shard', ['campaignId', 'shardKey']),

	// Curated campaign sender addresses. A campaign may send from one of these
	// enabled addresses; a custom (off-list) from-address is allowed only when
	// `instanceSettings.isCustomCampaignSendersAllowed` is on. In BOTH branches the
	// address must sit on a verified sending domain — the write path
	// (`campaigns/senders.ts`) rejects unverified domains at insert/update time,
	// and the send-time preflight keeps the verified-domain gate as the floor.
	// Single-org-per-deployment: no `organizationId` column (mirrors `campaigns`
	// and the `instanceSettings` singleton). `email` is stored lowercased for
	// case-insensitive lookup.
	campaignSenders: defineTable({
		// Lowercased sender email address (e.g. "news@acme.com").
		email: v.string(),
		// Human-facing display name shown in the From header (e.g. "Acme News").
		displayName: v.optional(v.string()),
		// Whether this sender may currently be used. Disabled rows stay for
		// history but are rejected at send time.
		isEnabled: v.boolean(),
		// The sender pre-selected for new campaigns. At most one row is the
		// default; setting a new default clears the previous one.
		isDefault: v.boolean(),
		// Auth user id of the admin who created the row (audit trail).
		createdBy: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Case-insensitive lookup / uniqueness guard by lowercased address.
		.index('by_email', ['email']),
};
