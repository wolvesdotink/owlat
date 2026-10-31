/**
 * TLS-RPT aggregate report generation and delivery (RFC 8460 §3, §4.1, §5.3).
 *
 * Reads the per-domain-per-day results tlsRpt.ts records, builds the JSON
 * report, and sends it gzip-compressed to the domain's `_smtp._tls` rua
 * address over HTTPS or as a mailto attachment on the MTA's own send queue.
 */

import type Redis from 'ioredis';
import { createHash } from 'crypto';
import { resolve as dnsResolve } from 'dns/promises';
import { gzipSync } from 'zlib';
import { logger } from '../monitoring/logger.js';
import { Counter } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import type { EmailJob } from '../types.js';
import { isRecord } from '@owlat/shared/utils/guards';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { enqueueReconciledIntake } from '../queue/intakeEnqueue.js';
import { TLS_RPT_PREFIX, type TlsPolicyType } from './tlsRpt.js';

// ─── Prometheus Metrics ─────────────────────────────────────────────

const tlsReportsSent = new Counter({
	name: 'mta_tls_reports_sent_total',
	help: 'TLS-RPT reports sent',
	registers: [registry],
});

// ─── Types ──────────────────────────────────────────────────────────

interface TlsReportPolicy {
	'policy-type': TlsPolicyType;
	'policy-string': string[];
	'policy-domain': string;
	'mx-host'?: string[];
}

interface TlsReportFailureDetail {
	'result-type': string;
	'sending-mta-ip': string;
	'receiving-mx-hostname': string;
	'receiving-ip'?: string;
	'failed-session-count': number;
	'additional-information'?: string;
}

interface TlsReport {
	'organization-name': string;
	'date-range': {
		'start-datetime': string;
		'end-datetime': string;
	};
	'contact-info': string;
	'report-id': string;
	policies: Array<{
		policy: TlsReportPolicy;
		summary: {
			'total-successful-session-count': number;
			'total-failure-session-count': number;
		};
		'failure-details'?: TlsReportFailureDetail[];
	}>;
}

/**
 * The slice of the GroupMQ queue API that TLS-RPT mailto delivery needs.
 * Declared structurally so report generation does not depend on the concrete
 * `Queue<EmailJob>` import (and so tests can pass a lightweight stub).
 */
export interface TlsRptQueue {
	add(opts: {
		groupId: string;
		data: EmailJob;
		jobId?: string;
		orderMs?: number;
	}): Promise<{ id: string }>;
	getJob(jobId: string): Promise<unknown | null>;
}

// ─── Report Generation ──────────────────────────────────────────────

/**
 * Look up the TLS-RPT reporting address for a domain.
 * Checks the _smtp._tls TXT record for a rua= address.
 *
 * @returns The reporting address (mailto: or https: URI), or null
 */
