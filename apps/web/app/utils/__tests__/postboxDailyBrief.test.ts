/**
 * Daily Brief template copy (utils/postboxDailyBrief.ts): deterministic
 * sentence assembly — every concrete count is a linked segment routed to the
 * surface holding the real rows, empty sections drop out, and the whole body
 * never exceeds three sentences.
 */
import { describe, it, expect } from 'vitest';
import {
	briefGreeting,
	composeBriefSentences,
	localDayOf,
	localDayStartOf,
	BRIEF_LINK_TARGETS,
	type BriefSentence,
} from '../postboxDailyBrief';

function flat(sentences: BriefSentence[]): string {
	return sentences.map((s) => s.map((seg) => seg.text).join('')).join(' ');
}

function links(sentences: BriefSentence[]): Array<{ text: string; to: string }> {
	return sentences.flatMap((s) =>
		s.filter((seg) => seg.to !== undefined).map((seg) => ({ text: seg.text, to: seg.to! }))
	);
}

describe('briefGreeting', () => {
	it('is time-of-day aware', () => {
		expect(briefGreeting(6)).toBe('Good morning');
		expect(briefGreeting(11)).toBe('Good morning');
		expect(briefGreeting(12)).toBe('Good afternoon');
		expect(briefGreeting(17)).toBe('Good afternoon');
		expect(briefGreeting(18)).toBe('Good evening');
		expect(briefGreeting(23)).toBe('Good evening');
	});
});

describe('composeBriefSentences', () => {
	it('links every concrete count to its surface', () => {
		const sentences = composeBriefSentences({
			newMail: 4,
			drafted: 3,
			questions: 2,
			autoFiled: 6,
		});
		expect(sentences).toHaveLength(3);
		expect(flat(sentences)).toBe(
			'Quiet day: 4 new since this morning. ' +
				'Your agent drafted 3 replies for review and filed 6 low-priority emails overnight. ' +
				'2 questions need you — answering them unblocks the waiting replies.'
		);
		expect(links(sentences)).toEqual([
			{ text: '4 new', to: BRIEF_LINK_TARGETS.newMail },
			{ text: '3 replies', to: BRIEF_LINK_TARGETS.drafts },
			{ text: '2 questions', to: BRIEF_LINK_TARGETS.questions },
		]);
	});

	it('drops empty sections and keeps singular forms', () => {
		const sentences = composeBriefSentences({
			newMail: 0,
			drafted: 1,
			questions: 1,
			autoFiled: 0,
		});
		expect(flat(sentences)).toBe(
			'All quiet — nothing new since this morning. ' +
				'Your agent drafted 1 reply for review overnight. ' +
				'1 question needs you — answering it unblocks the waiting replies.'
		);
		// The zero-count sentence carries no link (nothing to inspect).
		expect(links(sentences).map((l) => l.to)).toEqual([
			BRIEF_LINK_TARGETS.drafts,
			BRIEF_LINK_TARGETS.questions,
		]);
	});

	it('collapses to the single new-mail line on a plain day', () => {
		const sentences = composeBriefSentences({
			newMail: 7,
			drafted: 0,
			questions: 0,
			autoFiled: 0,
		});
		expect(sentences).toHaveLength(1);
		expect(flat(sentences)).toBe('Busy morning: 7 new since this morning.');
	});

	it('mentions auto-filed mail without a draft clause', () => {
		const sentences = composeBriefSentences({
			newMail: 2,
			drafted: 0,
			questions: 0,
			autoFiled: 5,
		});
		expect(flat(sentences)).toBe(
			'Quiet day: 2 new since this morning. Your agent filed 5 low-priority emails overnight.'
		);
	});
});

describe('local day helpers', () => {
	it('formats the local calendar day and its midnight', () => {
		const d = new Date(2026, 6, 7, 9, 30, 0); // 2026-07-07 09:30 local
		expect(localDayOf(d)).toBe('2026-07-07');
		const start = new Date(localDayStartOf(d));
		expect(start.getFullYear()).toBe(2026);
		expect(start.getMonth()).toBe(6);
		expect(start.getDate()).toBe(7);
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
	});
});
