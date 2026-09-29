import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { getInstanceSettings, upsertInstanceSettings } from '../instanceSettings';

const modules = import.meta.glob('../../**/*.*s');

describe('upsertInstanceSettings', () => {
	it('creates the singleton once, then patches the same row', async () => {
		const t = convexTest(schema, modules);

		const { firstId, secondId, rows } = await t.run(async (ctx) => {
			const firstId = await upsertInstanceSettings(ctx, { contactCount: 1 }, { now: 1_000 });
			const secondId = await upsertInstanceSettings(ctx, { contactCount: 2 }, { now: 2_000 });
			const rows = await ctx.db.query('instanceSettings').take(5);
			return { firstId, secondId, rows };
		});

		expect(secondId).toBe(firstId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.contactCount).toBe(2);
		expect(rows[0]?.createdAt).toBe(1_000);
		expect(rows[0]?.updatedAt).toBe(2_000);
	});

	it('patches an existing row without touching its other columns', async () => {
		const t = convexTest(schema, modules);

		const row = await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				timezone: 'Europe/Berlin',
				defaultFromName: 'Wizard',
				createdAt: 1,
			});
			await upsertInstanceSettings(ctx, { mtaHealth: { status: 'unreachable', observedAt: 5 } });
			return await getInstanceSettings(ctx.db);
		});

		expect(row?.mtaHealth?.status).toBe('unreachable');
		expect(row?.timezone).toBe('Europe/Berlin');
		expect(row?.defaultFromName).toBe('Wizard');
		expect(row?.createdAt).toBe(1);
		expect(typeof row?.updatedAt).toBe('number');
	});

	it('writes no seed-owned column when a cron-style writer creates the row', async () => {
		const t = convexTest(schema, modules);

		const row = await t.run(async (ctx) => {
			await upsertInstanceSettings(ctx, { mtaHealth: { status: 'unreachable', observedAt: 5 } });
			return await getInstanceSettings(ctx.db);
		});

		expect(row?.mtaHealth?.status).toBe('unreachable');
		expect(row?.timezone).toBeUndefined();
		expect(row?.defaultFromName).toBeUndefined();
		expect(row?.isMigrationMode).toBeUndefined();
		expect(row?.adminSeedCompletedAt).toBeUndefined();
	});

	it('applies onCreate columns only when it creates the row', async () => {
		const t = convexTest(schema, modules);

		const row = await t.run(async (ctx) => {
			await upsertInstanceSettings(ctx, { contactCount: 1 }, { onCreate: { timezone: 'UTC' } });
			await upsertInstanceSettings(
				ctx,
				{ contactCount: 2 },
				{ onCreate: { timezone: 'Europe/Berlin' } }
			);
			return await getInstanceSettings(ctx.db);
		});

		expect(row?.timezone).toBe('UTC');
		expect(row?.contactCount).toBe(2);
	});
});
