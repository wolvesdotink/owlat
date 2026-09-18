import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	checkConnectionRateLimit,
	releaseConnection,
	getConnectionCount,
} from '../inboundSecurity.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('inboundSecurity', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
	});

	describe('checkConnectionRateLimit', () => {
		it('allows connections under the limit', async () => {
			const allowed = await checkConnectionRateLimit(redis, '1.2.3.4', 10);
			expect(allowed).toBe(true);
		});

		it('allows up to max connections', async () => {
			for (let i = 0; i < 5; i++) {
				const allowed = await checkConnectionRateLimit(redis, '1.2.3.4', 5);
				expect(allowed).toBe(true);
			}
		});

		it('rejects connections over the limit', async () => {
			// Fill up to limit
			for (let i = 0; i < 5; i++) {
				await checkConnectionRateLimit(redis, '1.2.3.4', 5);
			}

			// Next should be rejected
			const allowed = await checkConnectionRateLimit(redis, '1.2.3.4', 5);
			expect(allowed).toBe(false);
		});

		it('tracks per-IP independently', async () => {
			for (let i = 0; i < 5; i++) {
				await checkConnectionRateLimit(redis, '1.2.3.4', 5);
			}

			// Different IP should still be allowed
			const allowed = await checkConnectionRateLimit(redis, '5.6.7.8', 5);
			expect(allowed).toBe(true);
		});

		it('handles IPv4-mapped IPv6 addresses', async () => {
			await checkConnectionRateLimit(redis, '::ffff:1.2.3.4', 10);
			const count = await getConnectionCount(redis, '1.2.3.4');
			expect(count).toBe(1);
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

			expect(await redis.ttl('mta:bounce:conn:9.9.9.9')).toBeGreaterThan(0);
		});

		it('leaves nothing behind when the counter write faults', async () => {
			// onConnect fails open on a Redis error and accepts the connection without
			// registering a slot release, so a failure here must not leave a dangling
			// increment leaking a slot until the TTL.
			const broken = {
				eval: vi.fn().mockRejectedValue(new Error('redis unreachable')),
			} as unknown as RealRedis;

			await expect(checkConnectionRateLimit(broken, '9.9.9.9', 1)).rejects.toThrow();

			expect(await getConnectionCount(redis, '9.9.9.9')).toBe(0);
			// A fresh connection at max=1 is still allowed.
			expect(await checkConnectionRateLimit(redis, '9.9.9.9', 1)).toBe(true);
		});

		it('nets a rejected connection back without going below the live count', async () => {
			await checkConnectionRateLimit(redis, '8.8.8.8', 1); // count -> 1 (allowed)

			expect(await checkConnectionRateLimit(redis, '8.8.8.8', 1)).toBe(false);

			// The refused connection undid its own increment inside the same script,
			// so the counter still reflects exactly the one live connection.
			expect(await getConnectionCount(redis, '8.8.8.8')).toBe(1);
		});

		/**
		 * The bug this guards: the counter is named after an unauthenticated peer's
		 * IP, and Redis runs `maxmemory-policy noeviction`, so an untimed one is a
		 * key that never goes away on an instance that refuses writes at its cap.
		 */
		it('never leaves the per-IP counter without an expiry', async () => {
			await checkConnectionRateLimit(redis, '1.2.3.4', 5);
			expect(await redis.ttl('mta:bounce:conn:1.2.3.4')).toBeGreaterThan(0);

			// A key that predates this — written by the old INCR/EXPIRE pair whose
			// EXPIRE faulted — is healed by the next connection, not inherited.
			await redis.set('mta:bounce:conn:5.5.5.5', '3');
			expect(await redis.ttl('mta:bounce:conn:5.5.5.5')).toBe(-1);

			await checkConnectionRateLimit(redis, '5.5.5.5', 10);

			expect(await redis.ttl('mta:bounce:conn:5.5.5.5')).toBeGreaterThan(0);
		});
	});

	describe('releaseConnection', () => {
		it('decrements the connection counter', async () => {
			await checkConnectionRateLimit(redis, '1.2.3.4', 10);
			await checkConnectionRateLimit(redis, '1.2.3.4', 10);

			let count = await getConnectionCount(redis, '1.2.3.4');
			expect(count).toBe(2);

			await releaseConnection(redis, '1.2.3.4');
			count = await getConnectionCount(redis, '1.2.3.4');
			expect(count).toBe(1);
		});

		it('cleans up key when counter reaches zero', async () => {
			await checkConnectionRateLimit(redis, '1.2.3.4', 10);
			await releaseConnection(redis, '1.2.3.4');

			const count = await getConnectionCount(redis, '1.2.3.4');
			expect(count).toBe(0);
		});

		it('handles releasing non-existent connections', async () => {
			// Should not throw
			await releaseConnection(redis, '9.9.9.9');
			const count = await getConnectionCount(redis, '9.9.9.9');
			expect(count).toBe(0);
		});

		/**
		 * `DECR` on a key whose window already expired RECREATES it at -1 with no
		 * expiry. Split from the `DEL` that follows, a fault in between left that
		 * untimed key behind — and `createSlotTracker` swallows release failures,
		 * so nothing would have reported it.
		 */
		it('removes the counter rather than leaving an untimed one behind', async () => {
			await releaseConnection(redis, '9.9.9.9');
			expect(await redis.exists('mta:bounce:conn:9.9.9.9')).toBe(0);

			// The same, for a slot released after its own window expired.
			await checkConnectionRateLimit(redis, '7.7.7.7', 5);
			await redis.del('mta:bounce:conn:7.7.7.7');
			await releaseConnection(redis, '7.7.7.7');
			expect(await redis.exists('mta:bounce:conn:7.7.7.7')).toBe(0);
		});
	});
});
