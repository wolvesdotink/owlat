export const WARMING_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const RESERVE_WARMING_SLOT_LUA = `
local hashKey = KEYS[1]
local reservationsKey = KEYS[2]
local today = ARGV[1]
local now = tonumber(ARGV[2])
local expiresAt = tonumber(ARGV[3])
local messageId = ARGV[4]

local startedAt = redis.call('HGET', hashKey, 'startedAt')
local phase = redis.call('HGET', hashKey, 'phase')
if not startedAt or phase == 'graduated' then return { 1, 0, -1, 0 } end

local reset = redis.call('HGET', hashKey, 'sentTodayReset')
if reset ~= today then redis.call('HSET', hashKey, 'sentToday', '0', 'sentTodayReset', today) end
redis.call('ZREMRANGEBYSCORE', reservationsKey, '-inf', now)
local existing = redis.call('ZSCORE', reservationsKey, messageId)
local sent = tonumber(redis.call('HGET', hashKey, 'sentToday') or '0')
local capRaw = redis.call('HGET', hashKey, 'dailyCap') or '0'
local reserved = tonumber(redis.call('ZCARD', reservationsKey))
-- A plateaued/accelerated IP past the schedule writes the literal 'Infinity'.
-- tonumber() turns that into a Lua inf, which Redis truncates to a nonsense
-- integer on the way back. Report the uncapped sentinel instead.
if capRaw == 'Infinity' or capRaw == 'inf' then return { 1, sent, -1, reserved } end
local cap = tonumber(capRaw) or 0
if existing then return { 1, sent, cap, reserved } end
if sent + reserved >= cap then return { 0, sent, cap, reserved } end
redis.call('ZADD', reservationsKey, expiresAt, messageId)
redis.call('PEXPIRE', reservationsKey, ${WARMING_RESERVATION_TTL_MS + 60_000})
return { 1, sent, cap, reserved + 1 }
`;

export const RECORD_RESERVED_WARMING_SEND_LUA = `
local hashKey = KEYS[1]
local reservationsKey = KEYS[2]
local statsKey = KEYS[3]
local receiptKey = KEYS[4]
local messageId = ARGV[1]
if redis.call('EXISTS', receiptKey) == 1 then return 0 end
if redis.call('ZREM', reservationsKey, messageId) ~= 1 then return -1 end
redis.call('HINCRBY', hashKey, 'sentToday', 1)
redis.call('HINCRBY', statsKey, 'sent', 1)
redis.call('EXPIRE', statsKey, 172800)
-- The receipt must outlive the reservation it guards; anything shorter would
-- silently stop guarding replays that arrive late in the reservation horizon.
redis.call('SET', receiptKey, '1', 'PX', ${WARMING_RESERVATION_TTL_MS})
return 1
`;

/** Atomically rolls a stale UTC-day counter before returning the cap. */
export const CHECK_WARMING_CAP_ROLLOVER_LUA = `
local hashKey = KEYS[1]
local today = ARGV[1]

local reset = redis.call('HGET', hashKey, 'sentTodayReset')
local dailyCap = redis.call('HGET', hashKey, 'dailyCap') or '0'

if reset ~= today then
  redis.call('HSET', hashKey, 'sentToday', '0', 'sentTodayReset', today)
  return { '0', dailyCap }
end

local sentToday = redis.call('HGET', hashKey, 'sentToday') or '0'
return { sentToday, dailyCap }
`;
