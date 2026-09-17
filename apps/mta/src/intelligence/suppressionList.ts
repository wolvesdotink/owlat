/**
 * MTA-Level Suppression List
 *
 * Defense-in-depth check before sending to known-bad addresses.
 * Auto-populated on hard bounces and complaints.
 *
 * Uses dual storage:
 * - Redis Set for O(1) lookup (mta:suppressed)
 * - Redis Hash per entry for metadata (mta:suppressed-meta:{email})
 *
 * WHY EXPIRY NEEDS ITS OWN INDEX. Membership lives in a SET, and Redis has no
 * per-member TTL for a set — only whole keys expire. The shipped code expressed
 * a temporary suppression by writing `expiresAt` into the metadata and putting
 * the SAME ttl on the metadata KEY, so the two died at the same instant: by the
 * time `Date.now() > meta.expiresAt` could be true, `getMetadata` already
 * returned null, the expiry branch could not fire, and `isSuppressed` fell
 * through to "member, no metadata ⇒ suppressed". A 7-day soft-bounce
 * suppression was therefore PERMANENT, and it left a set member behind that
 * nothing could ever attribute to an expired entry — one more address on a
 * list that only ever grows, on a Redis that refuses writes at `--maxmemory`.
 *
 * So the metadata key no longer expires (it is the evidence the expiry check
 * reads), and the due date is indexed separately in a sorted set scored by
 * `expiresAt`. That index is what makes expiry both LAZY-correct (a read past
 * the date removes the entry) and COMPLETE (`sweepExpiredSuppressions` reclaims
 * the entries nobody reads again) — without ever scanning the membership set,
 * and without a permanent suppression appearing in it at all.
 */

import type Redis from 'ioredis';
import { normalizeEmail } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';

const SUPPRESSION_SET = 'mta:suppressed';
const SUPPRESSION_META_PREFIX = 'mta:suppressed-meta:';
/**
 * Due-date index for TEMPORARY suppressions only: member = normalized address,
 * score = `expiresAt` in epoch ms. A permanent suppression (hard bounce,
 * complaint) is never a member, which is what keeps the sweep below incapable
 * of dropping one.
 */
const SUPPRESSION_EXPIRY_ZSET = 'mta:suppressed-expiring';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/** Default TTL for soft-bounce suppressions (7 days) */
const SOFT_BOUNCE_TTL_SECONDS = 7 * 86400;

export interface SuppressionMeta {
	reason: SuppressionReason;
	source?: string;
	suppressedAt: number;
	expiresAt?: number;
}

/**
 * Check if an email address is on the suppression list
 */
export async function isSuppressed(redis: Redis, email: string): Promise<boolean> {
	const normalized = normalizeEmail(email);
	const isMember = (await redis.sismember(SUPPRESSION_SET, normalized)) === 1;
	if (!isMember) return false;

	// Check if metadata has an expiry
	const meta = await getMetadata(redis, normalized);
	if (meta?.expiresAt && Date.now() > meta.expiresAt) {
		// Expired — auto-remove
		await unsuppress(redis, email);
		return false;
	}

	return true;
}

/**
 * Add an email address to the suppression list
 */
export async function suppress(
	redis: Redis,
	email: string,
	reason: SuppressionReason,
	options?: { source?: string; ttlSeconds?: number }
): Promise<void> {
	const normalized = normalizeEmail(email);
	const now = Date.now();

	const meta: SuppressionMeta = {
		reason,
		source: options?.source,
		suppressedAt: now,
	};

	// Set TTL for soft bounces by default
	const ttl =
		options?.ttlSeconds ??
		(reason === 'hard_bounce' || reason === 'complaint' ? undefined : SOFT_BOUNCE_TTL_SECONDS);
	if (ttl) {
		meta.expiresAt = now + ttl * 1000;
	}

	const pipeline = redis.pipeline();
	pipeline.sadd(SUPPRESSION_SET, normalized);
	pipeline.set(`${SUPPRESSION_META_PREFIX}${normalized}`, JSON.stringify(meta));

	// Index (or de-index) the due date. The `zrem` arm is the load-bearing one:
	// an address that soft-bounced last week and hard-bounces today is rewritten
	// here as permanent, and leaving its old due date in the index would let the
	// sweep delete a hard-bounce suppression seven days later.
	if (meta.expiresAt) {
		pipeline.zadd(SUPPRESSION_EXPIRY_ZSET, meta.expiresAt, normalized);
	} else {
		pipeline.zrem(SUPPRESSION_EXPIRY_ZSET, normalized);
	}

	await pipeline.exec();
	logger.info(
		{ email: normalized, reason, source: options?.source },
		'Address added to suppression list'
	);
}

/**
 * Remove an email address from the suppression list
 */
