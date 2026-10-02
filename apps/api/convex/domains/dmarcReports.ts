/**
 * DMARC aggregate (RUA) reports — ingestion, the per-domain dashboard and the
 * reporting setup each sending domain shows.
 *
 * Intake: receivers mail reports to Owlat's report address
 * (`owlatDmarcReportAddress`, default `dmarc-reports@<return-path domain>`).
 * The MTA routes that address to `/webhooks/mta-dmarc-report`
 * (`dmarcReportsHttp.ts`), the Node action `dmarcReportsNode.ts` unpacks and
 * parses the attachment with `@owlat/shared/dmarcReport`, and {@link ingest}
 * stores it once per (reporter, report id). After a report lands, the source
 * IPs get a forward-confirmed reverse DNS name in the background, which is what
 * lets the dashboard name an organisation instead of an address.
 *
 * Reads are admin-gated (`organization:manage`), like the TLS report card and
 * every other Delivery telemetry surface. Owlat never changes a domain's DNS
 * policy on its own: the readiness verdict hands the operator the record to
 * publish, and the policy selector on the domain stays the only writer.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { internalQuery } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { DAY_MS } from '../lib/constants';
import { getOrThrow } from '../_utils/errors';
import { omit } from '../lib/validators/fields';
import { literalUnion } from '../lib/literalUnion';
import { dmarcReportFields, dmarcReportRecordFields } from '../schema/dmarcReports';
import {
	dmarcReportAuthorizationRecord,
	normalizeDmarcReportAddress,
} from '@owlat/shared/dmarcReportAddress';
import { DMARC_REPORT_MAX_RECORDS, DMARC_REPORT_MAX_ROW_COUNT } from '@owlat/shared/dmarcReport';
import {
	buildDmarcRecordValue,
	DEFAULT_DMARC_POLICY,
	dmarcRuaFromEnv,
	externalDmarcRuaFromEnv,
	owlatDmarcReportAddress,
	type DmarcPolicy,
} from './dmarc';
import { parsePoolIpsLenient } from './spf';
import { READINESS_WINDOW_DAYS, rollUpDmarcRows } from './dmarcSources';

/** Reports (and their rows) are kept this long after they arrive. */
export const DMARC_REPORT_RETENTION_DAYS = 90;
/** The windows the dashboard offers. */
const DMARC_DASHBOARD_WINDOW_DAYS = [7, 30, 90] as const;
/** Rows read for one dashboard view; a busier domain shows a truncated view. */
const MAX_ROWS_PER_SUMMARY = 20_000;
const MAX_REPORTS_PER_SUMMARY = 3_000;
/** Source IPs per report that get a reverse DNS lookup. */
export const MAX_RESOLVED_SOURCES_PER_REPORT = 100;
const RETENTION_BATCH = 1_000;

const recordArgValidator = v.object(
	omit(dmarcReportRecordFields, ['reportDocId', 'policyDomain', 'rangeBeginMs', 'sourceHost'])
);

/**
 * Persist one parsed report, once. Called only by
 * `dmarcReportsNode.decodeAndIngest` after the shared parser validated it.
 * Drops (without error) a report about a domain this deployment does not send
 * for, one outside the retention window, and a re-delivery of a stored report.
 */
export const ingest = internalMutation({
	args: {
		report: v.object(
			omit(dmarcReportFields, ['messageCount', 'alignedCount', 'recordCount', 'receivedAt'])
		),
		records: v.array(recordArgValidator),
	},
	returns: v.object({
		status: v.union(
			v.literal('stored'),
			v.literal('duplicate'),
			v.literal('unknown-domain'),
			v.literal('out-of-window')
		),
	}),
	handler: async (ctx, { report, records }) => {
		if (records.length > DMARC_REPORT_MAX_RECORDS) {
			throw new Error(`DMARC report exceeds the ${DMARC_REPORT_MAX_RECORDS} record limit`);
		}
		if (
			records.some(
				(record) =>
					!Number.isSafeInteger(record.count) ||
					record.count < 0 ||
					record.count > DMARC_REPORT_MAX_ROW_COUNT
			)
		) {
			throw new Error('DMARC report contains an invalid message count');
		}

		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', report.policyDomain))
			.first();
		if (!domain) return { status: 'unknown-domain' as const };

		const now = Date.now();
		if (
			report.rangeEndMs > now + DAY_MS ||
			report.rangeBeginMs < now - DMARC_REPORT_RETENTION_DAYS * DAY_MS
		) {
			return { status: 'out-of-window' as const };
		}

		const existing = await ctx.db
			.query('dmarcReports')
			.withIndex('by_reporter_report_id', (q) =>
				q.eq('reporterOrgName', report.reporterOrgName).eq('reportId', report.reportId)
			)
			.first();
		if (existing) return { status: 'duplicate' as const };

		let messageCount = 0;
		let alignedCount = 0;
		for (const record of records) {
			messageCount += record.count;
			if (record.isDkimAligned || record.isSpfAligned) alignedCount += record.count;
		}
		const reportDocId = await ctx.db.insert('dmarcReports', {
			...report,
			messageCount,
			alignedCount,
			recordCount: records.length,
			receivedAt: now,
		});
		for (const record of records) {
			await ctx.db.insert('dmarcReportRecords', {
				...record,
				reportDocId,
				policyDomain: report.policyDomain,
				rangeBeginMs: report.rangeBeginMs,
			});
		}
		await ctx.scheduler.runAfter(0, internal.domains.dmarcReportsNode.resolveSourceHosts, {
			reportDocId,
		});
		return { status: 'stored' as const };
	},
});

