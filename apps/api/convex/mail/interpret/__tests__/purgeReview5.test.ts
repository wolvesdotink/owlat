/**
 * Review round 5 regressions of the thread brief erasure (Sol F2–F5): the
 * counterparty follows the final parties, responsibility is reset on its own,
 * a responsibility refill keeps the surviving responsible party, and the
 * survivor check costs no reads.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Doc, Id } from '../../../_generated/dataModel';
import { MAX_RANGE_READS, unitBudget, type DrainBudget } from '../purgeDrain';
import { drivePurgeJob } from '../purgeRun';
import { applyRefill, refillPatch } from '../redactedRefill';
import { modules, reduceItem, seedMailThread, type Test } from './interpret.testlib';
import { SENT, addSibling, insertItem } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

let jobs = 0;
async function drive(
	t: Test,
	fields: Parameters<typeof drivePurgeJob>[2],
	budget: () => DrainBudget = () => unitBudget(400)
): Promise<void> {
	const key = `test-${jobs++}`;
	for (let slice = 1; slice <= 200; slice++) {
		if (await t.run((ctx) => drivePurgeJob(ctx, key, fields, budget()))) return;
	}
	throw new Error('purge never finished');
}

async function pair(t: Test) {
	const { messageId: a, threadId } = await seedMailThread(t);
	const c = await addSibling(t, a);
	return {
		ref: { kind: 'mail' as const, id: threadId },
		srcA: { kind: 'mail' as const, id: a },
		srcC: { kind: 'mail' as const, id: c },
	};
}

describe('F2: the counterparty follows the final parties', () => {
	it('an unstamped requester and a purged responsible stamp leave no erased address behind', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcA, srcC } = await pair(t);
		const itemId = await t.run((ctx) =>
			insertItem(ctx, ref, [srcA, srcC], {
				requester: { email: 'ann@example.com', name: 'Ann', isUs: false },
				responsible: { email: 'bob@example.com', isUs: false },
				responsibility: 'them',
				counterpartyKey: 'ann@example.com',
				fieldSources: { responsible: { sourceKey: `mail:${srcA.id}`, at: SENT } },
			})
		);

		await drive(t, { ref, kind: 'sources', sources: [srcA] });

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(item.requester).toEqual({ isUs: false });
		expect(item.responsible).toEqual({ isUs: false });
		expect(item.counterpartyKey).toBeUndefined();
	});
});

describe('F3: responsibility is reset on its own', () => {
	it('keeps a responsible party whose provenance survives', async () => {
		const t = convexTest(schema, modules);
		const { ref, srcA, srcC } = await pair(t);
		const bob = { email: 'bob@example.com', name: 'Bob', isUs: false };
		const itemId = await t.run((ctx) =>
			insertItem(ctx, ref, [srcA, srcC], {
				responsible: bob,
				responsibility: 'them',
				fieldSources: {
					wording: { sourceKey: `mail:${srcC.id}`, at: SENT },
					requester: { sourceKey: `mail:${srcC.id}`, at: SENT },
					responsible: { sourceKey: `mail:${srcC.id}`, at: SENT },
				},
			})
		);

		await drive(t, { ref, kind: 'sources', sources: [srcA] });

		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		expect(item.responsible).toEqual(bob);
		expect(item.responsibility).toBe('unclear');
		expect(item.fieldSources?.responsible?.sourceKey).toBe(`mail:${srcC.id}`);
		expect(item.redactedFields).toContain('responsibility');
		expect(item.redactedFields).not.toContain('responsible');
	});
});

describe('F4: a responsibility refill keeps the surviving responsible party', () => {
	it('derives responsibility from the claim, but Bob and his C stamp stay', () => {
		const bob = { email: 'bob@example.com', name: 'Bob', isUs: false };
		const item: Parameters<typeof applyRefill>[0] = {
			redactedFields: ['responsibility'],
			fieldSources: { responsible: { sourceKey: 'mail:c', at: SENT } },
		};
		const claim = reduceItem({
			responsible: { email: 'me@owlat.test', name: 'Alice', isUs: true },
		});

		applyRefill(item, claim, ['responsibility'], { sourceKey: 'mail:a', at: SENT + 1 });
		const { patch } = refillPatch(
			{ requester: { isUs: false }, responsible: bob, responsibility: 'unclear' } as Pick<
				Doc<'threadItems'>,
				'requester' | 'responsible' | 'responsibility'
			>,
			item.refilled!
		);

		expect(patch.responsible).toBeUndefined();
		expect(patch.responsibility).toBe('us');
		expect(item.fieldSources?.responsible?.sourceKey).toBe('mail:c');
		expect(item.fieldSources?.responsibility?.sourceKey).toBe('mail:a');
		expect(item.redactedFields).toBeUndefined();
	});
});

describe('F5: the survivor check makes no reads', () => {
	it('an item backed by 1,100 surviving sources stays under the range-read cap', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const itemId = await t.run(async (ctx) => {
			const { _id, _creationTime, ...first } = (await ctx.db.get(a))!;
			const survivors: Id<'mailMessages'>[] = [];
			for (let i = 0; i < 1100; i++) {
				survivors.push(await ctx.db.insert('mailMessages', { ...first, uid: first.uid + i + 1 }));
			}
			return insertItem(
				ctx,
				ref,
				[{ kind: 'mail', id: a }, ...survivors.map((id) => ({ kind: 'mail' as const, id }))],
				{ lineageKeys: [`mail:${a}#one`, ...survivors.map((id) => `mail:${id}#claim`)] }
			);
		});
		let maxRanges = 0;
		const counting = (): DrainBudget => {
			const budget = unitBudget(1_000_000, 1024 * 1024 * 1024);
			let ranges = 0;
			return {
				...budget,
				range: () => {
					ranges += 1;
					maxRanges = Math.max(maxRanges, ranges);
					budget.range();
				},
			};
		};

		await drive(t, { ref, kind: 'sources', sources: [{ kind: 'mail', id: a }] }, counting);

		expect(maxRanges).toBeLessThanOrEqual(MAX_RANGE_READS);
		const item = (await t.run((ctx) => ctx.db.get(itemId)))!;
		// A surviving source still claims it: its facets stay.
		expect(item.redactedFields).not.toContain('facets');
	});
});
