/**
 * Inbound SMTP TLS Reports (TLS-RPT, RFC 8460) — ingestion + dashboard
 * aggregation.
 *
 * We publish a `_smtp._tls` `rua=` reporting address (see `domains/tlsRpt.ts`
 * for the outbound record and `apps/mta/src/inbound/router.ts` for the system
 * inbound route that catches it). Reports arrive as gzip-compressed JSON;
 * the MTA forwards them to the dedicated `/webhooks/mta-tls-report` webhook,
 * whose handler (`handleTlsReportWebhook`, wired in `http.ts`) verifies the HMAC
 * signature and hands the attachment to the `'use node'` action
 * `domains/tlsReportsNode.ts:decodeAndIngest` (the gunzip step needs the Node
 * runtime), which parses with the shared never-throwing parser (`@owlat/shared`
 * `decodeTlsReport`) and calls {@link ingest}.
 *
 * `ingest` is idempotent by reporting organization + `report-id` (RFC 8460 §4.1)
 * so a re-delivered report never double-counts. {@link getTlsReportSummary} rolls
 * the stored rows up for the Delivery-page dashboard card: per-reporter success
 * rate, failure-type tallies, and a 30-day trend.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import {
	TLS_RPT_MAX_CONTACT_INFO_LENGTH,
	TLS_RPT_MAX_FAILURE_TYPE_LENGTH,
	TLS_RPT_MAX_FAILURE_TYPES,
	TLS_RPT_MAX_ORGANIZATION_NAME_LENGTH,
	TLS_RPT_MAX_POLICY_DOMAIN_LENGTH,
	TLS_RPT_MAX_REPORT_ID_LENGTH,
	TLS_RPT_MAX_SESSION_COUNT,
} from '@owlat/shared';

/** Window the dashboard summarises. */
const SUMMARY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_SUMMARY = 5_000;

const failureTypeCountValidator = v.array(v.object({ type: v.string(), count: v.number() }));

/**
 * Idempotently persist one parsed TLS-RPT report digest. Called only by the
 * `/webhooks/mta-tls-report` HTTP action after the shared parser has validated
 * the upload. De-duplicates on reporting organization + `reportId`: a
 * re-delivered or corrected report patches that reporter's existing row instead
 * of conflating reporters that happened to choose the same id.
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
		if (args.failureTypeCounts.length > TLS_RPT_MAX_FAILURE_TYPES) {
			throw new Error(`TLS report exceeds the ${TLS_RPT_MAX_FAILURE_TYPES} failure-type limit`);
		}
		if (
			args.reportId.length === 0 ||
			args.reportId.length > TLS_RPT_MAX_REPORT_ID_LENGTH ||
			args.organizationName.length === 0 ||
			args.organizationName.length > TLS_RPT_MAX_ORGANIZATION_NAME_LENGTH ||
			args.contactInfo.length > TLS_RPT_MAX_CONTACT_INFO_LENGTH ||
			args.policyDomain.length === 0 ||
			args.policyDomain.length > TLS_RPT_MAX_POLICY_DOMAIN_LENGTH
		) {
			throw new Error('TLS report contains an invalid stored label');
		}
		if (
			!isNonNegativeSafeInteger(args.successCount) ||
			!isNonNegativeSafeInteger(args.failureCount) ||
			!Number.isSafeInteger(args.rangeStartMs) ||
			!Number.isSafeInteger(args.rangeEndMs) ||
			args.rangeStartMs > args.rangeEndMs ||
			args.failureTypeCounts.some(
				(entry) =>
					entry.type.length === 0 ||
					entry.type.length > TLS_RPT_MAX_FAILURE_TYPE_LENGTH ||
					!isNonNegativeSafeInteger(entry.count)
			)
		) {
			throw new Error('TLS report contains invalid counters or date range');
		}
		const existing = await ctx.db
			.query('tlsReports')
			.withIndex('by_reporter_report_id', (q) =>
				q.eq('organizationName', args.organizationName).eq('reportId', args.reportId)
			)
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

function isNonNegativeSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= TLS_RPT_MAX_SESSION_COUNT;
}

/** Per-reporting-organization roll-up returned to the dashboard. */
interface ReportingOrganizationSummary {
	organizationName: string;
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
 * Returns per-reporter success rates, aggregate failure-type counts, a 30-day
 * daily trend, and headline totals. Empty when nothing has been ingested (the
 * card renders its own empty state).
 *
 * Admin-gated (`adminQuery` → `organization:manage`): TLS-RPT is operator
 * transport telemetry that lives on the admin-only Delivery → Config page
 * alongside `delivery.status.getStatus` (also `adminQuery`), so it follows the
 * same floor rather than being visible to every org member.
 */
export const getTlsReportSummary = adminQuery({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - SUMMARY_WINDOW_DAYS * DAY_MS;
		const matchedRows = await ctx.db
			.query('tlsReports')
			.withIndex('by_range_start_ms', (q) => q.gte('rangeStartMs', cutoff))
			.take(MAX_REPORTS_PER_SUMMARY + 1);
		const rows = matchedRows.slice(0, MAX_REPORTS_PER_SUMMARY);

		const reportingOrganizations = new Map<string, ReportingOrganizationSummary>();
		const failureTypes = new Map<string, number>();
		const trend = new Map<string, TrendPoint>();
		let totalSuccess = 0;
		let totalFailure = 0;

		for (const r of rows) {
			totalSuccess += r.successCount;
			totalFailure += r.failureCount;

			const reportingOrganization = reportingOrganizations.get(r.organizationName) ?? {
				organizationName: r.organizationName,
				successCount: 0,
				failureCount: 0,
				successRate: null,
				reportCount: 0,
			};
			reportingOrganization.successCount += r.successCount;
			reportingOrganization.failureCount += r.failureCount;
			reportingOrganization.reportCount += 1;
			reportingOrganizations.set(r.organizationName, reportingOrganization);

			for (const f of r.failureTypeCounts) {
				failureTypes.set(f.type, (failureTypes.get(f.type) ?? 0) + f.count);
			}

			const dayKey = new Date(r.rangeStartMs).toISOString().slice(0, 10);
			const point = trend.get(dayKey) ?? { date: dayKey, successCount: 0, failureCount: 0 };
			point.successCount += r.successCount;
			point.failureCount += r.failureCount;
			trend.set(dayKey, point);
		}

		for (const reportingOrganization of reportingOrganizations.values()) {
			const total = reportingOrganization.successCount + reportingOrganization.failureCount;
			reportingOrganization.successRate =
				total > 0 ? reportingOrganization.successCount / total : null;
		}

		const totalSessions = totalSuccess + totalFailure;
		return {
			windowDays: SUMMARY_WINDOW_DAYS,
			reportCount: rows.length,
			isTruncated: matchedRows.length > MAX_REPORTS_PER_SUMMARY,
			totalSuccessCount: totalSuccess,
			totalFailureCount: totalFailure,
			overallSuccessRate: totalSessions > 0 ? totalSuccess / totalSessions : null,
			reportingOrganizations: Array.from(reportingOrganizations.values()).sort(
				(a, b) => b.successCount + b.failureCount - (a.successCount + a.failureCount)
			),
			failureTypeCounts: Array.from(failureTypes.entries())
				.map(([type, count]) => ({ type, count }))
				.sort((a, b) => b.count - a.count),
			trend: Array.from(trend.values()).sort((a, b) => a.date.localeCompare(b.date)),
		};
	},
});