export async function unsuppress(redis: Redis, email: string): Promise<boolean> {
	const normalized = normalizeEmail(email);
	const pipeline = redis.pipeline();
	pipeline.srem(SUPPRESSION_SET, normalized);
	pipeline.del(`${SUPPRESSION_META_PREFIX}${normalized}`);
	pipeline.zrem(SUPPRESSION_EXPIRY_ZSET, normalized);
	const results = await pipeline.exec();

	const removed = (results?.[0]?.[1] as number) > 0;
	if (removed) {
		logger.info({ email: normalized }, 'Address removed from suppression list');
	}
	return removed;
}

/**
 * Largest number of expired entries one {@link sweepExpiredSuppressions} call
 * will reclaim. The sweep runs on the leader's hourly timer beside the other
 * maintenance crons, so it must return promptly rather than walk an arbitrarily
 * long backlog while the delivery workers share the same Redis.
 */
export const SUPPRESSION_SWEEP_BATCH = 500;

/**
 * Reclaim a batch of temporary suppressions whose due date has passed.
 *
 * ONE SCRIPT, because the decision and the deletion must not be separable. A
 * two-step sweep reads the due list and then deletes, and an address that hard
 * bounces between those two steps is rewritten as permanent and then deleted
 * anyway. Redis runs this start to finish with nothing interleaved, so a
 * re-suppression is either already visible to the metadata read below — and the
 * entry is kept — or has not happened yet, and it will re-add the address.
 *
 * The metadata is what each decision turns on, and the branches are the things
 * it can say:
 *   - no `expiresAt` — re-suppressed permanently since it was indexed, so drop
 *     the stale due date and KEEP the suppression;
 *   - an `expiresAt` in the future — re-suppressed with a longer window by a
 *     write whose index update did not land, so repair the score instead;
 *   - anything else — expired; remove the address entirely. Missing metadata
 *     belongs here too: membership of the due index is itself the evidence that
 *     this address was suppressed temporarily, and the score is the evidence
 *     that its window has closed.
 *
 * Only temporary suppressions are ever indexed, so a hard bounce or a complaint
 * is not reachable from here at all — the safety argument is a property of the
 * data, not of a filter this code could get wrong. `ZRANGEBYSCORE ... LIMIT`
 * reads only what is actually due, so the cost is O(log N + batch) and does not
 * grow with the size of the suppression list; nothing scans the membership set.
 *
 * Returns how many addresses were removed; a caller that gets its full `limit`
 * back knows more may be due and can call again.
 */
const SWEEP_EXPIRED_LUA = `
local zkey = KEYS[1]
local setkey = KEYS[2]
local prefix = ARGV[1]
local now = tonumber(ARGV[2])
local due = redis.call('ZRANGEBYSCORE', zkey, '-inf', '(' .. ARGV[2], 'LIMIT', 0, tonumber(ARGV[3]))
local removed = 0
for index = 1, #due do
  local email = due[index]
  local metaKey = prefix .. email
  local raw = redis.call('GET', metaKey)
  local expiresAt = nil
  if raw then expiresAt = tonumber(string.match(raw, '"expiresAt":(%d+)')) end
  if raw and not expiresAt then
    redis.call('ZREM', zkey, email)
  elseif expiresAt and expiresAt >= now then
    redis.call('ZADD', zkey, expiresAt, email)
  else
    redis.call('SREM', setkey, email)
    redis.call('DEL', metaKey)
    redis.call('ZREM', zkey, email)
    removed = removed + 1
  end
end
return removed
`;

export async function sweepExpiredSuppressions(
	redis: Redis,
	options?: { now?: number; limit?: number }
): Promise<number> {
	const now = options?.now ?? Date.now();
	const limit = options?.limit ?? SUPPRESSION_SWEEP_BATCH;

	const removed = (await redis.eval(
		SWEEP_EXPIRED_LUA,
		2,
		SUPPRESSION_EXPIRY_ZSET,
		SUPPRESSION_SET,
		SUPPRESSION_META_PREFIX,
		String(now),
		String(limit)
	)) as number;

	if (removed > 0) {
		logger.info({ count: removed }, 'Expired suppressions swept');
	}
	return removed;
}

/**
 * Check suppression status with full metadata
 */
export async function getSuppressionStatus(
	redis: Redis,
	email: string
): Promise<{
	suppressed: boolean;
	reason?: SuppressionReason;
	source?: string;
	suppressedAt?: number;
	expiresAt?: number;
}> {
	const normalized = normalizeEmail(email);
	const isMember = await redis.sismember(SUPPRESSION_SET, normalized);
	if (isMember === 0) return { suppressed: false };

	const meta = await getMetadata(redis, normalized);
	if (!meta) return { suppressed: true };

	// Check expiry
	if (meta.expiresAt && Date.now() > meta.expiresAt) {
		await unsuppress(redis, email);
		return { suppressed: false };
	}

	return {
		suppressed: true,
		reason: meta.reason,
		source: meta.source,
		suppressedAt: meta.suppressedAt,
		expiresAt: meta.expiresAt,
	};
}

