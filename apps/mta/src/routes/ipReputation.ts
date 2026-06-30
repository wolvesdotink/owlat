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
import { getWarmingState } from '../intelligence/warming.js';
import { getPoolStatus } from '../scaling/ipPool.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

export function createIpReputationRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All ip-reputation routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /ip-reputation/:ip — aggregate reputation data for a single IP
	app.get('/:ip', async (c) => {
		const ip = c.req.param('ip');
		const today = new Date().toISOString().split('T')[0]!;

		// Gather data from multiple systems in parallel
		const [todayMetrics, warmingState, poolStatuses] = await Promise.all([
			getIpMetrics(redis, ip, today),
			getWarmingState(redis, ip),
			getPoolStatus(redis, config.ipPools),
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
				? { pool: ipPoolEntry.pool, active: ipPoolEntry.active }
				: null,
		});
	});

	// GET /ip-reputation — list all IPs with summary
	app.get('/', async (c) => {
		const allIps = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
		const today = new Date().toISOString().split('T')[0]!;
		const poolStatuses = await getPoolStatus(redis, config.ipPools);

		const summaries = await Promise.all(
			allIps.map(async (ip) => {
				const [metrics, warmingState] = await Promise.all([
					getIpMetrics(redis, ip, today),
					getWarmingState(redis, ip),
				]);

				const ipPoolEntry = poolStatuses.find((p) => p.ip === ip);
				const totalSent = metrics['sent'] ?? 0;

				return {
					ip,
					sent: totalSent,
					delivered: metrics['delivered'] ?? 0,
					bounced: metrics['bounced'] ?? 0,
					deferred: metrics['deferred'] ?? 0,
					bounceRate: totalSent > 0 ? Math.round(((metrics['bounced'] ?? 0) / totalSent) * 10000) / 100 : 0,
					warmingPhase: warmingState?.phase ?? 'unknown',
					warmingDay: warmingState?.currentDay ?? 0,
					pool: ipPoolEntry?.pool ?? 'unknown',
					active: ipPoolEntry?.active ?? false,
				};
			})
		);

		return c.json({ date: today, ips: summaries });
	});

	return app;
}
