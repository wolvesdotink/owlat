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
 * Expiry is the sibling concern and lives in `suppressionExpiry.ts`: the
 * due-date index, the batch sweep and the lazy compare-and-delete this file
 * calls on the two read paths. Key names are shared through
 * `suppressionKeys.ts` so neither file spells one out.
 */

import type Redis from 'ioredis';
import { normalizeEmail } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';
import { expireIfDue } from './suppressionExpiry.js';
import {
	SUPPRESSION_EXPIRY_ZSET,
	SUPPRESSION_META_PREFIX,
	SUPPRESSION_SET,
} from './suppressionKeys.js';

// The sweep's own surface is re-exported here so this module's published
// exports are byte-identical to what they were before the split and no
// importer had to change.
export {
	SUPPRESSION_SWEEP_BATCH,
	sweepExpiredSuppressions,
	type SuppressionSweepResult,
} from './suppressionExpiry.js';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/** Default TTL for soft-bounce suppressions (7 days) */
const SOFT_BOUNCE_TTL_SECONDS = 7 * 86400;

/**
 * The reasons that are evidence about a mailbox rather than a policy choice
 * about it, and therefore never expire.
 */
const PERMANENT_REASONS: ReadonlySet<SuppressionReason> = new Set(['hard_bounce', 'complaint']);

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

	// A TTL IS IGNORED FOR A PERMANENT REASON, rather than merely unused by
	// today's callers. "A hard bounce or a complaint is never in the due index"
	// is the whole safety argument for the sweep, and honouring an explicit
	// `ttlSeconds` here is the one way to put one there. Nothing passes one
	// today; this makes the claim a property of the code instead of a property
	// of the call sites.
	const ttl = PERMANENT_REASONS.has(reason)
		? undefined
		: (options?.ttlSeconds ?? SOFT_BOUNCE_TTL_SECONDS);
	if (ttl) {
		meta.expiresAt = now + ttl * 1000;
	}

	// KNOWN, DELIBERATELY UNFIXED HERE: this write is unconditional, so a later
	// weaker signal downgrades a stronger one — `POST /suppression` defaults an
	// omitted reason to `manual` (routes/suppression.ts), and a `manual` write
	// over a `hard_bounce` entry turns a permanent suppression into a 7-day one.
	// A read-before-write guard here would be the very stale-read pattern
	// `expireIfDue` exists to remove, and the atomic alternative changes what a
	// failed write does on the uncaught `suppress_recipient` effect path
	// (dispatch/effects.ts). It dissolves entirely once `manual` becomes
	// permanent, which is the follow-up that also ships the un-mirror on
	// `blockedEmails.remove` that has to land with it.

	// METADATA BEFORE MEMBERSHIP, and the due date in between. `pipeline()` is
	// not `multi()`: the commands are only batched on the wire, and another
	// client — the sweep — can be served between any two of them. With membership
	// written first, a sweep landing in the gap deletes the address off the OLD
	// metadata and the `SET` below then resurrects that metadata with no
	// membership behind it: not suppressed, plus an orphaned key. Writing the
	// metadata first inverts that: whatever the sweep reads in the gap is already
	// this write's answer, so it keeps the entry and the `SADD` is a no-op repeat.
	const pipeline = redis.pipeline();
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

	pipeline.sadd(SUPPRESSION_SET, normalized);

	// `exec()` resolves with per-command results INCLUDING per-command errors,
	// and nothing here inspects them: at `maxmemory` with `noeviction` the `SET`
	// and `SADD` above are both refused (`denyoom`) and the only trace is the
	// success line below. A Redis at the cap therefore loses hard-bounce
	// suppressions silently. Surfacing that is a follow-up, because a throw here
	// reaches `applyEffects`' uncaught `suppress_recipient` await and would fail
	// the delivery attempt that reported the bounce.
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
 * the endpoint exists so an operator can carry an accumulated suppression list
 * onto this MTA in one request, and silently expiring an imported list after a
 * week would be a far worse defect than the inconsistency. The `zrem` below
 * states it: a bulk write CLEARS any pending due date the address had.
 *
 * NOTHING IN OWLAT CALLS IT TODAY. The migration import goes through Convex's
 * `blockedEmails.addFromEvent`, whose mirror POSTs to `/suppression` one address
 * at a time, so an imported entry that maps to `manual` gets the 7-day TTL like
 * any other. Bulk permanence is a property of this endpoint, not a guarantee
 * about imports — do not describe it as one.
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

			// Metadata, then de-index, then membership — see `suppress`. It matters
			// MORE here: a 100-entry batch is ~26 KB of commands, past Redis's 16 KB
			// client read buffer, so this pipeline genuinely spans several reads and
			// other clients really are served in the middle of it.
			pipeline.set(`${SUPPRESSION_META_PREFIX}${normalized}`, JSON.stringify(meta));
			pipeline.zrem(SUPPRESSION_EXPIRY_ZSET, normalized);
			pipeline.sadd(SUPPRESSION_SET, normalized);
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
