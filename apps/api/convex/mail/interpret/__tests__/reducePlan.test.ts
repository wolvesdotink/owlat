/** The reducer's decisions (mail/interpret/reducePlan.ts), every edge. */

import { describe, expect, it } from 'vitest';
import type { Id, TableNames } from '../../../_generated/dataModel';
import {
	counterpartyKeyOf,
	planReduction,
	responsibilityOf,
	textSimilarity,
	type PlanFact,
	type PlanItem,
	type PlanOptions,
} from '../reducePlan';
import type { ReduceFact, ReduceItem, ReduceResult, ReduceTransition } from '../reduceInput';

const REV = 'rev-2';
const ev = (start = 0, end = 10) => ({ segmentId: 's0', start, end, quote: 'quoted words' });
const id = <T extends TableNames>(s: string) => s as Id<T>;

function stored(overrides: Partial<PlanItem> = {}): PlanItem {
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
		assertionText: 'Send the signed contract to Jonas',
		...overrides,
	} as PlanItem;
}

function proposal(overrides: Partial<ReduceItem> = {}): ReduceItem {
	return {
		intent: 'request',
		facets: ['file'],
		consequences: [],
		assertion: 'Send the quarterly report',
		display: { en: 'Send the quarterly report', de: 'Schick den Quartalsbericht' },
		requester: { email: 'jonas@example.com', isUs: false },
		responsible: { isUs: true },
		evidence: [ev()],
		verify: 'na',
		isReviewNeeded: false,
		...overrides,
	};
}

function transition(overrides: Partial<ReduceTransition> = {}): ReduceTransition {
	return {
		itemId: 'item_a',
		to: 'done',
		evidence: [ev(20, 30)],
		isVerified: true,
		isReviewNeeded: false,
		...overrides,
	};
}

function result(overrides: Partial<ReduceResult> = {}): ReduceResult {
	return {
		items: [],
		transitions: [],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		dropped: { grounding: 0, verify: 0 },
		...overrides,
	};
}

const SOURCE = { kind: 'mail' as const, id: id<'mailMessages'>('m2') };
const BRIEF: PlanOptions = { mode: 'brief', threadKind: 'mail', isOutOfOrder: false, source: SOURCE };

