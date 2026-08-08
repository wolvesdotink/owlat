/**
 * transportOutcomes — the aging sweep (plan D16).
 *
 * The bucket table is written on the send hot path, so an unbounded table is a
 * design defect rather than housekeeping. The sweep must be indexed, bounded
 * per tick, resumable across ticks so a backlog actually drains, and it must
 * never touch a bucket inside the retention horizon. Same shape, and same test
 * shape, as `delivery/__tests__/sendAssignmentsRetention.test.ts`.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE,
	TRANSPORT_OUTCOME_RETENTION_MS,
} from '../transportOutcomes';
import { startOfDayUtc } from '../../lib/clock';
import { modules } from '../../__tests__/testModules';
import { bucketRow, DAY_MS, readBuckets } from './transportOutcomesFixtures';

// A failing assertion must not leak fake timers into the next test.
afterEach(() => {
	vi.useRealTimers();
});

describe('aging sweep', () => {
	it('drops buckets past the retention horizon and keeps everything inside it', async () => {
		const t = convexTest(schema, modules);
		const now = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS, shardKey: 0 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - 5 * DAY_MS, shardKey: 3 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - DAY_MS, shardKey: 1 })
			);
			await ctx.db.insert('transportOutcomes', bucketRow({ periodStart: now, shardKey: 2 }));
		});

		const result = await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, {
			now,
		});
		expect(result.deleted).toBe(2);

		await t.run(async (ctx) => {
			const remaining = await readBuckets(ctx);
			expect(remaining).toHaveLength(2);
			expect(remaining.every((row) => row.periodStart >= now - DAY_MS)).toBe(true);
		});
	});

	it('is bounded per tick and resumes until the backlog drains', async () => {
		// `finishInProgressScheduledFunctions` only drains what is already
		// running; the sweep's `runAfter(0)` follow-up is still PENDING at that
		// point, so the drain assertion would pass vacuously. Fake timers +
		// `finishAllScheduledFunctions(runAllTimers)` actually advance the
		// scheduler to the follow-up, and the timers must be faked BEFORE the
		// first mutation so the scheduler sees the fake clock.
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const now = startOfDayUtc(Date.now());
		const expired = TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE + 25;
		await t.run(async (ctx) => {
			for (let index = 0; index < expired; index += 1) {
				await ctx.db.insert(
					'transportOutcomes',
					bucketRow({
						periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS - index,
						shardKey: index % 8,
					})
				);
			}
			await ctx.db.insert('transportOutcomes', bucketRow({ periodStart: now, shardKey: 0 }));
		});

		const first = await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, {
			now,
		});
		expect(first.deleted).toBe(TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE);
		expect(await t.run(async (ctx) => (await readBuckets(ctx)).length)).toBe(
			expired + 1 - TRANSPORT_OUTCOME_CLEANUP_BATCH_SIZE
		);

		// The tick came back full, so it rescheduled itself; drain the follow-up.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		const remaining = await t.run(async (ctx) => await readBuckets(ctx));
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.periodStart).toBe(now);

		// And the backlog really did drain through a SECOND tick, not one big
		// one. Asserting the length first matters: `[].every(...)` is vacuously
		// true, so the success check alone would pass with nothing rescheduled.
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled.every((job) => job.state.kind === 'success')).toBe(true);
	});

	it('does not reschedule when the tick comes back short', async () => {
		const t = convexTest(schema, modules);
		const now = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS, shardKey: 0 })
			);
		});

		await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, { now });
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});

	it('falls back to the real clock rather than sweeping nothing forever on a NaN clock', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({
					periodStart: Date.now() - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS,
					shardKey: 0,
				})
			);
		});
		const result = await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, {
			now: Number.NaN,
		});
		expect(result.deleted).toBe(1);
	});
});
