/**
 * GET /health — Full system status
 * GET /metrics — Prometheus format metrics
 */

import type { Context } from 'hono';
import type Redis from 'ioredis';
import { resolve as dnsResolve } from 'dns/promises';
import type { MtaConfig } from '../config.js';
import { isRedisHealthy } from '../redis.js';
import { getPoolStatus } from '../scaling/ipPool.js';
import { getDnsblStatus } from '../intelligence/dnsbl.js';
import { getWarmingState } from '../intelligence/warming.js';
import { registry } from '../monitoring/collector.js';
import { logger } from '../monitoring/logger.js';

const startTime = Date.now();

// Worker heartbeat tracking
const WORKER_HEARTBEAT_KEY = 'mta:worker:heartbeat';
const WORKER_HEARTBEAT_TTL = 120; // 2 minutes — if no heartbeat, worker is considered dead

/**
 * Record a worker heartbeat (called by the queue worker after processing a job)
 */
export async function recordWorkerHeartbeat(redis: Redis, serverId: string): Promise<void> {
	await redis.hset(WORKER_HEARTBEAT_KEY, serverId, String(Date.now()));
	await redis.expire(WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL * 2);
}

/**
 * Create the health endpoint handler
 */
export function createHealthHandler(redis: Redis, config: MtaConfig) {
	return async (c: Context) => {
		const redisOk = await isRedisHealthy();

		// Get IP pool status
		const pools = await getPoolStatus(redis, config.ipPools);

		// Get DNSBL + warming status per IP
		const ipStatus = await Promise.all(
			pools.map(async (pool) => {
				const dnsbl = await getDnsblStatus(redis, pool.ip);
				const warmingState = await getWarmingState(redis, pool.ip);

				return {
					...pool,
					dnsbl: dnsbl?.['overallStatus'] ?? 'unknown',
					warming: warmingState
						? {
								phase: warmingState.phase,
								day: warmingState.currentDay,
								dailyCap: warmingState.dailyCap === Infinity ? 'unlimited' : warmingState.dailyCap,
								sentToday: warmingState.sentToday,
								bounceRate: warmingState.bounceRate,
							}
						: null,
				};
			})
		);

		// Check for emergency state
		const allIpsBlocked = (await redis.get('mta:emergency:all_ips_blocked')) === '1';

		// ── Extended health checks ──

		// Worker liveness check
		const workerStatus = await checkWorkerLiveness(redis, config.serverId);

		// DNS resolver health
		const dnsOk = await checkDnsResolver();

		// SMTP outbound reachability (probe a well-known MX)
		const smtpProbe = await checkSmtpReachability();

		// Determine overall status
		const degraded = !redisOk || allIpsBlocked || !workerStatus.alive || !dnsOk;
		const status = degraded ? 'degraded' : 'ok';

		return c.json({
			status,
			uptime: Math.floor((Date.now() - startTime) / 1000),
			redis: redisOk ? 'connected' : 'disconnected',
			serverId: config.serverId,
			ips: ipStatus,
			emergency: { allIpsBlocked },
			worker: workerStatus,
			dns: dnsOk ? 'ok' : 'unreachable',
			smtpOutbound: smtpProbe,
		});
	};
}

/**
 * Check if the GroupMQ worker is alive based on heartbeat
 */
async function checkWorkerLiveness(redis: Redis, serverId: string): Promise<{
	alive: boolean;
	lastHeartbeat?: number;
	secondsSinceHeartbeat?: number;
}> {
	try {
		const lastBeat = await redis.hget(WORKER_HEARTBEAT_KEY, serverId);
		if (!lastBeat) {
			return { alive: false };
		}

		const lastBeatMs = parseInt(lastBeat, 10);
		const secondsSince = Math.floor((Date.now() - lastBeatMs) / 1000);

		return {
			alive: secondsSince < WORKER_HEARTBEAT_TTL,
			lastHeartbeat: lastBeatMs,
			secondsSinceHeartbeat: secondsSince,
		};
	} catch {
		return { alive: false };
	}
}

/**
 * Check DNS resolver health by resolving a well-known domain
 */
async function checkDnsResolver(): Promise<boolean> {
	try {
		const records = await dnsResolve('dns.google', 'A');
		return records.length > 0;
	} catch {
		try {
			// Fallback to another well-known domain
			const records = await dnsResolve('one.one.one.one', 'A');
			return records.length > 0;
		} catch {
			return false;
		}
	}
}

/**
 * Check SMTP outbound reachability by attempting DNS MX lookup
 * for a well-known domain. Does NOT connect — just verifies DNS works.
 */
async function checkSmtpReachability(): Promise<{
	status: 'ok' | 'degraded' | 'unknown';
	mxResolutionMs?: number;
}> {
	const start = Date.now();
	try {
		const records = await dnsResolve('gmail.com', 'MX');
		const durationMs = Date.now() - start;

		if (records.length > 0) {
			return { status: 'ok', mxResolutionMs: durationMs };
		}
		return { status: 'degraded' };
	} catch (err) {
		logger.debug({ err }, 'SMTP reachability probe failed');
		return { status: 'degraded', mxResolutionMs: Date.now() - start };
	}
}

/**
 * Create the Prometheus metrics endpoint
 */
export function createMetricsHandler() {
	return async (c: Context) => {
		const metrics = await registry.metrics();
		return c.text(metrics, 200, {
			'Content-Type': registry.contentType,
		});
	};
}
