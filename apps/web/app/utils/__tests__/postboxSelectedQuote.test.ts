/**
 * A selected passage in a reply body (utils/postboxSelectedQuote): the text as
 * it is quoted, and where a further passage goes.
 */
import { describe, expect, it } from 'vitest';
import { splitAnswerBody } from '@owlat/shared/answerMode';
import { SELECTED_QUOTE_CLASS } from '../answerMode';
import { insertSelectedQuote, normalizeQuotedPassage } from '../postboxSelectedQuote';

const block = (text: string) =>
	`<br><br><div class="gmail_quote ${SELECTED_QUOTE_CLASS}"><div>On …, Sam wrote:</div><blockquote>${text}</blockquote></div>`;
const signature = '<br><br><div data-postbox-signature="true">Ada</div>';
const original =
	'<br><br><div class="gmail_quote"><div>On …, Sam wrote:</div><blockquote class="gmail_quote"><div><p>All of it</p></div></blockquote></div>';

describe('normalizeQuotedPassage', () => {
	it('keeps line and paragraph breaks and trims the edges', () => {
		expect(normalizeQuotedPassage('\n  First line  \r\nsecond line\n\n\n\nnext para \n')).toBe(
			'First line\nsecond line\n\nnext para'
		);
	});

	it('is empty for a selection of only whitespace', () => {
		expect(normalizeQuotedPassage(' \n\t \n')).toBe('');
	});
});

describe('insertSelectedQuote', () => {
	it('goes where the written part ends, before the signature and the original', () => {
		const body = `<p>Thanks!</p>${signature}${original}`;
		expect(insertSelectedQuote(body, block('one'))).toBe(
			`<p>Thanks!</p>${block('one')}${signature}${original}`
		);
	});

	it('goes at the end of a body with nothing seeded', () => {
		expect(insertSelectedQuote('<p>Hi</p>', block('one'))).toBe(`<p>Hi</p>${block('one')}`);
		expect(insertSelectedQuote('', block('one'))).toBe(block('one'));
	});

	it('follows the passages already quoted, in the order they were picked', () => {
		const once = insertSelectedQuote(`<p>Hi</p>${original}`, block('one'));
		const twice = insertSelectedQuote(once, block('<div>two</div>'));
		expect(twice).toBe(`<p>Hi</p>${block('one')}${block('<div>two</div>')}${original}`);
	});

	it('stays in the seeded tail, so an AI draft replacing the written part keeps it', () => {
		const body = insertSelectedQuote(`<p>Hi</p>${signature}`, block('one'));
		expect(splitAnswerBody(body)).toEqual({
			fresh: '<p>Hi</p>',
			tail: `${block('one')}${signature}`,
		});
	});
});
