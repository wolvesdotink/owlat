/**
 * No draft with silent gaps (mail/ai/gapQuestions.ts and its seams): the gaps a
 * draft leaves become questions, a pre-written slot next to open questions is
 * never shown, "Answer and draft" needs every question, and a suggested reply
 * never carries a gap.
 */

import { describe, expect, it } from 'vitest';
import { authoredGapLabels } from '../../agent/shared/draftGaps';
import { checkDraftGaps } from '../ai/gapQuestions';
import {
	isGapsAccepted,
	visibleClarification,
	visibleDraftSlot,
	withVisibleDrafts,
} from '../needsReplySlot';
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

describe('checkDraftGaps', () => {
	const opts = (existing: { id: string }[] = []) => ({
		fromAddress: 'jonas@brightpath.example',
		existing,
	});

	it('asks one text question per gap, attributed to the email, with fresh ids', () => {
		const check = checkDraftGaps(
			'Total: [[invoice total]], due [[due date]].',
			opts([{ id: 'gap_0' }, { id: 'clarify_0' }])
		);
		expect(check).toEqual({
			kind: 'ask',
			questions: [
				expect.objectContaining({
					id: 'gap_1',
					text: 'invoice total',
					answerKind: 'text',
					origin: { kind: 'email', senderDomain: 'brightpath.example' },
				}),
				expect.objectContaining({ id: 'gap_2', text: 'due date' }),
			],
		});
	});

	it('asks for a file where the gap wants one', () => {
		const check = checkDraftGaps('Here it is: [[attach the September invoice]]', opts());
		expect(check).toEqual({
			kind: 'ask',
			questions: [expect.objectContaining({ slotType: 'attachment', answerKind: 'file' })],
		});
		const german = checkDraftGaps('[[Rechnung als PDF anhängen]]', opts());
		expect(german.kind === 'ask' && german.questions[0]!.answerKind).toBe('file');
	});

	it('keeps a gap that only mentions a file a text question', () => {
		for (const label of [
			'maximum file size in MB',
			'amount in the attached invoice',
			'delivery date stated in the document',
			'Betrag laut PDF-Anhang',
		]) {
			const check = checkDraftGaps(`[[${label}]]`, opts());
			expect(check.kind === 'ask' && check.questions[0]!.answerKind, label).toBe('text');
		}
	});

	it('holds a draft whose gap no question may ask for, instead of passing it', () => {
		expect(checkDraftGaps('Log in with [[your password]].', opts())).toEqual({
			kind: 'unaskable',
		});
	});

	it('passes a complete draft', () => {
		expect(checkDraftGaps('All done.', opts())).toEqual({ kind: 'complete' });
	});
});

describe('visibleDraftSlot and visibleClarification', () => {
	const slot = { draft: 'Hi', confidence: 0.8, generatedAt: 1 };
	const answered = {
		id: 'q1',
		slotType: 'decision',
		text: 'Approve?',
		answer: { value: 'Yes', at: 1 },
	};
	const clarification = { isNeeded: true, questions: [answered], askedAt: 1 };

	it('shows the slot of a thread without questions', () => {
		expect(visibleDraftSlot({ draftSlot: slot })).toBe(slot);
	});

	it('never shows a slot next to a clarification, or one with a gap of its own', () => {
		expect(visibleDraftSlot({ draftSlot: slot, clarification })).toBeUndefined();
		expect(
			visibleDraftSlot({ draftSlot: { ...slot, draft: 'Total: [[amount]]' } })
		).toBeUndefined();
	});

	it('reads a reply with gaps nobody agreed to as asking again, answers kept', () => {
		const stored = { ...clarification, isNeeded: false, answeredAt: 2, draft: 'Total: [[amount]]' };
		expect(visibleClarification(stored)).toEqual({
			isNeeded: true,
			questions: [answered],
			askedAt: 1,
		});
		// "Draft with what I have", or a question left open: the gaps were agreed to.
		expect(visibleClarification({ ...stored, isGapsAccepted: true })).toEqual({
			...stored,
			isGapsAccepted: true,
		});
		const open = { ...stored, questions: [{ ...answered, answer: undefined }] };
		expect(visibleClarification(open)).toBe(open);
		const clean = { ...stored, draft: 'Total: EUR 2,100' };
		expect(visibleClarification(clean)).toBe(clean);
	});

	it('shows no reply stored on a card that is still asking, and infers no consent there', () => {
		const raced = {
			isNeeded: true,
			questions: [{ ...answered, answer: undefined }],
			askedAt: 1,
			draft: 'Total: [[amount]]',
		};
		expect(isGapsAccepted(raced)).toBe(false);
		expect(visibleClarification(raced)).toEqual({
			isNeeded: true,
			questions: [{ ...answered, answer: undefined }],
			askedAt: 1,
		});
	});

	it('applies both to a whole thread row', () => {
		const thread = { _id: 't1', needsReply: { draftSlot: slot, clarification, messageId: 'm1' } };
		expect(withVisibleDrafts(thread)).toEqual({
			_id: 't1',
			needsReply: { clarification, messageId: 'm1' },
		});
		const plain = { _id: 't2', needsReply: { draftSlot: slot } };
		expect(withVisibleDrafts(plain)).toEqual(plain);
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
	it('drops a suggestion cut off inside a gap or reviewer note', () => {
		expect(
			parseReplyOptionsText('1. Sure.\n2. The total is [[invoice total\n3. On [Bitte prüfen: Da', {
				partial: true,
			})
		).toEqual(['Sure.']);
		// An ordinary bracket stays.
		expect(parseReplyOptionsText('1. See [1] for details.')).toEqual(['See [1] for details.']);
	});

	it('drops a suggestion that leaves a fact open', () => {
		expect(
			parseReplyOptionsText(
				'1. Tuesday at 2 works for me.\n2. I can do [[a time that works]].\n3. [TBD: date] is fine.'
			)
		).toEqual(['Tuesday at 2 works for me.']);
	});
});
