/**
 * Bounds on how often the MTA fetches MTA-STS policies for one recipient
 * domain. Each fetch can hold a sender for up to 10s, and the domain's owner
 * controls both the DNS id and the policy host, so the fetch path needs limits
 * the owner can't step around:
 *
 * - **Per-id backoff.** A failed fetch backs that DNS id off for 5 minutes
 *   (RFC 8461 §3.3 suggests a delay before retrying). The last
 *   {@link STS_FAILED_IDS_KEPT} failed ids are remembered per domain, so
 *   alternating between two ids doesn't reset the backoff.
 * - **Domain budget.** At most {@link STS_FETCH_BUDGET} fetch attempts per
 *   domain per window, successful or not, so ids rotated on every lookup
 *   can't make every send fetch.
 * - **Coalescing.** Concurrent lookups of the same domain and id in this
 *   process share one fetch.
 *
 * A skipped fetch yields `null` ("no fresh policy"). The caller then keeps an
 * unexpired cached policy, or applies none; a skip never extends an expired
 * policy. The limits live in Redis and are best-effort: a storage error is
 * logged and treated as "not backed off, within budget", so it can never
 * change which policy applies. Each write is one Lua script, so concurrent
 * workers can't lose each other's records and no key outlives its window.
 */

import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

// A sorted set per domain: member = DNS id, score = failure time (ms).
const FAILED_IDS_PREFIX = 'mta:sts-fetch-failures:';
const BUDGET_PREFIX = 'mta:sts-fetch-budget:';
export const STS_FETCH_FAILURE_BACKOFF_SECONDS = 300;
export const STS_FAILED_IDS_KEPT = 8;
export const STS_FETCH_BUDGET = 6;
export const STS_FETCH_BUDGET_WINDOW_SECONDS = 300;
// RFC 8461 §3.1 ids are at most 32 characters; a longer one is stored cut down.
const MAX_STORED_ID_LENGTH = 64;

// Coalescing is an optimisation; past this many distinct in-flight fetches a
// lookup just fetches on its own (the domain budget still applies).
const MAX_IN_FLIGHT = 1000;

/**
 * Drop failures older than the backoff, add this one, keep the newest
 * {@link STS_FAILED_IDS_KEPT}, and expire the set with its newest entry.
 *
 * KEYS: 1 = the domain's failure set. ARGV: 1 = now (ms), 2 = backoff (ms),
 * 3 = ids kept, 4 = backoff (s), 5 = the failed id.
 */
const RECORD_FAILURE_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
redis.call('ZADD', KEYS[1], now, ARGV[5])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[3]) + 1))
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * Count one fetch attempt. The window starts on the first attempt, and a
 * counter that somehow has no TTL gets one on the next call, so the key can
 * never persist.
 *
 * KEYS: 1 = the domain's budget counter. ARGV: 1 = window (s).
 */
const TAKE_BUDGET_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return used
`;

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `fetch` for `domain` at DNS id `id`, unless that id is backed off or the
 * domain's fetch budget is spent (then `null`). A rejection from `fetch`
 * records the failure and is passed on. Concurrent calls for the same domain
 * and id share one run. `maxInFlight` is the coalescing-map cap (a test seam).
 */
export function gatedPolicyFetch<T>(
	redis: Redis,
	domain: string,
	id: string,
	fetch: () => Promise<T>,
	maxInFlight = MAX_IN_FLIGHT
): Promise<T | null> {
	const key = `${domain}\n${id}`;
	const running = inFlight.get(key) as Promise<T | null> | undefined;
	if (running) return running;

	const run: Promise<T | null> = (async (): Promise<T | null> => {
		if (await isBackedOff(redis, domain, id)) return null;
		if (!(await takeFetchBudget(redis, domain))) {
			logger.warn({ domain }, 'MTA-STS policy fetch budget spent; not fetching');
			return null;
		}
		try {
			return await fetch();
		} catch (err) {
			await recordFailure(redis, domain, id);
			throw err;
		}
	})().finally(() => {
		// Only remove our own entry: a run started while the map was full is
		// untracked, and a later run for the same key may hold the slot now.
		if (inFlight.get(key) === run) inFlight.delete(key);
	});
	if (inFlight.size < maxInFlight) inFlight.set(key, run);
	return run;
}

function storedId(id: string): string {
	return id.slice(0, MAX_STORED_ID_LENGTH);
}

async function isBackedOff(redis: Redis, domain: string, id: string): Promise<boolean> {
	try {
		const failedAt = await redis.zscore(`${FAILED_IDS_PREFIX}${domain}`, storedId(id));
		return (
			failedAt !== null && Number(failedAt) > Date.now() - STS_FETCH_FAILURE_BACKOFF_SECONDS * 1000
		);
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch backoff unreadable; fetching anyway');
		return false;
	}
}

async function recordFailure(redis: Redis, domain: string, id: string): Promise<void> {
	try {
		await redis.eval(
			RECORD_FAILURE_SCRIPT,
			1,
			`${FAILED_IDS_PREFIX}${domain}`,
			Date.now(),
			STS_FETCH_FAILURE_BACKOFF_SECONDS * 1000,
			STS_FAILED_IDS_KEPT,
			STS_FETCH_FAILURE_BACKOFF_SECONDS,
			storedId(id)
		);
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch backoff not stored');
	}
}

async function takeFetchBudget(redis: Redis, domain: string): Promise<boolean> {
	try {
		const used = Number(
			await redis.eval(
				TAKE_BUDGET_SCRIPT,
				1,
				`${BUDGET_PREFIX}${domain}`,
				STS_FETCH_BUDGET_WINDOW_SECONDS
			)
		);
		return used <= STS_FETCH_BUDGET;
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch budget unreadable; fetching anyway');
		return true;
	}
}
