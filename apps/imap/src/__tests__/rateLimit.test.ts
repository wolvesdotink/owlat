import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { AuthRateLimiter } from '../rateLimit.js';

vi.mock('../logger.js', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

/**
 * ioredis-mock, not a hand-rolled stub: `recordFailure` is one Lua script and
 * the properties under test here are Redis semantics — sorted-set cardinality,
 * key TTLs and the exact shape of the key space. A double that answers those
 * from a Map would be testing the double.
 */
function newRedis(): Redis {
	return new RedisMock() as unknown as Redis;
}

const cfg = { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 };

function authKeyFor(ip: string, address: string): string {
	return `imap:lim:{${ip}}:auth:${createHash('sha256').update(address.toLowerCase()).digest('hex')}`;
}

describe('AuthRateLimiter', () => {
	let redis: Redis;
	let limiter: AuthRateLimiter;

	beforeEach(async () => {
		redis = newRedis();
		// ioredis-mock shares one keyspace across instances.
		await redis.flushall();
		limiter = new AuthRateLimiter(redis, cfg);
	});

	it('does not throttle the first request', async () => {
		const result = await limiter.check('1.2.3.4', 'alice@example.com');
		expect(result.throttled).toBe(false);
		expect(result.authCount).toBe(0);
	});

	it('throttles after the configured number of failures from same ip+address', async () => {
		for (let i = 0; i < cfg.failuresPerWindow; i++) {
			await limiter.recordFailure('1.2.3.4', 'alice@example.com');
		}
		const result = await limiter.check('1.2.3.4', 'alice@example.com');
		expect(result.throttled).toBe(true);
		expect(result.tarpitMs).toBe(cfg.tarpitMs);
	});

	it('isolates buckets across distinct addresses for the same IP at the per-credential level', async () => {
		for (let i = 0; i < cfg.failuresPerWindow; i++) {
			await limiter.recordFailure('1.2.3.4', 'alice@example.com');
		}
		// bob@... has its own auth bucket; it isn't over its own 5-fail credential cap
		const bobAuth = await limiter.check('1.2.3.4', 'bob@example.com');
		expect(bobAuth.authCount).toBe(0);
		// But the per-IP bucket has 5 entries — well under the 50/min global IP cap.
		expect(bobAuth.ipCount).toBe(cfg.failuresPerWindow);
		expect(bobAuth.throttled).toBe(false);
	});

	it('lowercases the address so case differences share the same bucket', async () => {
		for (let i = 0; i < cfg.failuresPerWindow; i++) {
			await limiter.recordFailure('1.2.3.4', 'Alice@Example.com');
		}
		const result = await limiter.check('1.2.3.4', 'ALICE@EXAMPLE.COM');
		expect(result.throttled).toBe(true);
	});

	it('fails open when redis throws', async () => {
		const broken = {
			pipeline: () => {
				throw new Error('redis unreachable');
			},
			eval: vi.fn().mockRejectedValue(new Error('redis unreachable')),
		} as unknown as Redis;
		const failing = new AuthRateLimiter(broken, cfg);
		const result = await failing.check('1.2.3.4', 'alice@example.com');
		expect(result.throttled).toBe(false);
		// recordFailure also swallows errors
		await expect(failing.recordFailure('1.2.3.4', 'alice@example.com')).resolves.toBeUndefined();
	});

	it('fails open when no redis client is configured', async () => {
		const noRedis = new AuthRateLimiter(null, cfg);
		const result = await noRedis.check('1.2.3.4', 'alice@example.com');
		expect(result.throttled).toBe(false);
		await noRedis.recordFailure('1.2.3.4', 'alice@example.com');
		// No throw is enough.
	});

	it('trips the global per-IP cap independent of per-credential count', async () => {
		// 50 distinct addresses from one IP, one failure each
		for (let i = 0; i < 50; i++) {
			await limiter.recordFailure('1.2.3.4', `target${i}@example.com`);
		}
		// 51st new address — auth bucket is fresh (0), but IP cap (50) trips
		const result = await limiter.check('1.2.3.4', 'fresh@example.com');
		expect(result.ipCount).toBeGreaterThanOrEqual(50);
		expect(result.throttled).toBe(true);
	});

	describe('key-space bounds against an unauthenticated peer', () => {
		it('keeps the key size constant however long the claimed address is', async () => {
			// A pre-auth LOGIN line may be up to maxLineBytes (64 KiB), and the
			// address used to go into the key verbatim.
			const huge = `${'a'.repeat(60_000)}@example.com`;
			await limiter.recordFailure('1.2.3.4', huge);

			const keys = await redis.keys('imap:lim:*');
			expect(keys).toHaveLength(2);
			for (const key of keys) {
				expect(key.length).toBeLessThan(200);
			}
			expect(keys).toContain(authKeyFor('1.2.3.4', huge));
		});

		it('stops minting new credential keys once the IP is past its global budget', async () => {
			for (let i = 0; i < 400; i++) {
				await limiter.recordFailure('9.9.9.9', `target${i}@example.com`);
			}

			// One per-IP counter plus at most one credential key per allowed
			// failure — not one per address the peer chose to name.
			const authKeys = await redis.keys('imap:lim:{9.9.9.9}:auth:*');
			expect(authKeys.length).toBeLessThanOrEqual(50);
			expect(await redis.zcard('imap:lim:{9.9.9.9}:ip')).toBe(400);
		});

		it('still records against a credential bucket that already exists', async () => {
			// Push the IP far past its budget on other addresses first...
			for (let i = 0; i < 80; i++) {
				await limiter.recordFailure('9.9.9.9', `target${i}@example.com`);
			}
			// ...then keep failing against one of the buckets that did get minted.
			const victim = 'target0@example.com';
			const before = await redis.zcard(authKeyFor('9.9.9.9', victim));
			await limiter.recordFailure('9.9.9.9', victim);
			expect(await redis.zcard(authKeyFor('9.9.9.9', victim))).toBe(before + 1);
		});

		it('expires both counters so an idle attacker leaves nothing behind', async () => {
			await limiter.recordFailure('1.2.3.4', 'alice@example.com');
			const expectedTtl = Math.ceil(cfg.windowMs / 1000) + 60;
			for (const key of await redis.keys('imap:lim:*')) {
				const ttl = await redis.ttl(key);
				expect(ttl).toBeGreaterThan(0);
				expect(ttl).toBeLessThanOrEqual(expectedTtl);
			}
		});
	});
});
