/**
 * Which sending domains currently have mail held for a missing DKIM signature.
 *
 * A send that requires a signature and cannot get one is deferred, not sent
 * (see `dispatch/phases/dkimSignature.ts`). Deferral alone is silent: the queue
 * grows and nothing tells the operator why. Every hold is therefore recorded per
 * domain here, read by `/health` into the snapshot Convex polls, and cleared by
 * the next send for that domain that does get signed.
 *
 * One hash, field per domain. The value keeps the cause of the latest hold and
 * the time the domain was first held, so a poll that finds the same hold reports
 * the same bytes and Convex can skip the write (`mtaHealthFreshness.ts`).
 */

import type Redis from 'ioredis';
import { DKIM_UNAVAILABLE_CAUSES, type DkimUnavailableCause } from './dkim.js';
import { hasDkimKey } from './dkimStore.js';
import { dkimSignatureWithheldTotal } from '../monitoring/collector.js';
import { logger } from '../monitoring/logger.js';

const HOLD_KEY = 'mta:dkim:signing-held';

/**
 * A hold with no new occurrence for this long is no longer reported: the
 * messages behind it either signed on retry (which clears the field) or
 * expired. Longer than the hold's own retry delay, so a held queue keeps
 * refreshing it.
 */
export const DKIM_HOLD_REPORT_WINDOW_MS = 30 * 60_000;

/** The retry delay for a held message: long enough to restore a key, short enough to notice. */
export const DKIM_HOLD_RETRY_DELAY_MS = 5 * 60_000;

/** The most domains one health answer names. */
const MAX_REPORTED_DOMAINS = 20;

export interface DkimSigningHold {
	domain: string;
	cause: DkimUnavailableCause;
	/** First hold of the current streak, epoch ms. */
	since: number;
}

interface StoredHold {
	cause: DkimUnavailableCause;
	since: number;
	lastAt: number;
}

const CAUSES: ReadonlySet<string> = new Set(DKIM_UNAVAILABLE_CAUSES);

function parseHold(raw: string | null | undefined): StoredHold | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const { cause, since, lastAt } = value as Record<string, unknown>;
	if (
		typeof cause !== 'string' ||
		!CAUSES.has(cause) ||
		typeof since !== 'number' ||
		typeof lastAt !== 'number'
	) {
		return null;
	}
	return { cause: cause as DkimUnavailableCause, since, lastAt };
}

/** Count one held send and keep the domain's hold current. Never throws. */
export async function recordDkimSigningHold(
	redis: Redis,
	domain: string,
	cause: DkimUnavailableCause,
	now = Date.now()
): Promise<void> {
	dkimSignatureWithheldTotal.inc({ cause });
	logger.warn(
		{ domain, cause },
		'DKIM signature required but unavailable — deferring instead of sending unsigned'
	);
	try {
		const previous = parseHold(await redis.hget(HOLD_KEY, domain));
		const current = previous && now - previous.lastAt < DKIM_HOLD_REPORT_WINDOW_MS;
		const next: StoredHold = { cause, since: current ? previous.since : now, lastAt: now };
		await redis.hset(HOLD_KEY, domain, JSON.stringify(next));
	} catch (err) {
		logger.warn({ err, domain }, 'Could not record the DKIM signing hold');
	}
}

/** A signed send for the domain ends its hold. Never throws. */
export async function clearDkimSigningHold(redis: Redis, domain: string): Promise<void> {
	try {
		await redis.hdel(HOLD_KEY, domain);
	} catch (err) {
		logger.warn({ err, domain }, 'Could not clear the DKIM signing hold');
	}
}

/**
 * The holds seen within the report window, oldest first.
 *
 * A `no_key` hold is reported only while the key is still missing. Convex
 * regenerates a verified domain that reports it, so a hold outliving the key's
 * return (a regeneration that already minted one, a restored Redis) would undo
 * the recovery on the next poll, before any held message has retried.
 */
export async function readDkimSigningHolds(
	redis: Redis,
	now = Date.now()
): Promise<DkimSigningHold[]> {
	const all = await redis.hgetall(HOLD_KEY);
	const holds: DkimSigningHold[] = [];
	for (const [domain, raw] of Object.entries(all ?? {})) {
		const hold = parseHold(raw);
		if (!hold || now - hold.lastAt >= DKIM_HOLD_REPORT_WINDOW_MS) continue;
		if (hold.cause === 'no_key' && (await hasDkimKey(redis, domain))) continue;
		holds.push({ domain, cause: hold.cause, since: hold.since });
	}
	holds.sort((a, b) => a.since - b.since || a.domain.localeCompare(b.domain));
	return holds.slice(0, MAX_REPORTED_DOMAINS);
}
