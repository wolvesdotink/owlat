import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	checkConnectionRateLimit,
	releaseConnection,
	checkAuthThrottle,
	recordAuthFailure,
	clearAuthFailures,
} from '../submissionSecurity.js';

describe('submissionSecurity', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('checkConnectionRateLimit / releaseConnection', () => {
		it('allows up to the per-IP max then rejects', async () => {
			for (let i = 0; i < 3; i++) {
				expect(await checkConnectionRateLimit(redis, '1.2.3.4', 3)).toBe(true);
			}
			expect(await checkConnectionRateLimit(redis, '1.2.3.4', 3)).toBe(false);
		});

		it('frees a slot on release', async () => {
			for (let i = 0; i < 3; i++) {
				await checkConnectionRateLimit(redis, '1.2.3.4', 3);
			}
			await releaseConnection(redis, '1.2.3.4');
			expect(await checkConnectionRateLimit(redis, '1.2.3.4', 3)).toBe(true);
		});

		it('tracks IPs independently', async () => {
			for (let i = 0; i < 3; i++) {
				await checkConnectionRateLimit(redis, '1.2.3.4', 3);
			}
			expect(await checkConnectionRateLimit(redis, '5.6.7.8', 3)).toBe(true);
		});

		it('undoes its increment when a post-incr step throws (no leaked slot)', async () => {
			// The caller fails open on error and accepts the connection WITHOUT
			// registering a slot release, so a partial Redis failure after the incr
			// must not leave a dangling increment that leaks a slot until the TTL.
			const realExpire = redis.expire.bind(redis);
			let boom = true;
			// Fail the first-increment `expire` exactly once (the partial-failure race).
			(redis as unknown as { expire: RealRedis['expire'] }).expire = (async (...args) => {
				if (boom) {
					boom = false;
					throw new Error('redis expire failed');
				}
				return realExpire(...(args as Parameters<RealRedis['expire']>));
			}) as RealRedis['expire'];

			await expect(checkConnectionRateLimit(redis, '9.9.9.9', 1)).rejects.toThrow();

			// The increment was compensated: a fresh connection at max=1 is still
			// allowed. Without the fix the counter would already sit at 1 and this
			// would reject.
			expect(await checkConnectionRateLimit(redis, '9.9.9.9', 1)).toBe(true);
		});

		it('does not collide with the bounce server connection counter', async () => {
			// Bounce uses mta:bounce:conn: — submission must use its own prefix.
			await checkConnectionRateLimit(redis, '1.2.3.4', 1);
			expect(await redis.get('mta:submission:conn:1.2.3.4')).toBe('1');
			expect(await redis.get('mta:bounce:conn:1.2.3.4')).toBeNull();
		});
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
	});
});
