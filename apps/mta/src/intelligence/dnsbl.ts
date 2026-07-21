/**
 * [2] DNS-Based Blocklist (DNSBL) Auto-Checking
 *
 * Periodically checks sending IPs against major blocklists.
 * Auto-removes blocked IPs from the active pool and alerts Convex.
 */

import { resolve4 } from 'dns/promises';
import type Redis from 'ioredis';
import { DNSBL_ZONES } from '../config.js';
import type { MtaConfig } from '../config.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { logger } from '../monitoring/logger.js';
import { getIpPoolBlockReasons, setIpPoolBlock } from '../scaling/ipPool.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LOOKUP_TIMEOUT_MS = 5000;
const DNSBL_PREFIX = 'mta:dnsbl:';
const IP_POOL_ACTIVE = 'mta:ip-pool:active';
const IP_POOL_BLOCKED = 'mta:ip-pool:blocked';

type DnsblSeverity = 'critical' | 'warning';

interface DnsblResult {
	zone: string;
	name: string;
	severity: DnsblSeverity;
	listed: boolean;
}

/**
 * Check a single IP against a single DNSBL zone
 */
async function checkDnsbl(ip: string, zone: string): Promise<boolean> {
	const reversed = ip.split('.').reverse().join('.');
	const lookup = `${reversed}.${zone}`;

	try {
		const result = await Promise.race([
			resolve4(lookup),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('DNSBL lookup timeout')), LOOKUP_TIMEOUT_MS)
			),
		]);
		// If resolves to 127.0.0.x, the IP is listed
		return Array.isArray(result) && result.some((addr) => addr.startsWith('127.'));
	} catch (err: unknown) {
		const error = err as { code?: string; message?: string };
		// NXDOMAIN/ENOTFOUND = not listed (this is the expected "clean" result)
		if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
			return false;
		}
		// Timeout or other error — treat as clean (don't block on DNS failure)
		logger.warn({ ip, zone, error: error.message }, 'DNSBL check failed, treating as clean');
		return false;
	}
}

/**
 * Check an IP against all configured DNSBL zones
 */
async function checkAllZones(ip: string): Promise<DnsblResult[]> {
	const results = await Promise.all(
		DNSBL_ZONES.map(async (zone) => ({
			zone: zone.zone,
			name: zone.name,
			severity: zone.severity,
			listed: await checkDnsbl(ip, zone.zone),
		}))
	);
	return results;
}

/**
 * Run a full DNSBL check for all IPs and update Redis state
 */
export async function runDnsblCheck(redis: Redis, config: MtaConfig): Promise<void> {
	const allIps = [...config.ipPools.transactional, ...config.ipPools.campaign];
	const uniqueIps = [...new Set(allIps)];

	logger.info({ ips: uniqueIps }, 'Running DNSBL check');

	for (const ip of uniqueIps) {
		const results = await checkAllZones(ip);
		const hashKey = `${DNSBL_PREFIX}${ip}`;

		// Update Redis state
		const updates: string[] = [];
		let hasCritical = false;
		let hasWarning = false;
		const listedOn: string[] = [];

		for (const result of results) {
			updates.push(result.name.toLowerCase(), result.listed ? 'listed' : 'clean');
			updates.push(`${result.name.toLowerCase()}At`, String(Date.now()));

			if (result.listed) {
				listedOn.push(result.name);
				if (result.severity === 'critical') hasCritical = true;
				else hasWarning = true;
			}
		}

		const previousStatus = await redis.hget(hashKey, 'overallStatus');
		const newStatus = hasCritical ? 'critical' : hasWarning ? 'degraded' : 'clean';
		updates.push('overallStatus', newStatus);

		await redis.hset(hashKey, ...updates);
		// Reconcile on every observation, not only transitions. The shared pool
		// gate composes this reason atomically with FCrDNS quarantine.
		await setIpPoolBlock(redis, ip, 'dnsbl', newStatus === 'critical');
		if (newStatus === 'critical') await redis.sadd(IP_POOL_BLOCKED, ip);
		else await redis.srem(IP_POOL_BLOCKED, ip);

		// Handle status transitions
		if (newStatus === 'critical' && previousStatus !== 'critical') {
			logger.error({ ip, listedOn }, 'IP BLOCKED — removed from active pool');

			await notifyConvex(
				{
					event: 'ip.blocklisted',
					ip,
					blocklists: listedOn,
					severity: 'critical',
					message: `IP ${ip} listed on ${listedOn.join(', ')}`,
					timestamp: Date.now(),
				},
				config,
				redis
			).catch((err) => logger.error({ err }, 'Failed to alert Convex about IP blocklisting'));
		} else if (newStatus === 'degraded' && previousStatus === 'clean') {
			// WARNING: Deprioritize but keep active
			logger.warn({ ip, listedOn }, 'IP degraded — listed on non-critical blocklist');

			await notifyConvex(
				{
					event: 'ip.blocklisted',
					ip,
					blocklists: listedOn,
					severity: 'warning',
					message: `IP ${ip} listed on ${listedOn.join(', ')} (non-critical)`,
					timestamp: Date.now(),
				},
				config,
				redis
			).catch(() => {});
		} else if (newStatus === 'clean' && previousStatus !== 'clean' && previousStatus) {
			logger.info({ ip }, 'IP delisted — DNSBL block cleared');

			await notifyConvex(
				{
					event: 'ip.delisted',
					ip,
					severity: 'info',
					message: `IP ${ip} delisted from all blocklists`,
					timestamp: Date.now(),
				},
				config,
				redis
			).catch(() => {});
		}
	}

	// Check if ALL IPs are blocked
	const activeCount = await redis.scard(IP_POOL_ACTIVE);
	if (activeCount === 0) {
		logger.error('ALL IPs unavailable — emergency state');
		await redis.set('mta:emergency:all_ips_blocked', '1');
		const reasonSets = await Promise.all(uniqueIps.map((ip) => getIpPoolBlockReasons(redis, ip)));
		if (reasonSets.every((reasons) => reasons.includes('dnsbl'))) {
			await notifyConvex(
				{
					event: 'all_ips_blocked',
					severity: 'critical',
					message: 'All sending IPs are blocklisted. Email sending is paused.',
					timestamp: Date.now(),
				},
				config,
				redis
			).catch(() => {});
		}
	} else {
		await redis.del('mta:emergency:all_ips_blocked');
	}
}

/**
 * Initialize IP pools in Redis and start the DNSBL check interval
 */
export function startDnsblChecker(redis: Redis, config: MtaConfig): NodeJS.Timeout {
	// Run initial check
	runDnsblCheck(redis, config).catch((err) => logger.error({ err }, 'Initial DNSBL check failed'));

	// Schedule periodic checks
	return setInterval(() => {
		runDnsblCheck(redis, config).catch((err) =>
			logger.error({ err }, 'Periodic DNSBL check failed')
		);
	}, CHECK_INTERVAL_MS);
}

/**
 * Get DNSBL status for an IP (for monitoring)
 */
export async function getDnsblStatus(
	redis: Redis,
	ip: string
): Promise<Record<string, string> | null> {
	const hashKey = `${DNSBL_PREFIX}${ip}`;
	const data = await redis.hgetall(hashKey);
	return Object.keys(data).length > 0 ? data : null;
}
