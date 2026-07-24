/**
 * ARGV[6..11] describe the existing row as observed by parseDlqEntry. The script
 * compares the exact raw value before trusting that observation, keeping row
 * validation, quarantine or index repair, and the attempts sidecar update in
 * one transition.
 */
export const STORE_LUA = `
local id = ARGV[1]
local existing = redis.call('HGET', KEYS[1], id)
local inserted = 0
if existing then
  if ARGV[5] ~= '1' then return 0 end
  if ARGV[6] ~= '1' or existing ~= ARGV[7] then return -4 end
  if ARGV[10] == '1' then
    if redis.call('HEXISTS', KEYS[1], 'claim:' .. id) == 1 then return -3 end
    redis.call('HDEL', KEYS[1], id, 'attempts:' .. id, 'claim:' .. id, 'claim-expiry:' .. id, 'version:' .. id)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', KEYS[3], id)
    redis.call('SREM', KEYS[4], id)
    return -5
  end
  if ARGV[11] ~= '1' then return -6 end
  if ARGV[8] ~= '1' then
    if redis.call('HEXISTS', KEYS[1], 'claim:' .. id) == 1 then return -3 end
    redis.call('HSET', KEYS[1], id, ARGV[2], 'attempts:' .. id, '0')
    redis.call('HDEL', KEYS[1], 'claim-expiry:' .. id, 'version:' .. id)
  else
    redis.call('HSET', KEYS[1], 'attempts:' .. id, ARGV[9])
  end
  if not redis.call('ZSCORE', KEYS[2], id) then
    local sequence = redis.call('HINCRBY', KEYS[1], '_created-sequence', 1)
    redis.call('ZADD', KEYS[2], sequence, id)
  end
  if not redis.call('ZSCORE', KEYS[3], id) then redis.call('ZADD', KEYS[3], ARGV[3], id) end
  redis.call('SADD', KEYS[4], id)
else
  if ARGV[5] == '1' and ARGV[6] == '1' then return -4 end
  inserted = 1
  local sequence = redis.call('HINCRBY', KEYS[1], '_created-sequence', 1)
  redis.call('HSET', KEYS[1], id, ARGV[2])
  redis.call('HSET', KEYS[1], 'attempts:' .. id, '0')
  redis.call('ZADD', KEYS[2], sequence, id)
  redis.call('ZADD', KEYS[3], ARGV[3], id)
  if ARGV[5] == '1' then redis.call('SADD', KEYS[4], id) end
end
local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
local insertedRetained = 1
if excess > 0 then
  local candidates = redis.call('ZRANGE', KEYS[2], 0, -1)
  for _, id in ipairs(candidates) do
    if excess <= 0 then break end
    if redis.call('SISMEMBER', KEYS[4], id) == 0 then
      redis.call('HDEL', KEYS[1], id, 'attempts:' .. id, 'claim:' .. id, 'claim-expiry:' .. id, 'version:' .. id)
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZREM', KEYS[3], id)
      if id == ARGV[1] then insertedRetained = 0 end
      excess = excess - 1
    end
  end
end
if insertedRetained == 0 then return -2 end
if excess > 0 then
  if inserted == 1 then
    redis.call('HDEL', KEYS[1], ARGV[1], 'attempts:' .. ARGV[1], 'claim:' .. ARGV[1], 'claim-expiry:' .. ARGV[1], 'version:' .. ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    redis.call('SREM', KEYS[4], ARGV[1])
  end
  if ARGV[5] == '1' then return -2 end
  return -1
end
if inserted == 1 then return 1 end
return 0
`;
