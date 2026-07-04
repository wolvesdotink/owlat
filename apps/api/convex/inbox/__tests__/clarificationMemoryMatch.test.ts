/**
 * Pure clarification answer-memory matching (inbox/clarificationMemoryMatch.ts).
 *
 * Asserts the deterministic match rule that decides whether a stored standing
 * answer resolves a question the pipeline is about to ask — and the contact
 * -scope isolation that stops contact A's answer filling contact B's slot.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeQuestionKey,
	isStandingAnswerVisible,
	selectFills,
	matchStandingAnswers,
	type StandingAnswerRow,
	type PendingQuestion,
} from '../clarificationMemoryMatch';

const CONTACT_A = 'contact_a';
const CONTACT_B = 'contact_b';

function row(over: Partial<StandingAnswerRow> & { answerValue: string }): StandingAnswerRow {
	return {
		contactId: over.contactId,
		slotType: over.slotType ?? 'factual_lookup',
		questionKey: over.questionKey ?? normalizeQuestionKey(over.slotType ?? 'factual_lookup', 'q'),
		answerValue: over.answerValue,
		updatedAt: over.updatedAt ?? 1,
	};
}

function question(over: Partial<PendingQuestion> = {}): PendingQuestion {
	return {
		id: over.id ?? 'q1',
		slotType: over.slotType ?? 'factual_lookup',
		text: over.text ?? 'Which dock should the delivery use?',
	};
}

describe('normalizeQuestionKey', () => {
	it('collapses casing, punctuation and whitespace so re-asks collide', () => {
		expect(normalizeQuestionKey('factual_lookup', 'Which dock should we use?')).toBe(
			normalizeQuestionKey('factual_lookup', '  which   dock, should we use ')
		);
	});

	it('never collides across slot kinds', () => {
		expect(normalizeQuestionKey('decision', 'ship it?')).not.toBe(
			normalizeQuestionKey('date_time', 'ship it?')
		);
	});
});

describe('isStandingAnswerVisible (contact-scope isolation)', () => {
	it('org-general answers (undefined contactId) fill for anyone', () => {
		expect(isStandingAnswerVisible(undefined, CONTACT_A)).toBe(true);
		expect(isStandingAnswerVisible(undefined, undefined)).toBe(true);
	});

	it('a contact-scoped answer fills ONLY its own contact', () => {
		expect(isStandingAnswerVisible(CONTACT_A, CONTACT_A)).toBe(true);
		expect(isStandingAnswerVisible(CONTACT_A, CONTACT_B)).toBe(false);
		expect(isStandingAnswerVisible(CONTACT_A, undefined)).toBe(false);
	});
});

describe('selectFills', () => {
	const key = normalizeQuestionKey('factual_lookup', 'Which dock should the delivery use?');

	it('fills a matching question from a contact-scoped answer for that contact', () => {
		const rows = [row({ contactId: CONTACT_A, questionKey: key, answerValue: 'Bay 3' })];
		const fills = selectFills(rows, [question()], CONTACT_A);
		expect(fills).toEqual([{ questionId: 'q1', slotType: 'factual_lookup', value: 'Bay 3' }]);
	});

	it('does NOT fill across contact scope (A answer, B asking)', () => {
		const rows = [row({ contactId: CONTACT_A, questionKey: key, answerValue: 'Bay 3' })];
		expect(selectFills(rows, [question()], CONTACT_B)).toEqual([]);
	});

	it('an org-general (promoted) answer fills for a different contact', () => {
		const rows = [row({ contactId: undefined, questionKey: key, answerValue: 'Bay 3' })];
		expect(selectFills(rows, [question()], CONTACT_B)).toEqual([
			{ questionId: 'q1', slotType: 'factual_lookup', value: 'Bay 3' },
		]);
	});

	it('does not fill a different question of the same slot kind', () => {
		const rows = [row({ contactId: CONTACT_A, questionKey: key, answerValue: 'Bay 3' })];
		const other = question({ text: 'What is the invoice number?' });
		expect(selectFills(rows, [other], CONTACT_A)).toEqual([]);
	});

	it('prefers the freshest row when several match', () => {
		const rows = [
			row({ contactId: CONTACT_A, questionKey: key, answerValue: 'Bay 1', updatedAt: 1 }),
			row({ contactId: CONTACT_A, questionKey: key, answerValue: 'Bay 9', updatedAt: 5 }),
		];
		expect(selectFills(rows, [question()], CONTACT_A)[0]!.value).toBe('Bay 9');
	});

	it('ignores blank stored answers', () => {
		const rows = [row({ contactId: CONTACT_A, questionKey: key, answerValue: '   ' })];
		expect(selectFills(rows, [question()], CONTACT_A)).toEqual([]);
	});
});

describe('matchStandingAnswers preserves the winning row', () => {
	it('returns the row object so a caller can bump usage', () => {
		const key = normalizeQuestionKey('factual_lookup', 'Which dock should the delivery use?');
		const winner = row({
			contactId: CONTACT_A,
			questionKey: key,
			answerValue: 'Bay 3',
			updatedAt: 9,
		});
		const matches = matchStandingAnswers([winner], [question()], CONTACT_A);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.row).toBe(winner);
	});
});
