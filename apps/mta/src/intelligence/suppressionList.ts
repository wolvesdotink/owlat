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
		// Expired — hand the decision to Redis rather than acting on the read
		// above. `expireIfDue` re-reads the metadata inside one script, so a hard
		// bounce that landed while this round trip was in flight is seen and the
		// entry is kept; it reports back whether the address is still suppressed.
		return !(await expireIfDue(redis, normalized));
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
 * The decision one indexed entry gets, shared verbatim by the batch sweep and by
 * the lazy expiry check so the two can never disagree about what an entry means.
 *
 * ONE SCRIPT, because the decision and the deletion must not be separable. A
 * two-step reclaim reads the metadata and then deletes, and an address that hard
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
 * WHY THE REPAIR ARM IS `pcall`ED. `ZADD` is a `denyoom` command and this Redis
 * runs `--maxmemory ... --maxmemory-policy noeviction` (docker-compose.yml, and
 * the VPS template), so at the cap Redis refuses it. An uncaught `redis.call`
 * error aborts the WHOLE `EVAL` — the sweep would reclaim nothing, and it would
 * fail identically every hour because the offending entry stays at the head of
 * the due range. That is a total failure at precisely the moment the sweep is
 * what frees memory. Skipping the repair costs nothing durable: the metadata is
 * untouched, `isSuppressed` still honours the future `expiresAt`, and the stale
 * score is simply reconsidered on the next run. The delete arm below uses only
 * `SREM`/`DEL`/`ZREM`, none of which is `denyoom`, so the sweep keeps doing its
 * actual job at the cap.
 *
 * `#!lua flags=allow-oom` would also let the `ZADD` through, and is rejected
 * here: the shebang is Redis 7.0+ only (on anything older it is not a Lua
 * comment and the script does not compile at all — and nothing pins or checks
 * the server version behind `REDIS_URL`), it grants every `denyoom` command in
 * the script rather than the one that needs it, and it opts the script into
 * Redis 7's stricter script-flag validation, which a script that deliberately
 * touches a key outside `KEYS` has no reason to invite.
 *
 * NOT CLUSTER-SAFE, deliberately: `metaKey` is derived inside the script and is
 * therefore an undeclared key, and it does not share a hash slot with the zset
 * or the set. The MTA's Redis is standalone (one container in the compose file),
 * and the alternative — hash-tagging all three key families the way
 * `webhooks/dlq.ts` and `scaling/ipReadinessAlerts.ts` do — would rename keys
 * that already exist in every deployment. If this client ever grows a cluster
 * mode, that migration is the prerequisite.
 */
const RECLAIM_ENTRY_LUA = `
local function reclaimEntry(zkey, setkey, metaKey, email, now)
  local raw = redis.call('GET', metaKey)
  local expiresAt = nil
  if raw then expiresAt = tonumber(string.match(raw, '"expiresAt":(%d+)')) end
  if raw and not expiresAt then
    redis.call('ZREM', zkey, email)
    return 0
  end
  if expiresAt and expiresAt >= now then
    redis.pcall('ZADD', zkey, expiresAt, email)
    return 0
  end
  redis.call('SREM', setkey, email)
  redis.call('DEL', metaKey)
  redis.call('ZREM', zkey, email)
  return 1
end
`;

/**
 * Reclaim a batch of temporary suppressions whose due date has passed.
 *
 * Only temporary suppressions are ever indexed, so a hard bounce or a complaint
 * is not reachable from here at all — the safety argument is a property of the
 * data, not of a filter this code could get wrong. `ZRANGEBYSCORE ... LIMIT`
 * reads only what is actually due, so the cost is O(log N + batch) and does not
 * grow with the size of the suppression list; nothing scans the membership set.
 *
 * Returns BOTH counts, because they answer different questions and only one of
 * them tells a draining caller whether to come back. `removed` is what was
 * reclaimed; `processed` is how much of the due range was looked at, and a batch
 * that was entirely keep/repair arms reports `processed === limit` with
 * `removed === 0`. A loop that stopped on `removed` alone would quit with work
 * still due.
 */
