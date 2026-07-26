import {
	BASE_WARMING_SCHEDULE,
	isValidNonGraduatedWarmingCap,
	NON_GRADUATED_WARMING_CAP_RANGE,
} from '@owlat/shared/warming';

export const WARMING_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VALID_WARMING_CAP_FALLBACK_LOOKUP_LUA = BASE_WARMING_SCHEDULE.filter((entry) =>
	isValidNonGraduatedWarmingCap(entry.cap)
)
	.map(
		(entry) =>
			`if currentDay >= ${entry.day} then fallbackCap = math.min(${entry.cap}, maximumCap) end`
	)
	.join('\n  ');

const NORMALIZE_WARMING_CAP_FUNCTION_LUA = `
local function normalizeWarmingCap(hashKey)
  local minimumCap = ${NON_GRADUATED_WARMING_CAP_RANGE.minimum}
  local maximumCap = ${NON_GRADUATED_WARMING_CAP_RANGE.maximum}
  local currentDay = tonumber(redis.call('HGET', hashKey, 'currentDay') or '1')
  if not currentDay or currentDay ~= currentDay or currentDay == math.huge or currentDay == -math.huge or currentDay < 1 then
    currentDay = 1
  else
    currentDay = math.floor(currentDay)
  end
  local fallbackCap = minimumCap
  ${VALID_WARMING_CAP_FALLBACK_LOOKUP_LUA}
  local capRaw = redis.call('HGET', hashKey, 'dailyCap')
  local cap = tonumber(capRaw)
  if not cap or cap ~= cap or cap == math.huge or cap == -math.huge or cap < minimumCap or cap > maximumCap or cap % 1 ~= 0 then
    cap = fallbackCap
    redis.call('HSET', hashKey, 'dailyCap', tostring(cap))
  end
  return cap
end
`;

/**
 * Enforces the persisted cap contract for a non-graduated row. The phase check,
 * day-derived fallback, and conditional repair are one Redis command, so this
 * cannot overwrite a concurrent graduation.
 */
export const NORMALIZE_NON_GRADUATED_WARMING_CAP_LUA = `
${NORMALIZE_WARMING_CAP_FUNCTION_LUA}
local hashKey = KEYS[1]
local startedAt = redis.call('HGET', hashKey, 'startedAt')
local phase = redis.call('HGET', hashKey, 'phase')
if not startedAt or phase == 'graduated' then return 'Infinity' end
return tostring(normalizeWarmingCap(hashKey))
`;

/** Atomically repairs and returns one coherent warming-state snapshot. */
export const GET_NORMALIZED_WARMING_STATE_LUA = `
${NORMALIZE_WARMING_CAP_FUNCTION_LUA}
local hashKey = KEYS[1]
local startedAt = redis.call('HGET', hashKey, 'startedAt')
if not startedAt then return {} end
local phase = redis.call('HGET', hashKey, 'phase')
if phase == 'graduated' then
  if redis.call('HGET', hashKey, 'dailyCap') ~= 'Infinity' then
    redis.call('HSET', hashKey, 'dailyCap', 'Infinity')
  end
else
  normalizeWarmingCap(hashKey)
end
return redis.call('HGETALL', hashKey)
`;

export const RESERVE_WARMING_SLOT_LUA = `
${NORMALIZE_WARMING_CAP_FUNCTION_LUA}
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
local reserved = tonumber(redis.call('ZCARD', reservationsKey))
local cap = normalizeWarmingCap(hashKey)
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
${NORMALIZE_WARMING_CAP_FUNCTION_LUA}
local hashKey = KEYS[1]
local today = ARGV[1]

local startedAt = redis.call('HGET', hashKey, 'startedAt')
local phase = redis.call('HGET', hashKey, 'phase')
if not startedAt or phase == 'graduated' then return { '0', 'Infinity' } end
local reset = redis.call('HGET', hashKey, 'sentTodayReset')
local dailyCap = tostring(normalizeWarmingCap(hashKey))

if reset ~= today then
  redis.call('HSET', hashKey, 'sentToday', '0', 'sentTodayReset', today)
  return { '0', dailyCap }
end

local sentToday = redis.call('HGET', hashKey, 'sentToday') or '0'
return { sentToday, dailyCap }
`;
