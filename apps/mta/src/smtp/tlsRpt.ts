/**
 * TLS-RPT (TLS Reporting) — RFC 8460
 *
 * Tracks TLS negotiation failures per recipient domain during outbound
 * delivery and generates aggregate reports. These reports help domain
 * owners understand TLS connectivity issues with their mail servers.
 *
 * Flow:
 * 1. `recordTlsResult()` is called after each SMTP connection attempt
 * 2. Failures are stored in Redis, aggregated per domain per day
 * 3. `generateAndSendReports()` runs daily (leader-only cron)
 * 4. Reports are sent as JSON to the domain's _smtp._tls TXT record address
 */

import type Redis from 'ioredis';
import { createHash } from 'crypto';
import { resolve as dnsResolve } from 'dns/promises';
import { gzipSync } from 'zlib';
import { logger } from '../monitoring/logger.js';
import { Counter } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import type { EmailJob } from '../types.js';
import { formatTlsaRecord, type TlsaRecord } from '@owlat/shared/dane';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { enqueueReconciledIntake } from '../queue/intakeEnqueue.js';

const TLS_RPT_PREFIX = 'mta:tls-rpt:';
const TLS_RPT_TTL = 3 * 86400; // Keep 3 days of records

// ─── Prometheus Metrics ─────────────────────────────────────────────

export const tlsFailuresTotal = new Counter({
	name: 'mta_tls_failures_total',
	help: 'TLS negotiation failures by type',
	labelNames: ['type', 'domain'] as const,
	registers: [registry],
});

export const tlsReportsSent = new Counter({
	name: 'mta_tls_reports_sent_total',
	help: 'TLS-RPT reports sent',
	registers: [registry],
});

// ─── Types ──────────────────────────────────────────────────────────

export type TlsResultType =
	| 'success'
	| 'starttls-not-supported'
	| 'certificate-host-mismatch'
	| 'certificate-expired'
	| 'certificate-not-trusted'
	| 'validation-failure'
	| 'sts-policy-invalid'
	| 'sts-webpki-invalid'
	| 'sts-policy-fetch-error';

export type TlsPolicyType = 'sts' | 'no-policy-found' | 'tlsa';

/**
 * The policy context under which a TLS result was observed. RFC 8460 §3 requires
 * each `failure-details`/policy block to carry the *applied* policy: when an
 * MTA-STS policy is in force the report MUST say so (`policy-type: sts`) and
 * echo the policy body (`policy-string`) and the policy's MX host patterns
 * (`mx-host`). Without this every result was being mis-attributed to
 * `no-policy-found`, so STS enforcement was invisible in our own reports.
 */
export interface TlsPolicyContext {
	policyType: TlsPolicyType;
	/** The MTA-STS policy body lines (RFC 8461 §3.2 key:value form). */
	policyString: string[];
	/** The policy's MX host patterns, e.g. ["*.google.com", "mail.google.com"]. */
	mxHostPatterns?: string[];
}

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

// ─── Recording TLS Results ──────────────────────────────────────────

/**
 * Record a TLS negotiation result for a recipient domain.
 * Called after each SMTP connection attempt.
 *
 * `policy` records the policy context the result was observed under (RFC 8460
 * §3): when an MTA-STS policy applied, the day's report block is upgraded to
 * `policy-type: sts` and carries the policy body + MX patterns. The first STS
 * context seen for a domain/day wins (an enforce policy is stable for the day);
 * absent context preserves the prior `no-policy-found` default.
 */
export async function recordTlsResult(
	redis: Redis,
	recipientDomain: string,
	resultType: TlsResultType,
	mxHost: string,
	sendingIp: string,
	policy?: TlsPolicyContext
): Promise<void> {
	const today = new Date().toISOString().split('T')[0]!;
	const key = `${TLS_RPT_PREFIX}${recipientDomain}:${today}`;

	if (resultType === 'success') {
		await redis.hincrby(key, 'successes', 1);
	} else {
		// Store failure details as JSON in a Redis list
		const failureKey = `${key}:failures`;
		const failure = JSON.stringify({
			type: resultType,
			mxHost,
			sendingIp,
			timestamp: Date.now(),
		});

		const pipeline = redis.pipeline();
		pipeline.hincrby(key, 'failures', 1);
		pipeline.hincrby(key, `fail:${resultType}`, 1);
		pipeline.rpush(failureKey, failure);
		pipeline.ltrim(failureKey, -1000, -1); // Keep last 1000 failures
		pipeline.expire(key, TLS_RPT_TTL);
		pipeline.expire(failureKey, TLS_RPT_TTL);
		await pipeline.exec();

		tlsFailuresTotal.inc({ type: resultType, domain: recipientDomain });
	}

	// Persist the applied policy context so generateReport can attribute the
	// day's block to the real policy-type (e.g. 'sts') instead of always
	// defaulting to 'no-policy-found'. Only upgrade away from no-policy-found,
	// and only on the first STS context — the enforce/testing policy is fixed
	// for the day, so re-writing it on every send is wasteful and racy.
	if (policy && policy.policyType !== 'no-policy-found') {
		const existingType = await redis.hget(key, 'policy-type');
		if (existingType !== policy.policyType) {
			await redis.hset(key, 'policy-type', policy.policyType);
			await redis.hset(key, 'policy-string', JSON.stringify(policy.policyString));
			await redis.hset(key, 'mx-host', JSON.stringify(policy.mxHostPatterns ?? []));
		}
	}

	await redis.expire(key, TLS_RPT_TTL);
}

/**
 * Build the MTA-STS `policy-string` for a TLS-RPT report (RFC 8460 §3 +
 * RFC 8461 §3.2). The policy body is the same line-delimited `key: value`
 * form a recipient publishes at `/.well-known/mta-sts.txt`, reconstructed
 * from the cached/applied policy so a report consumer sees exactly the policy
 * we enforced. Order follows RFC 8461 §3.2 (version, mode, mx*, max_age).
 */
export function buildStsPolicyString(
	mode: 'enforce' | 'testing',
	mxHostPatterns: string[]
): string[] {
	return ['version: STSv1', `mode: ${mode}`, ...mxHostPatterns.map((mx) => `mx: ${mx}`)];
}

/**
 * Build the `policy-string` for a DANE (TLSA) TLS-RPT report block (RFC 8460 §3,
 * policy-type `tlsa`). Each line is the TLSA record in presentation form
 * `"<usage> <selector> <matching-type> <hex>"` (RFC 6698 §2.2) — the applied
 * policy a report consumer sees so a DANE validation failure is attributable to
 * the exact RRset we authenticated against.
 */
export function buildTlsaPolicyString(records: readonly TlsaRecord[]): string[] {
	return records.map(formatTlsaRecord);
}

// ─── Report Generation ──────────────────────────────────────────────

/**
 * Look up the TLS-RPT reporting address for a domain.
 * Checks the _smtp._tls TXT record for a rua= address.
 *
 * @returns The reporting address (mailto: or https: URI), or null
 */
export async function getTlsRptAddress(domain: string): Promise<string | null> {
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
		try {
			const f = JSON.parse(raw) as { type: string; mxHost: string; sendingIp: string };
			const mapKey = `${f.type}:${f.mxHost}:${f.sendingIp}`;
			const existing = failureMap.get(mapKey);
			if (existing) {
				existing.count++;
			} else {
				failureMap.set(mapKey, { ...f, count: 1 });
			}
		} catch {
			// Skip malformed entries
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
