import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthRateLimiter } from '../rateLimit.js';

vi.mock('../logger.js', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

interface ZsetEntry {
	score: number;
	member: string;
}

/**
 * Hand-rolled in-memory ioredis stub: just the surface our limiter
 * actually uses (pipeline → zadd/expire/zremrangebyscore/zcard → exec).
 */
class FakeRedis {
	private store = new Map<string, ZsetEntry[]>();
	public throwOnExec = false;

	pipeline() {
		const ops: Array<() => unknown> = [];
		const pipeline = {
			zadd: (key: string, score: number, member: string) => {
				ops.push(() => {
					const list = this.store.get(key) ?? [];
					list.push({ score, member });
					this.store.set(key, list);
					return 1;
				});
				return pipeline;
			},
			expire: (_key: string, _ttl: number) => {
				ops.push(() => 1);
				return pipeline;
			},
			zremrangebyscore: (key: string, min: number, max: number) => {
				ops.push(() => {
					const list = this.store.get(key) ?? [];
					const filtered = list.filter((e) => e.score < min || e.score > max);
					this.store.set(key, filtered);
					return list.length - filtered.length;
				});
				return pipeline;
			},
			zcard: (key: string) => {
				ops.push(() => (this.store.get(key) ?? []).length);
				return pipeline;
			},
			exec: async () => {
				if (this.throwOnExec) throw new Error('redis unreachable');
				return ops.map((op) => [null, op()] as [Error | null, unknown]);
			},
		};
		return pipeline;
	}
}

describe('AuthRateLimiter', () => {
	const cfg = { failuresPerWindow: 5, windowMs: 60_000, tarpitMs: 900_000 };

	let redis: FakeRedis;
	let limiter: AuthRateLimiter;

	beforeEach(() => {
		redis = new FakeRedis();
		limiter = new AuthRateLimiter(redis as never, cfg);
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
		redis.throwOnExec = true;
		const result = await limiter.check('1.2.3.4', 'alice@example.com');
		expect(result.throttled).toBe(false);
		// recordFailure also swallows errors
		await expect(
			limiter.recordFailure('1.2.3.4', 'alice@example.com')
		).resolves.toBeUndefined();
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
});
