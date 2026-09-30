/**
 * Answer mode "Draft with AI that asks first": the pure decisions in
 * mail/ai/composeDraftPolicy.ts. File ranking and the three outcomes of plan
 * §06, the round-2 follow-up date, and the gap placeholders.
 */

import { describe, it, expect } from 'vitest';
import { findDraftGaps } from '@owlat/shared/answerMode';
import type { FoundFile } from '../../inbox/attachmentSuggest';
import {
	FILE_NOT_READY_OPTION,
	FILE_QUESTION_ID,
	FOLLOW_UP_QUESTION_ID,
	buildAnswerConfirmedContext,
	buildFileQuestion,
	buildFollowUpQuestion,
	canonicalAnswerValue,
	decideFileOutcome,
	ensureGapPlaceholders,
	fileRequestLabel,
	isNotReadyAnswer,
	monthInFileName,
	monthInText,
	openGapPlaceholders,
	rankFoundFiles,
	resolveFollowUpAt,
	scoreFileName,
	slotAnswerKind,
	type AskQuestion,
} from '../ai/composeDraftPolicy';

function found(overrides: Partial<FoundFile> & { id: string; filename: string }): FoundFile {
	return {
		source: 'semanticFile',
		mimeType: 'application/pdf',
		size: 84_000,
		score: 0,
		...overrides,
	};
}

describe('periods', () => {
	it('reads the month a request names, in English or German', () => {
		expect(monthInText('could you send the September invoice?')).toBe(8);
		expect(monthInText('die Rechnung für Oktober')).toBe(9);
		expect(monthInText('the invoice for June and July')).toBeUndefined();
		expect(monthInText('the latest invoice')).toBeUndefined();
	});

	it('reads the month a file is about from words or date parts', () => {
		expect(monthInFileName('invoice-2026-08-brightpath.pdf')).toBe(7);
		expect(monthInFileName('invoice_09-2026.pdf')).toBe(8);
		expect(monthInFileName('Brightpath invoice September.pdf')).toBe(8);
		expect(monthInFileName('contract.pdf', 'Signed contract')).toBeUndefined();
	});
});

describe('ranking and the three file outcomes', () => {
	it('scores a file by the request words its name carries', () => {
		expect(scoreFileName('september invoice', 'invoice-2026-09-brightpath.pdf')).toBe(1);
		expect(scoreFileName('september invoice', 'invoice-2026-08-brightpath.pdf')).toBe(0.5);
		expect(scoreFileName('september invoice', 'team-photo.jpg')).toBe(0);
	});

	it('attaches one confident match without asking', () => {
		const ranked = rankFoundFiles('september invoice', [
			found({ id: 'f1', filename: 'invoice-2026-09-brightpath.pdf' }),
			found({ id: 'f2', filename: 'offer-2026.pdf', score: 0.05 }),
		]);
		const outcome = decideFileOutcome(ranked);
		expect(outcome.kind).toBe('attach');
		expect(outcome.kind === 'attach' && outcome.file.id).toBe('f1');
	});

	it('asks which file when several match about as well', () => {
		const ranked = rankFoundFiles('september invoice', [
			found({ id: 'f1', filename: 'invoice-2026-09.pdf' }),
			found({ id: 'm1', source: 'mailAttachment', filename: 'invoice-2026-09-v2.pdf' }),
		]);
		const outcome = decideFileOutcome(ranked);
		expect(outcome.kind).toBe('choose');
		const question = buildFileQuestion(
			outcome as Exclude<typeof outcome, { kind: 'attach' }>,
			'september invoice',
			'Generated from an email from example.com'
		);
		expect(question?.answerKind).toBe('file');
		expect(question?.options).toBeUndefined();
		expect(question?.fileCandidates?.map((c) => c.id)).toEqual(['f1', 'm1']);
	});

	it('offers the near miss for another period, noted, with the way out', () => {
		const ranked = rankFoundFiles('september invoice', [
			found({ id: 'aug', filename: 'invoice-2026-08-brightpath.pdf', score: 0.6 }),
		]);
		const outcome = decideFileOutcome(ranked);
		expect(outcome.kind).toBe('missing');
		const question = buildFileQuestion(
			outcome as Exclude<typeof outcome, { kind: 'attach' }>,
			'september invoice',
			'attribution'
		)!;
		expect(question.id).toBe(FILE_QUESTION_ID);
		expect(question.text).toContain("couldn't find it");
		expect(question.options).toEqual([FILE_NOT_READY_OPTION]);
		expect(question.fileCandidates).toEqual([
			expect.objectContaining({ id: 'aug', note: 'August', source: 'semanticFile' }),
		]);
		// Ranking-only fields never reach the stored candidate.
		expect(question.fileCandidates?.[0]).not.toHaveProperty('fileId');
		expect(question.fileCandidates?.[0]).not.toHaveProperty('isPeriodMismatch');
	});

	it('asks with no candidates when nothing came close', () => {
		const outcome = decideFileOutcome(rankFoundFiles('september invoice', []));
		expect(outcome).toEqual({ kind: 'missing', near: [] });
	});

	it('drops a file question whose label fishes for a credential', () => {
		const question = buildFileQuestion(
			{ kind: 'missing', near: [] },
			fileRequestLabel('password list'),
			'attribution'
		);
		expect(question).toBeNull();
	});

	it('keeps the best score when both searches find the same file', () => {
		const ranked = rankFoundFiles('invoice', [
			found({ id: 'f1', filename: 'a.pdf', score: 0.2 }),
			found({ id: 'f1', filename: 'a.pdf', score: 0.7 }),
		]);
		expect(ranked).toHaveLength(1);
		expect(ranked[0]!.score).toBe(0.7);
	});
});

