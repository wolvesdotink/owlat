/**
 * Cached segment counts — the checkpointed cron sweep and on-write refresh.
 *
 * A segment's count is a predicate over the whole live-Contact population, so
 * the population here is seeded LARGER than one execution's document budget:
 * that is the only way to exercise what these tests are about — that the walk
 * resumes across executions, sums to the exact count, and refuses to write a
 * tally computed from filters an edit has already retired.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id, Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
const modules = import.meta.glob('../**/*.*s');

/** These filters read nothing but the contact row, so one contact costs one document. */
const ACME_FILTERS = {
	logic: 'AND' as const,
	conditions: [
		{
			kind: 'contact_property' as const,
			field: 'email',
			operator: 'contains' as const,
			value: 'acme',
		},
	],
};

const NEVER_MATCHING_FILTERS = {
	logic: 'AND' as const,
	conditions: [
		{
			kind: 'contact_property' as const,
			field: 'email',
			operator: 'contains' as const,
			value: 'nobody-has-this',
		},
	],
};

/**
 * Matching contacts, chosen to exceed `REFRESH_DOCUMENT_BUDGET` (1,000
 * documents, one per contact for these filters) so no single execution can
 * finish the walk.
 */
const MATCHING = 1_200;
const NON_MATCHING = 20;

async function seedContacts(ctx: MutationCtx) {
	for (let i = 0; i < MATCHING; i++) {
		await ctx.db.insert('contacts', {
			email: `p${i}@acme.com`,
			source: 'api',
			doiStatus: 'not_required',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	}
	for (let i = 0; i < NON_MATCHING; i++) {
		await ctx.db.insert('contacts', {
			email: `n${i}@other.com`,
			source: 'api',
			doiStatus: 'not_required',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	}
}

async function insertSegment(
	ctx: MutationCtx,
	name: string,
	filters: typeof ACME_FILTERS
): Promise<Id<'segments'>> {
	const now = Date.now();
	return await ctx.db.insert('segments', { name, filters, createdAt: now, updatedAt: now });
}

/** Run the self-rescheduling walk to completion. */
async function drain(t: ReturnType<typeof convexTest>): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

describe('refreshSingleSegmentCount', () => {
	it('counts a population larger than one execution across rescheduled executions', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return await insertSegment(ctx, 'acme', ACME_FILTERS);
		});

		await t.mutation(internal.segments.countRefresh.refreshSingleSegmentCount, { segmentId });
		// The first execution cannot have finished the walk, so the count is only
		// written once the rescheduled continuations drain.
		const beforeDrain = await t.run(async (ctx) => await ctx.db.get(segmentId));
		expect(beforeDrain?.cachedCount).toBeUndefined();

		await drain(t);

		const segment = await t.run(async (ctx) => await ctx.db.get(segmentId));
		expect(segment?.cachedCount).toBe(MATCHING);
		expect(segment?.cachedCountUpdatedAt).toBeTypeOf('number');
	});

	it('abandons the walk when the segment is re-filtered mid-walk', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return await insertSegment(ctx, 'acme', ACME_FILTERS);
		});

		// One execution: enough to bank a partial tally, not enough to finish.
		await t.mutation(internal.segments.countRefresh.refreshSingleSegmentCount, { segmentId });

		// The edit an admin makes while the walk is in flight. In production it
		// schedules its own refresh; here the point is that the in-flight walk —
		// counting the OLD filters — must not write its result.
		await t.run(async (ctx) => {
			await ctx.db.patch(segmentId, {
				filters: NEVER_MATCHING_FILTERS,
				updatedAt: Date.now() + 1,
			});
		});

		await drain(t);

		const segment = await t.run(async (ctx) => await ctx.db.get(segmentId));
		expect(segment?.cachedCount).toBeUndefined();
	});

	it('keeps counting through a rename, which cannot change the count', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return await insertSegment(ctx, 'acme', ACME_FILTERS);
		});

		await t.mutation(internal.segments.countRefresh.refreshSingleSegmentCount, { segmentId });
		await t.run(async (ctx) => {
			await ctx.db.patch(segmentId, { name: 'acme (renamed)', updatedAt: Date.now() + 1 });
		});

		await drain(t);

		const segment = await t.run(async (ctx) => await ctx.db.get(segmentId));
		expect(segment?.cachedCount).toBe(MATCHING);
	});
});

describe('refreshAllSegmentCounts (cron sweep)', () => {
	it('writes exact counts for every segment after the shared walk finishes', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return {
				acme: await insertSegment(ctx, 'acme', ACME_FILTERS),
				everyone: await insertSegment(ctx, 'everyone', { logic: 'AND', conditions: [] }),
			};
		});

		await t.mutation(internal.segments.countRefresh.refreshAllSegmentCounts, {});
		await drain(t);

		const [acme, everyone] = await t.run(
			async (ctx) =>
				[await ctx.db.get(ids.acme), await ctx.db.get(ids.everyone)] as [
					Doc<'segments'> | null,
					Doc<'segments'> | null,
				]
		);
		expect(acme?.cachedCount).toBe(MATCHING);
		expect(everyone?.cachedCount).toBe(MATCHING + NON_MATCHING);
	});

	it('skips a segment edited mid-walk and still writes its batch siblings', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return {
				acme: await insertSegment(ctx, 'acme', ACME_FILTERS),
				everyone: await insertSegment(ctx, 'everyone', { logic: 'AND', conditions: [] }),
			};
		});

		await t.mutation(internal.segments.countRefresh.refreshAllSegmentCounts, {});
		await t.run(async (ctx) => {
			await ctx.db.patch(ids.acme, {
				filters: NEVER_MATCHING_FILTERS,
				updatedAt: Date.now() + 1,
			});
		});

		await drain(t);

		const [acme, everyone] = await t.run(
			async (ctx) =>
				[await ctx.db.get(ids.acme), await ctx.db.get(ids.everyone)] as [
					Doc<'segments'> | null,
					Doc<'segments'> | null,
				]
		);
		expect(acme?.cachedCount).toBeUndefined();
		expect(everyone?.cachedCount).toBe(MATCHING + NON_MATCHING);
	});

	it('leaves a segment created mid-sweep for the next sweep rather than half-counting it', async () => {
		const t = convexTest(schema, modules);
		const first = await t.run(async (ctx) => {
			await seedContacts(ctx);
			return await insertSegment(ctx, 'acme', ACME_FILTERS);
		});

		// One execution of the sweep: the walk is now mid-population.
		await t.mutation(internal.segments.countRefresh.refreshAllSegmentCounts, {});

		// A segment created now lands on the same page when the continuation
		// re-reads it, but it has missed every contact behind the cursor. Counting
		// it in this walk would write a real number that is simply too low.
		const late = await t.run(
			async (ctx) => await insertSegment(ctx, 'late', { logic: 'AND', conditions: [] })
		);

		await drain(t);

		const [firstSegment, lateSegment] = await t.run(
			async (ctx) =>
				[await ctx.db.get(first), await ctx.db.get(late)] as [
					Doc<'segments'> | null,
					Doc<'segments'> | null,
				]
		);
		expect(firstSegment?.cachedCount).toBe(MATCHING);
		expect(lateSegment?.cachedCount).toBeUndefined();
	});
});
