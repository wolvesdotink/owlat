/**
 * IP pool eligibility and round-robin selection.
 *
 * Redis owns one configured-membership set, one active set, composed exclusion
 * reasons, and an eligibility generation used as a fencing token at SMTP time.
 * Observation transitions are generation-ordered Lua transactions so late DNS
 * results cannot undo newer decisions from another MTA instance. The Lua
 * sources themselves live in `ipPoolScripts.ts`; this module owns the KEYS/ARGV
 * binding and the interpretation of their replies.
 */

import type Redis from 'ioredis';
import { normalizeIpAddress } from '@owlat/shared/ipAddress';
import {
	IP_READINESS_BLOCK_REASONS,
	isIpReadinessBlockReason,
	type IpReadinessBlockReason,
} from '@owlat/shared/ipReadiness';
import type { IpPoolConfig, IpPoolType } from '../types.js';
import { logger } from '../monitoring/logger.js';
import {
	APPLY_OBSERVATION_SCRIPT,
	INITIALIZE_POOLS_SCRIPT,
	VALIDATE_LEASE_SCRIPT,
} from './ipPoolScripts.js';

const IP_POOL_ACTIVE = 'mta:ip-pool:active';
const IP_POOL_CONFIGURED = 'mta:ip-pool:configured';
const IP_POOL_ELIGIBILITY_GENERATIONS = 'mta:ip-pool:eligibility-generations';
const EMERGENCY_KEY = 'mta:emergency:all_ips_blocked';
const COUNTER_PREFIX = 'mta:ip-rr:';
const BLOCK_REASONS_PREFIX = 'mta:ip-pool:block-reasons:';
const OBSERVATION_SEQUENCE_PREFIX = 'mta:ip-pool:observation-sequence:';
const APPLIED_OBSERVATIONS_PREFIX = 'mta:ip-pool:applied-observations:';
const UNDERLYING_BLOCKS_PREFIX = 'mta:ip-pool:underlying-blocks:';
const FCRDNS_PREFIX = 'mta:fcrdns:';
const DNSBL_PREFIX = 'mta:dnsbl:';
const IPV4_IDENTITY_PREFIX = 'mta:ipv4-identity:';
const SOURCE_ADDRESS_PREFIX = 'mta:source-address-readiness:';
const SPF_PREFIX = 'mta:ipv6-spf:';
export const IP_READINESS_ALERTS_PENDING = 'mta:ip-readiness-alerts:pending';

export type IpPoolBlockReason = IpReadinessBlockReason;
export type IpPoolObservationDecision = 'block' | 'clear' | 'preserve';

export interface IpEligibilityLease {
	ip: string;
	eligibilityGeneration: number;
}

export interface IpPoolObservation {
	ip: string;
	reason: IpPoolBlockReason;
	generation: number;
	decision: IpPoolObservationDecision;
	/** Only FCrDNS uses this explicit lab bypass. */
	override?: boolean;
	stateKey: string;
	stateFields: Record<string, string>;
	regressionAlert?: {
		check: 'fcrdns' | 'spf';
		reason: string;
		timestamp: number;
		message: string;
	};
}

export interface IpPoolObservationResult {
	applied: boolean;
	active: boolean;
	eligibilityGeneration: number;
	wouldBlockWithoutOverride: boolean;
	becameBlocked: boolean;
}

function isIpPoolBlockReason(value: string): value is IpPoolBlockReason {
	return isIpReadinessBlockReason(value);
}

const STATE_PREFIX_BY_BLOCK_REASON: Record<IpPoolBlockReason, string> = {
	dnsbl: DNSBL_PREFIX,
	fcrdns: FCRDNS_PREFIX,
	'ipv4-identity': IPV4_IDENTITY_PREFIX,
	'source-address': SOURCE_ADDRESS_PREFIX,
	spf: SPF_PREFIX,
};

function observationSequenceKey(ip: string, reason: IpPoolBlockReason): string {
	return `${OBSERVATION_SEQUENCE_PREFIX}${reason}:${ip}`;
}

