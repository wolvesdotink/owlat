/**
 * Per-IP Reputation Dashboard Routes
 *
 * Aggregates per-IP metrics from warming, DNSBL, and delivery logs
 * into a single reputation view for monitoring and debugging.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { getIpMetrics } from '../monitoring/collector.js';
import { getIspMetrics } from '../monitoring/collector.js';
import { getWarmingState } from '../intelligence/warming.js';
import { getState as getCircuitBreakerState } from '../intelligence/circuitBreaker.js';
import { getPoolStatus } from '../scaling/ipPool.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { getFcrdnsReadiness } from '../scaling/fcrdns.js';
import { configuredDnsblZones, getDnsblStatus } from '../intelligence/dnsbl.js';
import {
	DESTINATION_PROVIDER_KEYS,
	type DeliverabilitySignal,
} from '@owlat/shared/deliverabilityRouting';

const PERSISTENT_DEFER_MIN = 5;
const PERSISTENT_DEFER_RATIO = 0.5;

async function routingSignals(
	redis: Redis,
	organizationId: string | undefined,
	poolStatuses: Awaited<ReturnType<typeof getPoolStatus>>,
	now: number
): Promise<DeliverabilitySignal[]> {
	const signals: DeliverabilitySignal[] = [];
	if (poolStatuses.length > 0 && poolStatuses.every((pool) => !pool.active)) {
		const reasons = new Set(poolStatuses.flatMap((pool) => pool.blockReasons ?? []));
		if (reasons.has('fcrdns')) {
			signals.push({
				provider: 'all',
				source: 'ip_quarantined',
				severity: 'critical',
				observedAt: now,
			});
		}
		if (reasons.has('dnsbl')) {
			signals.push({
				provider: 'all',
				source: 'dnsbl_listed',
				severity: 'critical',
				observedAt: now,
			});
		}
	}

	const today = new Date(now).toISOString().split('T')[0]!;
	await Promise.all(
		DESTINATION_PROVIDER_KEYS.map(async (provider) => {
			const [metrics, breaker] = await Promise.all([
				getIspMetrics(redis, provider, today),
				organizationId
					? getCircuitBreakerState(redis, organizationId, provider)
					: Promise.resolve(null),
			]);
			if (breaker?.status === 'open') {
				signals.push({
					provider,
					source: 'breaker_open',
					severity: 'critical',
					observedAt: now,
				});
			}
			const sent = metrics['sent'] ?? 0;
			const deferred = metrics['deferred'] ?? 0;
			if (
				deferred >= PERSISTENT_DEFER_MIN &&
				sent > 0 &&
				deferred / sent >= PERSISTENT_DEFER_RATIO
			) {
				signals.push({
					provider,
					source: 'persistent_defers',
					severity: 'warning',
					observedAt: now,
				});
			}
		})
	);
	return signals;
}

function listedDnsblIds(config: MtaConfig, dnsbl: Record<string, string> | null) {
	if (!dnsbl) return [];
	return configuredDnsblZones(config)
		.filter((list) => dnsbl[list.id] === 'listed')
		.map((list) => list.id);
}

export function createIpReputationRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All ip-reputation routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /ip-reputation/:ip — aggregate reputation data for a single IP
	app.get('/:ip', async (c) => {
		const ip = c.req.param('ip');
		const today = new Date().toISOString().split('T')[0]!;

		// Gather data from multiple systems in parallel
		const [todayMetrics, warmingState, poolStatuses, fcrdns, dnsbl] = await Promise.all([
			getIpMetrics(redis, ip, today),
			getWarmingState(redis, ip),
			getPoolStatus(redis, config.ipPools),
			getFcrdnsReadiness(redis, ip),
			getDnsblStatus(redis, ip),
		]);

		const ipPoolEntry = poolStatuses.find((p) => p.ip === ip);

		// Calculate rates
		const totalSent = todayMetrics['sent'] ?? 0;
		const bounceRate = totalSent > 0 ? (todayMetrics['bounced'] ?? 0) / totalSent : 0;
		const deferralRate = totalSent > 0 ? (todayMetrics['deferred'] ?? 0) / totalSent : 0;
		const errorRate = totalSent > 0 ? (todayMetrics['error'] ?? 0) / totalSent : 0;

		return c.json({
			ip,
			date: today,
			metrics: {
				sent: totalSent,
				delivered: todayMetrics['delivered'] ?? 0,
				bounced: todayMetrics['bounced'] ?? 0,
				deferred: todayMetrics['deferred'] ?? 0,
				rejected: todayMetrics['rejected'] ?? 0,
				errors: todayMetrics['error'] ?? 0,
			},
			rates: {
				bounceRate: Math.round(bounceRate * 10000) / 100,
				deferralRate: Math.round(deferralRate * 10000) / 100,
				errorRate: Math.round(errorRate * 10000) / 100,
			},
			warming: warmingState
				? {
						phase: warmingState.phase,
						currentDay: warmingState.currentDay,
						dailyCap: warmingState.dailyCap,
						sentToday: warmingState.sentToday,
						bounceRate: warmingState.bounceRate,
						deferralRate: warmingState.deferralRate,
					}
				: null,
			pool: ipPoolEntry
				? {
						pool: ipPoolEntry.pool,
						active: ipPoolEntry.active,
						blockReasons: ipPoolEntry.blockReasons,
					}
				: null,
			fcrdns,
			dnsbl: dnsbl?.['overallStatus'] ?? 'unknown',
			dnsblListings: listedDnsblIds(config, dnsbl),
		});
	});

	// GET /ip-reputation — list all IPs with summary
	app.get('/', async (c) => {
		const allIps = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
		const now = Date.now();
		const today = new Date(now).toISOString().split('T')[0]!;
		const poolStatuses = await getPoolStatus(redis, config.ipPools);

		const summaries = await Promise.all(
			allIps.map(async (ip) => {
				const [metrics, warmingState, fcrdns, dnsbl] = await Promise.all([
					getIpMetrics(redis, ip, today),
					getWarmingState(redis, ip),
					getFcrdnsReadiness(redis, ip),
					getDnsblStatus(redis, ip),
				]);

				const ipPoolEntry = poolStatuses.find((p) => p.ip === ip);
				const totalSent = metrics['sent'] ?? 0;

				return {
					ip,
					sent: totalSent,
					delivered: metrics['delivered'] ?? 0,
					bounced: metrics['bounced'] ?? 0,
					deferred: metrics['deferred'] ?? 0,
					bounceRate:
						totalSent > 0 ? Math.round(((metrics['bounced'] ?? 0) / totalSent) * 10000) / 100 : 0,
					warmingPhase: warmingState?.phase ?? 'unknown',
					warmingDay: warmingState?.currentDay ?? 0,
					pool: ipPoolEntry?.pool ?? 'unknown',
					active: ipPoolEntry?.active ?? false,
					blockReasons: ipPoolEntry?.blockReasons ?? [],
					fcrdns,
					dnsbl: dnsbl?.['overallStatus'] ?? 'unknown',
					dnsblListings: listedDnsblIds(config, dnsbl),
				};
			})
		);

		const organizationId = c.req.query('organizationId');
		const signals = await routingSignals(
			redis,
			organizationId && organizationId.length <= 128 ? organizationId : undefined,
			poolStatuses,
			now
		);
		return c.json({ date: today, ips: summaries, routing: { generatedAt: now, signals } });
	});

	return app;
}
