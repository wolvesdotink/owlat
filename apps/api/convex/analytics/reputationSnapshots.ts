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
import { summarize, type ReputationSummary } from './sendingReputation';

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

/** Start-of-day timestamp (midnight UTC) for a given time. */
export function startOfDayUtc(epochMs: number): number {
	const d = new Date(epochMs);
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
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

		// Prune old points. bounded: ~90 days of daily rows, so this stays a small
		// scan even when the cutoff sweeps several stale rows at once.
		const cutoff = now - SNAPSHOT_RETENTION_MS;
		const stale = await ctx.db
			.query('deliverySnapshots')
			.withIndex('by_period', (q) => q.lt('periodStart', cutoff))
			.collect();
		for (const row of stale) {
			await ctx.db.delete(row._id);
		}
	},
});

/** Chart-ready snapshot point (oldest → newest). */
export interface DeliverySnapshotPoint extends SnapshotMetrics {
	periodStart: number;
}

/**
 * The Delivery health page's trend source — up to ~90 days of daily snapshots,
 * oldest first, so the client can render the delivery-rate line and gate its
 * "collecting history" copy on how many points exist. Member-visible: coarse
 * org-wide operational rates, no credentials.
 */
// all-members: delivery-rate history is org-wide operational status, member-visible — coarse daily rates, no credentials or per-recipient data.
export const getDeliverySnapshots = authedQuery({
	args: {},
	handler: async (ctx): Promise<DeliverySnapshotPoint[]> => {
		await getUserIdFromSession(ctx);

		// bounded: the cron prunes >90-day rows, so at most ~90 daily points.
		const rows = await ctx.db
			.query('deliverySnapshots')
			.withIndex('by_period')
			.order('asc')
			.collect();

		return rows.map((r) => ({
			periodStart: r.periodStart,
			deliveryRate: r.deliveryRate,
			bounceRate: r.bounceRate,
			complaintRate: r.complaintRate,
			sentCount: r.sentCount,
		}));
	},
});
