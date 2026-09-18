import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

		it('has no second round trip left to fault after the increment lands', async () => {
			// The old shape was INCR then EXPIRE. An EXPIRE that faulted left the
			// counter with no expiry, and the compensating DECR left it sitting at
			// zero rather than removing it — a permanent key for any IP that
			// happened to connect during a Redis blip.
			(redis as unknown as { expire: RealRedis['expire'] }).expire = (() => {
				throw new Error('redis expire failed');
			}) as RealRedis['expire'];

			expect(await checkConnectionRateLimit(redis, '9.9.9.9', 5)).toBe(true);

			expect(await redis.ttl('mta:submission:conn:9.9.9.9')).toBeGreaterThan(0);
		});

		it('leaves nothing behind when the counter write faults', async () => {
			// The caller fails open on error and accepts the connection WITHOUT
			// registering a slot release, so a Redis failure must not leave a dangling
			// increment that leaks a slot until the TTL. One script, so the increment
			// either lands whole or not at all.
			const broken = {
				eval: vi.fn().mockRejectedValue(new Error('redis unreachable')),
			} as unknown as RealRedis;

			await expect(checkConnectionRateLimit(broken, '9.9.9.9', 1)).rejects.toThrow();

			expect(await redis.exists('mta:submission:conn:9.9.9.9')).toBe(0);
			// A fresh connection at max=1 is still allowed.
			expect(await checkConnectionRateLimit(redis, '9.9.9.9', 1)).toBe(true);
		});

		it('nets a rejected connection back without going below the live count', async () => {
			await checkConnectionRateLimit(redis, '8.8.8.8', 1); // count -> 1 (allowed)

			expect(await checkConnectionRateLimit(redis, '8.8.8.8', 1)).toBe(false);

			// The refused connection undid its own increment inside the same script,
			// so the counter still reflects exactly the one live connection.
			expect(await redis.get('mta:submission:conn:8.8.8.8')).toBe('1');
		});

		/**
		 * Both the connection counter and the AUTH-failure counter are named after
		 * an unauthenticated peer's IP, and Redis runs `maxmemory-policy
		 * noeviction` — an untimed one is a key that never goes away on an instance
		 * that refuses writes at its cap. For the AUTH counter it is worse than
		 * bloat: an untimed one locks that IP out of submission for good.
		 */
		it('never leaves a per-IP counter without an expiry', async () => {
			await checkConnectionRateLimit(redis, '1.2.3.4', 5);
			expect(await redis.ttl('mta:submission:conn:1.2.3.4')).toBeGreaterThan(0);

			// A key that predates this — written by the old INCR/EXPIRE pair whose
			// EXPIRE faulted — is healed by the next connection, not inherited.
			await redis.set('mta:submission:conn:5.5.5.5', '3');
			expect(await redis.ttl('mta:submission:conn:5.5.5.5')).toBe(-1);

			await checkConnectionRateLimit(redis, '5.5.5.5', 10);

			expect(await redis.ttl('mta:submission:conn:5.5.5.5')).toBeGreaterThan(0);
		});

		it('removes the counter rather than leaving an untimed one behind', async () => {
			// `DECR` on a key whose window already expired RECREATES it at -1 with
			// no expiry; split from the `DEL` that follows, a fault in between left
			// that untimed key behind.
			await releaseConnection(redis, '9.9.9.9');
			expect(await redis.exists('mta:submission:conn:9.9.9.9')).toBe(0);

			await checkConnectionRateLimit(redis, '7.7.7.7', 5);
			await redis.del('mta:submission:conn:7.7.7.7');
			await releaseConnection(redis, '7.7.7.7');
			expect(await redis.exists('mta:submission:conn:7.7.7.7')).toBe(0);
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
