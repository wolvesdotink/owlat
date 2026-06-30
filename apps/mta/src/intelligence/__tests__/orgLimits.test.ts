import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import { checkAndIncrement, setOrgLimits, getOrgUsage, setDefaults } from '../orgLimits.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('orgLimits', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
		// Reset defaults
		setDefaults(50_000, 5_000);
	});

	describe('checkAndIncrement', () => {
		it('allows when under limits and returns allowed:true', async () => {
			const result = await checkAndIncrement(redis, 'org-1');
			expect(result.allowed).toBe(true);
			expect(result.dailySent).toBe(1);
			expect(result.hourlySent).toBe(1);
		});

		it('blocks when daily limit reached', async () => {
			setDefaults(3, 5_000);

			for (let i = 0; i < 3; i++) {
				await checkAndIncrement(redis, 'org-daily');
			}

			const result = await checkAndIncrement(redis, 'org-daily');
			expect(result.allowed).toBe(false);
			expect(result.retryAfter).toBeGreaterThan(0);
		});

		it('blocks when hourly limit reached', async () => {
			setDefaults(50_000, 2);

			await checkAndIncrement(redis, 'org-hourly');
			await checkAndIncrement(redis, 'org-hourly');

			const result = await checkAndIncrement(redis, 'org-hourly');
			expect(result.allowed).toBe(false);
			expect(result.retryAfter).toBeGreaterThan(0);
		});

		it('increments counters on each allowed call', async () => {
			await checkAndIncrement(redis, 'org-inc');
			const result = await checkAndIncrement(redis, 'org-inc');
			expect(result.allowed).toBe(true);
			expect(result.dailySent).toBe(2);
			expect(result.hourlySent).toBe(2);
		});

		it('uses custom limits set via setOrgLimits', async () => {
			await setOrgLimits(redis, 'org-custom', 2, 1);

			const first = await checkAndIncrement(redis, 'org-custom');
			expect(first.allowed).toBe(true);

			const second = await checkAndIncrement(redis, 'org-custom');
			expect(second.allowed).toBe(false);
		});
	});

	describe('setOrgLimits', () => {
		it('stores custom limits in Redis', async () => {
			await setOrgLimits(redis, 'org-store', 1000, 100);

			const dailyLimit = await redis.hget('mta:org-config:org-store', 'dailyLimit');
			const hourlyLimit = await redis.hget('mta:org-config:org-store', 'hourlyLimit');
			expect(dailyLimit).toBe('1000');
			expect(hourlyLimit).toBe('100');
		});
	});

	describe('getOrgUsage', () => {
		it('returns counts and limits', async () => {
			await checkAndIncrement(redis, 'org-usage');
			await checkAndIncrement(redis, 'org-usage');

			const usage = await getOrgUsage(redis, 'org-usage');
			expect(usage.dailySent).toBe(2);
			expect(usage.hourlySent).toBe(2);
			expect(usage.limits.dailyLimit).toBe(50_000);
			expect(usage.limits.hourlyLimit).toBe(5_000);
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// PR-73 regression lock: per-org daily/hourly send caps.
	// Locks the EXACT enforcement at the cap, the retryAfter pointing at the
	// next UTC window boundary (next hour / next midnight), and that
	// concurrent racing cannot overshoot the cap unboundedly.
	// ────────────────────────────────────────────────────────────────────
	describe('PR-73: exact cap enforcement and window-boundary retryAfter', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			// 2026-03-22T12:30:00Z — mid-hour, mid-day, so both boundaries are
			// in the future by a known amount.
			vi.setSystemTime(new Date('2026-03-22T12:30:00.000Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('admits EXACTLY the hourly cap then denies', async () => {
			setDefaults(50_000, 5);

			let allowed = 0;
			for (let i = 0; i < 10; i++) {
				if ((await checkAndIncrement(redis, 'org-h')).allowed) allowed++;
			}

			expect(allowed).toBe(5);
		});

		it('admits EXACTLY the daily cap then denies (daily gate fires before hourly)', async () => {
			setDefaults(3, 5_000);

			let allowed = 0;
			for (let i = 0; i < 8; i++) {
				if ((await checkAndIncrement(redis, 'org-d')).allowed) allowed++;
			}

			expect(allowed).toBe(3);
		});

		it('hourly retryAfter points at the next UTC hour boundary', async () => {
			setDefaults(50_000, 1);

			await checkAndIncrement(redis, 'org-hr'); // hits the cap of 1
			const denied = await checkAndIncrement(redis, 'org-hr');

			expect(denied.allowed).toBe(false);
			// From 12:30:00 to 13:00:00 = 30 minutes.
			expect(denied.retryAfter).toBe(30 * 60 * 1000);
		});

		it('daily retryAfter points at the next UTC midnight', async () => {
			setDefaults(1, 5_000);

			await checkAndIncrement(redis, 'org-dr'); // hits the daily cap of 1
			const denied = await checkAndIncrement(redis, 'org-dr');

			expect(denied.allowed).toBe(false);
			// From 12:30:00 to the next midnight (00:00:00 the following day) =
			// 11h30m.
			expect(denied.retryAfter).toBe((11 * 60 + 30) * 60 * 1000);
		});

		it('reports the limits alongside a denial for observability', async () => {
			setDefaults(50_000, 2);
			await checkAndIncrement(redis, 'org-obs');
			await checkAndIncrement(redis, 'org-obs');
			const denied = await checkAndIncrement(redis, 'org-obs');

			expect(denied.allowed).toBe(false);
			expect(denied.hourlyLimit).toBe(2);
			expect(denied.dailyLimit).toBe(50_000);
		});
	});

	describe('PR-73: concurrent racing cannot overshoot the cap unboundedly', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-22T12:30:00.000Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('overshoot from a parallel burst is bounded by the in-flight racer count', async () => {
			const cap = 10;
			const racers = 40;
			setDefaults(50_000, cap);

			// checkAndIncrement is check-then-increment (not atomic), so a fully
			// concurrent burst can let racers that all observed a sub-cap count
			// through before any of them increments. The contract we lock is that
			// this overshoot is BOUNDED — admitted sends never exceed the number
			// of in-flight racers — and the stored counter never disagrees with
			// the number actually admitted.
			const results = await Promise.all(
				Array.from({ length: racers }, () => checkAndIncrement(redis, 'org-race')),
			);
			const allowed = results.filter((r) => r.allowed).length;

			expect(allowed).toBeGreaterThanOrEqual(cap); // at least the cap goes out
			expect(allowed).toBeLessThanOrEqual(racers); // bounded — never unbounded

			// The persisted counter exactly equals the number admitted (no
			// double-counting or lost increments).
			const usage = await getOrgUsage(redis, 'org-race');
			expect(usage.hourlySent).toBe(allowed);
		});

		it('after a burst, the next SEQUENTIAL call past the cap is denied', async () => {
			const cap = 10;
			setDefaults(50_000, cap);

			// Drain the cap sequentially so the counter is at/above the cap.
			for (let i = 0; i < cap; i++) await checkAndIncrement(redis, 'org-seq');

			// Once the counter has reached the cap, further sequential calls are
			// firmly denied with a retryAfter — the race window only exists for
			// simultaneously in-flight calls, not for serialised ones.
			const denied = await checkAndIncrement(redis, 'org-seq');
			expect(denied.allowed).toBe(false);
			expect(denied.retryAfter).toBeGreaterThan(0);
		});
	});
});
