/**
 * Reviewer notes a draft model writes in single brackets become `[[...]]`
 * placeholders (agent/shared/draftGaps.ts), so the composer and the send guard
 * count them. Real bracketed mail content keeps its text.
 */

import { describe, expect, it } from 'vitest';
import { findDraftGaps } from '@owlat/shared/answerMode';
import { markReviewerNotes } from '../draftGaps';

describe('markReviewerNotes', () => {
	it('turns the notes from the production draft into gaps the send guard counts', () => {
		const draft = [
			'Hallo Frau Berger,',
			'',
			'danke für deine Nachricht. Das Guthaben wurde deinem Konto gutgeschrieben.',
			'[Bitte prüfen: Betrag von 67 € anhand der Buchung bestätigen]',
			'[Bitte ergänzen: wo und wann das Guthaben sichtbar ist]',
			'',
			'Viele Grüße',
		].join('\n');

		const marked = markReviewerNotes(draft);

		expect(findDraftGaps(draft)).toHaveLength(0);
		expect(findDraftGaps(marked).map((g) => g.label)).toEqual([
			'Bitte prüfen: Betrag von 67 € anhand der Buchung bestätigen',
			'Bitte ergänzen: wo und wann das Guthaben sichtbar ist',
		]);
		expect(marked).toContain('[[Bitte prüfen: Betrag von 67 € anhand der Buchung bestätigen]]');
	});

	it.each([
		['[Please confirm: the refund amount]', '[[Please confirm: the refund amount]]'],
		['Your order ships on [TODO date].', 'Your order ships on [[TODO date]].'],
		['[TBD]', '[[TBD]]'],
		['- [Insert tracking number]', '- [[Insert tracking number]]'],
		['[Note to reviewer: check the contract]', '[[Note to reviewer: check the contract]]'],
		['[bitte bestätigen – Liefertermin]', '[[bitte bestätigen – Liefertermin]]'],
		['[Zu klären: Rabatt]', '[[Zu klären: Rabatt]]'],
		['[Platzhalter: Ansprechpartner]', '[[Platzhalter: Ansprechpartner]]'],
		['[Überprüfen: IBAN]', '[[Überprüfen: IBAN]]'],
	])('rewrites %s', (input, expected) => {
		expect(markReviewerNotes(input)).toBe(expected);
	});

	it.each([
		['a numbered reference', 'As described in the handbook [1], the fee applies.'],
		['a markdown link', 'See [Please check our FAQ](https://example.com/faq) for details.'],
		['a reference-style link', 'See [Check the status][1] page.'],
		['a subject tag', '[EXTERNAL] Re: your booking'],
		['a placeholder already in place', 'The amount is [[refund amount]].'],
		['a word that only starts like a prefix', '[Checklist attached] and [Addendum B]'],
		['an ordinary bracketed aside', 'We open at 9 [local time].'],
		['a task-list box', '- [ ] Send the invoice'],
	])('leaves %s alone', (_label, input) => {
		expect(markReviewerNotes(input)).toBe(input);
	});

	it('leaves the quoted original alone', () => {
		const draft = [
			'Hi Sam,',
			'',
			'[Please confirm: delivery date]',
			'',
			'On Mon, Sep 1, 2026 at 10:00 Sam <sam@example.com> wrote:',
			'> [TODO] from your own notes',
		].join('\n');

		expect(markReviewerNotes(draft)).toBe(
			draft.replace('[Please confirm: delivery date]', '[[Please confirm: delivery date]]')
		);
	});

	it('leaves `>` quote lines alone even at the top of the draft', () => {
		expect(markReviewerNotes('> [TODO] theirs')).toBe('> [TODO] theirs');
	});

	it('keeps a long note to the placeholder limit the send guard matches', () => {
		const marked = markReviewerNotes(`[Bitte prüfen: ${'x'.repeat(300)}]`);
		expect(findDraftGaps(marked)).toHaveLength(1);
	});
});