describe('answer kinds and round 2', () => {
	it('maps slot types to pickers', () => {
		expect(slotAnswerKind('date_time', undefined)).toBe('date');
		expect(slotAnswerKind('price_number', ['10', '20'])).toBe('number');
		expect(slotAnswerKind('decision', ['Yes', 'No'])).toBe('choice');
		expect(slotAnswerKind('factual_lookup', undefined)).toBe('text');
	});

	const WED_2026_09_30 = Date.UTC(2026, 8, 30, 14, 0);

	it('asks when the file can be sent, with tomorrow and the day after by name', () => {
		const q = buildFollowUpQuestion('september invoice', 'attribution', WED_2026_09_30);
		expect(q.id).toBe(FOLLOW_UP_QUESTION_ID);
		expect(q.answerKind).toBe('date');
		expect(q.options).toEqual(['Tomorrow', 'Friday']);
	});

	it('resolves the follow-up date to the morning of that day', () => {
		const morning = (y: number, m: number, d: number) => Date.UTC(y, m, d, 9);
		expect(resolveFollowUpAt('Tomorrow', WED_2026_09_30)).toBe(morning(2026, 9, 1));
		expect(resolveFollowUpAt('Friday', WED_2026_09_30)).toBe(morning(2026, 9, 2));
		expect(resolveFollowUpAt('freitag', WED_2026_09_30)).toBe(morning(2026, 9, 2));
		expect(resolveFollowUpAt('Wednesday', WED_2026_09_30)).toBe(morning(2026, 9, 7));
		expect(resolveFollowUpAt('2026-10-05', WED_2026_09_30)).toBe(morning(2026, 9, 5));
		expect(resolveFollowUpAt('2026-10-05T15:30:00+02:00', WED_2026_09_30)).toBe(
			Date.parse('2026-10-05T15:30:00+02:00')
		);
		// Past dates and prose resolve to nothing; the draft still quotes them.
		expect(resolveFollowUpAt('2026-09-01', WED_2026_09_30)).toBeUndefined();
		expect(resolveFollowUpAt('next week sometime', WED_2026_09_30)).toBeUndefined();
	});

	it('maps a translated chip back to the canonical option', () => {
		const q: AskQuestion = {
			id: FILE_QUESTION_ID,
			slotType: 'attachment',
			text: 'They asked for "invoice".',
			attribution: 'a',
			answerKind: 'file',
			options: [FILE_NOT_READY_OPTION],
			translations: [
				{ locale: 'de', text: 'Sie wollten "invoice".', options: ['Noch nicht fertig'] },
			],
		};
		expect(canonicalAnswerValue(q, 'Noch nicht fertig')).toBe(FILE_NOT_READY_OPTION);
		expect(isNotReadyAnswer(q, 'Noch nicht fertig')).toBe(true);
		expect(isNotReadyAnswer(q, 'invoice.pdf')).toBe(false);
		expect(canonicalAnswerValue(q, ' something else ')).toBe('something else');
	});
});

describe('gaps and the trusted block', () => {
	const questions: AskQuestion[] = [
		{
			id: FILE_QUESTION_ID,
			slotType: 'attachment',
			text: 'They asked for "september invoice".',
			attribution: 'a',
			answerKind: 'file',
		},
		{
			id: 'clarify_0',
			slotType: 'decision',
			text: 'Is PO BP-2231 already printed on the invoice?',
			attribution: 'a',
			answerKind: 'choice',
			options: ['Yes', 'No'],
			answer: { value: 'Yes', at: 1, source: 'memory' },
		},
		{
			id: 'clarify_1',
			slotType: 'date_time',
			text: 'When does the renewal start?',
			attribution: 'a',
			answerKind: 'date',
		},
	];

	it('leaves one placeholder per open question', () => {
		const gaps = openGapPlaceholders(questions, 'september invoice');
		expect(gaps).toEqual(['[[attach september invoice]]', '[[When does the renewal start]]']);
		expect(findDraftGaps(gaps.join(' '))).toHaveLength(2);
	});

	it('appends a placeholder the model dropped, and leaves a complete draft alone', () => {
		const gaps = ['[[attach september invoice]]'];
		expect(ensureGapPlaceholders('Hi Jonas,\n\nhere it is.', gaps)).toBe(
			'Hi Jonas,\n\nhere it is.\n\n[[attach september invoice]]'
		);
		const complete = 'Hi Jonas, [[attach september invoice]] follows.';
		expect(ensureGapPlaceholders(complete, gaps)).toBe(complete);
	});

	it('puts answers, files, the promise, gaps and the instruction in the trusted block', () => {
		const block = buildAnswerConfirmedContext({
			questions,
			attachedFiles: [{ source: 'upload', id: 's1', filename: 'invoice-2026-09.pdf' }],
			gapPlaceholders: ['[[When does the renewal start]]'],
			fileLabel: 'september invoice',
			followUp: { value: 'Friday', at: Date.UTC(2026, 9, 2, 9) },
			instruction: 'Say sorry it is late',
		});
		expect(block).toContain('Is PO BP-2231 already printed on the invoice? Yes');
		expect(block).toContain('invoice-2026-09.pdf');
		expect(block).toContain('promise to send it by: Friday (Fri, 02 Oct 2026)');
		expect(block).toContain('[[When does the renewal start]]');
		expect(block).toContain("in the owner's words: Say sorry it is late");
	});

	it('does not quote "It isn\'t ready yet" as a confirmed fact', () => {
		const block = buildAnswerConfirmedContext({
			questions: [
				{ ...questions[0]!, answer: { value: FILE_NOT_READY_OPTION, at: 1, source: 'user' } },
			],
			attachedFiles: [],
			gapPlaceholders: [],
		});
		expect(block).toBe('');
	});
});
