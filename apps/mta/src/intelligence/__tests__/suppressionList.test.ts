import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import {
	isSuppressed,
	suppress,
	unsuppress,
	getSuppressionStatus,
	suppressBulk,
	sweepExpiredSuppressions,
	SUPPRESSION_SWEEP_BATCH,
} from '../suppressionList.js';

const SUPPRESSION_SET = 'mta:suppressed';
const EXPIRY_ZSET = 'mta:suppressed-expiring';
const metaKeyFor = (email: string) => `mta:suppressed-meta:${email}`;

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

		// THE OLD VERSION OF THIS TEST PROVED NOTHING. It re-`set` the metadata
		// with a past `expiresAt` "to avoid the ioredis-mock TTL race" — and a
		// bare `SET` clears the key's TTL, so it manufactured the one state
		// production could never be in: metadata still present after its due
		// date. In production the metadata key carried the SAME ttl as
		// `expiresAt`, so it was already gone by the time the check could fire,
		// `getMetadata` returned null, and `isSuppressed` fell through to
		// "member ⇒ suppressed". The entry never expired and the set member
		// leaked. Nothing here touches Redis by hand any more: the clock moves,
		// and the production key shapes answer for themselves.
		it('stops suppressing once the due date passes, and leaves nothing behind', async () => {
			await suppress(redis, 'temp@example.com', 'manual', { ttlSeconds: 60 });
			expect(await isSuppressed(redis, 'temp@example.com')).toBe(true);

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect(await isSuppressed(redis, 'temp@example.com')).toBe(false);
			expect(await redis.sismember(SUPPRESSION_SET, 'temp@example.com')).toBe(0);
			expect(await redis.exists(metaKeyFor('temp@example.com'))).toBe(0);
			expect(await redis.zscore(EXPIRY_ZSET, 'temp@example.com')).toBeNull();
		});

		it('keeps the metadata readable past the due date — it IS the expiry evidence', async () => {
			await suppress(redis, 'temp@example.com', 'manual', { ttlSeconds: 60 });
			// No TTL on the metadata key: one that expired alongside `expiresAt`
			// would take the evidence with it and make the entry permanent.
			expect(await redis.ttl(metaKeyFor('temp@example.com'))).toBe(-1);
			expect(await redis.zscore(EXPIRY_ZSET, 'temp@example.com')).toBe(String(Date.now() + 60_000));
		});

		it('never due-indexes a permanent suppression', async () => {
			await suppress(redis, 'hard@example.com', 'hard_bounce');
			await suppress(redis, 'spam@example.com', 'complaint');
			expect(await redis.zcard(EXPIRY_ZSET)).toBe(0);
		});
	});

	// THE LAZY EXPIRY PATH IS NOT A READ-THEN-DELETE. The metadata read and the
	// delete are a full application round trip apart — far wider than any
	// intra-pipeline window — so a hard bounce written in between would be
	// deleted by a decision taken before it existed, leaving the address
	// deliverable with no record that it ever bounced. `redis.get` is stubbed to
	// land exactly that write between the read and the delete.
	describe('lazy expiry races', () => {
		const raceOnGet = (concurrentWrite: () => Promise<unknown>) => {
			const originalGet = redis.get.bind(redis);
			let fired = false;
			redis.get = (async (key: string) => {
				const value = await originalGet(key);
				if (!fired) {
					fired = true;
					await concurrentWrite();
				}
				return value;
			}) as typeof redis.get;
			return () => {
				redis.get = originalGet;
			};
		};

		it('does not delete a permanent suppression that lands mid-check', async () => {
			await suppress(redis, 'race@example.com', 'manual', { ttlSeconds: 60 });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			const restore = raceOnGet(() => suppress(redis, 'race@example.com', 'hard_bounce'));
			expect(await isSuppressed(redis, 'race@example.com')).toBe(true);
			restore();

			expect(await isSuppressed(redis, 'race@example.com')).toBe(true);
			expect(await redis.sismember(SUPPRESSION_SET, 'race@example.com')).toBe(1);
			expect(await redis.exists(metaKeyFor('race@example.com'))).toBe(1);
		});

		it('reports the re-suppression rather than the stale expiry it read', async () => {
			await suppress(redis, 'race@example.com', 'manual', { ttlSeconds: 60 });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			const restore = raceOnGet(() =>
				suppress(redis, 'race@example.com', 'complaint', { source: 'feedback-loop' })
			);
			const status = await getSuppressionStatus(redis, 'race@example.com');
			restore();

			expect(status.suppressed).toBe(true);
			expect(status.reason).toBe('complaint');
			expect(status.expiresAt).toBeUndefined();
		});

		it('still reclaims an entry nothing re-suppressed', async () => {
			await suppress(redis, 'lapsed@example.com', 'manual', { ttlSeconds: 60 });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect(await isSuppressed(redis, 'lapsed@example.com')).toBe(false);
			expect(await redis.sismember(SUPPRESSION_SET, 'lapsed@example.com')).toBe(0);
			expect(await redis.exists(metaKeyFor('lapsed@example.com'))).toBe(0);
			expect(await redis.zscore(EXPIRY_ZSET, 'lapsed@example.com')).toBeNull();
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
			await suppress(redis, 'expire@example.com', 'manual', { ttlSeconds: 60 });

			vi.setSystemTime(new Date(Date.now() + 61_000));

			const status = await getSuppressionStatus(redis, 'expire@example.com');
			expect(status.suppressed).toBe(false);
			expect(await redis.sismember(SUPPRESSION_SET, 'expire@example.com')).toBe(0);
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

	// `redis.pipeline()` is not `multi()` — the commands are batched on the wire
	// and another client can be served between any two of them. A 100-entry bulk
	// batch is ~26 KB, past Redis's 16 KB client read buffer, so this really does
	// happen there. The stub replays a pipeline one command at a time with the
	// sweep run after the first, which is the interleaving that matters: the
	// sweep is the only other writer that touches these three keys.
	describe('write ordering against an interleaved sweep', () => {
		const interleaveSweepAfterFirstCommand = () => {
			const original = redis.pipeline.bind(redis);
			redis.pipeline = (() => {
				const queued: Array<[string, unknown[]]> = [];
				const stub: Record<string, unknown> = {
					exec: async () => {
						for (const [index, [command, args]] of queued.entries()) {
							const run = (
								redis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
							)[command]!;
							await run.apply(redis, args);
							if (index === 0) await sweepExpiredSuppressions(redis);
						}
						return [];
					},
				};
				for (const command of ['sadd', 'set', 'zadd', 'zrem', 'srem', 'del']) {
					stub[command] = (...args: unknown[]) => {
						queued.push([command, args]);
						return stub;
					};
				}
				return stub;
			}) as unknown as typeof redis.pipeline;
			return () => {
				redis.pipeline = original;
			};
		};

		it('does not let a sweep orphan an escalating suppress', async () => {
			await suppress(redis, 'esc@example.com', 'manual', { ttlSeconds: 60 });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			const restore = interleaveSweepAfterFirstCommand();
			await suppress(redis, 'esc@example.com', 'hard_bounce');
			restore();

			expect(await isSuppressed(redis, 'esc@example.com')).toBe(true);
			expect(await redis.sismember(SUPPRESSION_SET, 'esc@example.com')).toBe(1);
		});

		it('does not let a sweep orphan a bulk entry', async () => {
			await suppress(redis, 'orphan@example.com', 'manual', { ttlSeconds: 60 });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			const restore = interleaveSweepAfterFirstCommand();
			await suppressBulk(redis, [{ email: 'orphan@example.com', reason: 'hard_bounce' }]);
			restore();

			expect(await isSuppressed(redis, 'orphan@example.com')).toBe(true);
			expect(await redis.sismember(SUPPRESSION_SET, 'orphan@example.com')).toBe(1);
		});
	});

	describe('sweepExpiredSuppressions', () => {
		it('reclaims every key an expired temporary suppression owns', async () => {
			await suppress(redis, 'gone@example.com', 'manual', { ttlSeconds: 60 });

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(1);
			expect(await redis.sismember(SUPPRESSION_SET, 'gone@example.com')).toBe(0);
			expect(await redis.exists(metaKeyFor('gone@example.com'))).toBe(0);
			expect(await redis.zcard(EXPIRY_ZSET)).toBe(0);
		});

		it('leaves an entry that is not due yet alone', async () => {
			await suppress(redis, 'later@example.com', 'manual', { ttlSeconds: 60 });

			vi.setSystemTime(new Date(Date.now() + 59_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'later@example.com')).toBe(true);
		});

		// THE COMPLIANCE PROPERTY. A hard bounce or a complaint is never a member
		// of the due-date index, so no amount of sweeping — at any clock — can
		// reach one.
		it('cannot remove a hard bounce or a complaint, however far the clock moves', async () => {
			await suppress(redis, 'hard@example.com', 'hard_bounce');
			await suppress(redis, 'spam@example.com', 'complaint');

			vi.setSystemTime(new Date(Date.now() + 10 * 365 * 86400 * 1000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'hard@example.com')).toBe(true);
			expect(await isSuppressed(redis, 'spam@example.com')).toBe(true);
		});

		// The escalation case: an address soft-bounces, then hard-bounces inside
		// the soft window. Re-suppressing it permanently must CLEAR the pending
		// due date, or the sweep would delete a hard-bounce suppression when the
		// superseded soft one came due.
		it('drops the pending due date when an address is re-suppressed permanently', async () => {
			await suppress(redis, 'escalate@example.com', 'manual', { ttlSeconds: 60 });
			await suppress(redis, 'escalate@example.com', 'hard_bounce');
			expect(await redis.zcard(EXPIRY_ZSET)).toBe(0);

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'escalate@example.com')).toBe(true);
		});

		it('clears the pending due date on a bulk re-suppression too', async () => {
			await suppress(redis, 'bulk@example.com', 'manual', { ttlSeconds: 60 });
			await suppressBulk(redis, [{ email: 'bulk@example.com', reason: 'hard_bounce' }]);

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'bulk@example.com')).toBe(true);
		});

		it('stops at the batch limit and reports it, so the caller can come back', async () => {
			for (let index = 0; index < 5; index += 1) {
				await suppress(redis, `batch${index}@example.com`, 'manual', { ttlSeconds: 60 });
			}

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis, { limit: 2 })).removed).toBe(2);
			expect(await redis.zcard(EXPIRY_ZSET)).toBe(3);
			expect((await sweepExpiredSuppressions(redis)).removed).toBe(3);
			expect(await redis.scard(SUPPRESSION_SET)).toBe(0);
			expect(SUPPRESSION_SWEEP_BATCH).toBeGreaterThan(0);
		});

		// A pipeline is not atomic, so a permanent re-suppression can land its
		// metadata and lose its `zrem`. The sweep must read the metadata and keep
		// the suppression, not trust a due date the metadata contradicts.
		it('keeps a suppression whose metadata says it is permanent, despite a stale due date', async () => {
			await suppress(redis, 'torn@example.com', 'manual', { ttlSeconds: 60 });
			// The permanent rewrite, minus the index update it should have made.
			await redis.set(
				metaKeyFor('torn@example.com'),
				JSON.stringify({ reason: 'hard_bounce', suppressedAt: Date.now() })
			);

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'torn@example.com')).toBe(true);
			// ...and the stale due date is gone, so it is not reconsidered forever.
			expect(await redis.zcard(EXPIRY_ZSET)).toBe(0);
		});

		it('repairs a due date the metadata says is further out', async () => {
			await suppress(redis, 'extended@example.com', 'manual', { ttlSeconds: 60 });
			const later = Date.now() + 600_000;
			await redis.set(
				metaKeyFor('extended@example.com'),
				JSON.stringify({ reason: 'manual', suppressedAt: Date.now(), expiresAt: later })
			);

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await isSuppressed(redis, 'extended@example.com')).toBe(true);
			expect(await redis.zscore(EXPIRY_ZSET, 'extended@example.com')).toBe(String(later));
		});

		// Metadata gone is the EXPIRED case, not an unknown one: membership of the
		// due index is itself proof the address was suppressed temporarily.
		it('removes a due entry whose metadata has gone missing', async () => {
			await suppress(redis, 'nometa@example.com', 'manual', { ttlSeconds: 60 });
			await redis.del(metaKeyFor('nometa@example.com'));

			vi.setSystemTime(new Date(Date.now() + 61_000));

			expect((await sweepExpiredSuppressions(redis)).removed).toBe(1);
			expect(await redis.sismember(SUPPRESSION_SET, 'nometa@example.com')).toBe(0);
		});

		// The hourly drain loop in `index.ts` comes back while a batch is FULL, and
		// a batch that is entirely keep/repair arms reclaims nothing while still
		// consuming the whole limit. Reporting only `removed` would stop that loop
		// on its first such batch with the rest of the backlog still due.
		it('reports the due entries it looked at, not only the ones it reclaimed', async () => {
			for (let index = 0; index < 2; index += 1) {
				await suppress(redis, `keep${index}@example.com`, 'manual', { ttlSeconds: 60 });
				// Re-suppressed permanently without its index update — the keep arm.
				await redis.set(
					metaKeyFor(`keep${index}@example.com`),
					JSON.stringify({ reason: 'hard_bounce', suppressedAt: Date.now() })
				);
			}
			await suppress(redis, 'drop@example.com', 'manual', { ttlSeconds: 120 });

			vi.setSystemTime(new Date(Date.now() + 121_000));

			// Lowest scores first, so the full batch is the two keeps.
			expect(await sweepExpiredSuppressions(redis, { limit: 2 })).toEqual({
				processed: 2,
				removed: 0,
			});
			expect(await sweepExpiredSuppressions(redis, { limit: 2 })).toEqual({
				processed: 1,
				removed: 1,
			});
		});

		it('creates nothing when there is nothing due', async () => {
			expect((await sweepExpiredSuppressions(redis)).removed).toBe(0);
			expect(await redis.keys('mta:suppressed*')).toEqual([]);
		});
	});
});
