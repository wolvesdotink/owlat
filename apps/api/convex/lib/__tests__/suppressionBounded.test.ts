/**
 * `loadSuppressionSetBounded` — the bounded suppression read and, critically,
 * the `rowsRead` the audience document budget is charged with.
 *
 * `rowsRead` is NOT `blockedEmails.size`. The set is de-duplicated by
 * normalized address and truncated at the bound; the budget must be charged
 * what the query actually READ, including the one-row truncation probe.
 * Charging the surviving set instead silently under-counts the reads the bound
 * exists to cap (deliverability plan D16).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { loadSuppressionSetBounded } from '../suppression';

const modules = import.meta.glob('../../**/*.*s');

async function seedBlocked(t: TestConvex<typeof schema>, emails: readonly string[]): Promise<void> {
	await t.run(async (ctx) => {
		for (const email of emails) {
			await ctx.db.insert('blockedEmails', {
				email,
				reason: 'manual' as const,
				createdAt: 1_000,
			});
		}
	});
}

describe('loadSuppressionSetBounded', () => {
	it('counts ROWS read, not the de-duplicated set', async () => {
		const t = convexTest(schema, modules);
		// Four rows collapsing to two addresses: same address twice, plus a
		// case/whitespace variant that normalizes onto an existing one.
		await seedBlocked(t, [
			'dup@example.com',
			'dup@example.com',
			'Other@Example.com',
			'other@example.com',
		]);

		await t.run(async (ctx) => {
			const result = await loadSuppressionSetBounded(ctx, 100);
			expect(result.truncated).toBe(false);
			expect(result.blockedEmails.size).toBe(2);
			expect(result.rowsRead).toBe(4);
			expect(result.rowsRead).toBeGreaterThan(result.blockedEmails.size);
		});
	});

	it('charges the truncation probe: rowsRead === bound + 1 when truncated', async () => {
		const t = convexTest(schema, modules);
		const bound = 3;
		await seedBlocked(t, [
			'a@example.com',
			'b@example.com',
			'c@example.com',
			'd@example.com',
			'e@example.com',
		]);

		await t.run(async (ctx) => {
			const result = await loadSuppressionSetBounded(ctx, bound);
			expect(result.truncated).toBe(true);
			// The probe row is READ but NOT KEPT: the set stops at the bound while
			// the charge includes the extra row the query paid for.
			expect(result.blockedEmails.size).toBe(bound);
			expect(result.rowsRead).toBe(bound + 1);
		});
	});

	it('reads nothing but the probe at a zero bound', async () => {
		const t = convexTest(schema, modules);
		await seedBlocked(t, ['a@example.com']);

		await t.run(async (ctx) => {
			const result = await loadSuppressionSetBounded(ctx, 0);
			expect(result.truncated).toBe(true);
			expect(result.blockedEmails.size).toBe(0);
			expect(result.rowsRead).toBe(1);
		});
	});

	it('is empty and free on an empty blocklist', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const result = await loadSuppressionSetBounded(ctx, 10);
			expect(result.truncated).toBe(false);
			expect(result.blockedEmails.size).toBe(0);
			expect(result.rowsRead).toBe(0);
		});
	});
});
