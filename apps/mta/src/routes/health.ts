/**
 * GET /health — Full system status
 * GET /metrics — Prometheus format metrics
 */

import type { Context } from 'hono';
import type Redis from 'ioredis';
import { resolve as dnsResolve } from 'dns/promises';
import { X509Certificate } from 'node:crypto';
import type { MtaConfig } from '../config.js';
import { isRedisHealthy } from '../redis.js';
import { getPoolStatus } from '../scaling/ipPool.js';
import { getDnsblStatus } from '../intelligence/dnsbl.js';
import { getWarmingState } from '../intelligence/warming.js';
import { registry } from '../monitoring/collector.js';
import { getSmtpReachability } from './smtpReachability.js';
import { getFcrdnsReadiness } from '../scaling/fcrdns.js';
import { getIpv6SpfReadiness } from '../scaling/ipv6SpfReadiness.js';
import { getSourceAddressReadiness } from '../scaling/sourceAddressReadiness.js';

const startTime = Date.now();
const CERTIFICATE_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1_000;

export type SmtpTlsReadiness = {
	status: 'pass' | 'warn' | 'fail';
	hostname: string;
	isHostnameMatched: boolean;
	validFrom?: number;
	validTo?: number;
	reason?: string;
	checkedAt: number;
};

export function classifySmtpTlsCertificate(
	input: {
		hostname: string;
		isHostnameMatched: boolean;
		validFrom: number;
		validTo: number;
	},
	now: number
): SmtpTlsReadiness {
	if (!input.isHostnameMatched) {
		return { ...input, status: 'fail', reason: 'hostname-mismatch', checkedAt: now };
	}
	if (input.validFrom > now) {
		return { ...input, status: 'fail', reason: 'not-yet-valid', checkedAt: now };
	}
	if (input.validTo <= now) {
		return { ...input, status: 'fail', reason: 'expired', checkedAt: now };
	}
	if (input.validTo - now < CERTIFICATE_EXPIRY_WARNING_MS) {
		return { ...input, status: 'warn', reason: 'expires-within-14-days', checkedAt: now };
	}
	return { ...input, status: 'pass', checkedAt: now };
}

/** Parse the configured STARTTLS certificate without exposing its PEM or subject. */
export function inspectSmtpTlsCertificate(
	certificatePem: string | undefined,
	hostname: string,
	now = Date.now()
): SmtpTlsReadiness {
	if (!certificatePem) {
		return {
			status: 'fail',
			hostname,
			isHostnameMatched: false,
			reason: 'certificate-not-configured',
			checkedAt: now,
		};
	}
	try {
		const certificate = new X509Certificate(certificatePem);
		const validFrom = Date.parse(certificate.validFrom);
		const validTo = Date.parse(certificate.validTo);
		if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
			throw new Error('Certificate dates are invalid');
		}
		return classifySmtpTlsCertificate(
			{
				hostname,
				isHostnameMatched: certificate.checkHost(hostname) !== undefined,
				validFrom,
				validTo,
			},
			now
		);
	} catch {
		return {
			status: 'fail',
			hostname,
			isHostnameMatched: false,
			reason: 'certificate-invalid',
			checkedAt: now,
		};
	}
}

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
				const fcrdns = await getFcrdnsReadiness(redis, pool.ip);
				const ipv6Spf = await getIpv6SpfReadiness(redis, pool.ip);
				const sourceAddress = await getSourceAddressReadiness(redis, pool.ip);

				return {
					...pool,
					dnsbl: dnsbl?.['overallStatus'] ?? 'unknown',
					fcrdns,
					ipv6Spf,
					sourceAddress,
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

		// Real TCP/25 reachability from every configured source IP. Cached by the
		// probe module so normal health polling does not hammer the remote MX.
		const sendingIps = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
		const smtpProbe = await getSmtpReachability(sendingIps);
		const smtpTls = inspectSmtpTlsCertificate(config.bounceServerTlsCert, config.ehloHostname);

		// Determine overall status
		const identityNotReady = ipStatus.some(
			(ip) =>
				!ip.fcrdns ||
				(ip.fcrdns.verdict !== 'pass' && ip.fcrdns.verdict !== 'warn' && !ip.fcrdns.overridden)
		);
		const degraded =
			!redisOk ||
			allIpsBlocked ||
			identityNotReady ||
			!workerStatus.alive ||
			!dnsOk ||
			smtpProbe.status !== 'ok';
		const tlsDegraded = smtpTls.status === 'fail';
		const status = degraded || tlsDegraded ? 'degraded' : 'ok';

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
			smtpTls,
		});
	};
}

/**
 * Check if the GroupMQ worker is alive based on heartbeat
 */
async function checkWorkerLiveness(
	redis: Redis,
	serverId: string
): Promise<{
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
