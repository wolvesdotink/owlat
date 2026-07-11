/**
 * Reputation snapshots — the daily history behind the Delivery health page's
 * 30-day delivery-rate trend.
 *
 * `summarize` (analytics/sendingReputation.ts) only ever derives the *current*
 * rolling window, so there is no time series to chart from it alone. This module
 * persists one small point per day — the org's rolling delivery/bounce/complaint
 * rates + sent count at snapshot time — into `deliverySnapshots`, and prunes
 * points older than ~90 days in the same cron so the table stays bounded.
 *
 * The derivation is a pure function (`deriveSnapshot`) so the "what number gets
 * written" decision is unit-testable without a DB; the cron mutation
 * (`writeDailySnapshot`) is idempotent per UTC day (it patches the existing row
 * rather than inserting a duplicate) so a re-run in the same day is safe.
 */

import { internalMutation } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { summarize, startOfDayUtc, type ReputationSummary } from './sendingReputation';

// Re-exported so existing importers (and tests) keep resolving it from here.
export { startOfDayUtc };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How much snapshot history to keep. ~90 days of daily points. */
const SNAPSHOT_RETENTION_MS = 90 * DAY_MS;

/** The persisted per-day metrics, derived from a rolling reputation summary. */
export interface SnapshotMetrics {
	deliveryRate: number;
	bounceRate: number;
	complaintRate: number;
	sentCount: number;
}

/**
 * Derive the per-day snapshot metrics from a rolling reputation summary. Pure —
 * no DB — so the delivery-rate computation (delivered/sent, guarded against a
 * zero-send window) is unit-testable in isolation.
 */
export function deriveSnapshot(summary: ReputationSummary): SnapshotMetrics {
	const deliveryRate = summary.totalSent > 0 ? summary.totalDelivered / summary.totalSent : 0;
	return {
		deliveryRate,
		bounceRate: summary.bounceRate,
		complaintRate: summary.complaintRate,
		sentCount: summary.totalSent,
	};
}

/**
 * Daily cron: write today's reputation snapshot and prune points older than the
 * retention horizon. Idempotent per UTC day — a second run on the same day
 * patches the existing row instead of inserting a duplicate.
 */
export const writeDailySnapshot = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const periodStart = startOfDayUtc(now);

		const orgSummary = await summarize(ctx.db, { kind: 'org' });
		const metrics = deriveSnapshot(orgSummary);

		const existing = await ctx.db
			.query('deliverySnapshots')
			.withIndex('by_period', (q) => q.eq('periodStart', periodStart))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, { ...metrics, createdAt: now });
		} else {
			await ctx.db.insert('deliverySnapshots', { periodStart, ...metrics, createdAt: now });
		}

		// Prune old points beyond the retention horizon.
		const cutoff = now - SNAPSHOT_RETENTION_MS;
		const stale = await ctx.db
			.query('deliverySnapshots')
			.withIndex('by_period', (q) => q.lt('periodStart', cutoff))
			.collect(); // bounded: ~90 days of daily rows, so at most a handful of stale points per run
		for (const row of stale) {
			await ctx.db.delete(row._id);
		}
	},
});

/** Chart-ready snapshot point (oldest → newest). */
export interface DeliverySnapshotPoint extends SnapshotMetrics {
	periodStart: number;
}

/** How many trailing daily points the delivery-rate trend chart plots. */
const TREND_WINDOW_DAYS = 30;

/**
 * The Delivery health page's trend source — the last 30 daily snapshots, oldest
 * first, so the client can render the 30-day delivery-rate line and gate its
 * "collecting history" copy on how many points exist. The cron retains ~90 days,
 * but the chart is a fixed 30-day window, so the query bounds itself rather than
 * shipping the whole retention window and letting the page silently grow to 90.
 * Member-visible: coarse org-wide operational rates, no credentials.
 */
// all-members: delivery-rate history is org-wide operational status, member-visible — coarse daily rates, no credentials or per-recipient data.
export const getDeliverySnapshots = authedQuery({
	args: {},
	handler: async (ctx): Promise<DeliverySnapshotPoint[]> => {
		await getUserIdFromSession(ctx);

		const rows = await ctx.db
			.query('deliverySnapshots')
			.withIndex('by_period')
			.order('desc')
			.take(TREND_WINDOW_DAYS); // bounded: the fixed 30-day trend window, newest first
		rows.reverse(); // → oldest-first for the chart's left-to-right axis

		return rows.map((r) => ({
			periodStart: r.periodStart,
			deliveryRate: r.deliveryRate,
			bounceRate: r.bounceRate,
			complaintRate: r.complaintRate,
			sentCount: r.sentCount,
		}));
	},
});
