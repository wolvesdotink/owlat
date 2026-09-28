import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { MutationCtx } from '../../_generated/server';
import {
	decrementContactCount,
	getContactCount,
	incrementContactCount,
	reconcileContactCount,
} from '../contactCountHelpers';
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

describe('getContactCount — cached count, else the live count', () => {
	it('counts only live contacts when no count is cached', async () => {
		// A new or restored instance before the daily reconcile has no cached
		// count; the fallback must not include soft-deleted rows.
		const t = convexTest(schema, modules);
		const count = await t.run(async (ctx) => {
			await seedContacts(ctx, 1);
			await seedContacts(ctx, 1, { deletedAt: Date.now() });
			return await getContactCount(ctx);
		});
		expect(count).toBe(1);
	});

	it('returns the cached count when one exists', async () => {
		const t = convexTest(schema, modules);
		const count = await t.run(async (ctx) => {
			await seedContacts(ctx, 2);
			await ctx.db.insert('instanceSettings', { contactCount: 7, createdAt: Date.now() });
			return await getContactCount(ctx);
		});
		expect(count).toBe(7);
	});
});

describe('increment/decrementContactCount', () => {
	it('creates the singleton on the first increment without seed columns', async () => {
		const t = convexTest(schema, modules);
		const row = await t.run(async (ctx) => {
			await incrementContactCount(ctx, 2);
			await incrementContactCount(ctx);
			return await ctx.db.query('instanceSettings').first();
		});
		expect(row?.contactCount).toBe(3);
		expect(row?.timezone).toBeUndefined();
		expect(row?.isMigrationMode).toBeUndefined();
	});

	it('does not create the singleton on a decrement', async () => {
		const t = convexTest(schema, modules);
		const row = await t.run(async (ctx) => {
			await decrementContactCount(ctx);
			return await ctx.db.query('instanceSettings').first();
		});
		expect(row).toBeNull();
	});
});
