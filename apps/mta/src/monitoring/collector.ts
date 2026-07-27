/**
 * [9] Delivery Metrics Collector
 *
 * Aggregates per-ISP and per-IP delivery metrics in Redis.
 * Exposes Prometheus-format metrics for Grafana dashboards.
 */

import type Redis from 'ioredis';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { DestinationProviderKey, MetricOutcome } from '../types.js';
import { classifyIsp } from '../queue/groups.js';

// Redis metric keys
const ISP_METRICS_PREFIX = 'mta:metrics:isp:';
const IP_METRICS_PREFIX = 'mta:metrics:ip:';
const METRICS_TTL = 30 * 86400; // 30 days

// Prometheus registry
export const registry = new Registry();

// Prometheus counters
export const emailsSentTotal = new Counter({
	name: 'mta_emails_sent_total',
	help: 'Total emails processed',
	labelNames: ['pool', 'isp', 'outcome'] as const,
	registers: [registry],
});

export const bouncesTotal = new Counter({
	name: 'mta_bounces_total',
	help: 'Total bounces by type',
	labelNames: ['type', 'isp'] as const,
	registers: [registry],
});

export const smtpDuration = new Histogram({
	name: 'mta_smtp_duration_seconds',
	help: 'SMTP transaction duration',
	labelNames: ['pool', 'isp'] as const,
	buckets: [0.5, 1, 2, 5, 10, 30, 60],
	registers: [registry],
});

export const queueDepth = new Gauge({
	name: 'mta_queue_depth',
	help: 'Current queue depth',
	labelNames: ['state'] as const,
	registers: [registry],
});

export const activeConnections = new Gauge({
	name: 'mta_active_connections',
	help: 'Currently active SMTP connections',
	registers: [registry],
});

export const warmingPhase = new Gauge({
	name: 'mta_warming_phase',
	help: 'IP warming phase (0=ramp, 1=plateau, 2=graduated)',
	labelNames: ['ip'] as const,
	registers: [registry],
});

export const deduplicationsTotal = new Counter({
	name: 'mta_deduplications_total',
	help: 'Total number of deduplicated (skipped) messages',
	registers: [registry],
});

export const mtaStsEnforced = new Counter({
	name: 'mta_sts_enforced_total',
	help: 'Total sends where MTA-STS enforce mode was active',
	labelNames: ['domain'] as const,
	registers: [registry],
});

export const mtaStsMxSkipped = new Counter({
	name: 'mta_sts_mx_skipped_total',
	help: 'MX hosts skipped due to MTA-STS policy violation',
	registers: [registry],
});

export const unattributedBouncesTotal = new Counter({
	name: 'mta_unattributed_bounces_total',
	help: 'Bounces where message ID could not be extracted from DSN',
	registers: [registry],
});

export const fblComplaintsTotal = new Counter({
	name: 'mta_fbl_complaints_total',
	help: 'Total FBL/ARF complaints received',
	labelNames: ['isp', 'attributed'] as const,
	registers: [registry],
});

/**
 * Per-campaign FBL complaints. The org-level circuit breaker only computes a
 * per-ORG complaint rate, so a campaign whose ARF carried a `Feedback-ID`
 * campaignId (but whose org was not extractable) was previously invisible. This
 * counter gives per-campaign granularity alongside the per-isp view.
 */
export const fblComplaintsByCampaignTotal = new Counter({
	name: 'mta_fbl_complaints_by_campaign_total',
	help: 'FBL/ARF complaints attributed to a campaign',
	labelNames: ['campaign', 'isp'] as const,
	registers: [registry],
});

/**
 * RFC 9477 CFBL reports that produced a TRUSTED attribution, by the signed
 * source that carried it (`rcpt_to` — the report was delivered to the signed
 * address itself; `feedback_id` — the report echoed our signed
 * `CFBL-Feedback-ID`). Distinct from `fblComplaintsTotal`, which counts every
 * ARF regardless of how (or whether) it attributed.
 */
export const cfblAttributionsTotal = new Counter({
	name: 'mta_cfbl_attributions_total',
	help: 'RFC 9477 CFBL complaint reports attributed via a verified signed address',
	labelNames: ['source'] as const,
	registers: [registry],
});

