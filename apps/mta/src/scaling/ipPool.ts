/**
 * IP pool eligibility and round-robin selection.
 *
 * Redis owns one configured-membership set, one active set, composed exclusion
 * reasons, and an eligibility generation used as a fencing token at SMTP time.
 * Observation transitions are generation-ordered Lua transactions so late DNS
 * results cannot undo newer decisions from another MTA instance.
 */

import type Redis from 'ioredis';
import type { IpPoolConfig, IpPoolType } from '../types.js';
import { logger } from '../monitoring/logger.js';

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
const VALIDATE_LEASE_SCRIPT = `
return redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1
  and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
  and tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0') == tonumber(ARGV[2])
  and 1 or 0
`;

export const IP_POOL_BLOCK_REASONS = ['dnsbl', 'fcrdns'] as const;
export type IpPoolBlockReason = (typeof IP_POOL_BLOCK_REASONS)[number];
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
}

export interface IpPoolObservationResult {
	applied: boolean;
	active: boolean;
	eligibilityGeneration: number;
	wouldBlockWithoutOverride: boolean;
	becameBlocked: boolean;
}

const APPLY_OBSERVATION_SCRIPT = `
local stateKey = KEYS[1]
local reasonKey = KEYS[2]
local activeKey = KEYS[3]
local configuredKey = KEYS[4]
local appliedKey = KEYS[5]
local underlyingKey = KEYS[6]
local eligibilityGenerationKey = KEYS[7]
local emergencyKey = KEYS[8]

local ip = ARGV[1]
local reason = ARGV[2]
local observationGeneration = tonumber(ARGV[3])
local decision = ARGV[4]
local override = ARGV[5] == '1'
local fieldCount = tonumber(ARGV[6])
local appliedGeneration = tonumber(redis.call('HGET', appliedKey, ip) or '0')
local wasActive = redis.call('SISMEMBER', activeKey, ip) == 1
local isConfigured = redis.call('SISMEMBER', configuredKey, ip) == 1

-- A sweep may finish after an address is retired. Dropping it before either
-- the generation CAS or state writes prevents stale readiness from surviving
-- retirement and becoming authoritative if the address is later re-added.
if not isConfigured then
  local existingUnderlying = redis.call('HGET', underlyingKey, ip) == '1'
  return {0, 0, tonumber(redis.call('HGET', eligibilityGenerationKey, ip) or '0'), existingUnderlying and 1 or 0, 0}
end

if observationGeneration <= appliedGeneration then
  local existingUnderlying = redis.call('HGET', underlyingKey, ip) == '1'
  return {0, wasActive and 1 or 0, tonumber(redis.call('HGET', eligibilityGenerationKey, ip) or '0'), existingUnderlying and 1 or 0, 0}
end

local underlying
if decision == 'block' then
  underlying = true
elseif decision == 'clear' then
  underlying = false
else
  local stored = redis.call('HGET', underlyingKey, ip)
  underlying = not stored or stored == '1'
end

redis.call('HSET', appliedKey, ip, observationGeneration)
redis.call('HSET', underlyingKey, ip, underlying and '1' or '0')
for index = 0, fieldCount - 1 do
  local fieldOffset = 7 + index * 2
  redis.call('HSET', stateKey, ARGV[fieldOffset], ARGV[fieldOffset + 1])
end
if reason == 'fcrdns' then
  redis.call('HSET', stateKey, 'wouldBlockWithoutOverride', underlying and 'true' or 'false')
  redis.call('HSET', stateKey, 'overridden', (underlying and override) and 'true' or 'false')
end

local effectiveBlock = underlying and not override
if effectiveBlock then
  redis.call('HSET', reasonKey, reason, '1')
else
  redis.call('HDEL', reasonKey, reason)
end
if redis.call('HLEN', reasonKey) == 0 then redis.call('DEL', reasonKey) end

local shouldBeActive = isConfigured and redis.call('HLEN', reasonKey) == 0
if shouldBeActive then redis.call('SADD', activeKey, ip) else redis.call('SREM', activeKey, ip) end
local isActive = redis.call('SISMEMBER', activeKey, ip) == 1
local eligibilityGeneration = tonumber(redis.call('HGET', eligibilityGenerationKey, ip) or '0')
local becameBlocked = false
if wasActive ~= isActive then
  eligibilityGeneration = redis.call('HINCRBY', eligibilityGenerationKey, ip, 1)
  becameBlocked = wasActive and not isActive
end

local configuredIps = redis.call('SMEMBERS', configuredKey)
local eligibleCount = 0
for _, configuredIp in ipairs(configuredIps) do
  if redis.call('SISMEMBER', activeKey, configuredIp) == 1 then eligibleCount = eligibleCount + 1 end
end
if #configuredIps > 0 and eligibleCount == 0 then redis.call('SET', emergencyKey, '1') else redis.call('DEL', emergencyKey) end

return {1, isActive and 1 or 0, eligibilityGeneration, underlying and 1 or 0, becameBlocked and 1 or 0}
`;

