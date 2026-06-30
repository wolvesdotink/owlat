/**
 * [9] Delivery Metrics Collector
 *
 * Aggregates per-ISP and per-IP delivery metrics in Redis.
 * Exposes Prometheus-format metrics for Grafana dashboards.
 */

import type Redis from 'ioredis';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { IspName, MetricOutcome } from '../types.js';
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
 * Record a delivery outcome in both Redis (persistent) and Prometheus (in-memory)
 */
export async function record(
	redis: Redis,
	domain: string,
	ip: string,
	pool: string,
	outcome: MetricOutcome,
	durationMs?: number
): Promise<void> {
	const isp = classifyIsp(domain);
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
export async function getIspMetrics(redis: Redis, isp: IspName, date: string): Promise<Record<string, number>> {
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
export async function getIpMetrics(redis: Redis, ip: string, date: string): Promise<Record<string, number>> {
	const key = `${IP_METRICS_PREFIX}${ip}:${date}`;
	const data = await redis.hgetall(key);
	const result: Record<string, number> = {};
	for (const [k, v] of Object.entries(data)) {
		result[k] = parseInt(v, 10);
	}
	return result;
}
