/**
 * [2] DNS-Based Blocklist (DNSBL) Auto-Checking
 *
 * Periodically checks sending IPs against major blocklists.
 * Auto-removes blocked IPs from the active pool and alerts Convex.
 */

import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import {
	DNSBL_LIST_IDS,
	DNSBL_LISTS,
	dnsblZoneHost,
	type DnsblListDefinition,
} from '@owlat/shared/dnsbl';
import { ipAddressFamily, type IpAddressFamily } from '@owlat/shared/ipAddress';
import {
	checkDnsbl,
	defaultLookupDeps,
	type DnsblLookupDeps,
	type DnsblStatus,
} from './dnsblLookup.js';
import { ALERT_MESSAGE_MAX_LENGTH, boundedListingDetail, type DnsblListing } from './dnsblAlert.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { logger } from '../monitoring/logger.js';
import { pool } from '../smtp/connectionPool.js';
import {
	applyIpPoolObservation,
	getIpPoolBlockReasons,
	nextIpPoolObservationGeneration,
} from '../scaling/ipPool.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DNSBL_PREFIX = 'mta:dnsbl:';
const IP_POOL_BLOCKED = 'mta:ip-pool:blocked';
/** Set while the fully-listed halt alert has already been sent for the day. */
const ALL_IPS_BLOCKED_ALERT_KEY = 'mta:dnsbl:all-ips-blocked-alerted';
const DAY_SECONDS = 24 * 60 * 60;
/**
 * Addresses whose zone lookups may be in flight at once.
 *
 * The bound has to hold in both directions. Unbounded, the sweep fires every
 * address x every zone at the same handful of public resolvers and earns the
 * rate-limit answers this module reads as `unknown`. Strictly sequential, each
 * address costs up to `LOOKUP_TOTAL_BUDGET_MS` and the total is linear in pool
 * size — which the boot sweep pays before delivery workers are enabled, and
 * which the periodic sweep cannot afford at all because `startDnsblChecker`'s
 * interval has no in-flight guard, so an overrunning sweep would overlap the
 * next tick and double the very query load this bound exists to cut.
 */
export const SWEEP_ADDRESS_CONCURRENCY = 4;

interface DnsblResult extends Pick<DnsblListDefinition, 'id' | 'name' | 'severity'> {
	status: DnsblStatus;
}

interface DnsblZone extends DnsblListDefinition {
	zone: string;
}

/** Only Spamhaus is allowed to eject; every added feed stays advisory. */
export function configuredDnsblZones(
	config: Pick<MtaConfig, 'abusixDnsblApiKey'>,
	addressFamily?: IpAddressFamily
): DnsblZone[] {
	// Zone hostnames live on DNSBL_LISTS so the routing sweep and the pre-flight
	// IP audit can never drift apart. A keyed feed without its credential is
	// simply absent here, exactly as before.
	const zones: DnsblZone[] = [];
	for (const id of DNSBL_LIST_IDS) {
		const list = DNSBL_LISTS[id];
		const zone = dnsblZoneHost(list, config.abusixDnsblApiKey);
		if (zone) zones.push({ ...list, zone });
	}
	return addressFamily
		? zones.filter((zone) => zone.addressFamilies.includes(addressFamily))
		: zones;
}

/**
 * Check an IP against all configured DNSBL zones
 */
async function checkAllZones(
	ip: string,
	config: MtaConfig,
	deps: DnsblLookupDeps
): Promise<DnsblResult[]> {
	const family = ipAddressFamily(ip);
	if (!family) throw new Error(`Configured DNSBL address is invalid: ${ip}`);
	const results = await Promise.all(
		configuredDnsblZones(config, family).map(async (zone) => ({
			id: zone.id,
			name: zone.name,
			severity: zone.severity,
			status: await checkDnsbl(ip, zone.id, zone.zone, deps),
		}))
	);
	return results;
}

/**
 * Run a full DNSBL check for all IPs and update Redis state
 */