/**
 * Allocate the fencing token for one observation, BEFORE its DNS work starts.
 *
 * The counter carries no TTL on purpose: it is the monotonic ordering of every
 * observation ever made about this (address, reason), and an expiry that fired
 * mid-life would restart it below the applied generation it is compared
 * against, after which every fresh sweep would read as stale and the address
 * would freeze at whatever verdict it last held. Its lifetime is instead tied
 * to the address: `INITIALIZE_POOLS_SCRIPT` deletes it when the address is
 * retired, alongside the applied generation.
 */
export async function nextIpPoolObservationGeneration(
	redis: Redis,
	ip: string,
	reason: IpPoolBlockReason
): Promise<number> {
	return redis.incr(observationSequenceKey(ip, reason));
}

export async function applyIpPoolObservation(
	redis: Redis,
	observation: IpPoolObservation
): Promise<IpPoolObservationResult> {
	const fields = Object.entries(observation.stateFields);
	const args: Array<string | number> = [
		observation.ip,
		observation.reason,
		observation.generation,
		observation.decision,
		observation.override ? '1' : '0',
		fields.length,
	];
	for (const [field, value] of fields) args.push(field, value);
	args.push(
		observation.regressionAlert?.check ?? '',
		observation.regressionAlert?.reason ?? '',
		observation.regressionAlert?.timestamp ?? '',
		observation.regressionAlert?.message ?? ''
	);
	const raw = (await redis.eval(
		APPLY_OBSERVATION_SCRIPT,
		10,
		observation.stateKey,
		`${BLOCK_REASONS_PREFIX}${observation.ip}`,
		IP_POOL_ACTIVE,
		IP_POOL_CONFIGURED,
		`${APPLIED_OBSERVATIONS_PREFIX}${observation.reason}`,
		`${UNDERLYING_BLOCKS_PREFIX}${observation.reason}`,
		IP_POOL_ELIGIBILITY_GENERATIONS,
		EMERGENCY_KEY,
		IP_READINESS_ALERTS_PENDING,
		observationSequenceKey(observation.ip, observation.reason),
		...args
	)) as number[];
	return {
		applied: Number(raw[0]) === 1,
		active: Number(raw[1]) === 1,
		eligibilityGeneration: Number(raw[2]),
		wouldBlockWithoutOverride: Number(raw[3]) === 1,
		becameBlocked: Number(raw[4]) === 1,
	};
}

/** Direct administrative/test transition through the same generation-CAS path as live observers. */
export async function setIpPoolBlock(
	redis: Redis,
	ip: string,
	reason: IpPoolBlockReason,
	blocked: boolean
): Promise<boolean> {
	const generation = await nextIpPoolObservationGeneration(redis, ip, reason);
	const transition = await applyIpPoolObservation(redis, {
		ip,
		reason,
		generation,
		decision: blocked ? 'block' : 'clear',
		stateKey: `${STATE_PREFIX_BY_BLOCK_REASON[reason]}${ip}`,
		stateFields: {},
	});
	return transition.active;
}

export async function getIpPoolBlockReasons(
	redis: Redis,
	ip: string
): Promise<IpPoolBlockReason[]> {
	const reasons = await redis.hkeys(`${BLOCK_REASONS_PREFIX}${ip}`);
	return reasons.filter(isIpPoolBlockReason);
}

export async function isIpEligibilityLeaseValid(
	redis: Redis,
	lease: IpEligibilityLease
): Promise<boolean> {
	return (
		Number(
			await redis.eval(
				VALIDATE_LEASE_SCRIPT,
				3,
				IP_POOL_CONFIGURED,
				IP_POOL_ACTIVE,
				IP_POOL_ELIGIBILITY_GENERATIONS,
				lease.ip,
				lease.eligibilityGeneration
			)
		) === 1
	);
}

