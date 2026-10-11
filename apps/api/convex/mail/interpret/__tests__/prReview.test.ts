/**
 * PR #1331 owner review. PR-1: a verified claim from a NEWER message changes a
 * term the item states differently (deadline, amount), per field by its
 * source stamp; a confirmed item holds it instead. PR-2: held field changes
 * merge by their sources' message times, newest wins.
 */

import { describe, expect, it } from 'vitest';
import type { Id, TableNames } from '../../../_generated/dataModel';
import { planReduction, type PlanItem, type PlanOptions } from '../reducePlan';
import type { ReduceItem, ReduceResult } from '../reduceInput';
import { applyPlan, mergeHeld, type MemItem, type MemState } from '../fold';

const id = <T extends TableNames>(s: string) => s as Id<T>;
const FRIDAY = { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false };
const MONDAY = { phrase: 'Monday instead', at: Date.UTC(2026, 9, 12), isAmbiguous: false };
const OLD = { sourceKey: 'mail:m1', at: 1000 };

function tracked(overrides: Partial<PlanItem> = {}): PlanItem {
	return {
		_id: id<'threadItems'>('item_a'),
		status: 'open',
		disposition: 'unanswered',
		intent: 'request',
		revision: 1,
		evidence: [
			{
				source: { kind: 'mail', id: id<'mailMessages'>('m1') },
				segmentId: 's0',
				start: 0,
				end: 10,
				contentRevision: 'rev-1',
			},
		],
		verify: 'passed',
		due: FRIDAY,
		amount: { value: 100, currency: 'EUR' },
		fieldSources: { due: OLD, amount: OLD },
		assertionText: 'Send the signed contract',
		...overrides,
	} as PlanItem;
}

function claim(overrides: Partial<ReduceItem> = {}): ReduceItem {
	return {
		matchItemId: 'item_a',
		intent: 'request',
		facets: ['file'],
		consequences: [],
		assertion: 'Actually, send it Monday instead',
		display: { en: 'Send it Monday', de: 'Schick es Montag' },
		requester: { email: 'jonas@example.com', isUs: false },
		responsible: { isUs: true },
		evidence: [{ segmentId: 's0', start: 0, end: 14, quote: 'Monday instead' }],
		verify: 'passed',
		isReviewNeeded: false,
		...overrides,
	};
}

const result = (items: ReduceItem[]): ReduceResult => ({
	items,
	transitions: [],
	replyIntent: 'request_for_action',
	urgency: 'normal',
	dropped: { grounding: 0, verify: 0 },
});

const at = (sourceAt: number): PlanOptions => ({
	mode: 'brief',
	threadKind: 'mail',
	isOutOfOrder: false,
	source: { kind: 'mail', id: id<'mailMessages'>('m2') },
	sourceAt,
});