const INITIALIZE_POOLS_SCRIPT = `
local configuredKey = KEYS[1]
local activeKey = KEYS[2]
local generationKey = KEYS[3]
local emergencyKey = KEYS[4]
local fcrdnsAppliedKey = KEYS[5]
local dnsblAppliedKey = KEYS[6]
local fcrdnsUnderlyingKey = KEYS[7]
local dnsblUnderlyingKey = KEYS[8]
local fcrdnsPrefix = ARGV[1]
local blockPrefix = ARGV[2]
local dnsblPrefix = ARGV[3]
local allowUnverifiedFcrdns = ARGV[4] == '1'
local newIps = {}
for index = 5, #ARGV do newIps[ARGV[index]] = true end

local previousIps = redis.call('SMEMBERS', configuredKey)
for _, ip in ipairs(previousIps) do
  if not newIps[ip] then
    local wasActive = redis.call('SISMEMBER', activeKey, ip) == 1
    redis.call('SREM', configuredKey, ip)
    redis.call('SREM', activeKey, ip)
    redis.call('DEL', fcrdnsPrefix .. ip)
    redis.call('DEL', dnsblPrefix .. ip)
    redis.call('DEL', blockPrefix .. ip)
    redis.call('HDEL', fcrdnsAppliedKey, ip)
    redis.call('HDEL', dnsblAppliedKey, ip)
    redis.call('HDEL', fcrdnsUnderlyingKey, ip)
    redis.call('HDEL', dnsblUnderlyingKey, ip)
    if wasActive then redis.call('HINCRBY', generationKey, ip, 1) end
  end
end

local staleActiveIps = redis.call('SMEMBERS', activeKey)
for _, ip in ipairs(staleActiveIps) do
  if not newIps[ip] then
    redis.call('SREM', activeKey, ip)
    redis.call('HINCRBY', generationKey, ip, 1)
  end
end

for ip, _ in pairs(newIps) do
  redis.call('SADD', configuredKey, ip)
  local readinessKey = fcrdnsPrefix .. ip
  local verdict = redis.call('HGET', readinessKey, 'verdict')
  local checkedAt = redis.call('HGET', readinessKey, 'checkedAt')
  local wouldBlockWithoutOverride = redis.call('HGET', readinessKey, 'wouldBlockWithoutOverride') == 'true'
  local ready = checkedAt and (verdict == 'pass' or verdict == 'warn' or (allowUnverifiedFcrdns and wouldBlockWithoutOverride))
  local shouldBeActive = ready and redis.call('HLEN', blockPrefix .. ip) == 0
  local wasActive = redis.call('SISMEMBER', activeKey, ip) == 1
  if shouldBeActive then redis.call('SADD', activeKey, ip) else redis.call('SREM', activeKey, ip) end
  local isActive = redis.call('SISMEMBER', activeKey, ip) == 1
  if wasActive ~= isActive then redis.call('HINCRBY', generationKey, ip, 1) end
end

local configuredIps = redis.call('SMEMBERS', configuredKey)
local eligibleCount = 0
for _, ip in ipairs(configuredIps) do
  if redis.call('SISMEMBER', activeKey, ip) == 1 then eligibleCount = eligibleCount + 1 end
end
if #configuredIps > 0 and eligibleCount == 0 then redis.call('SET', emergencyKey, '1') else redis.call('DEL', emergencyKey) end
return {#configuredIps, eligibleCount}
`;

export function isIpPoolBlockReason(value: string): value is IpPoolBlockReason {
	return value === 'dnsbl' || value === 'fcrdns';
}

export async function nextIpPoolObservationGeneration(
	redis: Redis,
	ip: string,
	reason: IpPoolBlockReason
): Promise<number> {
	return redis.incr(`${OBSERVATION_SEQUENCE_PREFIX}${reason}:${ip}`);
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
	const raw = (await redis.eval(
		APPLY_OBSERVATION_SCRIPT,
		8,
		observation.stateKey,
		`${BLOCK_REASONS_PREFIX}${observation.ip}`,
		IP_POOL_ACTIVE,
		IP_POOL_CONFIGURED,
		`${APPLIED_OBSERVATIONS_PREFIX}${observation.reason}`,
		`${UNDERLYING_BLOCKS_PREFIX}${observation.reason}`,
		IP_POOL_ELIGIBILITY_GENERATIONS,
		EMERGENCY_KEY,
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
		stateKey: `${reason === 'dnsbl' ? DNSBL_PREFIX : FCRDNS_PREFIX}${ip}`,
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
		if (configuredLocally.has(dedicatedIp) && activeIps.has(dedicatedIp)) selectedIp = dedicatedIp;
		else {
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
		8,
		IP_POOL_CONFIGURED,
		IP_POOL_ACTIVE,
		IP_POOL_ELIGIBILITY_GENERATIONS,
		EMERGENCY_KEY,
		`${APPLIED_OBSERVATIONS_PREFIX}fcrdns`,
		`${APPLIED_OBSERVATIONS_PREFIX}dnsbl`,
		`${UNDERLYING_BLOCKS_PREFIX}fcrdns`,
		`${UNDERLYING_BLOCKS_PREFIX}dnsbl`,
		FCRDNS_PREFIX,
		BLOCK_REASONS_PREFIX,
		DNSBL_PREFIX,
		allowUnverifiedFcrdns ? '1' : '0',
		...allIps
	);
	logger.info(
		{ transactional: config.transactional, campaign: config.campaign },
		'IP pools initialized'
	);
}
