import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { MutationCtx } from '../../_generated/server';
import {
	decrementContactCount,
	getCachedContactCount,
	incrementContactCount,
} from '../contactCountHelpers';
import { createTestContact } from '../../__tests__/factories';

const modules = import.meta.glob('../../**/*.*s');

async function seedContacts(ctx: MutationCtx, n: number, overrides: Record<string, unknown> = {}) {
	for (let i = 0; i < n; i++) {
		await ctx.db.insert('contacts', createTestContact({ email: `c${i}@x.com`, ...overrides }));
	}
}

describe('getCachedContactCount — the cached count or pending, never a scan', () => {
	it('reads null (pending) when no count is cached, even with contacts present', async () => {
		// A new or restored instance: the count is recovered in the background
		// (contacts/countReconcile.ts), so readers must not count rows.
		const t = convexTest(schema, modules);
		const count = await t.run(async (ctx) => {
			await seedContacts(ctx, 2);
			return await getCachedContactCount(ctx);
		});
		expect(count).toBeNull();
	});

	it('returns the cached count when one exists, including zero', async () => {
		const t = convexTest(schema, modules);
		const counts = await t.run(async (ctx) => {
			await seedContacts(ctx, 2);
			await ctx.db.insert('instanceSettings', { contactCount: 7, createdAt: Date.now() });
			const seven = await getCachedContactCount(ctx);
			await ctx.db.insert('instanceCounters', { key: 'contacts', contactCount: 0, updatedAt: 0 });
			return { seven, zero: await getCachedContactCount(ctx) };
		});
		expect(counts).toEqual({ seven: 7, zero: 0 });
	});
});

describe('increment/decrementContactCount', () => {
	it('counts on its own counter row and never creates the settings singleton', async () => {
		// The settings row is read by every feature gate (plan 2.4); a contact
		// write must not create or patch it, so `/seed/admin` still sees an
		// unseeded instance.
		const t = convexTest(schema, modules);
		const { count, settings } = await t.run(async (ctx) => {
			await incrementContactCount(ctx, 2);
			await incrementContactCount(ctx);
			return {
				count: await getCachedContactCount(ctx),
				settings: await ctx.db.query('instanceSettings').first(),
			};
		});
		expect(count).toBe(3);
		expect(settings).toBeNull();
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