/**
 * Bulk suppress multiple addresses.
 *
 * Every entry is written PERMANENTLY, including `manual` ones — unlike the
 * single-address {@link suppress}, which gives `manual` a 7-day TTL. That
 * asymmetry is the shipped behaviour of `POST /suppression/bulk` and is kept:
 * the bulk endpoint is how an operator carries an accumulated suppression list
 * onto this MTA, and silently expiring an imported list after a week would be a
 * far worse defect than the inconsistency. The `zrem` below states it: a bulk
 * write CLEARS any pending due date the address had.
 */
export async function suppressBulk(
	redis: Redis,
	entries: Array<{ email: string; reason: SuppressionReason; source?: string }>
): Promise<{ suppressed: number }> {
	let count = 0;

	// Process in batches of 100 for pipeline efficiency
	for (let i = 0; i < entries.length; i += 100) {
		const batch = entries.slice(i, i + 100);
		const pipeline = redis.pipeline();

		for (const entry of batch) {
			const normalized = normalizeEmail(entry.email);
			const meta: SuppressionMeta = {
				reason: entry.reason,
				source: entry.source,
				suppressedAt: Date.now(),
			};

			pipeline.sadd(SUPPRESSION_SET, normalized);
			pipeline.set(`${SUPPRESSION_META_PREFIX}${normalized}`, JSON.stringify(meta));
			pipeline.zrem(SUPPRESSION_EXPIRY_ZSET, normalized);
		}

		await pipeline.exec();
		count += batch.length;
	}

	logger.info({ count }, 'Bulk suppression completed');
	return { suppressed: count };
}

/**
 * Export suppression list with metadata (paginated via SSCAN)
 */
export async function exportSuppressionList(
	redis: Redis,
	options?: { reason?: SuppressionReason; cursor?: string; limit?: number }
): Promise<{
	entries: Array<{ email: string } & SuppressionMeta>;
	nextCursor?: string;
}> {
	const limit = options?.limit ?? 100;
	const entries: Array<{ email: string } & SuppressionMeta> = [];
	let cursor = options?.cursor ?? '0';

	// We need to scan more than `limit` since we may filter by reason
	const scanCount = Math.max(limit * 3, 300);

	const [nextCursor, members] = await redis.sscan(SUPPRESSION_SET, cursor, 'COUNT', scanCount);

	for (const email of members) {
		if (entries.length >= limit) break;

		const meta = await getMetadata(redis, email);
		if (!meta) continue;

		// Filter by reason if specified
		if (options?.reason && meta.reason !== options.reason) continue;

		entries.push({ email, ...meta });
	}

	return {
		entries,
		nextCursor: nextCursor !== '0' ? nextCursor : undefined,
	};
}

/**
 * Get suppression statistics (counts by reason)
 */
export async function getSuppressionStats(redis: Redis): Promise<{
	total: number;
	byReason: Record<string, number>;
}> {
	const total = await redis.scard(SUPPRESSION_SET);

	// Sample to estimate distribution (full scan would be expensive)
	const byReason: Record<string, number> = {
		hard_bounce: 0,
		complaint: 0,
		manual: 0,
		unknown: 0,
	};

	// Scan a sample of up to 1000 entries
	let cursor = '0';
	let sampled = 0;

	do {
		const [nextCursor, members] = await redis.sscan(SUPPRESSION_SET, cursor, 'COUNT', 200);
		cursor = nextCursor;

		for (const email of members) {
			if (sampled >= 1000) break;
			const meta = await getMetadata(redis, email);
			if (meta?.reason) {
				byReason[meta.reason] = (byReason[meta.reason] ?? 0) + 1;
			} else {
				byReason['unknown'] = (byReason['unknown'] ?? 0) + 1;
			}
			sampled++;
		}
	} while (cursor !== '0' && sampled < 1000);

	// If we sampled less than total, scale up estimates
	if (sampled > 0 && sampled < total) {
		const scale = total / sampled;
		for (const key of Object.keys(byReason)) {
			byReason[key] = Math.round(byReason[key]! * scale);
		}
	}

	return { total, byReason };
}

/**
 * Get metadata for a suppressed email
 */
async function getMetadata(redis: Redis, normalizedEmail: string): Promise<SuppressionMeta | null> {
	const data = await redis.get(`${SUPPRESSION_META_PREFIX}${normalizedEmail}`);
	if (!data) return null;

	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}
