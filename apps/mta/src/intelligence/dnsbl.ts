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
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	getIpPoolBlockReasons,
	nextIpPoolObservationGeneration,
} from '../scaling/ipPool.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LOOKUP_TIMEOUT_MS = 5000;
const DNSBL_PREFIX = 'mta:dnsbl:';
const IP_POOL_BLOCKED = 'mta:ip-pool:blocked';

type DnsblSeverity = 'critical' | 'warning';

interface DnsblResult {
	zone: string;
	name: string;
	severity: DnsblSeverity;
	status: 'listed' | 'clean' | 'unknown';
}

/**
 * Check a single IP against a single DNSBL zone
 */
async function checkDnsbl(ip: string, zone: string): Promise<DnsblResult['status']> {
	const reversed = ip.split('.').reverse().join('.');
	const lookup = `${reversed}.${zone}`;

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			resolve4(lookup),
			new Promise<never>(
				(_, reject) =>
					(timeout = setTimeout(() => reject(new Error('DNSBL lookup timeout')), LOOKUP_TIMEOUT_MS))
			),
		]);
		// If resolves to 127.0.0.x, the IP is listed
		return Array.isArray(result) && result.some((addr) => addr.startsWith('127.'))
			? 'listed'
			: 'clean';
	} catch (err: unknown) {
		const error = err as { code?: string; message?: string };
		// NXDOMAIN/ENOTFOUND = not listed (this is the expected "clean" result)
		if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
			return 'clean';
		}
		// Resolver availability is not evidence of delisting. Preserve the last
		// confirmed decision (and fail closed for a never-observed address).
		logger.warn({ ip, zone, error: error.message }, 'DNSBL check failed; status is unknown');
		return 'unknown';
	} finally {
		if (timeout) clearTimeout(timeout);
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
			status: await checkDnsbl(ip, zone.zone),
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

	const observations = await Promise.all(
		uniqueIps.map(async (ip) => {
			const generation = await nextIpPoolObservationGeneration(redis, ip, 'dnsbl');
			return { ip, generation, results: await checkAllZones(ip) };
		})
	);

	for (const { ip, generation, results } of observations) {
		const hashKey = `${DNSBL_PREFIX}${ip}`;

		// Update Redis state
		const updates: string[] = [];
		let hasCritical = false;
		let hasWarning = false;
		const listedOn: string[] = [];

		for (const result of results) {
			updates.push(result.name.toLowerCase(), result.status);
			updates.push(`${result.name.toLowerCase()}At`, String(Date.now()));

			if (result.status === 'listed') {
				listedOn.push(result.name);
				if (result.severity === 'critical') hasCritical = true;
				else hasWarning = true;
			}
		}

		const hasUnknown = results.some((result) => result.status === 'unknown');
		const previousStatus = await redis.hget(hashKey, 'overallStatus');
		const newStatus = hasCritical
			? 'critical'
			: hasUnknown
				? 'unknown'
				: hasWarning
					? 'degraded'
					: 'clean';
		updates.push('overallStatus', newStatus);
		const stateFields: Record<string, string> = {};
		for (let index = 0; index < updates.length; index += 2) {
			stateFields[updates[index]!] = updates[index + 1]!;
		}
		const transition = await applyIpPoolObservation(redis, {
			ip,
			reason: 'dnsbl',
			generation,
			decision: newStatus === 'critical' ? 'block' : newStatus === 'unknown' ? 'preserve' : 'clear',
			stateKey: hashKey,
			stateFields,
		});
		if (!transition.applied) continue;
		if (transition.becameBlocked) pool.invalidateBindIp(ip);
		if (transition.wouldBlockWithoutOverride) await redis.sadd(IP_POOL_BLOCKED, ip);
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
		} else if (
			newStatus === 'clean' &&
			previousStatus !== 'clean' &&
			previousStatus !== 'unknown' &&
			previousStatus
		) {
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

	// The pool transition owns the configured-only emergency aggregate; this
	// module only decides whether the specialized all-blocklisted alert applies.
	if ((await redis.get('mta:emergency:all_ips_blocked')) === '1') {
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
	}
}

/**
 * Initialize IP pools in Redis and start the DNSBL check interval
 */
export async function startDnsblChecker(
	redis: Redis,
	config: MtaConfig,
	isLeader: () => boolean
): Promise<NodeJS.Timeout> {
	const runIfLeader = async () => {
		if (!isLeader()) return;
		await runDnsblCheck(redis, config).catch((err) => logger.error({ err }, 'DNSBL check failed'));
	};
	// Every process completes a boot sweep before enabling delivery workers. This
	// cannot rely on the current leader: during a rolling deployment that process
	// may still have the old IP configuration. Generation CAS makes overlap safe.
	await runDnsblCheck(redis, config);

	// Schedule periodic checks
	return setInterval(() => {
		void runIfLeader();
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
