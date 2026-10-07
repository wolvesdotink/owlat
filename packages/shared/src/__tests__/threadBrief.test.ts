import { describe, expect, it } from 'vitest';
import {
	ACTIVITY_ACTORS,
	ACTIVITY_TYPES,
	defaultActivityVisibility,
	factKeyString,
	ITEM_DISPOSITIONS,
	ITEM_REACTIONS,
	ITEM_STATE_KEYS,
	ITEM_STATUSES,
	type ItemStatus,
} from '../threadBrief';
import {
	compareForYou,
	isConsequential,
	isLegalDispositionEdge,
	isLegalStatusEdge,
	itemFacetRisk,
	itemStateKey,
	LEGAL_STATUS_EDGES,
	primaryReaction,
	secondaryReactions,
	type ForYouSortable,
} from '../threadBriefRules';

describe('itemStateKey', () => {
	it('maps every stored combination the plan names', () => {
		expect(itemStateKey({ status: 'open', disposition: 'unanswered' })).toBe('open');
		expect(itemStateKey({ status: 'open', disposition: 'failed' })).toBe('open');
		expect(itemStateKey({ status: 'open', disposition: 'answered' })).toBe('answeredStillToDo');
		expect(itemStateKey({ status: 'open', disposition: 'accepted' })).toBe('answeredStillToDo');
		expect(itemStateKey({ status: 'open', disposition: 'deferred' })).toBe('answeredStillToDo');
		expect(itemStateKey({ status: 'done', disposition: 'answered', completion: 'recorded' })).toBe(
			'done'
		);
		expect(itemStateKey({ status: 'done', disposition: 'unanswered' })).toBe('done');
		expect(
			itemStateKey({ status: 'done', disposition: 'unanswered', completion: 'asserted' })
		).toBe('markedDoneByYou');
		expect(
			itemStateKey({ status: 'done', disposition: 'unanswered', completion: 'reported' })
		).toBe('reportedDone');
		expect(itemStateKey({ status: 'declined', disposition: 'declined' })).toBe('declined');
		expect(itemStateKey({ status: 'superseded', disposition: 'unanswered' })).toBe('replaced');
		expect(itemStateKey({ status: 'untracked', disposition: 'unanswered' })).toBe('notTracked');
	});

	it('computes addressedInDraft for open items only', () => {
		const opts = { addressedInDraft: true };
		expect(itemStateKey({ status: 'open', disposition: 'unanswered' }, opts)).toBe(
			'addressedInDraft'
		);
		expect(itemStateKey({ status: 'open', disposition: 'deferred' }, opts)).toBe(
			'addressedInDraft'
		);
		expect(itemStateKey({ status: 'done', disposition: 'answered' }, opts)).toBe('done');
		expect(itemStateKey({ status: 'declined', disposition: 'declined' }, opts)).toBe('declined');
	});

	it('only ever returns a declared state key', () => {
		for (const status of ITEM_STATUSES) {
			for (const disposition of ITEM_DISPOSITIONS) {
				for (const completion of [undefined, 'recorded', 'asserted', 'reported'] as const) {
					const key = itemStateKey({ status, disposition, completion });
					expect(ITEM_STATE_KEYS).toContain(key);
				}
			}
		}
	});
});

describe('primaryReaction', () => {
	it('follows the plan §5 table', () => {
		expect(primaryReaction('question', [], 'us')).toBe('reply');
		expect(primaryReaction('request', ['file'], 'us')).toBe('attach');
		expect(primaryReaction('request', ['file', 'signature'], 'us')).toBe('attach');
		expect(primaryReaction('request', ['meeting'], 'us')).toBe('proposeTimes');
		expect(primaryReaction('decision', ['payment'], 'us')).toBe('replyWithStance');
		expect(primaryReaction('request', ['payment'], 'us', { noReplyNeeded: true })).toBe('markPaid');
		expect(primaryReaction('promise', [], 'us')).toBe('markDone');
		expect(primaryReaction('promise', ['file'], 'them')).toBe('nudge');
		expect(primaryReaction('request', ['file'], 'them')).toBe('nudge');
	});

	it('falls back to reply for a plain request and for unclear ownership', () => {
		expect(primaryReaction('request', [], 'us')).toBe('reply');
		expect(primaryReaction('request', ['payment'], 'us')).toBe('reply');
		expect(primaryReaction('question', [], 'unclear')).toBe('reply');
	});

	it('lists the ⋯ menu reactions without repeating the primary', () => {
		expect(secondaryReactions('question', [], 'us')).toEqual(['remind', 'notARequest']);
		expect(secondaryReactions('request', ['file'], 'us')).toEqual(['reply', 'decline', 'markDone']);
		expect(secondaryReactions('request', ['meeting'], 'us')).toEqual(['reply', 'decline']);
		expect(secondaryReactions('decision', ['payment'], 'us')).toEqual(['remind', 'assign']);
		expect(secondaryReactions('request', ['payment'], 'us', { noReplyNeeded: true })).toEqual([
			'remind',
			'notARequest',
		]);
		expect(secondaryReactions('promise', [], 'us')).toEqual(['replyWithUpdate', 'remind']);
		expect(secondaryReactions('request', [], 'them')).toEqual(['markReceived', 'untrack']);
		for (const intent of ['question', 'request', 'decision', 'promise'] as const) {
			const primary = primaryReaction(intent, ['file'], 'us');
			const also = secondaryReactions(intent, ['file'], 'us');
			expect(also).not.toContain(primary);
			for (const reaction of [primary, ...also]) expect(ITEM_REACTIONS).toContain(reaction);
		}
	});
});

