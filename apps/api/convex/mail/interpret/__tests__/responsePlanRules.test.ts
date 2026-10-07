/**
 * The response plan's pure rules (SPEC §6): which items a plan holds, the
 * default stances, the owner's choices over them, the draft hash, the verdict,
 * and every objection of the `item_coverage` gate.
 */

import { describe, expect, it } from 'vitest';
import { stanceChoicesFor } from '@owlat/shared/threadBriefRules';
import {
	draftHashOf,
	isPlanRelevant,
	itemCoverageObjections,
	itemCoverageReason,
	planStances,
	planVerdictOf,
	type ItemCoverageInput,
	type PlanStance,
} from '../responsePlanRules';

describe('isPlanRelevant', () => {
	it('holds open, tracked items that are ours or unclear', () => {
		expect(isPlanRelevant({ status: 'open', responsibility: 'us', verify: 'passed' })).toBe(true);
		expect(isPlanRelevant({ status: 'open', responsibility: 'unclear', verify: 'na' })).toBe(true);
		expect(isPlanRelevant({ status: 'open', responsibility: 'them', verify: 'passed' })).toBe(
			false
		);
		expect(isPlanRelevant({ status: 'open', responsibility: 'us', verify: 'proposal' })).toBe(
			false
		);
		expect(isPlanRelevant({ status: 'done', responsibility: 'us', verify: 'passed' })).toBe(false);
	});
});

describe('planStances', () => {
	const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

	it('starts every item at answer, and at clarify while its slot is open', () => {
		expect(planStances(items, [], new Set(['b']))).toEqual([
			{ itemId: 'a', stance: 'answer', source: 'default' },
			{ itemId: 'b', stance: 'clarify', source: 'default' },
			{ itemId: 'c', stance: 'answer', source: 'default' },
		]);
	});

	it('keeps the owner’s and a policy’s choice, recomputes a stored default', () => {
		const chosen: PlanStance[] = [
			{ itemId: 'a', stance: 'accept', source: 'owner' },
			{ itemId: 'b', stance: 'clarify', source: 'default' },
			{ itemId: 'c', stance: 'decline', source: 'policy' },
			{ itemId: 'gone', stance: 'skip', source: 'owner' },
		];
		expect(planStances(items, chosen, new Set())).toEqual([
			{ itemId: 'a', stance: 'accept', source: 'owner' },
			{ itemId: 'b', stance: 'answer', source: 'default' },
			{ itemId: 'c', stance: 'decline', source: 'policy' },
		]);
	});

	it('never accepts by default', () => {
		const stances = planStances(items, [], new Set(['a']));
		expect(stances.some((s) => s.stance === 'accept')).toBe(false);
	});
});

describe('stanceChoicesFor', () => {
	it('offers accept for decisions and money, answer for questions and files', () => {
		expect(stanceChoicesFor('decision', [])).toEqual(['accept', 'decline', 'defer', 'clarify']);
		expect(stanceChoicesFor('request', ['payment'])).toEqual([
			'accept',
			'decline',
			'defer',
			'clarify',
		]);
		expect(stanceChoicesFor('request', ['file'])).toEqual(['answer', 'decline', 'defer']);
		// A signed contract to send is answered with the file, not "accepted".
		expect(stanceChoicesFor('request', ['file', 'signature'])).toEqual([
			'answer',
			'decline',
			'defer',
		]);
		expect(stanceChoicesFor('request', ['information'])).toEqual(['answer', 'decline', 'defer']);
		expect(stanceChoicesFor('question', ['payment'])).toEqual(['answer', 'decline', 'defer']);
		expect(stanceChoicesFor('request', [])).toEqual(['accept', 'decline', 'defer']);
		expect(stanceChoicesFor('promise', [])).toEqual(['answer', 'defer']);
	});
});

describe('draftHashOf', () => {
	it('ignores whitespace runs and trailing space, not the words', async () => {
		const a = await draftHashOf('Hi Jonas,\n\nthe quote is  approved.  ');
		expect(a).toHaveLength(32);
		expect(await draftHashOf('Hi Jonas,\r\n\r\n\r\nthe quote is approved.')).toBe(a);
		expect(await draftHashOf('Hi Jonas,\n\nthe quote is declined.')).not.toBe(a);
	});
});

describe('planVerdictOf', () => {
	const stances: PlanStance[] = [
		{ itemId: 'a', stance: 'answer', source: 'default' },
		{ itemId: 'b', stance: 'skip', source: 'owner' },
	];

	it('is covered when every answered item is addressed and every file attached', () => {
		expect(
			planVerdictOf(stances, {
				coverage: [{ itemId: 'a', verdict: 'addressed', spans: [] }],
				fileClaims: [{ text: 'attached', spans: [], isMatched: true }],
			})
		).toBe('covered');
	});

	it('has gaps for a partial item or a missing file', () => {
		expect(
			planVerdictOf(stances, {
				coverage: [{ itemId: 'a', verdict: 'partial', spans: [] }],
				fileClaims: [],
			})
		).toBe('gaps');
		expect(
			planVerdictOf(stances, {
				coverage: [{ itemId: 'a', verdict: 'addressed', spans: [] }],
				fileClaims: [{ text: 'attached', spans: [], isMatched: false }],
			})
		).toBe('gaps');
	});
});