/** Distinct source IPs of a report that have no host name yet (bounded). */
export const listUnresolvedSources = internalQuery({
	args: { reportDocId: v.id('dmarcReports') },
	returns: v.array(v.string()),
	handler: async (ctx, { reportDocId }) => {
		const rows = await ctx.db
			.query('dmarcReportRecords')
			.withIndex('by_report', (q) => q.eq('reportDocId', reportDocId))
			.take(DMARC_REPORT_MAX_RECORDS);
		const ips = new Set<string>();
		for (const row of rows) {
			if (row.sourceHost === undefined) ips.add(row.sourceIp);
			if (ips.size >= MAX_RESOLVED_SOURCES_PER_REPORT) break;
		}
		return Array.from(ips);
	},
});

/** Attach resolved host names to a report's rows. */
export const recordSourceHosts = internalMutation({
	args: {
		reportDocId: v.id('dmarcReports'),
		hosts: v.array(v.object({ ip: v.string(), host: v.string() })),
	},
	returns: v.null(),
	handler: async (ctx, { reportDocId, hosts }) => {
		const hostByIp = new Map(hosts.map((entry) => [entry.ip, entry.host.slice(0, 253)]));
		if (hostByIp.size === 0) return null;
		const rows = await ctx.db
			.query('dmarcReportRecords')
			.withIndex('by_report', (q) => q.eq('reportDocId', reportDocId))
			.take(DMARC_REPORT_MAX_RECORDS);
		for (const row of rows) {
			const host = hostByIp.get(row.sourceIp);
			if (host && row.sourceHost !== host) await ctx.db.patch(row._id, { sourceHost: host });
		}
		return null;
	},
});

/**
 * Delete reports past the retention window, one report's rows at a time, and
 * re-schedule until nothing is left. Registered as a daily retention cron.
 */
export const sweepExpiredReports = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const cutoff = Date.now() - DMARC_REPORT_RETENTION_DAYS * DAY_MS;
		const report = await ctx.db
			.query('dmarcReports')
			.withIndex('by_received_at', (q) => q.lt('receivedAt', cutoff))
			.first();
		if (!report) return null;
		const rows = await ctx.db
			.query('dmarcReportRecords')
			.withIndex('by_report', (q) => q.eq('reportDocId', report._id))
			.take(RETENTION_BATCH);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length < RETENTION_BATCH) await ctx.db.delete(report._id);
		await ctx.scheduler.runAfter(0, internal.domains.dmarcReports.sweepExpiredReports, {});
		return null;
	},
});

// ─── Reporting setup (DNS guidance) ─────────────────────────────────

/**
 * Whether this install reads DMARC reports itself, sends them to an address the
 * operator configured elsewhere (`MTA_DMARC_RUA`), or requests none.
 */
type ReportingMode = 'owlat' | 'external' | 'none';

function reportingMode(ownAddress: string | null): ReportingMode {
	if (ownAddress) return 'owlat';
	return externalDmarcRuaFromEnv() ? 'external' : 'none';
}

/** The `rua=` URIs of a stored `_dmarc` value, as bare lowercase addresses. */
function ruaAddressesOf(recordValue: string | undefined): string[] {
	const rua = /(?:^|;)\s*rua\s*=\s*([^;]*)/i.exec(recordValue ?? '')?.[1] ?? '';
	return rua
		.split(',')
		.map((uri) => normalizeDmarcReportAddress(uri))
		.filter((address): address is string => address !== null);
}

/**
 * How DMARC reporting is set up for one sending domain: where reports go, the
 * `rua=` value the record should carry, whether the published record already
 * asks for them, and the cross-domain authorization record when the report
 * address lives outside the domain's organizational domain.
 */
