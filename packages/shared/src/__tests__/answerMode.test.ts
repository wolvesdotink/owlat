import { describe, expect, it } from 'vitest';
import {
	aiTextToHtml,
	findDraftGaps,
	formatDraftGap,
	hasDraftGaps,
	isUntouchedAiAnswer,
} from '../answerMode';

describe('draft gaps', () => {
	it('finds each placeholder with its offsets and label', () => {
		const text = 'Hi Jonas, [[attach the September invoice]] and see [[ date ]].';
		expect(findDraftGaps(text)).toEqual([
			{ start: 10, end: 42, label: 'attach the September invoice' },
			{ start: 51, end: 61, label: 'date' },
		]);
		expect(hasDraftGaps(text)).toBe(true);
	});

	it('ignores single brackets, empty and multi-line brackets', () => {
		expect(hasDraftGaps('see [1] and [[ ]] and [[a\nb]]')).toBe(false);
	});

	it('formats a label into a placeholder it can find again', () => {
		const gap = formatDraftGap('the [PO] number\n');
		expect(gap).toBe('[[the  PO  number]]');
		expect(findDraftGaps(gap)[0]?.label).toBe('the  PO  number');
	});
});

describe('isUntouchedAiAnswer', () => {
	const ai = "Hi Sam,\n\nIt's ready & attached.";
	const quote = '<br><br><div class="gmail_quote">On Monday Sam wrote: ready?</div>';

	it('holds for the AI text as the composer wrote it, above the quote', () => {
		expect(isUntouchedAiAnswer(`${aiTextToHtml(ai)}${quote}`, ai)).toBe(true);
	});

	it('holds when the editor re-serialized the markup', () => {
		expect(isUntouchedAiAnswer("<p>Hi Sam,</p><p>It's ready &amp; attached.</p>", ai)).toBe(true);
	});

	it('fails for a changed word, or text a person kept above the AI text', () => {
		expect(isUntouchedAiAnswer(`${aiTextToHtml(`${ai} Thanks!`)}${quote}`, ai)).toBe(false);
		expect(isUntouchedAiAnswer(`<p>Quick note.</p>${aiTextToHtml(ai)}${quote}`, ai)).toBe(false);
	});

	it('fails without AI text', () => {
		expect(isUntouchedAiAnswer(quote, '  ')).toBe(false);
	});
});
