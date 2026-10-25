/**
 * Personal-mailbox address resolver (Redis-backed cache).
 *
 * Used by the bounce SMTP server's onRcptTo to decide whether an inbound
 * recipient maps to a per-user personal mailbox. Cache is populated by
 * Convex via the admin HTTP API (POST/DELETE /mailboxes/cache/{address}).
 *
 * Cache miss -> not a personal mailbox; fall through to existing routing.
 *
 * This Redis-only design mirrors the inbound router pattern (router.ts) and
 * avoids any Convex round-trip in the hot SMTP onRcptTo path.
 */

import type Redis from 'ioredis';
import { isRecord } from '@owlat/shared/utils/guards';
import { logger } from '../monitoring/logger.js';

const CACHE_PREFIX = 'mta:mailbox:';
const CACHE_INDEX = 'mta:mailbox-addresses';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface MailboxCacheEntry {
	mailboxId: string;
	organizationId: string;
	quotaBytes?: number;
	usedBytes: number;
	cachedAt: number;
}

function cacheKey(address: string): string {
	return `${CACHE_PREFIX}${address.toLowerCase()}`;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/**
 * A stored cache entry, or `null` when it is corrupt. A corrupt entry routes
 * nothing and is never rewritten: a non-numeric `usedBytes` must not become a
 * `NaN` quota check or be written back as one. Fields this build does not
 * know stay on the entry, so the usedBytes refresh keeps them.
 */
function decodeCacheEntry(data: string): MailboxCacheEntry | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const { mailboxId, organizationId, quotaBytes, usedBytes, cachedAt } = parsed;
	if (!isId(mailboxId) || !isId(organizationId)) return null;
	if (!isCount(usedBytes) || !isCount(cachedAt)) return null;
	if (quotaBytes !== undefined && !isCount(quotaBytes)) return null;
	return {
		...parsed,
		mailboxId,
		organizationId,
		...(quotaBytes === undefined ? {} : { quotaBytes }),
		usedBytes,
		cachedAt,
	};
}

/**
 * Look up a recipient address in the personal-mailbox cache.
 * Returns null if no mailbox is registered for that address.
 */
export async function findMailboxRoute(
	redis: Redis,
	address: string
): Promise<MailboxCacheEntry | null> {
	const data = await redis.get(cacheKey(address));
	if (!data) return null;
	const entry = decodeCacheEntry(data);
	if (!entry) logger.warn({ address }, 'Ignoring a corrupt mailbox cache entry');
	return entry;
}

/**
 * Insert or refresh a mailbox cache entry. Called from the admin HTTP API
 * when Convex pushes mailbox CRUD events.
 */
export async function setMailboxCache(
	redis: Redis,
	address: string,
	entry: Omit<MailboxCacheEntry, 'cachedAt'>
): Promise<void> {
	const lowered = address.toLowerCase();
	const value: MailboxCacheEntry = { ...entry, cachedAt: Date.now() };
	await redis.setex(cacheKey(lowered), CACHE_TTL_SECONDS, JSON.stringify(value));
	await redis.sadd(CACHE_INDEX, lowered);
	logger.info({ address: lowered, mailboxId: entry.mailboxId }, 'Mailbox cache populated');
}

export async function deleteMailboxCache(redis: Redis, address: string): Promise<boolean> {
	const lowered = address.toLowerCase();
	const removed = await redis.del(cacheKey(lowered));
	await redis.srem(CACHE_INDEX, lowered);
	return removed > 0;
}

/** List all cached addresses (admin/debug). */
export async function listMailboxCache(redis: Redis): Promise<string[]> {
	return redis.smembers(CACHE_INDEX);
}

/** Refresh usedBytes counter without losing other fields. Best-effort. */
export async function bumpUsedBytes(
	redis: Redis,
	address: string,
	deltaBytes: number
): Promise<void> {
	const data = await redis.get(cacheKey(address));
	if (!data) return;
	const entry = decodeCacheEntry(data);
	if (!entry) {
		logger.warn({ address }, 'Not bumping usedBytes on a corrupt mailbox cache entry');
		return;
	}
	entry.usedBytes = Math.max(0, entry.usedBytes + deltaBytes);
	try {
		await redis.setex(cacheKey(address), CACHE_TTL_SECONDS, JSON.stringify(entry));
	} catch (err) {
		logger.warn({ err, address }, 'Failed to bump usedBytes in mailbox cache');
	}
}