describe('PR-1: a newer verified claim changes the terms it states', () => {
	it('due Friday, then a newer verified "Monday instead": the deadline is Monday', () => {
		const plan = planReduction(
			{ items: [tracked()], facts: [] },
			result([claim({ due: MONDAY })]),
			'r',
			at(2000)
		);
		expect(plan.patches[0]?.fill).toEqual({ due: MONDAY });
		// Applied, it names the newer message as the deadline's source.
		const item = { ...tracked(), isNew: false, askedAt: 1 } as unknown as MemItem;
		const state: MemState = { items: new Map([['item_a', item]]), facts: new Map() };
		applyPlan(state, plan, {
			source: at(2000).source,
			sourceKey: 'mail:m2',
			contentRevision: 'r',
			sourceAt: 2000,
		});
		expect(item.due).toEqual(MONDAY);
		expect(item.fieldSources?.due).toEqual({ sourceKey: 'mail:m2', at: 2000 });
		expect(item.fieldSources?.amount).toEqual(OLD);
	});

	it('a revised invoice amount from a newer verified message replaces the old one', () => {
		const plan = planReduction(
			{ items: [tracked()], facts: [] },
			result([claim({ amount: { value: 120, currency: 'EUR' } })]),
			'r',
			at(2000)
		);
		expect(plan.patches[0]?.fill).toEqual({ amount: { value: 120, currency: 'EUR' } });
	});

	it('an older verified claim never overwrites a newer term; it is reported', () => {
		const plan = planReduction(
			{
				items: [tracked({ fieldSources: { due: { sourceKey: 'mail:m3', at: 3000 } } })],
				facts: [],
			},
			result([claim({ due: MONDAY })]),
			'r',
			at(2000)
		);
		expect(plan.patches[0]?.fill).toBeUndefined();
		expect(plan.dropped).toContainEqual({ kind: 'item', index: 0, reason: 'out_of_order' });
		expect(plan.patches[0]?.addEvidence).toHaveLength(1);
	});

	it('on a confirmed item the newer value waits as a pending update', () => {
		const plan = planReduction(
			{
				items: [tracked({ correction: { by: 'user-A', at: 1, kind: 'confirmed' } })],
				facts: [],
			},
			result([claim({ due: MONDAY, amount: { value: 120, currency: 'EUR' } })]),
			'r',
			at(2000)
		);
		expect(plan.patches[0]?.fill).toBeUndefined();
		expect(plan.patches[0]?.pendingUpdate).toMatchObject({
			due: MONDAY,
			amount: { value: 120, currency: 'EUR' },
		});
		expect(plan.patches[0]?.isReviewNeeded).toBe(true);
	});
});

describe('PR-2: held field changes merge by their sources', () => {
	it('pending EUR 200 stamped at 200, then a late EUR 100 stamped at 100: EUR 200 stays', () => {
		const merged = mergeHeld(
			{
				evidence: [],
				amount: { value: 200, currency: 'EUR' },
				fieldSources: [{ field: 'amount', sourceKey: 'mail:new', at: 200 }],
			},
			{
				evidence: [],
				amount: { value: 100, currency: 'EUR' },
				fieldSources: [{ field: 'amount', sourceKey: 'mail:old', at: 100 }],
			}
		);
		expect(merged.amount).toEqual({ value: 200, currency: 'EUR' });
		expect(merged.fieldSources).toEqual([{ field: 'amount', sourceKey: 'mail:new', at: 200 }]);
	});

	it('an older removal does not erase a newer value; a newer removal does', () => {
		const newer = {
			evidence: [],
			amount: { value: 200, currency: 'EUR' },
			fieldSources: [{ field: 'amount' as const, sourceKey: 'mail:new', at: 200 }],
		};
		const removal = (stampAt: number) => ({
			evidence: [],
			removes: ['amount' as const],
			fieldSources: [{ field: 'amount' as const, sourceKey: 'mail:x', at: stampAt }],
		});
		const kept = mergeHeld(newer, removal(100));
		expect(kept.amount).toEqual({ value: 200, currency: 'EUR' });
		expect(kept.removes).toBeUndefined();
		const removed = mergeHeld(newer, removal(300));
		expect(removed.amount).toBeUndefined();
		expect(removed.removes).toEqual(['amount']);
	});

	it('per field, with quotes always merged; a tie goes to the later applied', () => {
		const quote = (n: number) => ({
			source: { kind: 'mail' as const, id: id<'mailMessages'>(`m${n}`) },
			contentRevision: 'r',
			segmentId: 's0',
			start: n,
			end: n + 1,
		});
		const merged = mergeHeld(
			{
				evidence: [quote(1)],
				amount: { value: 200, currency: 'EUR' },
				due: FRIDAY,
				fieldSources: [
					{ field: 'amount', sourceKey: 'mail:a', at: 200 },
					{ field: 'due', sourceKey: 'mail:a', at: 200 },
				],
			},
			{
				evidence: [quote(2)],
				amount: { value: 100, currency: 'EUR' },
				due: MONDAY,
				fieldSources: [
					{ field: 'amount', sourceKey: 'mail:b', at: 100 },
					{ field: 'due', sourceKey: 'mail:b', at: 200 },
				],
			}
		);
		expect(merged.amount).toEqual({ value: 200, currency: 'EUR' });
		expect(merged.due).toEqual(MONDAY);
		expect(merged.evidence).toHaveLength(2);
	});
});