describe('itemCoverageObjections', () => {
	function input(overrides: Partial<ItemCoverageInput> = {}): ItemCoverageInput {
		return {
			plan: {
				draftHash: 'h1',
				threadRevision: 3,
				itemRevisions: [
					{ itemId: 'a', revision: 1 },
					{ itemId: 'b', revision: 2 },
				],
				stances: [
					{ itemId: 'a', stance: 'answer', source: 'default' },
					{ itemId: 'b', stance: 'answer', source: 'default' },
				],
				coverage: [
					{ itemId: 'a', verdict: 'addressed', spans: [{ start: 0, end: 5 }] },
					{ itemId: 'b', verdict: 'addressed', spans: [{ start: 6, end: 9 }] },
				],
				fileClaims: [],
				newPromises: [],
			},
			draftHash: 'h1',
			threadRevision: 3,
			completeness: 'complete',
			items: [
				{ id: 'a', revision: 1, responsibility: 'us' },
				{ id: 'b', revision: 2, responsibility: 'us' },
			],
			...overrides,
		};
	}
	const plan = input().plan!;

	it('has nothing to object to for a covered, current plan', () => {
		expect(itemCoverageObjections(input())).toEqual([]);
		expect(itemCoverageReason([])).toBeNull();
	});

	it('objects without a plan', () => {
		expect(itemCoverageObjections(input({ plan: null }))).toEqual(['no_plan']);
	});

	it('objects to a plan for another draft text', () => {
		expect(itemCoverageObjections(input({ draftHash: 'h2' }))).toEqual(['stale_draft']);
		expect(itemCoverageObjections(input({ draftHash: null }))).toEqual(['stale_draft']);
	});

	it('objects when the thread or an item moved since the check', () => {
		expect(itemCoverageObjections(input({ threadRevision: 4 }))).toEqual(['stale_items']);
		expect(
			itemCoverageObjections(
				input({
					items: [
						{ id: 'a', revision: 2, responsibility: 'us' },
						{ id: 'b', revision: 2, responsibility: 'us' },
					],
				})
			)
		).toEqual(['stale_items']);
		// A new open item the plan never saw.
		expect(
			itemCoverageObjections(
				input({
					items: [...input().items, { id: 'c', revision: 1, responsibility: 'us' }],
				})
			)
		).toEqual(['stale_items']);
	});

	it('objects while interpretation is incomplete', () => {
		expect(itemCoverageObjections(input({ completeness: 'partial' }))).toEqual(['incomplete']);
	});

	it('objects to an item that is not addressed, or still needs the owner', () => {
		expect(
			itemCoverageObjections(
				input({
					plan: {
						...plan,
						coverage: [{ itemId: 'a', verdict: 'addressed', spans: [] }],
					},
				})
			)
		).toEqual(['not_addressed']);
		expect(
			itemCoverageObjections(
				input({
					plan: {
						...plan,
						stances: [
							{ itemId: 'a', stance: 'clarify', source: 'default' },
							{ itemId: 'b', stance: 'answer', source: 'default' },
						],
					},
				})
			)
		).toEqual(['not_addressed']);
	});

	it('passes over an item deliberately skipped', () => {
		expect(
			itemCoverageObjections(
				input({
					plan: {
						...plan,
						stances: [
							{ itemId: 'a', stance: 'answer', source: 'default' },
							{ itemId: 'b', stance: 'skip', source: 'policy' },
						],
						coverage: [{ itemId: 'a', verdict: 'addressed', spans: [] }],
					},
				})
			)
		).toEqual([]);
	});

	it('objects to an item whose owner is unclear', () => {
		expect(
			itemCoverageObjections(
				input({
					items: [
						{ id: 'a', revision: 1, responsibility: 'us' },
						{ id: 'b', revision: 2, responsibility: 'unclear' },
					],
				})
			)
		).toEqual(['unclear_owner']);
	});

	it('objects to a commitment no stance authorised', () => {
		expect(
			itemCoverageObjections(input({ plan: { ...plan, newPromises: [{ itemId: undefined }] } }))
		).toEqual(['unauthorized_commitment']);
		// Answering an item is not accepting it.
		expect(
			itemCoverageObjections(input({ plan: { ...plan, newPromises: [{ itemId: 'a' }] } }))
		).toEqual(['unauthorized_commitment']);
		// The owner accepted it: the commitment is authorised.
		expect(
			itemCoverageObjections(
				input({
					plan: {
						...plan,
						stances: [
							{ itemId: 'a', stance: 'accept', source: 'owner' },
							{ itemId: 'b', stance: 'answer', source: 'default' },
						],
						newPromises: [{ itemId: 'a' }],
					},
				})
			)
		).toEqual([]);
	});

	it('objects to a file the draft says is attached and is not', () => {
		expect(
			itemCoverageObjections(input({ plan: { ...plan, fileClaims: [{ isMatched: false }] } }))
		).toEqual(['file_missing']);
		expect(
			itemCoverageObjections(input({ plan: { ...plan, fileClaims: [{ isMatched: true }] } }))
		).toEqual([]);
	});

	it('names every objection in the reason', () => {
		const reason = itemCoverageReason(['not_addressed', 'file_missing']);
		expect(reason).toContain('not addressed');
		expect(reason).toContain('file is attached that is not');
		expect(reason).toContain('routing to human review');
	});
});