/**
 * Outbound RFC 9477 emission outcomes, by bounded reason.
 *
 * The §3.1.3 alignment rule makes SILENCE the default branch: a sending domain
 * that has not registered its own return-path host carries no CFBL pair at all.
 * That is a correct, D2-clean outcome — no error, no warning, no setup nag — but
 * an invisible one, so it is counted here. `host_unaligned` dominating this
 * counter is how an operator learns that CFBL is off for their domains and what
 * would turn it on.
 *
 * `outcome` is bounded to the `CfblEmissionOutcome` union: `emitted`,
 * `host_unaligned`, `no_signature`, `no_key`, `no_address`, `sealed_raw`.
 * `emitted` means the pair is genuinely on the wire — sealed-mail sends ship raw
 * MIME verbatim and are counted as `sealed_raw`, never as `emitted`, and a
 * message with no DKIM signature over its From domain is counted
 * `no_signature` because RFC 9477 §3.1.4 forbids a provider from acting on the
 * pair without one. `no_signature` covers BOTH ways a send ends up unsigned:
 * no key was configured, and a configured key threw during signing (the sender
 * ships the unsigned bytes rather than a corrupt signature, and the pair the
 * composer already embedded rides along inert). The label is therefore derived
 * from the bytes that were actually built, not from the configuration.
 */
export const cfblEmissionsTotal = new Counter({
	name: 'mta_cfbl_emissions_total',
	help: 'Outbound RFC 9477 CFBL header emissions, by outcome',
	labelNames: ['outcome'] as const,
	registers: [registry],
});

/**
 * CFBL signed-address verification REJECTIONS, by bounded reason
 * (`bad_signature`, `unsigned`, `expired`, `malformed_payload`, `oversized`,
 * `unverifiable`). The header invites unauthenticated parties to mail us, so a
 * forged-complaint campaign must be VISIBLE as a metric — rejections are
 * counted here and dropped, never thrown and never attributed.
 */
export const cfblRejectionsTotal = new Counter({
	name: 'mta_cfbl_rejections_total',
	help: 'CFBL signed-address verifications rejected, by reason',
	labelNames: ['reason'] as const,
	registers: [registry],
});

/**
 * Record a delivery outcome in both Redis (persistent) and Prometheus (in-memory)
 */
export async function record(
	redis: Redis,
	domain: string,
	ip: string,
	pool: string,
	outcome: MetricOutcome,
	durationMs?: number,
	providerKey?: string
): Promise<void> {
	const isp = providerKey ?? classifyIsp(domain);
	const today = new Date().toISOString().split('T')[0]!;

	// Update Prometheus
	emailsSentTotal.inc({ pool, isp, outcome });
	if (durationMs !== undefined) {
		smtpDuration.observe({ pool, isp }, durationMs / 1000);
	}
	if (outcome === 'bounced') {
		bouncesTotal.inc({ type: 'hard', isp });
	}

	// Update Redis (persistent, for dashboard)
	const ispKey = `${ISP_METRICS_PREFIX}${isp}:${today}`;
	const ipKey = `${IP_METRICS_PREFIX}${ip}:${today}`;

	const pipeline = redis.pipeline();
	pipeline.hincrby(ispKey, 'sent', 1);
	pipeline.hincrby(ispKey, outcome, 1);
	pipeline.expire(ispKey, METRICS_TTL);
	pipeline.hincrby(ipKey, 'sent', 1);
	pipeline.hincrby(ipKey, outcome, 1);
	pipeline.expire(ipKey, METRICS_TTL);
	await pipeline.exec();
}

/**
 * Get ISP-level metrics for a given date
 */
export async function getIspMetrics(
	redis: Redis,
	isp: DestinationProviderKey,
	date: string
): Promise<Record<string, number>> {
	const key = `${ISP_METRICS_PREFIX}${isp}:${date}`;
	const data = await redis.hgetall(key);
	const result: Record<string, number> = {};
	for (const [k, v] of Object.entries(data)) {
		result[k] = parseInt(v, 10);
	}
	return result;
}

/**
 * Get IP-level metrics for a given date
 */
export async function getIpMetrics(
	redis: Redis,
	ip: string,
	date: string
): Promise<Record<string, number>> {
	const key = `${IP_METRICS_PREFIX}${ip}:${date}`;
	const data = await redis.hgetall(key);
	const result: Record<string, number> = {};
	for (const [k, v] of Object.entries(data)) {
		result[k] = parseInt(v, 10);
	}
	return result;
}
