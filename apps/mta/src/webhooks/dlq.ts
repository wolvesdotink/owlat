/**
 * Webhook Dead Letter Queue
 *
 * Stores failed webhook events in Redis for later retry or inspection.
 * Prevents permanent event loss when the Convex backend is unreachable.
 */

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { MtaWebhookEvent } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

const DLQ_SORTED_SET = 'mta:dlq';
const DLQ_ENTRY_PREFIX = 'mta:dlq:entry:';
const DLQ_CLAIM_PREFIX = 'mta:dlq:claim:';
const DLQ_CLAIM_VERSION_PREFIX = 'mta:dlq:claim-version:';

declare const webhookHttpStatusBrand: unique symbol;

/** Valid HTTP response status observed while delivering a webhook. */
export type WebhookHttpStatus = number & {
	readonly [webhookHttpStatusBrand]: true;
};

/**
 * A deliberately closed, non-sensitive description of why delivery failed.
 * Provider response bodies and exception messages must never enter the DLQ.
 */
export type WebhookDeliveryFailure =
	| { category: 'transport' }
	| { category: 'deadline_exhausted' }
	| { category: 'unknown' }
	| { category: 'legacy' }
	| { category: 'http'; status: WebhookHttpStatus };

export interface DlqEntry {
	dlqId: string;
	event: MtaWebhookEvent;
	failure: WebhookDeliveryFailure;
	attempts: number;
	createdAt: number;
	lastRetryAt?: number;
	claim?: {
		owner: string;
		version: number;
		expiresAt: number;
	};
}

