import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { contentScanFlagValidator } from '../lib/convexValidators';

/**
 * Delivery + sending-infrastructure tables — blocklist, reputation tracking, content scanning,
 * URL reputation cache, provider routing, provider health, IP warming state.
 *
 * Spread into `defineSchema()` from schema.ts via `...deliveryTables`.
 */
export const deliveryTables = {
	// Blocked Emails - email addresses that should not receive emails
	// Used to protect sender reputation by excluding bounced, complained, or manually blocked addresses
	blockedEmails: defineTable({
		email: v.string(), // The blocked email address (normalized to lowercase)
		// Reason why this email was blocked
		reason: v.union(
			v.literal('bounced'), // Hard bounce - email address doesn't exist
			v.literal('complained'), // Recipient marked email as spam
			v.literal('manual') // Manually added to blocklist
		),
		// Bounce type classification (hard = permanent, soft = temporary)
		bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
		// Optional notes for manual blocks
		notes: v.optional(v.string()),
		// Polymorphic FK: sourceType discriminates which source-id field is set.
		// Optional because manual blocks (reason='manual') have no source.
		sourceType: v.optional(v.union(v.literal('emailSend'), v.literal('transactionalSend'))),
		sourceEmailSendId: v.optional(v.id('emailSends')),
		sourceTransactionalSendId: v.optional(v.id('transactionalSends')),
		// Timestamps
		createdAt: v.number(),
	})
		.index('by_email', ['email'])
		.index('by_reason', ['reason']),

	// Sending Reputation — rolling 30-day accumulation of delivery events into
	// per-day buckets, owned by the **Sending reputation (module)** at
	// `analytics/sendingReputation.ts` (ADR-0042). One scope-discriminated
	// table: `scope: 'org'` rows carry `domain: undefined`; `scope: 'domain'`
	// rows carry the sending domain. Bounce/complaint rate + risk level are
	// derived on read by the module's `summarize` — never stored.
	//
	// Each (scope, domain, day) bucket is SHARDED into `shardKey` 0..N-1 rows so
	// a high-volume campaign's per-recipient events spread their writes across N
	// rows instead of read-modify-writing one daily document N times (Convex OCC
	// write-hotspot). `summarize` sums across all shards for the window, so the
	// shard split is invisible to readers. The single index serves the org
	// window (eq scope), a domain window (eq scope+domain), the per-scope cron
	// sweep, and cleanup — `shardKey` trails the prefix so all those prefix
	// queries are unaffected.
	sendingReputation: defineTable({
		scope: v.union(v.literal('org'), v.literal('domain')),
		domain: v.optional(v.string()), // set iff scope === 'domain'
		periodStart: v.number(), // UTC start-of-day bucket (epoch ms)
		shardKey: v.number(), // 0..N-1 write shard within the (scope, domain, day) bucket
		totalSent: v.number(),
		totalDelivered: v.number(),
		totalBounced: v.number(),
		totalHardBounced: v.number(),
		totalComplaints: v.number(),
		lastCalculatedAt: v.number(),
	}).index('by_scope_domain_period_shard', ['scope', 'domain', 'periodStart', 'shardKey']),

	// Delivery snapshots — one per-day roll-up of the org's rolling sending
	// reputation, written by the daily `write delivery snapshot` cron
	// (analytics/reputationSnapshots.ts). Gives the Delivery health page a
	// history to draw its 30-day delivery-rate trend from; `summarize` derives
	// only the *current* rolling window, so without these persisted points there
	// is no time series to chart. Single-deployment = single org, so no org key
	// (mirrors `warmingState`). The cron prunes rows older than ~90 days, keeping
	// this table bounded to a small, chartable window.
	deliverySnapshots: defineTable({
		periodStart: v.number(), // UTC start-of-day bucket (epoch ms) — one row per day
		deliveryRate: v.number(), // delivered / sent over the rolling window (0..1)
		bounceRate: v.number(), // bounced / sent (0..1)
		complaintRate: v.number(), // complaints / sent (0..1)
		sentCount: v.number(), // total sent in the rolling window at snapshot time
		createdAt: v.number(),
	}).index('by_period', ['periodStart']),

	// Content Scan Results - audit trail for pre-send content scanning
	contentScanResults: defineTable({
		resourceType: v.union(
			v.literal('campaign'),
			v.literal('transactional'),
			v.literal('attachment'),
			v.literal('media_upload')
		),
		resourceId: v.string(), // campaign or transactional email ID
		score: v.number(), // 0-100 spam score
		level: v.union(
			v.literal('clean'), // Passed all checks
			v.literal('suspicious'), // Flagged for review
			v.literal('blocked') // Blocked from sending
		),
		flags: v.array(contentScanFlagValidator),
		scannedAt: v.number(),
	})
		.index('by_level', ['level'])
		.index('by_resource', ['resourceType', 'resourceId']),

	// URL Reputation Cache - cached verdicts from Google Safe Browsing API
	urlReputationCache: defineTable({
		urlHash: v.string(), // SHA-256 of normalized URL
		verdict: v.union(v.literal('safe'), v.literal('malicious'), v.literal('suspicious')),
		source: v.string(), // 'google_safe_browsing'
		threats: v.optional(v.array(v.string())),
		checkedAt: v.number(),
		expiresAt: v.number(), // 24h for clean, 1h for flagged
	}).index('by_url_hash', ['urlHash']),

	// Provider Routes - email provider routing configuration
	// Determines which email provider (mta, ses, resend, smtp) to use per message type
	providerRoutes: defineTable({
		messageType: v.union(
			v.literal('campaign'),
			v.literal('transactional'),
			v.literal('automation')
		),
		strategy: v.union(
			v.literal('single'), // Use one provider only
			v.literal('priority_failover'), // Try providers in order, failover on error
			v.literal('workload_split') // Split traffic by weight across providers
		),
		// Ordered list of providers for this route
		providers: v.array(
			v.object({
				providerType: v.string(), // 'mta' | 'ses' | 'resend' | 'smtp'
				weight: v.optional(v.number()), // For workload_split: traffic percentage (0-100)
				isEnabled: v.boolean(), // Whether this provider is active in the route
			})
		),
		// Optional IP pool override (for MTA provider)
		ipPool: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_message_type', ['messageType']),

	// Provider Health - tracks email provider health for failover decisions
	providerHealth: defineTable({
		providerType: v.string(), // 'mta' | 'ses' | 'resend' | 'smtp'
		status: v.union(v.literal('healthy'), v.literal('degraded'), v.literal('down')),
		// Rolling metrics
		recentSuccesses: v.number(),
		recentFailures: v.number(),
		successRate: v.number(), // 0-1 ratio
		avgLatencyMs: v.number(),
		// Timestamps
		lastCheckedAt: v.number(),
		lastErrorAt: v.optional(v.number()),
		consecutiveFailures: v.number(),
	}).index('by_provider_type', ['providerType']),

	// IP warming state — cached from MTA's /ip-reputation endpoint every 5 minutes
	warmingState: defineTable({
		phase: v.string(), // overall: 'ramp' | 'plateau' | 'graduated'
		totalDailyCap: v.number(), // sum across campaign IPs
		totalSentToday: v.number(),
		ipCount: v.number(),
		ips: v.array(
			v.object({
				ip: v.string(),
				phase: v.string(),
				currentDay: v.number(),
				dailyCap: v.number(),
				sentToday: v.number(),
				bounceRate: v.number(),
				deferralRate: v.number(),
				pool: v.string(),
				active: v.boolean(),
				blockReasons: v.optional(v.array(v.union(v.literal('dnsbl'), v.literal('fcrdns')))),
				dnsbl: v.optional(
					v.union(
						v.literal('unknown'),
						v.literal('clean'),
						v.literal('degraded'),
						v.literal('critical')
					)
				),
				fcrdns: v.optional(
					v.object({
						ehlo: v.string(),
						ptrNames: v.array(v.string()),
						isPtrPresent: v.boolean(),
						isPtrFqdn: v.boolean(),
						isForwardConfirmed: v.boolean(),
						isEhloMatched: v.boolean(),
						verdict: v.union(
							v.literal('pass'),
							v.literal('warn'),
							v.literal('fail'),
							v.literal('error')
						),
						isGenericPtr: v.boolean(),
						reason: v.optional(
							v.union(
								v.literal('no-ptr'),
								v.literal('ptr-not-fqdn'),
								v.literal('forward-mismatch'),
								v.literal('ehlo-mismatch'),
								v.literal('lookup-error')
							)
						),
						checkedAt: v.number(),
						isOverridden: v.boolean(),
					})
				),
			})
		),
		syncedAt: v.number(),
	}),
};