describe('compareForYou', () => {
	const item = (over: Partial<ForYouSortable>): ForYouSortable => ({
		facets: [],
		askedAt: 1000,
		...over,
	});

	it('orders by due date, undated last', () => {
		const list = [
			item({ id: 'c' }),
			item({ id: 'b', due: { at: 2000 } }),
			item({ id: 'a', due: { at: 1000 } }),
			item({ id: 'd', due: { at: null } }),
		];
		expect(list.sort(compareForYou).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('then by facet risk, then by age, then by id', () => {
		const list = [
			item({ id: 'meeting', facets: ['meeting'] }),
			item({ id: 'payment', facets: ['information', 'payment'] }),
			item({ id: 'old', askedAt: 10 }),
			item({ id: 'z', askedAt: 500 }),
			item({ id: 'y', askedAt: 500 }),
		];
		expect(list.sort(compareForYou).map((i) => i.id)).toEqual([
			'payment',
			'meeting',
			'old',
			'y',
			'z',
		]);
	});

	it('ranks facet risk payment > signature > access > documentReview > file > meeting > information', () => {
		const order = [
			'payment',
			'signature',
			'access',
			'documentReview',
			'file',
			'meeting',
			'information',
		] as const;
		const risks = order.map((facet) => itemFacetRisk([facet]));
		expect([...risks].sort((a, b) => b - a)).toEqual(risks);
		expect(itemFacetRisk([])).toBe(-1);
	});
});

describe('isConsequential', () => {
	it('flags money, signature, access, promises, amounts and deadlines', () => {
		expect(isConsequential({ intent: 'request', facets: ['payment'] })).toBe(true);
		expect(isConsequential({ intent: 'request', facets: ['signature'] })).toBe(true);
		expect(isConsequential({ intent: 'request', facets: ['access'] })).toBe(true);
		expect(isConsequential({ intent: 'promise', facets: [] })).toBe(true);
		expect(
			isConsequential({ intent: 'decision', facets: [], amount: { value: 5, currency: 'EUR' } })
		).toBe(true);
		expect(isConsequential({ intent: 'request', facets: [], due: { phrase: 'by Friday' } })).toBe(
			true
		);
	});

	it('leaves plain questions and file or meeting requests alone', () => {
		expect(isConsequential({ intent: 'question', facets: ['information'] })).toBe(false);
		expect(isConsequential({ intent: 'request', facets: ['file', 'meeting'] })).toBe(false);
		expect(isConsequential({ intent: 'request', facets: [], amount: null, due: undefined })).toBe(
			false
		);
	});
});

describe('isLegalStatusEdge', () => {
	it('allows exactly the reducer edges', () => {
		const allowed = new Set<string>();
		for (const [from, tos] of Object.entries(LEGAL_STATUS_EDGES)) {
			for (const to of tos) allowed.add(`${from}->${to}`);
		}
		for (const from of ITEM_STATUSES) {
			for (const to of ITEM_STATUSES) {
				expect(isLegalStatusEdge(from, to, 'user')).toBe(allowed.has(`${from}->${to}`));
			}
		}
	});

	it('keeps superseded terminal and untracked → open user-only', () => {
		for (const to of ITEM_STATUSES) expect(isLegalStatusEdge('superseded', to, 'user')).toBe(false);
		for (const actor of ACTIVITY_ACTORS) {
			expect(isLegalStatusEdge('untracked', 'open', actor)).toBe(actor === 'user');
		}
		const modelEdges: Array<[ItemStatus, ItemStatus]> = [
			['open', 'done'],
			['done', 'open'],
			['declined', 'open'],
			['open', 'superseded'],
		];
		for (const [from, to] of modelEdges) expect(isLegalStatusEdge(from, to, 'agent')).toBe(true);
	});
});

describe('isLegalDispositionEdge', () => {
	it('moves forward from unanswered and anywhere into failed', () => {
		expect(isLegalDispositionEdge('unanswered', 'answered')).toBe(true);
		expect(isLegalDispositionEdge('unanswered', 'declined')).toBe(true);
		expect(isLegalDispositionEdge('answered', 'failed')).toBe(true);
		expect(isLegalDispositionEdge('failed', 'unanswered')).toBe(true);
		expect(isLegalDispositionEdge('deferred', 'accepted')).toBe(true);
	});

	it('refuses going back without a failure, and self-edges', () => {
		expect(isLegalDispositionEdge('answered', 'unanswered')).toBe(false);
		expect(isLegalDispositionEdge('accepted', 'declined')).toBe(false);
		expect(isLegalDispositionEdge('deferred', 'unanswered')).toBe(false);
		for (const d of ITEM_DISPOSITIONS) expect(isLegalDispositionEdge(d, d)).toBe(false);
	});
});

describe('factKeyString', () => {
	it('normalizes case, whitespace and the separator', () => {
		expect(factKeyString({ entity: ' Launch  Date ', attribute: 'Value' })).toBe(
			'launch date|value|'
		);
		expect(factKeyString({ entity: 'a|b', attribute: 'c', context: 'D' })).toBe('a/b|c|d');
		expect(factKeyString({ entity: 'x', attribute: 'y', context: null })).toBe(
			factKeyString({ entity: 'X', attribute: 'Y' })
		);
	});
});

describe('defaultActivityVisibility', () => {
	it('marks housekeeping types and leaves the rest as substance', () => {
		expect(defaultActivityVisibility('snoozed')).toBe('housekeeping');
		expect(defaultActivityVisibility('item_claimed')).toBe('housekeeping');
		expect(defaultActivityVisibility('reply_sent')).toBe('substance');
		expect(defaultActivityVisibility('delivery_failed')).toBe('substance');
		expect(new Set(ACTIVITY_TYPES).size).toBe(ACTIVITY_TYPES.length);
	});
});
