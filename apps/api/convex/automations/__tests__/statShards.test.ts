import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import {
	bumpAutomationStats,
	summarizeAutomationStats,
	rollupAutomationStatsRow,
} from '../statShards';
import { createTestAutomation } from '../../__tests__/factories';

const modules = import.meta.glob('../../**/*.*s');

describe('automation stat shards', () => {
	it('spreads bumps across shards and derives statsActive on rollup', async () => {
		const t = convexTest(schema, modules);
		const automationId = await t.run(async (ctx) =>
			ctx.db.insert('automations', createTestAutomation({})),
		);

		await t.run(async (ctx) => {
			for (let i = 0; i < 30; i++) await bumpAutomationStats(ctx, automationId, { statsEntered: 1 });
			for (let i = 0; i < 12; i++)
				await bumpAutomationStats(ctx, automationId, { statsCompleted: 1 });
			for (let i = 0; i < 3; i++)
				await bumpAutomationStats(ctx, automationId, { statsCancelled: 1 });
		});

		await t.run(async (ctx) => {
			const sum = await summarizeAutomationStats(ctx.db, automationId);
			expect(sum.statsEntered).toBe(30);
			expect(sum.statsCompleted).toBe(12);
			expect(sum.statsCancelled).toBe(3);
			const shards = await ctx.db.query('automationStatShards').collect();
			expect(shards.length).toBeGreaterThan(1);
			expect(shards.length).toBeLessThanOrEqual(8);
		});

		// Rollup derives statsActive = entered − completed − cancelled.
		await t.run(async (ctx) => {
			const a = await ctx.db.get(automationId);
			if (a) await rollupAutomationStatsRow(ctx, a);
		});
		const automation = await t.run(async (ctx) => ctx.db.get(automationId));
		expect(automation?.statsEntered).toBe(30);
		expect(automation?.statsCompleted).toBe(12);
		expect(automation?.statsActive).toBe(15); // 30 − 12 − 3
	});
});
