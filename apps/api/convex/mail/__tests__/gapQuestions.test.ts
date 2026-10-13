/**
 * No draft with silent gaps (mail/ai/gapQuestions.ts and its seams): the gaps a
 * draft leaves become questions, a pre-written slot next to open questions is
 * never shown, "Answer and draft" needs every question, and a suggested reply
 * never carries a gap.
 */

import { describe, expect, it } from 'vitest';
import { authoredGapLabels } from '../../agent/shared/draftGaps';
import { gapQuestionsFor } from '../ai/gapQuestions';
import { visibleDraftSlot, withVisibleDraftSlot } from '../needsReplySlot';
import { leavesQuestionsOpen, type AskQuestion } from '../ai/composeDraftPolicy';
import { parseReplyOptionsText } from '../replyOptions';

const question = (id: string, answer?: AskQuestion['answer']): AskQuestion => ({
	id,
	slotType: 'factual_lookup',
	text: `Question ${id}?`,
	...(answer ? { answer } : {}),
});

describe('authoredGapLabels', () => {
	it('lists each gap of the authored part once, reviewer notes included', () => {
		const draft = [
			'Hi Jonas, the total is [[invoice total]].',
			'[Bitte prüfen: Lieferdatum] and again [[Invoice Total]].',
			'',
			'> On Monday Jonas wrote:',
			'> [[a gap in the quoted mail]]',
		].join('\n');
		expect(authoredGapLabels(draft)).toEqual(['invoice total', 'Bitte prüfen: Lieferdatum']);
	});

	it('finds nothing in a complete draft or in ordinary brackets', () => {
		expect(authoredGapLabels('See [1] and [EXTERNAL] notes. Thanks!')).toEqual([]);
	});
});

describe('gapQuestionsFor', () => {
	it('asks one text question per gap, attributed to the email, with fresh ids', () => {
		const questions = gapQuestionsFor('Total: [[invoice total]], due [[due date]].', {
			fromAddress: 'jonas@brightpath.example',
			existing: [{ id: 'gap_0' }, { id: 'clarify_0' }],
		});
		expect(questions).toEqual([
			expect.objectContaining({
				id: 'gap_1',
				text: 'invoice total',
				answerKind: 'text',
				origin: { kind: 'email', senderDomain: 'brightpath.example' },
			}),
			expect.objectContaining({ id: 'gap_2', text: 'due date' }),
		]);
	});

	it('never asks for a credential, even when the draft leaves a gap for one', () => {
		expect(
			gapQuestionsFor('Log in with [[your password]].', {
				fromAddress: 'a@b.example',
				existing: [],
			})
		).toEqual([]);
	});

	it('asks nothing about a complete draft', () => {
		expect(gapQuestionsFor('All done.', { fromAddress: 'a@b.example', existing: [] })).toEqual([]);
	});
});

describe('visibleDraftSlot', () => {
	const slot = { draft: 'Hi', confidence: 0.8, generatedAt: 1 };
	const clarification = { isNeeded: true, questions: [], askedAt: 1 };

	it('shows the slot of a thread without questions', () => {
		expect(visibleDraftSlot({ draftSlot: slot })).toBe(slot);
	});

	it('never shows a slot next to a clarification, answered or not', () => {
		expect(visibleDraftSlot({ draftSlot: slot, clarification })).toBeUndefined();
		expect(
			visibleDraftSlot({ draftSlot: slot, clarification: { ...clarification, answeredAt: 2 } })
		).toBeUndefined();
	});

	it('leaves a hidden slot out of a whole thread row', () => {
		const thread = { _id: 't1', needsReply: { draftSlot: slot, clarification, messageId: 'm1' } };
		expect(withVisibleDraftSlot(thread)).toEqual({
			_id: 't1',
			needsReply: { clarification, messageId: 'm1' },
		});
		const plain = { _id: 't2', needsReply: { draftSlot: slot } };
		expect(withVisibleDraftSlot(plain)).toBe(plain);
	});
});

describe('leavesQuestionsOpen', () => {
	it('is false only when every question has a usable answer', () => {
		const questions = [question('a'), question('b', { value: 'Yes', at: 1, source: 'memory' })];
		expect(leavesQuestionsOpen(questions, [{ questionId: 'a', value: 'Friday' }])).toBe(false);
		expect(leavesQuestionsOpen(questions, [{ questionId: 'a', value: '   ' }])).toBe(true);
		expect(leavesQuestionsOpen(questions, [])).toBe(true);
		expect(
			leavesQuestionsOpen(questions, [
				{ questionId: 'a', file: { source: 'upload', id: 's1', filename: 'x.pdf' } },
			])
		).toBe(false);
	});

	it('counts a blank stored answer as open', () => {
		expect(leavesQuestionsOpen([question('a', { value: ' ', at: 1 })], [])).toBe(true);
	});
});

describe('parseReplyOptionsText', () => {
	it('drops a suggestion that leaves a fact open', () => {
		expect(
			parseReplyOptionsText(
				'1. Tuesday at 2 works for me.\n2. I can do [[a time that works]].\n3. [TBD: date] is fine.'
			)
		).toEqual(['Tuesday at 2 works for me.']);
	});
});
