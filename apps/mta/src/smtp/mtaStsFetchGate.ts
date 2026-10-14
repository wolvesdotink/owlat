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
 * change which policy applies.
 */

import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

const FAILED_IDS_PREFIX = 'mta:sts-fetch-failed:';
const BUDGET_PREFIX = 'mta:sts-fetch-budget:';
export const STS_FETCH_FAILURE_BACKOFF_SECONDS = 300;
export const STS_FAILED_IDS_KEPT = 8;
export const STS_FETCH_BUDGET = 6;
export const STS_FETCH_BUDGET_WINDOW_SECONDS = 300;
// RFC 8461 §3.1 ids are at most 32 characters; a longer one is stored cut down.
const MAX_STORED_ID_LENGTH = 64;

interface FailedFetch {
	id: string;
	at: number;
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `fetch` for `domain` at DNS id `id`, unless that id is backed off or the
 * domain's fetch budget is spent (then `null`). A rejection from `fetch`
 * records the failure and is passed on. Concurrent calls for the same domain
 * and id share one run.
 */
export function gatedPolicyFetch<T>(
	redis: Redis,
	domain: string,
	id: string,
	fetch: () => Promise<T>
): Promise<T | null> {
	const key = `${domain}\n${id}`;
	const running = inFlight.get(key) as Promise<T | null> | undefined;
	if (running) return running;

	const run = (async (): Promise<T | null> => {
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
	})().finally(() => inFlight.delete(key));
	inFlight.set(key, run);
	return run;
}

function storedId(id: string): string {
	return id.slice(0, MAX_STORED_ID_LENGTH);
}

async function readFailures(redis: Redis, domain: string): Promise<FailedFetch[]> {
	const raw = await redis.get(`${FAILED_IDS_PREFIX}${domain}`);
	if (!raw) return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) return [];
	const cutoff = Date.now() - STS_FETCH_FAILURE_BACKOFF_SECONDS * 1000;
	return parsed.filter(
		(entry): entry is FailedFetch =>
			typeof entry?.id === 'string' && Number.isFinite(entry?.at) && entry.at > cutoff
	);
}

async function isBackedOff(redis: Redis, domain: string, id: string): Promise<boolean> {
	try {
		const wanted = storedId(id);
		return (await readFailures(redis, domain)).some((entry) => entry.id === wanted);
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch backoff unreadable; fetching anyway');
		return false;
	}
}

async function recordFailure(redis: Redis, domain: string, id: string): Promise<void> {
	try {
		const wanted = storedId(id);
		const kept = (await readFailures(redis, domain)).filter((entry) => entry.id !== wanted);
		kept.push({ id: wanted, at: Date.now() });
		await redis.set(
			`${FAILED_IDS_PREFIX}${domain}`,
			JSON.stringify(kept.slice(-STS_FAILED_IDS_KEPT)),
			'EX',
			STS_FETCH_FAILURE_BACKOFF_SECONDS
		);
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch backoff not stored');
	}
}

async function takeFetchBudget(redis: Redis, domain: string): Promise<boolean> {
	const key = `${BUDGET_PREFIX}${domain}`;
	try {
		const used = await redis.incr(key);
		// Set the window on the first attempt; re-arm one that lost its TTL
		// (an EXPIRE that failed after INCR) so the budget can't lock forever.
		if (used === 1 || (used > STS_FETCH_BUDGET && (await redis.ttl(key)) < 0)) {
			await redis.expire(key, STS_FETCH_BUDGET_WINDOW_SECONDS);
		}
		return used <= STS_FETCH_BUDGET;
	} catch (err) {
		logger.warn({ domain, err }, 'MTA-STS fetch budget unreadable; fetching anyway');
		return true;
	}
}
