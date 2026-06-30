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
	});
});
