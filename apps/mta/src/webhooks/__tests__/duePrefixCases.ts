import type Redis from 'ioredis';
import { expect } from 'vitest';
import {
	claimOne,
	listEligibleIds,
	listFailed,
	WEBHOOK_DLQ_CREATED_KEY,
	WEBHOOK_DLQ_DUE_KEY,
	WEBHOOK_DLQ_ENTRIES_KEY,
} from '../dlq.js';

/**
 * The due-prefix regressions, for any sweep page: a run of rows at the head of
 * the due index that the sweep has to skip, one row longer than the page it
 * reads, must not hide the work queued behind it. listEligibleIds has no size
 * of its own: it reads `max(limit, scanLimit)` rows, both chosen by the caller,
 * and the sweeper asks for a batch `limit` below a larger `scanLimit`. The
 * ioredis-mock suite runs these at a small page, where its interpreted Lua
 * stays cheap; the real-Redis suite runs them at the sweeper's page, with Lua
 * argument lists of that size.
 */

const TRANSPORT_FAILURE = { category: 'transport' } as const;

/** What one sweep pass asks listEligibleIds for. */
export interface ScanPage {
	limit: number;
	scanLimit: number;
}

function entry(id: string, attempts: number, createdAt: number): string {
	return JSON.stringify({
		dlqId: id,
		event: {
			event: 'bounced',
			messageId: id,
			organizationId: 'org-1',
			bounceType: 'hard',
			message: 'Mailbox not found',
			timestamp: 1_700_000_000_000,
		},
		failure: TRANSPORT_FAILURE,
		attempts,
		createdAt,
	});
}

/** Exhausted rows left in the due index by an older release are dropped from it, not deleted. */
export async function exhaustedDuePrefixDrains(redis: Redis, page: ScanPage): Promise<void> {
	const prefix = page.scanLimit + 1;
	const pipeline = redis.pipeline();
	for (let index = 0; index < prefix; index++) {
		const id = `exhausted-${index}`;
		pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, entry(id, 8, index));
		pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${id}`, '8');
		pipeline.zadd(WEBHOOK_DLQ_CREATED_KEY, index, id);
		pipeline.zadd(WEBHOOK_DLQ_DUE_KEY, index + 60_000, id);
	}
	// Due after every exhausted row, so only a sweep that gets past them sees it.
	const queued = 'routing-reentry-due';
	pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, queued, entry(queued, 0, prefix));
	pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${queued}`, '0');
	pipeline.zadd(WEBHOOK_DLQ_CREATED_KEY, prefix, queued);
	pipeline.zadd(WEBHOOK_DLQ_DUE_KEY, prefix + 60_000, queued);
	await pipeline.exec();

	const pass = { ...page, now: 1_000_000, autoRetryLimit: 8 };
	expect(await listEligibleIds(redis, pass)).toEqual([]);
	expect(await listEligibleIds(redis, pass)).toContain(queued);
	expect(
		await claimOne(redis, queued, {
			owner: 'sweeper-second-pass',
			now: 1_000_000,
			requireDue: true,
			enforceAutoLimit: true,
			autoRetryLimit: 8,
		})
	).not.toBeNull();
	expect(
		(await listFailed(redis, prefix + 1)).entries.filter((row) => row.attempts === 8)
	).toHaveLength(prefix);
}

/** A corrupt prefix is quarantined in one atomic step, and the valid row behind it is returned at once. */
export async function corruptDuePrefixIsQuarantined(redis: Redis, page: ScanPage): Promise<void> {
	const prefix = page.scanLimit + 1;
	const pipeline = redis.pipeline();
	for (let index = 0; index < prefix; index++) {
		const id = `corrupt-${String(index).padStart(String(prefix).length, '0')}`;
		pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, id, '{malformed');
		pipeline.zadd(WEBHOOK_DLQ_CREATED_KEY, index, id);
		pipeline.zadd(WEBHOOK_DLQ_DUE_KEY, index, id);
	}
	const valid = 'valid-after-corrupt';
	pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, valid, entry(valid, 0, 2 * prefix));
	pipeline.hset(WEBHOOK_DLQ_ENTRIES_KEY, `attempts:${valid}`, '0');
	pipeline.zadd(WEBHOOK_DLQ_CREATED_KEY, 2 * prefix, valid);
	pipeline.zadd(WEBHOOK_DLQ_DUE_KEY, 2 * prefix, valid);
	await pipeline.exec();

	// One page holds the whole prefix and the valid row behind it.
	const ids = await listEligibleIds(redis, {
		now: 4 * prefix,
		limit: page.limit,
		scanLimit: 2 * page.scanLimit,
	});
	expect(ids).toEqual([valid]);
	expect(await redis.zcard(WEBHOOK_DLQ_DUE_KEY)).toBe(1);
	expect(await redis.zcard(WEBHOOK_DLQ_CREATED_KEY)).toBe(1);
}
