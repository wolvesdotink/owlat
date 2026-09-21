/**
 * Agent-health metric retention — the sweep that replaced a `Math.random()`
 * gate inside the 5-minute rollup.
 *
 * Proven here:
 *   · rollup points past the 7-day window are deleted and fresher ones are not;
 *   · a backlog larger than one batch DRAINS: the sweep reschedules itself
 *     until nothing stale is left, which the old one-shot `.take(500)` could
 *     not do however often it happened to fire.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { createTestAgentMetric } from '../../__tests__/factories';

// The `../../**` glob omits the `maintenance/` dir it climbed through, so
// merge a second glob rooted there and re-prefix its keys (see
// inboundRetention.test.ts for the same arrangement).
const rootGlob = import.meta.glob('../../**/*.*s');
const maintenanceGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../maintenance/'),
		mod,
	])
);
const modules = { ...rootGlob, ...maintenanceGlob };

const DAY_MS = 24 * 60 * 60 * 1000;
/** BATCH in maintenance/retention.ts. */
const BATCH = 200;

afterEach(() => {
	vi.useRealTimers();
});

async function seedMetric(t: ReturnType<typeof convexTest>, windowStart: number): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'agentMetrics',
			createTestAgentMetric({
				windowStart,
				windowEnd: windowStart + 300000,
				createdAt: windowStart,
			})
		);
	});
}

describe('sweepAgentMetrics', () => {
	it('deletes rollup points past the 7-day window and keeps fresher ones', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const eightDaysAgo = now - 8 * DAY_MS;

		await seedMetric(t, eightDaysAgo);
		await seedMetric(t, now - 60000);

		await t.mutation(internal.maintenance.retention.sweepAgentMetrics, {});

		const metrics = await t.run(async (ctx) => await ctx.db.query('agentMetrics').collect());
		expect(metrics).toHaveLength(1);
		expect(metrics[0]!.windowStart).toBeGreaterThan(eightDaysAgo);
	});

	it('is bounded per tick and resumes until the backlog drains', async () => {
		// Fake timers must be installed BEFORE the first mutation so the
		// scheduler sees the fake clock (see inboundRetention.test.ts).
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const now = Date.now();

		// One more than a batch: a single tick cannot finish the backlog.
		for (let i = 0; i < BATCH + 1; i++) {
			await seedMetric(t, now - 8 * DAY_MS - i);
		}
		await seedMetric(t, now - 60000);

		await t.mutation(internal.maintenance.retention.sweepAgentMetrics, {});
		const afterFirst = await t.run(async (ctx) => await ctx.db.query('agentMetrics').collect());
		expect(afterFirst).toHaveLength(2);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		const remaining = await t.run(async (ctx) => await ctx.db.query('agentMetrics').collect());
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.windowStart).toBeGreaterThan(now - DAY_MS);
	});
});
