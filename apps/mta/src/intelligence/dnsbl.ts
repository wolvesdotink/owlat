/**
 * [2] DNS-Based Blocklist (DNSBL) Auto-Checking
 *
 * Periodically checks sending IPs against major blocklists.
 * Auto-removes blocked IPs from the active pool and alerts Convex.
 */

import { resolve4 } from 'dns/promises';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import {
	DNSBL_LIST_IDS,
	DNSBL_LISTS,
	dnsblZoneHost,
	type DnsblListDefinition,
	type DnsblListId,
} from '@owlat/shared/dnsbl';
import type { IpAuditZoneId } from '@owlat/shared/ipAudit';
import {
	ipAddressFamily,
	reverseIpAddressForDns,
	type IpAddressFamily,
} from '@owlat/shared/ipAddress';
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
const CLEAN_DNS_ERROR_CODES = new Set(['ENOTFOUND', 'ENODATA']);
const SAFE_DNS_ERROR_CODES = new Set([
	...CLEAN_DNS_ERROR_CODES,
	'ESERVFAIL',
	'ETIMEOUT',
	'ECANCELLED',
	'EREFUSED',
	'EFORMERR',
	'ENOTIMP',
	'EBADQUERY',
	'EBADNAME',
	'EBADFAMILY',
	'EBADRESP',
	'ECONNREFUSED',
	'ECONNRESET',
	'EAI_AGAIN',
]);

interface DnsblResult extends Pick<DnsblListDefinition, 'id' | 'name' | 'severity'> {
	status: 'listed' | 'clean' | 'unknown';
}

interface DnsblZone extends DnsblListDefinition {
	zone: string;
}

function safeDnsErrorCode(error: unknown): string {
	if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
	const code = error.code;
	return typeof code === 'string' && SAFE_DNS_ERROR_CODES.has(code) ? code : 'unknown';
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

/** Build the family-correct DNSBL query name for one canonical address. */
export function dnsblQueryName(ip: string, zone: string): string {
	const reversed = reverseIpAddressForDns(ip);
	if (!reversed) throw new Error(`Cannot build a DNSBL query for invalid IP address ${ip}`);
	return `${reversed}.${zone}`;
}

/** Resolver seam so callers (and tests) can supply their own DNS transport. */
export interface DnsblLookupDeps {
	resolve4: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
	/**
	 * Advisory callers (the /24 neighbourhood sample) set this so a resolver
	 * outage logs at debug instead of emitting one warn per probed address. The
	 * warn exists because ROUTING keeps a stale decision on `unknown`; a probe
	 * that gates nothing has no such consequence to announce.
	 */
	quiet?: boolean;
}

export interface DnsblLookupResult {
	status: DnsblResult['status'];
	/** Bounded copy of the raw A answers, for callers that decode return codes. */
	answers: string[];
}

/** A hostile or misconfigured zone can answer with an unbounded RRset. */
const MAX_RETAINED_ANSWERS = 16;
const MAX_ANSWER_LENGTH = 45;

function boundedAnswers(answers: readonly string[]): string[] {
	return answers
		.slice(0, MAX_RETAINED_ANSWERS)
		.map((answer) => String(answer).slice(0, MAX_ANSWER_LENGTH));
}

/**
 * Look one IP up in one DNSBL zone and return both the verdict and the raw
 * answers. This is the single DNSBL lookup path in the MTA: the periodic
 * routing checker and the pre-flight IP audit both go through it.
 */
export async function lookupDnsblZone(
	ip: string,
	listId: DnsblListId | IpAuditZoneId,
	zone: string,
	deps: DnsblLookupDeps = { resolve4 }
): Promise<DnsblLookupResult> {
	const lookup = dnsblQueryName(ip, zone);
	const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
	const logUnknown = (fields: { ip: string; listId: string; errorCode: string }) => {
		if (deps.quiet) logger.debug(fields, 'DNSBL check is unknown');
		else logger.warn(fields, 'DNSBL check is unknown');
	};

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			deps.resolve4(lookup),
			new Promise<never>(
				(_, reject) =>
					(timeout = setTimeout(() => reject(new Error('DNSBL lookup timeout')), timeoutMs))
			),
		]);
		// Spamhaus reserves 127.255.255.x for resolver/configuration errors. That
		// is neither listing nor delisting evidence, so it must preserve a prior
		// quarantine just like SERVFAIL/timeout.
		if (listId === 'spamhaus' && result.some((addr) => addr.startsWith('127.255.255.'))) {
			logUnknown({ ip, listId, errorCode: 'resolver_policy' });
			return { status: 'unknown', answers: boundedAnswers(result) };
		}
		return {
			status: result.some((addr) => addr.startsWith('127.')) ? 'listed' : 'unknown',
			answers: boundedAnswers(result),
		};
	} catch (err: unknown) {
		const errorCode = safeDnsErrorCode(err);
		// NXDOMAIN/ENOTFOUND = not listed (this is the expected "clean" result)
		if (CLEAN_DNS_ERROR_CODES.has(errorCode)) {
			return { status: 'clean', answers: [] };
		}
		// Resolver availability is not evidence of delisting. Preserve the last
		// confirmed decision (and fail closed for a never-observed address).
		// Never log `zone` or the resolver message: keyed providers such as Abusix
		// embed a credential in the queried hostname and resolver errors often echo it.
		logUnknown({ ip, listId, errorCode });
		return { status: 'unknown', answers: [] };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/** Check a single IP against a single applicable DNSBL zone. */
async function checkDnsbl(
	ip: string,
	listId: DnsblListDefinition['id'],
	zone: string
): Promise<DnsblResult['status']> {
	return (await lookupDnsblZone(ip, listId, zone)).status;
}

/**
 * Check an IP against all configured DNSBL zones
 */
async function checkAllZones(ip: string, config: MtaConfig): Promise<DnsblResult[]> {
	const family = ipAddressFamily(ip);
	if (!family) throw new Error(`Configured DNSBL address is invalid: ${ip}`);
	const results = await Promise.all(
		configuredDnsblZones(config, family).map(async (zone) => ({
			id: zone.id,
			name: zone.name,
			severity: zone.severity,
			status: await checkDnsbl(ip, zone.id, zone.zone),
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
			return { ip, generation, results: await checkAllZones(ip, config) };
		})
	);

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

		const spamhaus = results.find((result) => result.id === 'spamhaus');
		if (!spamhaus) throw new Error('Spamhaus DNSBL observation is missing');
		const hasUnknown = results.some((result) => result.status === 'unknown');
		const previousSpamhausStatus = await redis.hget(hashKey, 'spamhaus');
		const previousStatus = await redis.hget(hashKey, 'overallStatus');
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