export const getDomainReporting = adminQuery({
	args: { domainId: v.id('domains') },
	handler: async (ctx, { domainId }) => {
		const domain = await getOrThrow(ctx, domainId, 'Domain');
		const ownAddress = owlatDmarcReportAddress();
		const mode = reportingMode(ownAddress);
		const storedValue = (domain.dnsRecords as { dmarc?: { value: string } }).dmarc?.value;
		const expectedValue = storedValue
			? buildDmarcRecordValue(domain.domain, {
					policy: domain.dmarcPolicy ?? DEFAULT_DMARC_POLICY,
					subdomainPolicy: domain.dmarcSubdomainPolicy,
					pct: domain.dmarcPct,
					rua: dmarcRuaFromEnv(),
				})
			: null;
		const latest = await ctx.db
			.query('dmarcReports')
			.withIndex('by_policy_domain_range', (q) => q.eq('policyDomain', domain.domain))
			.order('desc')
			.first();
		return {
			domain: domain.domain,
			mode,
			reportAddress: ownAddress,
			externalRua: externalDmarcRuaFromEnv() ?? null,
			rua: dmarcRuaFromEnv() ?? null,
			hasDmarcRecord: storedValue !== undefined,
			isRecordRequestingReports:
				ownAddress !== null && ruaAddressesOf(storedValue).includes(ownAddress),
			isRecordCurrent: storedValue !== undefined && storedValue === expectedValue,
			authorizationRecord: ownAddress
				? dmarcReportAuthorizationRecord(domain.domain, ownAddress)
				: null,
			lastReportAt: latest?.receivedAt ?? null,
		};
	},
});

// ─── Dashboard ──────────────────────────────────────────────────────

function ownInfrastructure() {
	const host = getOptional('EHLO_HOSTNAME')?.trim().toLowerCase();
	return {
		ips: new Set(parsePoolIpsLenient(getOptional('MTA_IP_POOLS')).ips),
		hosts: new Set(host ? [host] : []),
	};
}

function nextPolicy(policy: DmarcPolicy): DmarcPolicy | null {
	if (policy === 'none') return 'quarantine';
	if (policy === 'quarantine') return 'reject';
	return null;
}

/**
 * The per-domain DMARC dashboard: volume and pass rate per day, sources grouped
 * by organisation (failing first), and the enforcement readiness verdict with
 * the exact `_dmarc` record to publish for the next policy step.
 */
export const getDomainSummary = adminQuery({
	args: {
		domainId: v.id('domains'),
		windowDays: literalUnion(DMARC_DASHBOARD_WINDOW_DAYS),
	},
	handler: async (ctx, { domainId, windowDays }) => {
		const domain: Doc<'domains'> = await getOrThrow(ctx, domainId, 'Domain');
		const now = Date.now();
		const readDays = Math.max(windowDays, READINESS_WINDOW_DAYS);
		const since = now - readDays * DAY_MS;

		const [matchedReports, matchedRows] = await Promise.all([
			ctx.db
				.query('dmarcReports')
				.withIndex('by_policy_domain_range', (q) =>
					q.eq('policyDomain', domain.domain).gte('rangeBeginMs', now - windowDays * DAY_MS)
				)
				.take(MAX_REPORTS_PER_SUMMARY + 1),
			ctx.db
				.query('dmarcReportRecords')
				.withIndex('by_policy_domain_range', (q) =>
					q.eq('policyDomain', domain.domain).gte('rangeBeginMs', since)
				)
				.order('desc')
				.take(MAX_ROWS_PER_SUMMARY + 1),
		]);
		const reports = matchedReports.slice(0, MAX_REPORTS_PER_SUMMARY);
		const rollup = rollUpDmarcRows(
			matchedRows.slice(0, MAX_ROWS_PER_SUMMARY),
			ownInfrastructure(),
			windowDays,
			now
		);

		const currentPolicy = domain.dmarcPolicy ?? DEFAULT_DMARC_POLICY;
		const next = nextPolicy(currentPolicy);
		const recommendedRecord =
			next === null
				? null
				: {
						type: 'TXT' as const,
						host: '_dmarc',
						value: buildDmarcRecordValue(domain.domain, {
							policy: next,
							subdomainPolicy: domain.dmarcSubdomainPolicy,
							rua: dmarcRuaFromEnv(),
						}),
					};

		return {
			domain: domain.domain,
			windowDays,
			reportCount: reports.length,
			reporterCount: new Set(reports.map((report) => report.reporterOrgName)).size,
			isTruncated:
				matchedReports.length > MAX_REPORTS_PER_SUMMARY ||
				matchedRows.length > MAX_ROWS_PER_SUMMARY,
			lastReportAt: reports.reduce<number | null>(
				(latest, report) => Math.max(latest ?? 0, report.receivedAt),
				null
			),
			...rollup,
			readiness: {
				...rollup.readiness,
				currentPolicy,
				nextPolicy: next,
				recommendedRecord,
			},
		};
	},
});