export async function selectIpWithLease(
	redis: Redis,
	pool: IpPoolType,
	config: IpPoolConfig,
	dedicatedIp?: string
): Promise<IpEligibilityLease | null> {
	const configuredLocally = new Set([...config.transactional, ...config.campaign]);
	const activeIps = new Set(await redis.smembers(IP_POOL_ACTIVE));
	let selectedIp: string | undefined;

	if (dedicatedIp) {
		const normalizedDedicatedIp = normalizeIpAddress(dedicatedIp);
		if (
			normalizedDedicatedIp &&
			configuredLocally.has(normalizedDedicatedIp) &&
			activeIps.has(normalizedDedicatedIp)
		) {
			selectedIp = normalizedDedicatedIp;
		} else {
			logger.error({ dedicatedIp }, 'Dedicated IP is unavailable; delivery remains queued');
			return null;
		}
	} else {
		const availableIps = config[pool].filter((ip) => activeIps.has(ip));
		if (availableIps.length === 0) {
			logger.error({ pool }, 'No eligible IPs available for pool; delivery remains queued');
			return null;
		}
		if (availableIps.length === 1) selectedIp = availableIps[0];
		else {
			const counter = await redis.incr(`${COUNTER_PREFIX}${pool}`);
			await redis.expire(`${COUNTER_PREFIX}${pool}`, 86400);
			selectedIp = availableIps[(counter - 1) % availableIps.length];
		}
	}

	if (!selectedIp) return null;
	const generation = Number((await redis.hget(IP_POOL_ELIGIBILITY_GENERATIONS, selectedIp)) ?? 0);
	const lease = { ip: selectedIp, eligibilityGeneration: generation };
	return (await isIpEligibilityLeaseValid(redis, lease)) ? lease : null;
}

export async function selectIp(
	redis: Redis,
	pool: IpPoolType,
	config: IpPoolConfig,
	dedicatedIp?: string
): Promise<string | null> {
	return (await selectIpWithLease(redis, pool, config, dedicatedIp))?.ip ?? null;
}

export async function getPoolStatus(
	redis: Redis,
	config: IpPoolConfig
): Promise<
	Array<{
		ip: string;
		pool: IpPoolType;
		active: boolean;
		blockReasons: IpPoolBlockReason[];
	}>
> {
	const activeSet = new Set(await redis.smembers(IP_POOL_ACTIVE));
	const result: Array<{
		ip: string;
		pool: IpPoolType;
		active: boolean;
		blockReasons: IpPoolBlockReason[];
	}> = [];
	for (const [pool, ips] of [
		['transactional', config.transactional],
		['campaign', config.campaign],
	] as const) {
		for (const ip of ips) {
			result.push({
				ip,
				pool,
				active: activeSet.has(ip),
				blockReasons: await getIpPoolBlockReasons(redis, ip),
			});
		}
	}
	return result;
}

/** Replace configured membership atomically; new/unknown IPs start inactive. */
export async function initializePools(
	redis: Redis,
	config: IpPoolConfig,
	allowUnverifiedFcrdns = false
): Promise<void> {
	const allIps = [...new Set([...config.transactional, ...config.campaign])];
	await redis.eval(
		INITIALIZE_POOLS_SCRIPT,
		14,
		IP_POOL_CONFIGURED,
		IP_POOL_ACTIVE,
		IP_POOL_ELIGIBILITY_GENERATIONS,
		EMERGENCY_KEY,
		`${APPLIED_OBSERVATIONS_PREFIX}fcrdns`,
		`${APPLIED_OBSERVATIONS_PREFIX}dnsbl`,
		`${APPLIED_OBSERVATIONS_PREFIX}ipv4-identity`,
		`${APPLIED_OBSERVATIONS_PREFIX}source-address`,
		`${APPLIED_OBSERVATIONS_PREFIX}spf`,
		`${UNDERLYING_BLOCKS_PREFIX}fcrdns`,
		`${UNDERLYING_BLOCKS_PREFIX}dnsbl`,
		`${UNDERLYING_BLOCKS_PREFIX}ipv4-identity`,
		`${UNDERLYING_BLOCKS_PREFIX}source-address`,
		`${UNDERLYING_BLOCKS_PREFIX}spf`,
		FCRDNS_PREFIX,
		BLOCK_REASONS_PREFIX,
		DNSBL_PREFIX,
		IPV4_IDENTITY_PREFIX,
		SOURCE_ADDRESS_PREFIX,
		SPF_PREFIX,
		OBSERVATION_SEQUENCE_PREFIX,
		allowUnverifiedFcrdns ? '1' : '0',
		IP_READINESS_BLOCK_REASONS.length,
		...IP_READINESS_BLOCK_REASONS,
		...allIps
	);
	logger.info(
		{ transactional: config.transactional, campaign: config.campaign },
		'IP pools initialized'
	);
}
