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
 *
 * This module records results (steps 1-2) and owns the stored shape; report
 * generation and delivery (steps 3-4) live in tlsRptReport.ts.
 */

import type Redis from 'ioredis';
import { Counter } from 'prom-client';
import { registry } from '../monitoring/collector.js';
import { formatTlsaRecord, type TlsaRecord } from '@owlat/shared/dane';

/** Redis key prefix of the per-domain-per-day result hashes (read by tlsRptReport.ts). */
export const TLS_RPT_PREFIX = 'mta:tls-rpt:';
const TLS_RPT_TTL = 3 * 86400; // Keep 3 days of records

// ─── Prometheus Metrics ─────────────────────────────────────────────

const tlsFailuresTotal = new Counter({
	name: 'mta_tls_failures_total',
	help: 'TLS negotiation failures by type',
	labelNames: ['type', 'domain'] as const,
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
