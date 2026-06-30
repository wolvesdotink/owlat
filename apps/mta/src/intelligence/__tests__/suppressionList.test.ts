import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	isSuppressed,
	suppress,
	unsuppress,
	getSuppressionStatus,
	suppressBulk,
} from '../suppressionList.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('suppressionList', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await redis.flushall();
	});

	describe('suppress + isSuppressed', () => {
		it('returns true for suppressed email', async () => {
			await suppress(redis, 'bad@example.com', 'hard_bounce');
			const result = await isSuppressed(redis, 'bad@example.com');
			expect(result).toBe(true);
		});

		it('returns false for unknown email', async () => {
			const result = await isSuppressed(redis, 'unknown@example.com');
			expect(result).toBe(false);
		});

		it('normalizes email case', async () => {
			await suppress(redis, 'BAD@EXAMPLE.COM', 'hard_bounce');
			const result = await isSuppressed(redis, 'bad@example.com');
			expect(result).toBe(true);
		});
	});

	describe('suppress TTL behavior', () => {
		it('hard_bounce has no expiry', async () => {
			await suppress(redis, 'hard@example.com', 'hard_bounce');
			const status = await getSuppressionStatus(redis, 'hard@example.com');
			expect(status.suppressed).toBe(true);
			expect(status.expiresAt).toBeUndefined();
		});

		it('manual suppression gets 7-day TTL expiry', async () => {
			await suppress(redis, 'manual@example.com', 'manual');
			const status = await getSuppressionStatus(redis, 'manual@example.com');
			expect(status.suppressed).toBe(true);
			expect(status.expiresAt).toBeDefined();
			// 7 days in ms from now
			const sevenDaysMs = 7 * 86400 * 1000;
			expect(status.expiresAt).toBe(Date.now() + sevenDaysMs);
		});

		it('auto-removes expired entries on isSuppressed check', async () => {
			// Suppress with a very short TTL (1 second) so it's already expired by the time we check
			await suppress(redis, 'temp@example.com', 'manual', { ttlSeconds: 1 });

			// Set system time 2 seconds past the TTL expiry, without advancing timers
			// We need the metadata key to still be in Redis (not expired by ioredis-mock)
			// but Date.now() to be past expiresAt
			// Since ioredis-mock may check TTL at read time, directly re-insert metadata with past expiresAt
			const metaKey = 'mta:suppressed-meta:temp@example.com';
			const meta = JSON.parse((await redis.get(metaKey))!);
			meta.expiresAt = Date.now() - 1000; // Already expired
			await redis.set(metaKey, JSON.stringify(meta));

			const result = await isSuppressed(redis, 'temp@example.com');
			expect(result).toBe(false);
		});
	});

	describe('unsuppress', () => {
		it('removes and returns true', async () => {
			await suppress(redis, 'remove@example.com', 'hard_bounce');
			const result = await unsuppress(redis, 'remove@example.com');
			expect(result).toBe(true);

			const suppressed = await isSuppressed(redis, 'remove@example.com');
			expect(suppressed).toBe(false);
		});

		it('returns false for non-suppressed email', async () => {
			const result = await unsuppress(redis, 'nonexistent@example.com');
			expect(result).toBe(false);
		});
	});

	describe('getSuppressionStatus', () => {
		it('returns full metadata', async () => {
			await suppress(redis, 'meta@example.com', 'complaint', { source: 'feedback-loop' });

			const status = await getSuppressionStatus(redis, 'meta@example.com');
			expect(status.suppressed).toBe(true);
			expect(status.reason).toBe('complaint');
			expect(status.source).toBe('feedback-loop');
			expect(status.suppressedAt).toBe(Date.now());
			// complaint = permanent, no expiry
			expect(status.expiresAt).toBeUndefined();
		});

		it('auto-cleans expired entries', async () => {
			await suppress(redis, 'expire@example.com', 'manual', { ttlSeconds: 1 });

			// Re-insert metadata with past expiresAt (to avoid ioredis-mock TTL race)
			const metaKey = 'mta:suppressed-meta:expire@example.com';
			const meta = JSON.parse((await redis.get(metaKey))!);
			meta.expiresAt = Date.now() - 1000; // Already expired
			await redis.set(metaKey, JSON.stringify(meta));

			const status = await getSuppressionStatus(redis, 'expire@example.com');
			expect(status.suppressed).toBe(false);
		});
	});

	describe('suppressBulk', () => {
		it('processes multiple entries and returns count', async () => {
			const entries = [
				{ email: 'a@example.com', reason: 'hard_bounce' as const },
				{ email: 'b@example.com', reason: 'complaint' as const },
				{ email: 'c@example.com', reason: 'manual' as const, source: 'admin' },
			];

			const result = await suppressBulk(redis, entries);
			expect(result.suppressed).toBe(3);

			// Verify all are suppressed
			expect(await isSuppressed(redis, 'a@example.com')).toBe(true);
			expect(await isSuppressed(redis, 'b@example.com')).toBe(true);
			expect(await isSuppressed(redis, 'c@example.com')).toBe(true);
		});
	});
});
