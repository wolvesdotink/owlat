import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { MutationCtx } from '../../_generated/server';
import { reconcileContactCount } from '../contactCountHelpers';
import { createTestContact } from '../../__tests__/factories';

const modules = import.meta.glob('../../**/*.*s');

async function seedContacts(ctx: MutationCtx, n: number, overrides: Record<string, unknown> = {}) {
	for (let i = 0; i < n; i++) {
		await ctx.db.insert('contacts', createTestContact({ email: `c${i}@x.com`, ...overrides }));
	}
}

describe('reconcileContactCount — paginated count (ADR-0033)', () => {
	it('sums every contact row across the reconcile page boundary (page size 1000)', async () => {
		const t = convexTest(schema, modules);
		// > 2 reconcile pages so the paginated sum must continue past isDone=false.
		const TOTAL = 2100;
		const result = await t.run(async (ctx) => {
			await seedContacts(ctx, TOTAL);
			return await reconcileContactCount(ctx);
		});

		expect(result.actual).toBe(TOTAL);
		expect(result.previous).toBeNull(); // no instanceSettings seeded
		expect(result.corrected).toBe(true);

		// The cached count is now written and matches the streamed actual.
		const cached = await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			return settings?.contactCount ?? null;
		});
		expect(cached).toBe(TOTAL);
	});

	it('counts only live rows, excluding soft-deleted (matches the live decrement)', async () => {
		// softDeleteContact decrements the cached count, so the reconcile must
		// also exclude soft-deleted rows or it would re-inflate the count.
		const t = convexTest(schema, modules);
		const result = await t.run(async (ctx) => {
			await seedContacts(ctx, 3);
			await seedContacts(ctx, 2, { deletedAt: Date.now() });
			return await reconcileContactCount(ctx);
		});
		expect(result.actual).toBe(3);
	});

	it('reports no correction when the cached count already matches', async () => {
		const t = convexTest(schema, modules);
		const result = await t.run(async (ctx) => {
			await seedContacts(ctx, 4);
			await ctx.db.insert('instanceSettings', { contactCount: 4, createdAt: Date.now() });
			return await reconcileContactCount(ctx);
		});
		expect(result.previous).toBe(4);
		expect(result.actual).toBe(4);
		expect(result.corrected).toBe(false);
	});
});