async function getTlsRptAddress(domain: string): Promise<string | null> {
	try {
		const records = await dnsResolve(`_smtp._tls.${domain}`, 'TXT');
		const flat = records.flat().join('');

		// Parse: v=TLSRPTv1; rua=mailto:reports@example.com
		const match = flat.match(/v=TLSRPTv1[;\s]+rua=([^\s;]+)/i);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * Generate a TLS-RPT report for a domain.
 */
export async function generateReport(
	redis: Redis,
	recipientDomain: string,
	date: string,
	organizationName: string,
	contactEmail: string
): Promise<TlsReport | null> {
	const key = `${TLS_RPT_PREFIX}${recipientDomain}:${date}`;
	const stats = await redis.hgetall(key);

	if (!stats || Object.keys(stats).length === 0) {
		return null; // No data for this domain/date
	}

	const successes = parseInt(stats['successes'] || '0', 10);
	const failures = parseInt(stats['failures'] || '0', 10);

	if (successes === 0 && failures === 0) {
		return null;
	}

	// Build failure details from stored failures
	const failureKey = `${key}:failures`;
	const rawFailures = await redis.lrange(failureKey, 0, -1);

	// Aggregate failures by type+mxHost
	const failureMap = new Map<
		string,
		{ type: string; mxHost: string; sendingIp: string; count: number }
	>();
	for (const raw of rawFailures) {
		const f = parseFailureDetail(raw);
		if (!f) continue; // Skip malformed entries
		const mapKey = `${f.type}:${f.mxHost}:${f.sendingIp}`;
		const existing = failureMap.get(mapKey);
		if (existing) {
			existing.count++;
		} else {
			failureMap.set(mapKey, { ...f, count: 1 });
		}
	}

	const failureDetails: TlsReportFailureDetail[] = Array.from(failureMap.values()).map((f) => ({
		'result-type': f.type,
		'sending-mta-ip': f.sendingIp,
		'receiving-mx-hostname': f.mxHost,
		'failed-session-count': f.count,
	}));

	const startDate = new Date(`${date}T00:00:00Z`);
	const endDate = new Date(`${date}T23:59:59Z`);

	// Attribute the report block to the policy actually applied this day.
	// recordTlsResult persists the policy context (RFC 8460 §3); absent that we
	// fall back to 'no-policy-found' (opportunistic TLS, no MTA-STS in force).
	const reportPolicy = buildReportPolicy(recipientDomain, stats);

	return {
		'organization-name': organizationName,
		'date-range': {
			'start-datetime': startDate.toISOString(),
			'end-datetime': endDate.toISOString(),
		},
		'contact-info': `mailto:${contactEmail}`,
		'report-id': `${organizationName}-${recipientDomain}-${date}`,
		policies: [
			{
				policy: reportPolicy,
				summary: {
					'total-successful-session-count': successes,
					'total-failure-session-count': failures,
				},
				...(failureDetails.length > 0 ? { 'failure-details': failureDetails } : {}),
			},
		],
	};
}

/**
 * Reconstruct the TLS-RPT policy block from the persisted per-domain-per-day
 * stats. When recordTlsResult stored an MTA-STS context the block reports
 * `policy-type: sts` with the policy body and MX host patterns; otherwise it
 * is the opportunistic-TLS default (`no-policy-found`, empty policy-string).
 */
function buildReportPolicy(
	recipientDomain: string,
	stats: Record<string, string>
): TlsReportPolicy {
	const storedType = stats['policy-type'];
	if (storedType === 'sts' || storedType === 'tlsa') {
		const policyString = parseJsonStringArray(stats['policy-string']);
		const mxHost = parseJsonStringArray(stats['mx-host']);
		return {
			'policy-type': storedType,
			'policy-string': policyString,
			'policy-domain': recipientDomain,
			...(mxHost.length > 0 ? { 'mx-host': mxHost } : {}),
		};
	}

	return {
		'policy-type': 'no-policy-found',
		'policy-string': [],
		'policy-domain': recipientDomain,
	};
}

/** Parse a JSON string-array field, tolerating absent/malformed values. */
function parseJsonStringArray(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

/** One stored failure session, or `null` when the entry is malformed. */
function parseFailureDetail(
	raw: string
): { type: string; mxHost: string; sendingIp: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const { type, mxHost, sendingIp } = parsed;
	return typeof type === 'string' && typeof mxHost === 'string' && typeof sendingIp === 'string'
		? { type, mxHost, sendingIp }
		: null;
}

/**
 * Generate and send TLS-RPT reports for all domains with session activity.
 * Called daily by the leader instance.
 *
 * Only sends reports to domains that have a _smtp._tls TXT record.
 * Reports are sent for every domain with at least one session — including
 * all-success days — per RFC 8460 §4.1 (continuous reporting).
 */
export async function generateAndSendReports(
	redis: Redis,
	organizationName: string,
	contactEmail: string,
	queue?: TlsRptQueue
): Promise<{ sent: number; skipped: number; errors: number }> {
	const yesterday = new Date(Date.now() - 86400_000).toISOString().split('T')[0]!;
	const stats = { sent: 0, skipped: 0, errors: 0 };

	// Scan for all domains with TLS data from yesterday
	let cursor = '0';
	const domainsWithData: string[] = [];

	do {
		const [nextCursor, keys] = await redis.scan(
			cursor,
			'MATCH',
			`${TLS_RPT_PREFIX}*:${yesterday}`,
			'COUNT',
			100
		);
		cursor = nextCursor;

		for (const key of keys) {
			// Skip failure detail keys
			if (key.endsWith(':failures')) continue;
			const domain = key.replace(`${TLS_RPT_PREFIX}`, '').replace(`:${yesterday}`, '');
			if (domain) domainsWithData.push(domain);
		}
	} while (cursor !== '0');

	for (const domain of domainsWithData) {
		try {
			// RFC 8460 §4.1: reporting is continuous — send a report whenever
			// there is *any* session activity for the day, including all-success
			// days (total-failure-session-count: 0). Skipping success-only days
			// would make our reports indistinguishable from "no data sent", which
			// the spec explicitly discourages.
			const key = `${TLS_RPT_PREFIX}${domain}:${yesterday}`;
			const successCount = parseInt((await redis.hget(key, 'successes')) ?? '0', 10);
			const failureCount = parseInt((await redis.hget(key, 'failures')) ?? '0', 10);
			if (successCount === 0 && failureCount === 0) {
				stats.skipped++;
				continue;
			}

			// Check if domain has a TLS-RPT reporting address
			const reportAddress = await getTlsRptAddress(domain);
			if (!reportAddress) {
				stats.skipped++;
				continue;
			}

			const report = await generateReport(redis, domain, yesterday, organizationName, contactEmail);
			if (!report) {
				stats.skipped++;
				continue;
			}

			// Submitter domain — the org that generated this report (RFC 8460 §5.3).
			const submitterDomain = extractDomain(contactEmail) || organizationName;
			// RFC 8460 §3: the report is gzip-compressed JSON ("application/tlsrpt+gzip").
			const reportJson = JSON.stringify(report);
			const gzipped = gzipSync(Buffer.from(reportJson, 'utf8'));

			// Send to HTTPS endpoint
			if (reportAddress.startsWith('https:')) {
				try {
					// RFC 8460 §3: HTTPS POST body MUST be gzip-compressed JSON with
					// Content-Type application/tlsrpt+gzip. Posting raw JSON under that
					// type is non-conformant and conformant receivers reject it.
					const response = await fetch(reportAddress, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/tlsrpt+gzip',
						},
						body: gzipped,
					});

					if (response.ok) {
						stats.sent++;
						tlsReportsSent.inc();
						logger.info({ domain, reportAddress }, 'TLS-RPT sent via HTTPS');
					} else {
						stats.errors++;
						logger.warn({ domain, status: response.status }, 'TLS-RPT HTTPS delivery failed');
					}
				} catch (err) {
					stats.errors++;
					logger.warn({ err, domain }, 'TLS-RPT HTTPS delivery error');
				}
			} else if (reportAddress.startsWith('mailto:')) {
				// RFC 8460 §5.3: deliver via email with the gzipped report as an
				// application/tlsrpt+gzip attachment and a Subject of the form
				// "Report Domain: <policy-domain> Submitter: <submitter-domain>
				//  Report-ID: <report-id>". We enqueue onto the MTA's own send
				// queue so the report rides the normal DKIM/IP-pool delivery path.
				if (!queue) {
					logger.warn(
						{ domain, reportAddress },
						'TLS-RPT mailto delivery skipped — no send queue available'
					);
					stats.skipped++;
					continue;
				}

				try {
					const recipient = reportAddress.slice('mailto:'.length).split('?')[0]!.trim();
					const fromAddress = contactEmail;
					const subject =
						`Report Domain: ${domain} Submitter: ${submitterDomain} ` +
						`Report-ID: <${report['report-id']}>`;
					// RFC 8460 §5.1 filename: sender!policy-domain!start!end.json.gz
					const startTs = Math.floor(
						new Date(report['date-range']['start-datetime']).getTime() / 1000
					);
					const endTs = Math.floor(new Date(report['date-range']['end-datetime']).getTime() / 1000);
					const filename = `${submitterDomain}!${domain}!${startTs}!${endTs}.json.gz`;

					const reportIdentity = createHash('sha256')
						.update(
							JSON.stringify({
								reportId: report['report-id'],
								submitterDomain,
								policyDomain: domain,
								recipient,
								startTs,
								endTs,
							})
						)
						.digest('hex');
					const messageId = `tlsrpt-${reportIdentity}`;
					const job: EmailJob & { intakeReceiptId: string } = {
						messageId,
						intakeReceiptId: messageId,
						to: recipient,
						from: fromAddress,
						subject,
						// RFC 8460 §5.3: the human-readable body is informational; the
						// machine-readable report travels as the attachment.
						html: `<p>TLS-RPT aggregate report for ${domain} (${yesterday}).</p>`,
						text: `TLS-RPT aggregate report for ${domain} (${yesterday}).`,
						headers: {
							'TLS-Report-Domain': domain,
							'TLS-Report-Submitter': submitterDomain,
						},
						attachments: [
							{
								filename,
								contentType: 'application/tlsrpt+gzip',
								contentBase64: gzipped.toString('base64'),
							},
						],
						ipPool: 'transactional',
						organizationId: 'tls-rpt',
						dkimDomain: submitterDomain,
						firstEnqueuedAt: Date.now(),
					};

					const groupId = buildGroupKey('transactional', extractDomain(recipient));
					await enqueueReconciledIntake(queue, redis, { groupId, data: job });

					stats.sent++;
					tlsReportsSent.inc();
					logger.info({ domain, reportAddress }, 'TLS-RPT enqueued via mailto');
				} catch (err) {
					stats.errors++;
					logger.warn({ err, domain }, 'TLS-RPT mailto delivery error');
				}
			} else {
				// Unknown scheme — neither https: nor mailto:
				stats.skipped++;
			}
		} catch (err) {
			stats.errors++;
			logger.warn({ err, domain }, 'Error generating TLS-RPT');
		}
	}

	if (stats.sent > 0 || stats.errors > 0) {
		logger.info(stats, 'TLS-RPT daily generation complete');
	}

	return stats;
}
