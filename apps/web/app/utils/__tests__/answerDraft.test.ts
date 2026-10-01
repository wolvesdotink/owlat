/**
 * The Answer mode draft body (utils/answerDraft): an AI draft replaces only
 * what was written, never the quote or the signature; gaps are counted in what
 * was written only; the backend's "gaps left" refusal is recognised by code.
 */
import { describe, it, expect } from 'vitest';
import {
	aiTextToHtml,
	freshDraftGaps,
	freshDraftText,
	hasOwnWriting,
	isDraftGapsRefusal,
	replaceAnswerText,
	splitAnswerBody,
} from '../answerDraft';

const SIGNATURE = '<br><br><div data-postbox-signature="true">Ada</div>';
const QUOTE =
	'<br><br><div class="gmail_quote"><div>On Monday, Jonas wrote:</div>' +
	'<blockquote class="gmail_quote">Could you send [[this]]?</blockquote></div>';

describe('splitAnswerBody', () => {
	it('splits at the signature or the quote, whichever comes first', () => {
		expect(splitAnswerBody(`<p>Hi</p>${SIGNATURE}${QUOTE}`)).toEqual({
			fresh: '<p>Hi</p>',
			tail: `${SIGNATURE}${QUOTE}`,
		});
		expect(splitAnswerBody(`<p>Hi</p>${QUOTE}`)).toEqual({ fresh: '<p>Hi</p>', tail: QUOTE });
	});

	it('treats a body without either as all written', () => {
		expect(splitAnswerBody('<p>Hi</p>')).toEqual({ fresh: '<p>Hi</p>', tail: '' });
	});
});

describe('aiTextToHtml', () => {
	it('makes paragraphs of blank-line blocks and keeps single breaks', () => {
		expect(aiTextToHtml('Hi Jonas,\n\nhere it is.\nBest,\nAda')).toBe(
			'<p>Hi Jonas,</p><p>here it is.<br>Best,<br>Ada</p>'
		);
	});

	it('escapes model output: it is never markup', () => {
		expect(aiTextToHtml('<img src=x onerror=alert(1)> & co')).toBe(
			'<p>&lt;img src=x onerror=alert(1)&gt; &amp; co</p>'
		);
	});
});

describe('replaceAnswerText', () => {
	it('replaces what was written and keeps the signature and quote byte for byte', () => {
		const body = `<p>my notes</p>${SIGNATURE}${QUOTE}`;
		expect(replaceAnswerText(body, 'Hi Jonas')).toBe(`<p>Hi Jonas</p>${SIGNATURE}${QUOTE}`);
	});

	it('leaves only the tail for empty text', () => {
		expect(replaceAnswerText(`<p>x</p>${QUOTE}`, '  ')).toBe(QUOTE);
	});
});

describe('freshDraftGaps / freshDraftText', () => {
	it('counts gaps in what was written, not in the quote', () => {
		const body = `<p>Attached. [[the PO number]]</p>${QUOTE}`;
		expect(freshDraftGaps(body).map((g) => g.label)).toEqual(['the PO number']);
	});

	it('reads the written text without the signature or the quote', () => {
		expect(freshDraftText(`<p>Here &amp; now</p>${SIGNATURE}${QUOTE}`)).toBe('Here & now');
	});
});

describe('isDraftGapsRefusal', () => {
	it('recognises the typed code on an invalid_state refusal', () => {
		expect(
			isDraftGapsRefusal({
				category: 'invalid_state',
				message: 'gaps',
				data: { code: 'DRAFT_HAS_GAPS' },
			})
		).toBe(true);
		expect(isDraftGapsRefusal({ category: 'invalid_state', message: 'other' })).toBe(false);
	});
});

describe('hasOwnWriting', () => {
	it('counts only words that are not the AI draft as it went in', () => {
		expect(hasOwnWriting('', null)).toBe(false);
		expect(hasOwnWriting('  ', 'Hi')).toBe(false);
		expect(hasOwnWriting('Hi Jana,\n\nhere they are.', 'Hi Jana,\nhere they are.')).toBe(false);
		expect(hasOwnWriting('Hi Jana, here they are. Best', 'Hi Jana, here they are.')).toBe(true);
		expect(hasOwnWriting('My own words', null)).toBe(true);
	});
});
