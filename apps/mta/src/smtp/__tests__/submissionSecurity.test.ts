import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { checkAuthThrottle, recordAuthFailure, clearAuthFailures } from '../submissionSecurity.js';

describe('submissionSecurity', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('auth-failure throttle', () => {
		it('is within budget until the failure count reaches the max', async () => {
			expect(await checkAuthThrottle(redis, '1.2.3.4', 3)).toBe(true);
			await recordAuthFailure(redis, '1.2.3.4');
			await recordAuthFailure(redis, '1.2.3.4');
			expect(await checkAuthThrottle(redis, '1.2.3.4', 3)).toBe(true);
			await recordAuthFailure(redis, '1.2.3.4');
			// 3 failures == max → no longer within budget
			expect(await checkAuthThrottle(redis, '1.2.3.4', 3)).toBe(false);
		});

		it('returns the running failure count from recordAuthFailure', async () => {
			expect(await recordAuthFailure(redis, '1.2.3.4')).toBe(1);
			expect(await recordAuthFailure(redis, '1.2.3.4')).toBe(2);
		});

		it('clearAuthFailures resets the counter', async () => {
			await recordAuthFailure(redis, '1.2.3.4');
			await recordAuthFailure(redis, '1.2.3.4');
			await clearAuthFailures(redis, '1.2.3.4');
			expect(await checkAuthThrottle(redis, '1.2.3.4', 3)).toBe(true);
			expect(await redis.get('mta:submission:authfail:1.2.3.4')).toBeNull();
		});

		it('normalizes IPv4-mapped IPv6 addresses', async () => {
			await recordAuthFailure(redis, '::ffff:1.2.3.4');
			expect(await redis.get('mta:submission:authfail:1.2.3.4')).toBe('1');
		});

		it('sets a TTL so the window is rolling, not permanent', async () => {
			await recordAuthFailure(redis, '1.2.3.4');
			const ttl = await redis.ttl('mta:submission:authfail:1.2.3.4');
			expect(ttl).toBeGreaterThan(0);
		});

		it('counts and expires in the same step, so a fault records neither', async () => {
			// Counting without expiring would lock that IP out of AUTH for good.
			const broken = {
				eval: vi.fn().mockRejectedValue(new Error('redis unreachable')),
			} as unknown as RealRedis;

			await expect(recordAuthFailure(broken, '4.4.4.4')).rejects.toThrow();

			expect(await redis.exists('mta:submission:authfail:4.4.4.4')).toBe(0);
		});

		it('cannot count a failure it could not expire', async () => {
			// Split across two round trips, an INCR that landed and an EXPIRE that
			// faulted left an untimed counter — which BLOCKS AUTH, so that IP would
			// be locked out of submission permanently.
			(redis as unknown as { expire: RealRedis['expire'] }).expire = (() => {
				throw new Error('redis expire failed');
			}) as RealRedis['expire'];

			expect(await recordAuthFailure(redis, '4.4.4.4')).toBe(1);

			expect(await redis.ttl('mta:submission:authfail:4.4.4.4')).toBeGreaterThan(0);
		});
	});
});
