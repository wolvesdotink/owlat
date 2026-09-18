/**
 * Lua sources for the IP-pool Redis transactions.
 *
 * These run inside Redis, so every multi-key decision they make is atomic
 * against concurrent MTA instances. They live together because they share one
 * invariant: `INITIALIZE_POOLS_SCRIPT` retires an address by deleting its
 * per-reason observation counters and applied generations, and
 * `APPLY_OBSERVATION_SCRIPT`'s out-of-epoch clause is what makes that deletion
 * safe when the address is later re-added. Changing the key set one deletes
 * without changing what the other compares against would silently freeze an
 * address at a stale readiness verdict.
 *
 * The KEYS/ARGV ordering is the contract with `ipPool.ts`, the only caller; the
 * two files must be read together whenever either changes.
 */

export const VALIDATE_LEASE_SCRIPT = `
return redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1
  and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
  and tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0') == tonumber(ARGV[2])
  and 1 or 0
`;

export const APPLY_OBSERVATION_SCRIPT = `
local stateKey = KEYS[1]
local reasonKey = KEYS[2]
local activeKey = KEYS[3]
local configuredKey = KEYS[4]
local appliedKey = KEYS[5]
local underlyingKey = KEYS[6]
local eligibilityGenerationKey = KEYS[7]
local emergencyKey = KEYS[8]
local pendingAlertsKey = KEYS[9]
local sequenceKey = KEYS[10]

local ip = ARGV[1]
local reason = ARGV[2]
local observationGeneration = tonumber(ARGV[3])
local decision = ARGV[4]
local override = ARGV[5] == '1'
local fieldCount = tonumber(ARGV[6])
local alertOffset = 7 + fieldCount * 2
local alertCheck = ARGV[alertOffset]
local alertReason = ARGV[alertOffset + 1]
local alertTimestamp = ARGV[alertOffset + 2]
local alertMessage = ARGV[alertOffset + 3]
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

-- Two ways an observation is out of date. It lost the CAS to a newer sweep, or
-- it outranks the counter that issued it, which can only mean the counter was
-- reset under it: retiring an address deletes both the counter and this
-- reason's applied generation, so an observation allocated before that
-- retirement belongs to a previous configuration epoch. Without this clause
-- such an observation would land on the re-added address with a generation no
-- fresh sweep can beat for a long time, freezing it at a stale verdict.
local sequence = tonumber(redis.call('GET', sequenceKey) or '0')
if observationGeneration <= appliedGeneration or observationGeneration > sequence then
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
if becameBlocked and alertCheck ~= '' then
  local eventId = 'ipv6-readiness-v1:' .. alertCheck .. ':' .. ip .. ':' .. eligibilityGeneration
  local marker = table.concat({alertCheck, alertReason, alertTimestamp, alertMessage, ip, eligibilityGeneration}, string.char(31))
  redis.call('HSETNX', pendingAlertsKey, eventId, marker)
end

local configuredIps = redis.call('SMEMBERS', configuredKey)
local eligibleCount = 0
for _, configuredIp in ipairs(configuredIps) do
  if redis.call('SISMEMBER', activeKey, configuredIp) == 1 then eligibleCount = eligibleCount + 1 end
end
if #configuredIps > 0 and eligibleCount == 0 then redis.call('SET', emergencyKey, '1') else redis.call('DEL', emergencyKey) end

return {1, isActive and 1 or 0, eligibilityGeneration, underlying and 1 or 0, becameBlocked and 1 or 0}
`;

export const INITIALIZE_POOLS_SCRIPT = `
local configuredKey = KEYS[1]
local activeKey = KEYS[2]
local generationKey = KEYS[3]
local emergencyKey = KEYS[4]
local fcrdnsAppliedKey = KEYS[5]
local dnsblAppliedKey = KEYS[6]
local ipv4IdentityAppliedKey = KEYS[7]
local sourceAddressAppliedKey = KEYS[8]
local spfAppliedKey = KEYS[9]
local fcrdnsUnderlyingKey = KEYS[10]
local dnsblUnderlyingKey = KEYS[11]
local ipv4IdentityUnderlyingKey = KEYS[12]
local sourceAddressUnderlyingKey = KEYS[13]
local spfUnderlyingKey = KEYS[14]
local fcrdnsPrefix = ARGV[1]
local blockPrefix = ARGV[2]
local dnsblPrefix = ARGV[3]
local ipv4IdentityPrefix = ARGV[4]
local sourceAddressPrefix = ARGV[5]
local spfPrefix = ARGV[6]
local observationSequencePrefix = ARGV[7]
local allowUnverifiedFcrdns = ARGV[8] == '1'
local reasonCount = tonumber(ARGV[9])
local reasons = {}
for index = 1, reasonCount do reasons[index] = ARGV[9 + index] end
local newIps = {}
for index = 10 + reasonCount, #ARGV do newIps[ARGV[index]] = true end

local previousIps = redis.call('SMEMBERS', configuredKey)
for _, ip in ipairs(previousIps) do
  if not newIps[ip] then
    local wasActive = redis.call('SISMEMBER', activeKey, ip) == 1
    redis.call('SREM', configuredKey, ip)
    redis.call('SREM', activeKey, ip)
    redis.call('DEL', fcrdnsPrefix .. ip)
    redis.call('DEL', dnsblPrefix .. ip)
    redis.call('DEL', ipv4IdentityPrefix .. ip)
    redis.call('DEL', sourceAddressPrefix .. ip)
    redis.call('DEL', spfPrefix .. ip)
    redis.call('DEL', blockPrefix .. ip)
    redis.call('HDEL', fcrdnsAppliedKey, ip)
    redis.call('HDEL', dnsblAppliedKey, ip)
    redis.call('HDEL', ipv4IdentityAppliedKey, ip)
    redis.call('HDEL', sourceAddressAppliedKey, ip)
    redis.call('HDEL', spfAppliedKey, ip)
    redis.call('HDEL', fcrdnsUnderlyingKey, ip)
    redis.call('HDEL', dnsblUnderlyingKey, ip)
    redis.call('HDEL', ipv4IdentityUnderlyingKey, ip)
    redis.call('HDEL', sourceAddressUnderlyingKey, ip)
    redis.call('HDEL', spfUnderlyingKey, ip)
    -- The per-reason observation counters are the last per-address keys left
    -- behind by a retirement, and they carry no TTL. They go with the applied
    -- generations they are compared against: reset together, or the pair is
    -- inconsistent. APPLY_OBSERVATION_SCRIPT's out-of-epoch clause is what
    -- makes discarding them safe for an address that is later re-added.
    for _, reason in ipairs(reasons) do
      redis.call('DEL', observationSequencePrefix .. reason .. ':' .. ip)
    end
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
  local isIpv6 = string.find(ip, ':', 1, true) ~= nil
  local sourceVerdict = redis.call('HGET', sourceAddressPrefix .. ip, 'verdict')
  local spfVerdict = redis.call('HGET', spfPrefix .. ip, 'verdict')
  local identityReady = checkedAt and (verdict == 'pass' or verdict == 'warn' or (allowUnverifiedFcrdns and not isIpv6 and wouldBlockWithoutOverride))
  local ready = identityReady and (not isIpv6 or (sourceVerdict == 'pass' and spfVerdict == 'pass'))
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
