/**
 * THE TWO QUEUE READS GROUPMQ HAS NO API FOR.
 *
 * `routes/queue.ts` goes through the `Queue` object for everything it can,
 * because a route layer that restates the queue's internal schema drifts from
 * it silently. These two reads cannot: GroupMQ offers no way to ask them, and
 * the answers it gives instead are wrong in a way an operator cannot see.
 *
 *  - WAITING JOBS FOR ONE RECIPIENT DOMAIN. `getJobsByStatus(['waiting'])`
 *    takes `SMEMBERS <ns>:groups`, keeps the FIRST 100 group ids and reads a
 *    slice of each. Filtering that in JS answers "nothing queued for that
 *    domain" for any sender with more than 100 `{ipPool}:{recipientDomain}`
 *    groups — which is every real one, and a certainty during the runaway
 *    backlog the endpoint exists for. It is a group-biased prefix, not a random
 *    sample, so polling never surfaces the missing groups either. The group key
 *    already encodes the domain, so the filter can be exact instead.
 *
 *  - WHEN A DELAYED JOB IS DUE. `Job.opts.delay` is `delayUntil - now`, and
 *    GroupMQ drops it to `undefined` the moment that is not positive — so a job
 *    stuck past its release time, the one delay worth looking at, reports "no
 *    delay set". The delay ZSET's score IS the due time and stays readable.
 *
 * Both are keyed off `QUEUE_KEY_NAMESPACE`, the single owner of the prefix, for
 * the same reason `delayedOrphans` is.
 */

import type Redis from 'ioredis';
import { QUEUE_KEY_NAMESPACE } from './namespace.js';

/** What a domain-scoped waiting scan found. */
export interface DomainWaitingScan {
	/** Job ids, oldest first across all matching groups, at most `limit`. */
	jobIds: string[];
	/**
	 * Every waiting job for the domain, across every matching group. Exact —
	 * summed from `ZCARD`, which is what GroupMQ's own `get-waiting-count.lua`
	 * does over all groups — so a caller can tell a backlog from a listing cap.
	 */
	waiting: number;
	/** Matching `{ipPool}:{domain}` groups. */
	groups: number;
}

/** Ids of the matching groups, ordered as `SMEMBERS` returned them. */
function matchingGroupIds(groupIds: string[], domain: string): string[] {
	// The key is `{ipPool}:{recipientDomain}` and `buildGroupKey` lowercases the
	// domain, so the domain is everything after the last colon.
	const suffix = `:${domain.toLowerCase()}`;
	return groupIds.filter((groupId) => groupId.toLowerCase().endsWith(suffix));
}

/** Flat `[member, score, …]` reply parsed into pairs, bad entries dropped. */
function parseScoredMembers(reply: unknown): Array<{ id: string; score: number }> {
	if (!Array.isArray(reply)) return [];
	const out: Array<{ id: string; score: number }> = [];
	for (let i = 0; i + 1 < reply.length; i += 2) {
		const score = Number(reply[i + 1]);
		if (Number.isFinite(score)) out.push({ id: String(reply[i]), score });
	}
	return out;
}

/**
 * Waiting jobs for one recipient domain, counted exactly and listed bounded.
 *
 * The count is O(matching groups) `ZCARD`s and the listing reads at most
 * `limit` ids per group, so neither scales with the backlog it describes —
 * the property a per-domain view has to keep, since it is reached for when the
 * backlog is large.
 *
 * "Waiting" here means what GroupMQ means by it: held in a group and not
 * reserved, which includes jobs still serving a retry delay.
 */
export async function scanWaitingByDomain(
	redis: Redis,
	domain: string,
	limit: number
): Promise<DomainWaitingScan> {
	const groupIds = matchingGroupIds(await redis.smembers(`${QUEUE_KEY_NAMESPACE}:groups`), domain);
	if (groupIds.length === 0) return { jobIds: [], waiting: 0, groups: 0 };

	const pipeline = redis.multi();
	for (const groupId of groupIds) {
		const groupKey = `${QUEUE_KEY_NAMESPACE}:g:${groupId}`;
		pipeline.zcard(groupKey);
		pipeline.zrange(groupKey, '0', String(limit - 1), 'WITHSCORES');
	}
	const rows = (await pipeline.exec()) ?? [];

	let waiting = 0;
	const heads: Array<{ id: string; score: number }> = [];
	for (let i = 0; i < groupIds.length; i++) {
		waiting += Number(rows[i * 2]?.[1] ?? 0);
		heads.push(...parseScoredMembers(rows[i * 2 + 1]?.[1]));
	}

	// Score is GroupMQ's FIFO ordering key, so merging on it gives the head of
	// the domain's queue rather than the head of whichever group came first.
	heads.sort((a, b) => a.score - b.score);
	return {
		jobIds: heads.slice(0, limit).map((entry) => entry.id),
		waiting,
		groups: groupIds.length,
	};
}

/**
 * When a delayed job comes due, ms since epoch, or `null` if it is not in the
 * delay set.
 */
export async function readDelayedRunAt(redis: Redis, jobId: string): Promise<number | null> {
	const score = await redis.zscore(`${QUEUE_KEY_NAMESPACE}:delayed`, jobId);
	if (score === null) return null;
	const runAt = Number(score);
	return Number.isFinite(runAt) ? runAt : null;
}
