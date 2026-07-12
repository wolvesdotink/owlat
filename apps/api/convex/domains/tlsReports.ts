/**
 * Inbound SMTP TLS Reports (TLS-RPT, RFC 8460) — ingestion + dashboard
 * aggregation.
 *
 * We publish a `_smtp._tls` `rua=` reporting address (see `domains/tlsRpt.ts`
 * for the outbound record and `apps/mta/src/inbound/router.ts` for the system
 * inbound route that catches it). Reports arrive as gzip-compressed JSON;
 * the MTA forwards them to the dedicated `/webhooks/mta-tls-report` webhook,
 * whose handler (`handleTlsReportWebhook`, wired in `http.ts`) gunzips + parses
 * them with the shared, never-throwing parser (`@owlat/shared` `decodeTlsReport`)
 * and calls {@link ingest}.
 *
 * `ingest` is idempotent by the report's own `report-id` (RFC 8460 §4.1) so a
 * re-delivered report never double-counts. {@link getTlsReportSummary} rolls the
 * stored rows up for the Delivery-page dashboard card: per-partner success rate,
 * failure-type tallies, and a 30-day trend.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';

/** Window the dashboard summarises. */
const SUMMARY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const failureTypeCountValidator = v.array(v.object({ type: v.string(), count: v.number() }));

/**
 * Idempotently persist one parsed TLS-RPT report digest. Called only by the
 * `/webhooks/mta-tls-report` HTTP action after the shared parser has validated
 * the upload. De-duplicates on `reportId`: a re-delivered report patches the
 * existing row (partners may re-send a corrected report for the same id)
 * instead of inserting a duplicate.
 */
export const ingest = internalMutation({
	args: {
		reportId: v.string(),
		organizationName: v.string(),
		contactInfo: v.string(),
		policyDomain: v.string(),
		rangeStartMs: v.number(),
		rangeEndMs: v.number(),
		successCount: v.number(),
		failureCount: v.number(),
		failureTypeCounts: failureTypeCountValidator,
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('tlsReports')
			.withIndex('by_reportId', (q) => q.eq('reportId', args.reportId))
			.unique();

		const row = { ...args, receivedAt: Date.now() };

		if (existing) {
			await ctx.db.patch(existing._id, row);
			return { deduped: true as const, id: existing._id };
		}
		const id = await ctx.db.insert('tlsReports', row);
		return { deduped: false as const, id };
	},
});

/** Per-partner roll-up returned to the dashboard. */
interface PartnerSummary {
	domain: string;
	successCount: number;
	failureCount: number;
	/** 0–1; null when there were no sessions at all. */
	successRate: number | null;
	reportCount: number;
}

/** Per-day point for the 30-day trend chart. */
interface TrendPoint {
	/** UTC day, `YYYY-MM-DD`. */
	date: string;
	successCount: number;
	failureCount: number;
}

/**
 * Roll up the last 30 days of TLS-RPT reports for the Delivery dashboard.
 *
 * Returns per-partner success rates, aggregate failure-type counts, a 30-day
 * daily trend, and headline totals. Empty when nothing has been ingested (the
 * card renders its own empty state).
 */
export const getTlsReportSummary = authedQuery({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - SUMMARY_WINDOW_DAYS * DAY_MS;
		const rows = await ctx.db
			.query('tlsReports')
			.withIndex('by_rangeStart', (q) => q.gte('rangeStartMs', cutoff))
			.collect(); // bounded: 30-day window over inbound TLS-RPT — a handful of partner MX providers report at most daily (low hundreds of rows).

		const partners = new Map<string, PartnerSummary>();
		const failureTypes = new Map<string, number>();
		const trend = new Map<string, TrendPoint>();
		let totalSuccess = 0;
		let totalFailure = 0;

		for (const r of rows) {
			totalSuccess += r.successCount;
			totalFailure += r.failureCount;

			const partner = partners.get(r.policyDomain) ?? {
				domain: r.policyDomain,
				successCount: 0,
				failureCount: 0,
				successRate: null,
				reportCount: 0,
			};
			partner.successCount += r.successCount;
			partner.failureCount += r.failureCount;
			partner.reportCount += 1;
			partners.set(r.policyDomain, partner);

			for (const f of r.failureTypeCounts) {
				failureTypes.set(f.type, (failureTypes.get(f.type) ?? 0) + f.count);
			}

			const dayKey = new Date(r.rangeStartMs).toISOString().slice(0, 10);
			const point = trend.get(dayKey) ?? { date: dayKey, successCount: 0, failureCount: 0 };
			point.successCount += r.successCount;
			point.failureCount += r.failureCount;
			trend.set(dayKey, point);
		}

		for (const partner of partners.values()) {
			const total = partner.successCount + partner.failureCount;
			partner.successRate = total > 0 ? partner.successCount / total : null;
		}

		const totalSessions = totalSuccess + totalFailure;
		return {
			windowDays: SUMMARY_WINDOW_DAYS,
			reportCount: rows.length,
			totalSuccessCount: totalSuccess,
			totalFailureCount: totalFailure,
			overallSuccessRate: totalSessions > 0 ? totalSuccess / totalSessions : null,
			partners: Array.from(partners.values()).sort(
				(a, b) => b.successCount + b.failureCount - (a.successCount + a.failureCount)
			),
			failureTypeCounts: Array.from(failureTypes.entries())
				.map(([type, count]) => ({ type, count }))
				.sort((a, b) => b.count - a.count),
			trend: Array.from(trend.values()).sort((a, b) => a.date.localeCompare(b.date)),
		};
	},
});
