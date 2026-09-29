import { convexTest } from 'convex-test';
import { defineSchema, defineTable } from 'convex/server';
import type { Infer } from 'convex/values';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { literalUnion } from '../literalUnion';
import { INBOUND_RAW_RETENTION_DAY_CHOICES } from '@owlat/shared/inboundRetention';
import { inboundRawRetentionDaysValidator } from '../literalValidators';

const modules = import.meta.glob('../../**/*.*s');

const RETENTION_DAYS = [30, 90, 180] as const;
const retentionDays = literalUnion(RETENTION_DAYS);

/** A throwaway table whose one column is the number union, so convex-test's
 * schema validation decides membership exactly as a deployment would. */
const probeSchema = defineSchema({
	probes: defineTable({ days: retentionDays }),
});

describe('literalUnion over a number tuple', () => {
	it('builds one literal member per number, in order', () => {
		expect(retentionDays.kind).toBe('union');
		expect(retentionDays.members.map((member) => [member.kind, member.value])).toEqual([
			['literal', 30],
			['literal', 90],
			['literal', 180],
		]);
		expectTypeOf<Infer<typeof retentionDays>>().toEqualTypeOf<30 | 90 | 180>();
	});

	it('accepts a member and rejects a non-member at the table', async () => {
		const t = convexTest(probeSchema, modules);

		const stored = await t.run(async (ctx) => {
			const id = await ctx.db.insert('probes', { days: 90 });
			return (await ctx.db.get(id))?.days;
		});
		expect(stored).toBe(90);

		await expect(
			t.run(async (ctx) => {
				await ctx.db.insert('probes', { days: 45 as 30 });
			})
		).rejects.toThrow();
		// The string spelling of a member is not the member.
		await expect(
			t.run(async (ctx) => {
				await ctx.db.insert('probes', { days: '30' as unknown as 30 });
			})
		).rejects.toThrow();
	});

	it('backs the inbound retention validator with the shared choices', () => {
		expect(inboundRawRetentionDaysValidator.members.map((member) => member.value)).toEqual([
			...INBOUND_RAW_RETENTION_DAY_CHOICES,
		]);
		expectTypeOf<Infer<typeof inboundRawRetentionDaysValidator>>().toEqualTypeOf<
			(typeof INBOUND_RAW_RETENTION_DAY_CHOICES)[number]
		>();
	});
});

describe('literalUnion over a computed list', () => {
	it('takes a filtered subset and keeps its element type', () => {
		const settled = RETENTION_DAYS.filter((days): days is 90 | 180 => days !== 30);
		const validator = literalUnion(settled);

		expect(validator.members.map((member) => member.value)).toEqual([90, 180]);
		expectTypeOf<Infer<typeof validator>>().toEqualTypeOf<90 | 180>();
	});

	it('takes a Set without spreading it at the call site', () => {
		const validator = literalUnion(new Set<'a' | 'b'>(['a', 'b']));

		expect(validator.members.map((member) => member.value)).toEqual(['a', 'b']);
		expectTypeOf<Infer<typeof validator>>().toEqualTypeOf<'a' | 'b'>();
	});

	it('refuses an empty list instead of building a union that accepts nothing', () => {
		const none: readonly string[] = [];

		expect(() => literalUnion(none)).toThrow('literalUnion needs at least one literal');
	});
});
