import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const snapshot = (syncedAt: number) => ({
	phase: 'graduated',
	totalDailyCap: 1_000,
	totalSentToday: 0,
	ipCount: 1,
	ips: [
		{
			ip: '203.0.113.10',
			phase: 'graduated',
			currentDay: 30,
			dailyCap: 1_000,
			sentToday: 0,
			bounceRate: 0,
			deferralRate: 0,
			pool: 'campaign',
			active: true,
		},
	],
	syncedAt,
});

describe('upsertWarmingState', () => {
	it('clears stored pools when an MTA that predates them omits the field', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.warmingSync.upsertWarmingState, {
			...snapshot(1_000),
			pools: { transactional: ['203.0.113.10'], campaign: ['203.0.113.10', '2001:db8::10'] },
		});
		await t.mutation(internal.delivery.warmingSync.upsertWarmingState, snapshot(2_000));

		const rows = await t.run((ctx) => ctx.db.query('warmingState').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toHaveProperty('pools');
		expect(rows[0]?.syncedAt).toBe(2_000);
	});

	it('does not store the organization id it is handed', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.warmingSync.upsertWarmingState, {
			...snapshot(1_000),
			organizationId: 'org-1',
		});
		const row = await t.run((ctx) => ctx.db.query('warmingState').first());
		expect(row).not.toHaveProperty('organizationId');
	});
});