const SWEEP_EXPIRED_LUA = `${RECLAIM_ENTRY_LUA}
local zkey = KEYS[1]
local setkey = KEYS[2]
local prefix = ARGV[1]
local now = tonumber(ARGV[2])
local due = redis.call('ZRANGEBYSCORE', zkey, '-inf', '(' .. ARGV[2], 'LIMIT', 0, tonumber(ARGV[3]))
local removed = 0
for index = 1, #due do
  local email = due[index]
  removed = removed + reclaimEntry(zkey, setkey, prefix .. email, email, now)
end
return { #due, removed }
`;

export interface SuppressionSweepResult {
	/** Due entries the sweep looked at. Equal to the limit ⇒ more may be due. */
	processed: number;
	/** Due entries it actually reclaimed. */
	removed: number;
}

export async function sweepExpiredSuppressions(
	redis: Redis,
	options?: { now?: number; limit?: number }
): Promise<SuppressionSweepResult> {
	const now = options?.now ?? Date.now();
	const limit = options?.limit ?? SUPPRESSION_SWEEP_BATCH;

	const [processed = 0, removed = 0] = (await redis.eval(
		SWEEP_EXPIRED_LUA,
		2,
		SUPPRESSION_EXPIRY_ZSET,
		SUPPRESSION_SET,
		SUPPRESSION_META_PREFIX,
		String(now),
		String(limit)
	)) as [number, number];

	if (removed > 0) {
		logger.info({ count: removed }, 'Expired suppressions swept');
	}
	return { processed, removed };
}

const EXPIRE_ONE_LUA = `${RECLAIM_ENTRY_LUA}
local email = ARGV[2]
return reclaimEntry(KEYS[1], KEYS[2], ARGV[1] .. email, email, tonumber(ARGV[3]))
`;

/**
 * Apply the sweep's decision to ONE address, for the lazy expiry path.
 *
 * The read that gets us here — `GET` the metadata, notice a past `expiresAt` —
 * is a full application round trip away from the write that acts on it, which
 * is a far wider window than anything inside a pipeline. Deleting on the
 * strength of that stale read is how a hard bounce written during the round trip
 * gets erased, leaving the address deliverable with no record that it ever
 * bounced. So the read decides only whether to ASK; Redis re-reads the metadata
 * and decides, in the same script, whether to delete.
 *
 * Returns whether the address was reclaimed. `false` means the entry was kept —
 * it was re-suppressed permanently, or its window was extended — and the caller
 * must keep treating the address as suppressed.
 */
async function expireIfDue(redis: Redis, normalizedEmail: string): Promise<boolean> {
	const removed =
		(await redis.eval(
			EXPIRE_ONE_LUA,
			2,
			SUPPRESSION_EXPIRY_ZSET,
			SUPPRESSION_SET,
			SUPPRESSION_META_PREFIX,
			normalizedEmail,
			String(Date.now())
		)) === 1;

	if (removed) {
		logger.info({ email: normalizedEmail }, 'Expired suppression reclaimed on read');
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

	// Check expiry — same compare-and-delete as `isSuppressed`, so a report can
	// no more destroy a concurrently written permanent entry than a send gate can.
	if (meta.expiresAt && Date.now() > meta.expiresAt) {
		if (await expireIfDue(redis, normalized)) return { suppressed: false };
		// Kept: something re-suppressed the address while we were deciding.
		const fresh = await getMetadata(redis, normalized);
		return fresh ? toStatus(fresh) : { suppressed: false };
	}

	return toStatus(meta);
}

function toStatus(meta: SuppressionMeta): {
	suppressed: boolean;
	reason?: SuppressionReason;
	source?: string;
	suppressedAt?: number;
	expiresAt?: number;
} {
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
