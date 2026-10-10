/**
 * Grounding proposals through verification into the reducer input
 * (mail/interpret/pipeline.ts, review G5/G6): every verifier verdict × every
 * proposal kind, for items and transitions.
 */

import { describe, expect, it } from 'vitest';
import type { GroundedClaim, GroundingResult } from '../ground';
import { toReduceResult, verifyClaimsOf, type VerifyVerdict } from '../pipeline';
import type {
	InterpretActionsOutput,
	InterpretItemProposal,
	InterpretTransitionProposal,
} from '../schema';

const TEXT = 'FYI. Please pay invoice 2231 today.';
type Kind = 'tracked' | 'forwarded' | 'mixed';

function evidenceFor(kind: Kind): GroundedClaim<unknown>['evidence'] {
	const fresh = { segmentId: 's0', segmentKind: 'fresh' as const, start: 0, end: 4 };
	const fwd = { segmentId: 's1', segmentKind: 'forwarded' as const, start: 5, end: 35 };
	if (kind === 'tracked') return [{ ...fresh, end: 35 }];
	if (kind === 'forwarded') return [fwd];
	return [fresh, fwd];
}

function grounded<T>(claim: T, kind: Kind): GroundedClaim<T> {
	return {
		claim,
		evidence: evidenceFor(kind),
		flags: [],
		needsReview: false,
		...(kind !== 'tracked' ? { proposal: { reason: 'forwarded' as const } } : {}),
		...(kind === 'mixed' ? { isMixed: true as const } : {}),
	};
}

const item: InterpretItemProposal = {
	matchItemId: null,
	intent: 'request',
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay invoice 2231',
	display: { en: 'Pay invoice 2231', de: 'Bezahl Rechnung 2231' },
	requester: { ref: null, name: 'Mara', email: 'mara@example.com' },
	responsible: { ref: null, name: null, email: 'me@owlat.example' },
	beneficiary: null,
	due: null,
	amount: null,
	options: null,
	quotes: [],
};
const transition: InterpretTransitionProposal = {
	itemId: 'item_a',
	to: 'done',
	disposition: 'answered',
	quotes: [],
};

function run(kind: Kind, verdict: VerifyVerdict | 'none') {
	const output: InterpretActionsOutput = {
		mode: 'actions',
		items: [item],
		transitions: [transition],
		replyIntent: 'request_for_action',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: ['s0', 's1'], uncertain: false, overflow: false },
	};
	const grounding = {
		items: [grounded(item, kind)],
		transitions: [grounded(transition, kind)],
		rejected: [],
		counts: { proposed: 2, accepted: 2, rejected: 0, flagged: 0, proposals: 0 },
		coverage: { complete: true, gaps: [] },
	} as GroundingResult<typeof output>;
	const verdicts = new Map<string, VerifyVerdict>(
		verdict === 'none'
			? []
			: [
					['item:0', verdict],
					['transition:0', verdict],
				]
	);
	const checked = new Set(verdict === 'none' ? [] : ['item:0', 'transition:0']);
	return toReduceResult(output, grounding, {
		mode: 'actions',
		canonicalText: TEXT,
		participants: [],
		ownAddresses: new Set(['me@owlat.example']),
		timezone: 'UTC',
		sentAt: 0,
		verdicts,
		checked,
	});
}

describe('items: verdict × proposal (G5)', () => {
	it.each([
		['tracked', 'supported', 'passed'],
		['tracked', 'unsupported', null],
		['tracked', 'unclear', 'proposal'],
		['tracked', 'none', 'na'],
		['forwarded', 'supported', 'proposal'],
		['forwarded', 'unsupported', 'proposal'],
		['forwarded', 'unclear', 'proposal'],
		['forwarded', 'none', 'proposal'],
		['mixed', 'supported', 'passed'],
		['mixed', 'unsupported', 'proposal'],
		['mixed', 'unclear', 'proposal'],
		['mixed', 'none', 'proposal'],
	] as const)('%s item, verdict %s → %s', (kind, verdict, expected) => {
		const result = run(kind, verdict);
		if (expected === null) expect(result.items).toEqual([]);
		else expect(result.items[0]?.verify).toBe(expected);
	});
});

describe('transitions: verdict × proposal (G6)', () => {
	it.each([
		['tracked', 'supported', true],
		['tracked', 'unsupported', false],
		['tracked', 'unclear', false],
		['tracked', 'none', false],
	] as const)(
		'a tracked transition reaches the reducer (%s, %s), verified: %s',
		(kind, verdict, isVerified) => {
			const result = run(kind, verdict);
			expect(result.transitions).toHaveLength(1);
			expect(result.transitions[0]?.isVerified).toBe(isVerified);
		}
	);

	it.each([
		['forwarded', 'supported'],
		['forwarded', 'unsupported'],
		['forwarded', 'unclear'],
		['forwarded', 'none'],
		['mixed', 'unsupported'],
		['mixed', 'unclear'],
		['mixed', 'none'],
	] as const)('a proposal transition never reaches the reducer (%s, %s)', (kind, verdict) => {
		expect(run(kind, verdict).transitions).toEqual([]);
	});

	it('a mixed transition whose fresh quotes verify applies, verified', () => {
		expect(run('mixed', 'supported').transitions[0]).toMatchObject({
			isVerified: true,
			to: 'done',
		});
	});
});

describe('verifyClaimsOf and proposals (G3)', () => {
	const claimsFor = (kind: Kind) =>
		verifyClaimsOf(
			{ items: [grounded(item, kind)], transitions: [grounded(transition, kind)], facts: [] },
			TEXT,
			{
				participants: [],
				ownAddresses: new Set(['me@owlat.example']),
				itemText: () => 'Pay invoice 2231',
				factText: () => undefined,
			}
		);

	it('checks a mixed claim on its fresh quotes alone', () => {
		const claims = claimsFor('mixed');
		expect(claims.map((c) => c.id)).toEqual(['item:0', 'transition:0']);
		for (const claim of claims) expect(claim.quotes).toEqual(['FYI.']);
	});

	it('sends no forwarded-only proposal to the verifier', () => {
		expect(claimsFor('forwarded')).toEqual([]);
	});
});
