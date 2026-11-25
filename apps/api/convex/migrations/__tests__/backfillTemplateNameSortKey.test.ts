import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { createTestEmailTemplate } from '../../__tests__/factories';
import { PAGE_SIZE } from '../0077_backfill_template_name_sort_key';

const MIGRATION = '0077_backfill_template_name_sort_key';
const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0077_backfill_template_name_sort_key', () => {
	it('fills the key on every older row over several pages, deleted ones too', async () => {
		const t = convexTest(schema, modules);
		const count = PAGE_SIZE + 5;
		const ids = await t.run(async (ctx) => {
			const out = [];
			for (let i = 0; i < count; i++) {
				out.push(
					await ctx.db.insert(
						'emailTemplates',
						createTestEmailTemplate({
							name: `  Élan ${i}`,
							...(i === 0 ? { deletedAt: 1, deletedBy: 'user-1' } : {}),
						})
					)
				);
			}
			return out;
		});
		const current = await t.run((ctx) =>
			ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ name: 'Current', nameSortKey: 'current' })
			)
		);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			for (const [i, id] of ids.entries()) {
				expect((await ctx.db.get(id))?.nameSortKey).toBe(`elan ${i}`);
			}
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: count });
			expect((await ctx.db.get(current))?.nameSortKey).toBe('current');
		});

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
