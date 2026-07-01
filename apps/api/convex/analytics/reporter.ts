import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { summarize } from './sendingReputation';

/**
 * Gather instance metrics for reporting to the control plane.
 * Called by reportMetrics action every 15 minutes.
 */
export const gatherMetrics = internalQuery({
	args: {},
	returns: v.object({
		marketingEmailsSent: v.number(),
		transactionalEmailsSent: v.number(),
		totalEmailsSent: v.number(),
		userCount: v.number(),
		contactCount: v.number(),
		bounceRate: v.optional(v.number()),
		complaintRate: v.optional(v.number()),
		riskLevel: v.optional(v.union(
			v.literal('low'),
			v.literal('medium'),
			v.literal('high'),
			v.literal('critical'),
		)),
	}),
	handler: async (ctx) => {
		// 1. Marketing emails sent: sum statsSent across sent + sending campaigns.
		// Both collects are bounded: org-curated, growth is one row per campaign
		// (low-thousands ceiling).
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sent'))
			.collect(); // bounded: one row per sent campaign, org-curated
		const sendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sending'))
			.collect(); // bounded: in-flight campaigns only

		const marketingEmailsSent = [...sentCampaigns, ...sendingCampaigns].reduce(
			(sum, c) => sum + (c.statsSent ?? 0),
			0,
		);

		// 2. Transactional emails sent: read cached count
		const settings = await ctx.db.query('instanceSettings').first();
		const transactionalEmailsSent = settings?.transactionalSendCount ?? 0;

		// 3. User count: org-scoped, bounded by org membership size.
		const users = await ctx.db.query('userProfiles').collect(); // bounded: single-org membership
		const userCount = users.length;

		// 4. Contact count: read cached value
		const contactCount = settings?.contactCount ?? 0;

		// 5. Sending reputation — rolling 30-day org window, derived on read
		// through the single summarizer (no longer the stale latest-bucket
		// cache).
		const reputation = await summarize(ctx.db, { kind: 'org' });

		return {
			marketingEmailsSent,
			transactionalEmailsSent,
			totalEmailsSent: marketingEmailsSent + transactionalEmailsSent,
			userCount,
			contactCount,
			bounceRate: reputation.bounceRate,
			complaintRate: reputation.complaintRate,
			riskLevel: reputation.riskLevel,
		};
	},
});

/**
 * Report instance metrics to the control plane.
 * Called every 15 minutes by cron job.
 * Follows the warmingSync.ts pattern: internalAction that fetches data
 * via internal query, then POSTs to an external service.
 */
export const reportMetrics = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const controlPlaneUrl = getOptional('CONTROL_PLANE_URL');
		const instanceSecret = getOptional('INSTANCE_SECRET');

		if (!controlPlaneUrl || !instanceSecret) {
			// Not configured — skip silently (same pattern as warmingSync)
			return;
		}

		try {
			const metrics = await ctx.runQuery(
				internal.analytics.reporter.gatherMetrics,
				{},
			);

			const response = await fetch(`${controlPlaneUrl}/instance-metrics`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Instance-Secret': instanceSecret,
				},
				body: JSON.stringify({
					...metrics,
					reportedAt: Date.now(),
				}),
				signal: AbortSignal.timeout(15000),
			});

			if (!response.ok) {
				// eslint-disable-next-line no-console
				console.error(
					`[AnalyticsReporter] Control plane returned ${response.status}: ${response.statusText}`,
				);
			}
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[AnalyticsReporter] Failed to report metrics:', error);
		}
	},
});

/**
 * Sanity-check the cached transactional send count over a recent rolling
 * window. The authoritative counter is maintained inline on every insert
 * in `transactionalSends.ts` — a full-table reconcile is not viable on a
 * table that grows unboundedly. This check looks at the past 30 days only
 * and emits a structured log if the cached counter appears to have under-
 * counted. It never bumps the counter down (corruption recovery has to be
 * a deliberate, observed action, not a silent cron mutation).
 *
 * Called daily by cron job.
 */
export const reconcileTransactionalSendCount = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return;

		const cachedCount = settings.transactionalSendCount ?? 0;
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

		// Count recent sends by streaming (async iteration, no `.paginate()`):
		// Convex allows a single `.paginate()` per function execution, so the old
		// page-loop threw once a 30-day window held more than one page. A safety
		// cap bounds the scan (was MAX_PAGES * PAGE_SIZE) even if a burst happened.
		const MAX_RECENT = 10_000;
		let recentCount = 0;
		for await (const row of ctx.db
			.query('transactionalSends')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', thirtyDaysAgo))) {
			void row;
			recentCount += 1;
			if (recentCount >= MAX_RECENT) break;
		}

		if (recentCount > cachedCount) {
			// Running counter undercounted somewhere — log so an operator can
			// investigate the insert paths in transactionalSends.ts. Don't
			// auto-mutate the counter; that hides the bug.
			// eslint-disable-next-line no-console
			console.warn(
				JSON.stringify({
					event: 'transactional_count_drift',
					cachedCount,
					recentCount,
					windowDays: 30,
				}),
			);
		}
	},
});