describe('items', () => {
	it('creates a new item for an unmatched proposal', () => {
		const plan = planReduction(
			{ items: [], facts: [] },
			result({ items: [proposal()] }),
			REV,
			BRIEF
		);
		expect(plan.inserts).toHaveLength(1);
		expect(plan.inserts[0]?.possibleDuplicateOfId).toBeUndefined();
	});

	it('merges evidence into the matched item instead of creating one', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({
				items: [
					proposal({ matchItemId: 'item_a', due: { phrase: 'by Friday', isAmbiguous: false } }),
				],
			}),
			REV,
			BRIEF
		);
		expect(plan.inserts).toHaveLength(0);
		expect(plan.patches[0]).toMatchObject({
			itemId: 'item_a',
			addEvidence: [ev()],
			fill: { due: { phrase: 'by Friday', isAmbiguous: false } },
			activity: { type: 'item_changed' },
		});
	});

	it('treats an unknown matchItemId as a new item', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ items: [proposal({ matchItemId: 'not_ours' })] }),
			REV,
			BRIEF
		);
		expect(plan.inserts).toHaveLength(1);
	});

	it('marks a near-identical new item as a possible duplicate, never merging it', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ items: [proposal({ assertion: 'Send the signed contract to Jonas please' })] }),
			REV,
			BRIEF
		);
		expect(plan.inserts[0]?.possibleDuplicateOfId).toBe('item_a');
	});

	it('flags a repeat of a closed item for review instead of reopening it', () => {
		const plan = planReduction(
			{
				items: [
					stored({
						status: 'done',
						completion: 'asserted',
						correction: { by: 'u', at: 1, kind: 'markedDone' },
					}),
				],
				facts: [],
			},
			result({ items: [proposal({ matchItemId: 'item_a' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]?.isReviewNeeded).toBe(true);
		expect(plan.patches[0]?.status).toBeUndefined();
	});

	it('upgrades a proposal item once a later message is verified', () => {
		const plan = planReduction(
			{ items: [stored({ verify: 'proposal' })], facts: [] },
			result({ items: [proposal({ matchItemId: 'item_a', verify: 'passed' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]?.verify).toBe('passed');
	});
});

describe('transitions', () => {
	it('closes an item as reported done when verified', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ transitions: [transition()] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({
			status: 'done',
			completion: 'reported',
			activity: {
				type: 'item_closed',
				delta: { statusFrom: 'open', statusTo: 'done', completion: 'reported' },
			},
		});
	});

	it('drops an unverified closing transition', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ transitions: [transition({ isVerified: false })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]?.status).toBeUndefined();
		expect(plan.dropped).toEqual([{ kind: 'transition', index: 0, reason: 'unverified' }]);
	});

	it('reopens a done item without verification (not a closing edge)', () => {
		const plan = planReduction(
			{ items: [stored({ status: 'done', completion: 'reported' })], facts: [] },
			result({ transitions: [transition({ to: 'open', isVerified: false })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({ status: 'open', activity: { type: 'item_reopened' } });
	});

	it('marks a replaced item superseded', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ transitions: [transition({ to: 'superseded' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({
			status: 'superseded',
			activity: { type: 'item_replaced' },
		});
	});

	it('never leaves superseded (terminal)', () => {
		const plan = planReduction(
			{ items: [stored({ status: 'superseded' })], facts: [] },
			result({ transitions: [transition({ to: 'open' })] }),
			REV,
			BRIEF
		);
		expect(plan.dropped[0]?.reason).toBe('illegal_edge');
	});

	it('lets the model neither untrack nor fail', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({
				transitions: [
					transition({ to: 'untracked' }),
					transition({ to: undefined, disposition: 'failed' }),
				],
			}),
			REV,
			BRIEF
		);
		expect(plan.dropped.map((d) => d.reason)).toEqual(['model_forbidden', 'model_forbidden']);
	});

	it('never reopens an untracked item (user-only edge)', () => {
		const plan = planReduction(
			{ items: [stored({ status: 'untracked' })], facts: [] },
			result({ transitions: [transition({ to: 'open' })] }),
			REV,
			BRIEF
		);
		expect(plan.dropped[0]?.reason).toBe('illegal_edge');
	});

	it('never flips a human correction; flags it instead', () => {
		const plan = planReduction(
			{
				items: [
					stored({
						status: 'done',
						completion: 'asserted',
						correction: { by: 'u', at: 1, kind: 'markedDone' },
					}),
				],
				facts: [],
			},
			result({ transitions: [transition({ to: 'open' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({ isReviewNeeded: true });
		expect(plan.patches[0]?.status).toBeUndefined();
		expect(plan.dropped[0]?.reason).toBe('corrected');
	});

	it('records a disposition on its own', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ transitions: [transition({ to: undefined, disposition: 'answered' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({
			disposition: 'answered',
			activity: {
				type: 'item_changed',
				delta: { dispositionFrom: 'unanswered', dispositionTo: 'answered' },
			},
		});
	});

	it('rejects an illegal disposition edge', () => {
		const plan = planReduction(
			{ items: [stored({ disposition: 'answered' })], facts: [] },
			result({ transitions: [transition({ to: undefined, disposition: 'accepted' })] }),
			REV,
			BRIEF
		);
		expect(plan.dropped[0]?.reason).toBe('illegal_edge');
	});

	it('ignores transitions on items of other threads', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ transitions: [transition({ itemId: 'item_zz' })] }),
			REV,
			BRIEF
		);
		expect(plan.dropped[0]?.reason).toBe('unknown_item');
	});

	it('lets an out-of-order message add items but not move status', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({ items: [proposal()], transitions: [transition()] }),
			REV,
			{ ...BRIEF, isOutOfOrder: true }
		);
		expect(plan.inserts).toHaveLength(1);
		expect(plan.dropped[0]?.reason).toBe('out_of_order');
	});
});

describe('facts', () => {
	const current: PlanFact = {
		_id: id<'threadFacts'>('fact_a'),
		factKey: '["meeting","date",""]',
		status: 'current',
		revision: 1,
		evidence: [],
		value: { kind: 'date', at: 1000 },
		assertionText: 'The meeting is on Monday',
	};
	const fact = (overrides: Partial<ReduceFact> = {}): ReduceFact => ({
		key: '["meeting","date",""]',
		assertion: 'The meeting is on Monday',
		display: { en: 'Meeting on Monday', de: 'Treffen am Montag' },
		value: { kind: 'date', at: 1000 },
		evidence: [ev()],
		isVerified: false,
		isReviewNeeded: false,
		...overrides,
	});

	it('adds evidence to a restated fact', () => {
		const plan = planReduction(
			{ items: [], facts: [current] },
			result({ facts: [fact()] }),
			REV,
			BRIEF
		);
		expect(plan.facts).toEqual([{ kind: 'evidence', factId: 'fact_a', addEvidence: [ev()] }]);
	});

	it('retires the old fact on a verified supersession', () => {
		const plan = planReduction(
			{ items: [], facts: [current] },
			result({
				facts: [
					fact({ value: { kind: 'date', at: 2000 }, supersedes: 'fact_a', isVerified: true }),
				],
			}),
			REV,
			BRIEF
		);
		expect(plan.facts.map((f) => f.kind)).toEqual(['supersede', 'insert']);
		expect(plan.facts[1]).toMatchObject({ supersedesId: 'fact_a' });
	});

	it('stores an unverified supersession as a conflict', () => {
		const plan = planReduction(
			{ items: [], facts: [current] },
			result({ facts: [fact({ value: { kind: 'date', at: 2000 }, supersedes: 'fact_a' })] }),
			REV,
			BRIEF
		);
		expect(plan.facts).toEqual([
			expect.objectContaining({ kind: 'insert', conflictsWithId: 'fact_a' }),
		]);
	});

	it('stores a changed value under the same key as a conflict', () => {
		const plan = planReduction(
			{ items: [], facts: [current] },
			result({ facts: [fact({ value: { kind: 'date', at: 5000 } })] }),
			REV,
			BRIEF
		);
		expect(plan.facts[0]).toMatchObject({ kind: 'insert', conflictsWithId: 'fact_a' });
	});

	it('writes no facts in actions mode or on team threads', () => {
		expect(
			planReduction({ items: [], facts: [] }, result({ facts: [fact()] }), REV, {
				...BRIEF,
				mode: 'actions',
			}).facts
		).toEqual([]);
		expect(
			planReduction({ items: [], facts: [] }, result({ facts: [fact()] }), REV, {
				...BRIEF,
				threadKind: 'team',
			}).facts
		).toEqual([]);
	});
});

describe('review round 1', () => {
	it('keeps the same words quoted from another message as a second reference (F6)', () => {
		const item = stored({
			evidence: [
				{
					source: { kind: 'mail', id: id<'mailMessages'>('m1') },
					segmentId: 's0',
					start: 0,
					end: 10,
					contentRevision: REV,
				},
			],
		});
		const plan = planReduction(
			{ items: [item], facts: [] },
			result({ items: [proposal({ matchItemId: 'item_a' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]?.addEvidence).toEqual([ev()]);
		// The same span from the same message is not added twice.
		const again = planReduction(
			{ items: [item], facts: [] },
			result({ items: [proposal({ matchItemId: 'item_a' })] }),
			REV,
			{ ...BRIEF, source: { kind: 'mail', id: id<'mailMessages'>('m1') } }
		);
		expect(again.patches[0]?.addEvidence).toBeUndefined();
	});

	it('drops every effect of an unverified closing claim, disposition included (F7)', () => {
		const plan = planReduction(
			{ items: [stored()], facts: [] },
			result({
				transitions: [transition({ to: 'declined', disposition: 'declined', isVerified: false })],
			}),
			REV,
			BRIEF
		);
		expect(plan.patches).toEqual([]);
		expect(plan.dropped).toEqual([{ kind: 'transition', index: 0, reason: 'unverified' }]);
	});

	it('merges only a proven restatement of a fact (F8)', () => {
		const noValue: PlanFact = {
			_id: id<'threadFacts'>('fact_b'),
			factKey: '["venue","address",""]',
			status: 'current',
			revision: 1,
			evidence: [],
			assertionText: 'The venue is Hall 3',
		};
		const claim = (assertion: string): ReduceFact => ({
			key: '["venue","address",""]',
			assertion,
			display: { en: assertion, de: assertion },
			evidence: [ev()],
			isVerified: false,
			isReviewNeeded: false,
		});
		const same = planReduction({ items: [], facts: [noValue] }, result({ facts: [claim('The venue is hall 3.')] }), REV, BRIEF);
		expect(same.facts[0]).toMatchObject({ kind: 'evidence', factId: 'fact_b' });
		const other = planReduction({ items: [], facts: [noValue] }, result({ facts: [claim('The venue is Hall 7')] }), REV, BRIEF);
		expect(other.facts[0]).toMatchObject({ kind: 'insert', conflictsWithId: 'fact_b' });
		// A value on one side only is not proof either.
		const withValue = planReduction(
			{ items: [], facts: [noValue] },
			result({ facts: [{ ...claim('The venue is Hall 3'), value: { kind: 'text', text: 'Hall 3' } }] }),
			REV,
			BRIEF
		);
		expect(withValue.facts[0]).toMatchObject({ kind: 'insert', conflictsWithId: 'fact_b' });
	});

	it('keeps the conflicting quotes on a corrected item and flags it (F16)', () => {
		const plan = planReduction(
			{ items: [stored({ status: 'untracked', correction: { by: 'u', at: 1, kind: 'untracked' } })], facts: [] },
			result({ transitions: [transition({ to: 'open' })] }),
			REV,
			BRIEF
		);
		expect(plan.patches[0]).toMatchObject({ isReviewNeeded: true, addEvidence: [ev(20, 30)] });
		expect(plan.patches[0]?.status).toBeUndefined();
	});
});

describe('helpers', () => {
	it('derives responsibility from the responsible party', () => {
		expect(responsibilityOf({ isUs: true })).toBe('us');
		expect(responsibilityOf({ email: 'a@example.com', isUs: false })).toBe('them');
		expect(responsibilityOf({ isUs: false })).toBe('unclear');
	});

	it('keys the counterparty by the other side', () => {
		expect(
			counterpartyKeyOf({
				requester: { email: 'Jonas@Example.com', isUs: false },
				responsible: { isUs: true },
			})
		).toBe('jonas@example.com');
		expect(
			counterpartyKeyOf({ requester: { isUs: true }, responsible: { isUs: true } })
		).toBeUndefined();
	});

	it('scores similar sentences high and unrelated ones low', () => {
		expect(textSimilarity('Send the signed contract', 'send the SIGNED contract')).toBe(1);
		expect(textSimilarity('Send the contract', 'Book a meeting room')).toBeLessThan(0.2);
	});
});