export interface ClaimedDlqEntry extends DlqEntry {
	claim: NonNullable<DlqEntry['claim']>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWebhookHttpStatus(value: unknown): value is WebhookHttpStatus {
	return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/** Convert an untrusted response status to a safe delivery-failure category. */
export function classifyWebhookHttpFailure(status: number): WebhookDeliveryFailure {
	return isWebhookHttpStatus(status) ? { category: 'http', status } : { category: 'unknown' };
}

function parseDeliveryFailure(value: unknown): WebhookDeliveryFailure | null {
	if (!isRecord(value) || typeof value['category'] !== 'string') return null;

	switch (value['category']) {
		case 'transport':
		case 'deadline_exhausted':
		case 'unknown':
		case 'legacy':
			return { category: value['category'] };
		case 'http':
			return isWebhookHttpStatus(value['status'])
				? { category: 'http', status: value['status'] }
				: null;
		default:
			return null;
	}
}

function parseDlqEntry(data: string): DlqEntry | null {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}

	if (
		!isRecord(value) ||
		typeof value['dlqId'] !== 'string' ||
		!isRecord(value['event']) ||
		typeof value['event']['event'] !== 'string' ||
		typeof value['event']['timestamp'] !== 'number' ||
		typeof value['attempts'] !== 'number' ||
		typeof value['createdAt'] !== 'number' ||
		(value['lastRetryAt'] !== undefined && typeof value['lastRetryAt'] !== 'number')
	) {
		return null;
	}

	// Entries written before the typed failure model carried a free-form
	// `error`. Preserve their retryability without returning that sensitive text.
	const failure =
		parseDeliveryFailure(value['failure']) ??
		(typeof value['error'] === 'string' ? { category: 'legacy' as const } : null);
	if (!failure) return null;

	const claim = isRecord(value['claim'])
		? value['claim']['owner'] &&
			typeof value['claim']['owner'] === 'string' &&
			typeof value['claim']['version'] === 'number' &&
			Number.isInteger(value['claim']['version']) &&
			typeof value['claim']['expiresAt'] === 'number'
			? {
					owner: value['claim']['owner'],
					version: value['claim']['version'],
					expiresAt: value['claim']['expiresAt'],
				}
			: null
		: null;
	if (value['claim'] !== undefined && !claim) return null;

	return {
		dlqId: value['dlqId'],
		event: value['event'] as unknown as MtaWebhookEvent,
		failure,
		attempts: value['attempts'],
		createdAt: value['createdAt'],
		...(value['lastRetryAt'] === undefined ? {} : { lastRetryAt: value['lastRetryAt'] }),
		...(claim ? { claim } : {}),
	};
}

const SETTLE_CLAIM_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

const CLEAR_SETTLED_CLAIM_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export const WEBHOOK_DLQ_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Atomically claim one entry. Manual retries may bypass due/exhaustion policy. */
export async function claimOne(
	redis: Redis,
	dlqId: string,
	options: {
		owner: string;
		now: number;
		leaseMs?: number;
		requireDue: boolean;
		enforceAutoLimit: boolean;
		autoRetryLimit: number;
	}
): Promise<ClaimedDlqEntry | null> {
	const entry = await getEntry(redis, dlqId);
	if (!entry) return null;
	if (options.enforceAutoLimit && entry.attempts >= options.autoRetryLimit) return null;
	if (options.requireDue) {
		const dueAt =
			(entry.lastRetryAt ?? entry.createdAt) +
			Math.min(60_000 * 2 ** Math.max(0, entry.attempts), 60 * 60 * 1000);
		if (dueAt > options.now) return null;
	}

	const version = await redis.incr(`${DLQ_CLAIM_VERSION_PREFIX}${dlqId}`);
	const leaseMs = options.leaseMs ?? WEBHOOK_DLQ_CLAIM_LEASE_MS;
	const claim = { owner: options.owner, version, expiresAt: options.now + leaseMs };
	const claimValue = JSON.stringify(claim);
	const acquired = await redis.set(`${DLQ_CLAIM_PREFIX}${dlqId}`, claimValue, 'PX', leaseMs, 'NX');
	if (acquired !== 'OK') return null;

	// A concurrent administrative discard can remove the row between the
	// eligibility read and SET NX. Release that orphan claim with a token CAS.
	if (!(await redis.exists(`${DLQ_ENTRY_PREFIX}${dlqId}`))) {
		await redis.eval(
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
			1,
			`${DLQ_CLAIM_PREFIX}${dlqId}`,
			claimValue
		);
		return null;
	}
	return { ...entry, claim };
}

/**
 * Walk oldest pages until a bounded number of *eligible* rows are claimed.
 * Exhausted rows stay visible in the original ZSET but never block newer work.
 */
export async function claimEligible(
	redis: Redis,
	options: {
		owner: string;
		now: number;
		limit: number;
		autoRetryLimit: number;
		leaseMs?: number;
		pageSize?: number;
	}
): Promise<ClaimedDlqEntry[]> {
	const claimed: ClaimedDlqEntry[] = [];
	const pageSize = Math.max(1, options.pageSize ?? 100);
	const total = await redis.zcard(DLQ_SORTED_SET);
	for (let offset = 0; offset < total && claimed.length < options.limit; offset += pageSize) {
		const ids = await redis.zrange(DLQ_SORTED_SET, offset, offset + pageSize - 1);
		for (const dlqId of ids) {
			const entry = await claimOne(redis, dlqId, {
				owner: options.owner,
				now: options.now,
				leaseMs: options.leaseMs,
				requireDue: true,
				enforceAutoLimit: true,
				autoRetryLimit: options.autoRetryLimit,
			});
			if (entry) claimed.push(entry);
			if (claimed.length >= options.limit) break;
		}
		if (ids.length < pageSize) break;
	}
	return claimed;
}

/** CAS completion: a stale owner can neither delete nor resurrect the row. */
export async function settleClaim(
	redis: Redis,
	entry: ClaimedDlqEntry,
	outcome: 'success' | 'failure',
	now: number
): Promise<boolean> {
	const claimKey = `${DLQ_CLAIM_PREFIX}${entry.dlqId}`;
	const claimValue = JSON.stringify(entry.claim);
	const settlingValue = `settling:${claimValue}`;
	const began = (await redis.eval(
		SETTLE_CLAIM_LUA,
		1,
		claimKey,
		claimValue,
		settlingValue,
		String(WEBHOOK_DLQ_CLAIM_LEASE_MS)
	)) as number;
	if (began !== 1) return false;

	if (outcome === 'success') {
		// The token CAS above is the ownership boundary. These independent
		// idempotent commands intentionally avoid a Redis Cluster CROSSSLOT script.
		await redis.del(`${DLQ_ENTRY_PREFIX}${entry.dlqId}`);
		await redis.zrem(DLQ_SORTED_SET, entry.dlqId);
	} else {
		await redis.set(
			`${DLQ_ENTRY_PREFIX}${entry.dlqId}`,
			JSON.stringify({
				...entry,
				claim: undefined,
				attempts: entry.attempts + 1,
				lastRetryAt: now,
			})
		);
	}
	await redis.eval(CLEAR_SETTLED_CLAIM_LUA, 1, claimKey, settlingValue);
	return true;
}

/**
 * Store a failed webhook event in the DLQ
 */
export async function storeFailed(
	redis: Redis,
	event: MtaWebhookEvent,
	failure: WebhookDeliveryFailure,
	config: MtaConfig
): Promise<string> {
	const dlqId = randomUUID();
	const entry: DlqEntry = {
		dlqId,
		event,
		failure,
		attempts: 0,
		createdAt: Date.now(),
	};

	const pipeline = redis.pipeline();

	// Store full entry data
	pipeline.set(`${DLQ_ENTRY_PREFIX}${dlqId}`, JSON.stringify(entry));

	// Add to sorted set (score = timestamp for ordering)
	pipeline.zadd(DLQ_SORTED_SET, String(entry.createdAt), dlqId);

	// Trim to max size (remove oldest entries)
	pipeline.zremrangebyrank(DLQ_SORTED_SET, 0, -(config.webhookDlqMaxSize + 1));

	await pipeline.exec();

	logger.warn(
		{ operation: 'convex_webhook_dlq', category: 'stored', eventType: event.event },
		'Webhook event stored in DLQ'
	);

	return dlqId;
}

/**
 * List failed events from the DLQ (newest first)
 */
export async function listFailed(
	redis: Redis,
	limit: number = 50,
	offset: number = 0
): Promise<{ entries: DlqEntry[]; total: number }> {
	const total = await redis.zcard(DLQ_SORTED_SET);
	const dlqIds = await redis.zrevrange(DLQ_SORTED_SET, offset, offset + limit - 1);

	const entries: DlqEntry[] = [];
	for (const dlqId of dlqIds) {
		const data = await redis.get(`${DLQ_ENTRY_PREFIX}${dlqId}`);
		if (data) {
			const entry = parseDlqEntry(data);
			if (entry) entries.push(entry);
		}
	}

	return { entries, total };
}

/** Oldest bounded page used by the automatic recovery sweeper. */
export async function listOldest(redis: Redis, limit: number): Promise<DlqEntry[]> {
	const dlqIds = await redis.zrange(DLQ_SORTED_SET, 0, Math.max(0, limit - 1));
	const entries: DlqEntry[] = [];
	for (const dlqId of dlqIds) {
		const data = await redis.get(`${DLQ_ENTRY_PREFIX}${dlqId}`);
		if (!data) continue;
		const entry = parseDlqEntry(data);
		if (entry) entries.push(entry);
	}
	return entries;
}

/**
 * Get a specific DLQ entry
 */
export async function getEntry(redis: Redis, dlqId: string): Promise<DlqEntry | null> {
	const data = await redis.get(`${DLQ_ENTRY_PREFIX}${dlqId}`);
	if (!data) return null;
	return parseDlqEntry(data);
}

/**
 * Remove a specific entry from the DLQ (after successful retry or manual discard)
 */
export async function removeOne(redis: Redis, dlqId: string): Promise<boolean> {
	const pipeline = redis.pipeline();
	pipeline.del(`${DLQ_ENTRY_PREFIX}${dlqId}`);
	pipeline.zrem(DLQ_SORTED_SET, dlqId);
	pipeline.del(`${DLQ_CLAIM_PREFIX}${dlqId}`);
	const results = await pipeline.exec();

	const deleted = results?.[0]?.[1] as number;
	return deleted > 0;
}

/**
 * Update a DLQ entry (e.g., after a retry attempt)
 */
export async function updateEntry(redis: Redis, entry: DlqEntry): Promise<void> {
	await redis.set(`${DLQ_ENTRY_PREFIX}${entry.dlqId}`, JSON.stringify(entry));
}

/**
 * Get DLQ statistics
 */
export async function getStats(redis: Redis): Promise<{
	total: number;
	oldestTimestamp: number | null;
	newestTimestamp: number | null;
}> {
	const total = await redis.zcard(DLQ_SORTED_SET);
	if (total === 0) {
		return { total: 0, oldestTimestamp: null, newestTimestamp: null };
	}

	const oldest = await redis.zrange(DLQ_SORTED_SET, 0, 0, 'WITHSCORES');
	const newest = await redis.zrevrange(DLQ_SORTED_SET, 0, 0, 'WITHSCORES');

	return {
		total,
		oldestTimestamp: oldest[1] ? parseInt(oldest[1], 10) : null,
		newestTimestamp: newest[1] ? parseInt(newest[1], 10) : null,
	};
}

/**
 * Get all DLQ entry IDs for retry-all operations
 */
export async function getAllIds(redis: Redis): Promise<string[]> {
	return redis.zrange(DLQ_SORTED_SET, 0, -1);
}