export async function runDnsblCheck(
	redis: Redis,
	config: MtaConfig,
	deps: DnsblLookupDeps = defaultLookupDeps
): Promise<void> {
	const allIps = [...config.ipPools.transactional, ...config.ipPools.campaign];
	const uniqueIps = [...new Set(allIps)];

	logger.info({ ips: uniqueIps }, 'Running DNSBL check');

	// A FIXED NUMBER OF ADDRESSES AT A TIME, zones in parallel within an address.
	// Every address x every zone at once is a burst of hundreds of queries at the
	// same handful of public resolvers every 15 minutes, which is precisely what
	// earns the 127.255.255.x rate-limit answers this module must then read as
	// `unknown` — and an `unknown` preserves quarantine and holds the ramp
	// controller.
	const observations: Array<{ ip: string; generation: number; results: DnsblResult[] }> = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(SWEEP_ADDRESS_CONCURRENCY, uniqueIps.length) }, async () => {
			while (cursor < uniqueIps.length) {
				const index = cursor;
				cursor += 1;
				const ip = uniqueIps[index]!;
				const generation = await nextIpPoolObservationGeneration(redis, ip, 'dnsbl');
				observations[index] = { ip, generation, results: await checkAllZones(ip, config, deps) };
			}
		})
	);

	// Zone names per address, kept for the halt-and-alert payload so the operator
	// is told exactly which addresses are listed and on which blocklists.
	const listedZonesByIp = new Map<string, string[]>();

	for (const { ip, generation, results } of observations) {
		const hashKey = `${DNSBL_PREFIX}${ip}`;

		// Update Redis state
		const updates: string[] = [];
		let hasWarning = false;
		const listedOn: string[] = [];

		for (const result of results) {
			updates.push(result.id, result.status);
			updates.push(`${result.id}At`, String(Date.now()));

			if (result.status === 'listed') {
				listedOn.push(result.name);
				if (result.severity === 'warning') hasWarning = true;
			}
		}

		listedZonesByIp.set(ip, listedOn);
		const spamhaus = results.find((result) => result.id === 'spamhaus');
		if (!spamhaus) throw new Error('Spamhaus DNSBL observation is missing');
		const unknownOn = results
			.filter((result) => result.status === 'unknown')
			.map((result) => result.name);
		const hasUnknown = unknownOn.length > 0;
		// Unmeasured zones are recorded explicitly so no reader has to infer
		// "unknown" from the absence of a listing.
		updates.push('unknownOn', unknownOn.join(','));
		updates.push('listedOn', listedOn.join(','));
		// Both prior fields live in one hash: one round trip, and both are read at
		// the same instant, so the two transition gates below cannot disagree
		// about which sweep they are comparing against.
		const [previousSpamhausStatus = null, previousStatus = null] = await redis.hmget(
			hashKey,
			'spamhaus',
			'overallStatus'
		);
		const newStatus =
			spamhaus.status === 'listed'
				? 'critical'
				: hasWarning
					? 'degraded'
					: hasUnknown
						? 'unknown'
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
			decision:
				spamhaus.status === 'listed'
					? 'block'
					: spamhaus.status === 'unknown'
						? 'preserve'
						: 'clear',
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
			).catch(() =>
				logger.error(
					{
						operation: 'dnsbl_alert',
						category: 'delivery',
						eventType: 'ip.blocklisted',
					},
					'Failed to alert Convex about IP blocklisting'
				)
			);
		}
		if (newStatus === 'degraded' && previousStatus !== 'degraded') {
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
		}
		const spamhausCleared = previousSpamhausStatus === 'listed' && spamhaus.status === 'clean';
		const allListsCleared =
			newStatus === 'clean' &&
			previousStatus !== 'clean' &&
			previousStatus !== 'unknown' &&
			previousStatus !== null;
		if (spamhausCleared || allListsCleared) {
			logger.info({ ip }, 'IP delisted — Spamhaus quarantine cleared');

			await notifyConvex(
				{
					event: 'ip.delisted',
					ip,
					severity: 'info',
					message: `IP ${ip} is not listed on Spamhaus`,
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
		const reasonSets = await Promise.all(uniqueIps.map((ip) => getIpPoolBlockReasons(redis, ip)));
		if (reasonSets.every((reasons) => reasons.includes('dnsbl'))) {
			// Every configured address is blocklisted. The pool is already empty, so
			// `selectIpWithLease` has no eligible address and delivery stays queued —
			// there is deliberately no "send anyway" path out of a fully listed pool.
			// The operator alert names the addresses and the zones that listed them.
			const listings: DnsblListing[] = uniqueIps.map((ip) => ({
				ip,
				zones: listedZonesByIp.get(ip) ?? [],
			}));
			const blocklists = [...new Set(listings.flatMap((listing) => listing.zones))];
			// Say which it is: a confirmed listing on every address is a different
			// operator task from "we could not measure and therefore held".
			const prefix = listings.every((listing) => listing.zones.length > 0)
				? 'All sending IPs are blocklisted. Email sending is paused. Listed: '
				: 'All sending IPs are unavailable. Email sending is paused. Blocklist status: ';
			// The critical alert MUST survive Convex ingress, which rejects the whole
			// event when `message` exceeds the shared ingress bound — a truncated alert
			// in front of the operator beats a complete one in the dead-letter queue. Zone names
			// also travel structurally in `blocklists`, so nothing is actually lost.
			const message =
				prefix + boundedListingDetail(listings, ALERT_MESSAGE_MAX_LENGTH - prefix.length);
			// The halt itself is logged every sweep — that is the operator's local
			// heartbeat that mail is still parked.
			logger.error(
				{ ips: uniqueIps, blocklists },
				'ALL IPs blocklisted or unmeasurable — sending halted, nothing leaves the pool'
			);
			// The CONVEX alert is not: a halt persists for as long as delisting takes,
			// and one critical alert every 15 minutes buries the first one. Gate it
			// the way the per-IP transitions above gate on previous state — the flag
			// is the state here, so the key is cleared when the halt lifts and a
			// still-standing halt re-announces itself once a day.
			if ((await redis.set(ALL_IPS_BLOCKED_ALERT_KEY, '1', 'EX', DAY_SECONDS, 'NX')) === 'OK') {
				await notifyConvex(
					{
						event: 'all_ips_blocked',
						severity: 'critical',
						blocklists,
						message,
						timestamp: Date.now(),
					},
					config,
					redis
				).catch(() =>
					// A THROWN alert never reached the notifier's own durability, so it
					// must not consume the day's slot: drop the dedup key and the next
					// sweep retries it. A `false` return is the other case and keeps the
					// key deliberately — that event is already in the dead-letter queue,
					// which owns its redelivery, so re-alerting would duplicate it.
					redis.del(ALL_IPS_BLOCKED_ALERT_KEY).catch(() => {})
				);
			}
		} else {
			logger.error({ ips: uniqueIps }, 'ALL IPs unavailable — emergency state');
		}
	} else {
		// The halt lifted: the next one is a new event and alerts immediately.
		await redis.del(ALL_IPS_BLOCKED_ALERT_KEY).catch(() => {});
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
		await runDnsblCheck(redis, config).catch(() =>
			logger.error({ operation: 'dnsbl_sweep', category: 'storage' }, 'DNSBL check failed')
		);
	};
	// Every process completes a boot sweep before enabling delivery workers. This
	// cannot rely on the current leader: during a rolling deployment that process
	// may still have the old IP configuration. Generation CAS makes overlap safe.
	try {
		await runDnsblCheck(redis, config);
	} catch {
		// Do not propagate the raw Redis error into the process-level startup logger:
		// ioredis command metadata can contain payloads or credentials.
		throw new Error('Initial DNSBL sweep failed');
	}

	// Schedule periodic checks
	return setInterval(() => {
		void runIfLeader();
	}, CHECK_INTERVAL_MS);
}

/**
 * True when at least one configured zone could not be measured for this address.
 *
 * `overallStatus` is a PRIORITY roll-up (critical > degraded > unknown), so a
 * warning-severity listing on one zone hides an uncompleted lookup on another.
 * Readers that care about measurement honesty — the routing signal, and through
 * it the ramp controller — must use the explicitly recorded `unknownOn` field
 * instead, never the collapsed status.
 */
export function hasUnmeasuredDnsblZone(
	config: Pick<MtaConfig, 'abusixDnsblApiKey'>,
	ip: string,
	dnsbl: Record<string, string> | null
): boolean {
	// Never swept: nothing about this address has been measured at all.
	if (!dnsbl) return true;
	const unknownOn = dnsbl['unknownOn'];
	if (unknownOn !== undefined) return unknownOn.length > 0;
	// Rows written before `unknownOn` existed: read the per-zone statuses, and
	// only then fall back to the collapsed status.
	const family = ipAddressFamily(ip);
	if (family && configuredDnsblZones(config, family).some((zone) => dnsbl[zone.id] === 'unknown')) {
		return true;
	}
	const overallStatus = dnsbl['overallStatus'];
	return overallStatus === undefined || overallStatus === 'unknown';
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
