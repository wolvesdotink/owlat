/**
 * Lua for the per-(IP x mailbox provider) warming dimension.
 *
 * Kept beside the shipped `warmingScripts.ts` rather than inside it: the per-IP
 * scripts are the authoritative accounting path and are deliberately left
 * byte-identical by this change. Every script here is atomic, touches only keys
 * inside the `{warming:<ip>}` hash slot, and sets a TTL on every key it
 * creates — no per-provider key may grow unbounded.
 *
 * KEY ARITY IS FIXED PER SCRIPT. Each write path exists twice — a plain form
 * and an `_IDEMPOTENT_` form that additionally takes a receipt key — because a
 * variable `numkeys` that relies on `KEYS[n]` being nil is not a contract Redis
 * Cluster (or a reader) should have to reason about.
 */

/** Provider state survives a quiet month, then expires with the IP's traffic. */
export const PROVIDER_STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * Daily stats mirror the shipped 48h per-IP stats horizon. The bulk-pool
 * pacing counter is a per-day denominator written by the same script and rides
 * the same horizon.
 */
export const PROVIDER_DAILY_STATS_TTL_SECONDS = 48 * 60 * 60;

/**
 * The body shared by both send-recording forms.
 *
 * KEYS[1] provider state hash, KEYS[2] provider daily stats hash, KEYS[3]
 * bulk-pool daily counter. ARGV[1] the ATTEMPT's UTC day, ARGV[2] codec version,
 * ARGV[3] state TTL seconds, ARGV[4] stats TTL seconds, ARGV[5] '1' when this
 * send belongs to the bulk pool, ARGV[6] bulk counter TTL seconds.
 *
 * The two dimensions this writes are NOT symmetric under a stale day. The stats
 * hash and the bulk counter are per-day KEYS, so a late effect simply credits
 * its own day. `sentToday`/`sentTodayReset` is ONE rolling slot on the state
 * hash, so it is monotonic here: only a strictly newer day may roll it, and only
 * the day it currently holds may increment it.
 */
const RECORD_PROVIDER_WARMING_SEND_BODY_LUA = `
local stateKey = KEYS[1]
local statsKey = KEYS[2]
local bulkKey = KEYS[3]
local today = ARGV[1]
local storedDay = redis.call('HGET', stateKey, 'sentTodayReset')
-- YYYY-MM-DD compares lexicographically. Rewinding the stamp would zero the
-- LIVE day's counter and hand the IP its whole per-provider allowance again —
-- and a journal entry lives four days, so a crash replay would do exactly that.
if not storedDay or today > storedDay then
  redis.call('HSET', stateKey, 'sentToday', '0', 'sentTodayReset', today)
  storedDay = today
end
redis.call('HSET', stateKey, 'codecVersion', ARGV[2])
-- A stale-day send is still credited to its own day's stats hash below; only the
-- live day's rolling counter is off-limits to it.
if today == storedDay then
  redis.call('HINCRBY', stateKey, 'sentToday', 1)
end
redis.call('EXPIRE', stateKey, ARGV[3])
redis.call('HINCRBY', statsKey, 'sent', 1)
redis.call('EXPIRE', statsKey, ARGV[4])
if ARGV[5] == '1' then
  redis.call('INCR', bulkKey)
  redis.call('EXPIRE', bulkKey, ARGV[6])
end
`;

/** Count one delivered send against the provider (and bulk-pacing) dimensions. */
export const RECORD_PROVIDER_WARMING_SEND_LUA = `
${RECORD_PROVIDER_WARMING_SEND_BODY_LUA}
return 1
`;

/**
 * As above, guarded by a durable-effect receipt.
 *
 * KEYS[4] receipt key. ARGV[7] receipt TTL ms.
 */
export const RECORD_PROVIDER_WARMING_SEND_IDEMPOTENT_LUA = `
if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
redis.call('SET', KEYS[4], 'recorded', 'PX', ARGV[7])
${RECORD_PROVIDER_WARMING_SEND_BODY_LUA}
return 1
`;

/**
 * The body shared by both outcome-recording forms.
 *
 * KEYS[1] provider daily stats hash. ARGV[1] field name, ARGV[2] stats TTL
 * seconds.
 */
const RECORD_PROVIDER_WARMING_OUTCOME_BODY_LUA = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
`;

/** Count one non-delivery outcome against the provider dimension. */
export const RECORD_PROVIDER_WARMING_OUTCOME_LUA = `
${RECORD_PROVIDER_WARMING_OUTCOME_BODY_LUA}
return 1
`;

/** As above, receipt-guarded. KEYS[2] receipt key, ARGV[3] receipt TTL ms. */
export const RECORD_PROVIDER_WARMING_OUTCOME_IDEMPOTENT_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], 'recorded', 'PX', ARGV[3])
${RECORD_PROVIDER_WARMING_OUTCOME_BODY_LUA}
return 1
`;

/**
 * The body shared by both pressure-recording forms.
 *
 * KEYS[1] short-lived pressure counter, KEYS[2] provider daily stats hash.
 * ARGV[1] pressure TTL seconds, ARGV[2] stats TTL seconds. Leaves the new
 * counter value in `pressure`.
 */
const RECORD_PROVIDER_PRESSURE_BODY_LUA = `
local pressure = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], 'pressure', 1)
redis.call('EXPIRE', KEYS[2], ARGV[2])
`;

/**
 * Record one volume-pressure verdict and return the recent pressure count that
 * lengthens retry backoff.
 */
export const RECORD_PROVIDER_PRESSURE_LUA = `
${RECORD_PROVIDER_PRESSURE_BODY_LUA}
return pressure
`;

/**
 * As above, receipt-guarded. A replay returns the CURRENT counter and
 * increments nothing.
 *
 * KEYS[3] receipt key. ARGV[3] receipt TTL ms.
 */
export const RECORD_PROVIDER_PRESSURE_IDEMPOTENT_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  return tonumber(redis.call('GET', KEYS[1]) or '0')
end
redis.call('SET', KEYS[3], 'recorded', 'PX', ARGV[3])
${RECORD_PROVIDER_PRESSURE_BODY_LUA}
return pressure
`;

/**
 * Persist a re-evaluated cap multiplier and its clean streak.
 *
 * KEYS[1] provider state hash. ARGV[1] multiplier, ARGV[2] evaluated UTC date,
 * ARGV[3] codec version, ARGV[4] state TTL seconds, ARGV[5] clean streak.
 */
export const WRITE_PROVIDER_CAP_MULTIPLIER_LUA = `
local stateKey = KEYS[1]
redis.call('HSET', stateKey, 'capMultiplier', ARGV[1], 'lastEvaluatedDate', ARGV[2], 'codecVersion', ARGV[3], 'cleanStreak', ARGV[5])
redis.call('EXPIRE', stateKey, ARGV[4])
return 1
`;
